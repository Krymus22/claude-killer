/**
 * subAgents.ts - In-process sub-agents for parallel task execution.
 *
 * Two modes:
 *   - READ_ONLY (default): 4 read tools, focused on exploration. Fast, cheap, safe.
 *   - POWERFUL: inherits main agent's tools + system prompt. Can write, edit,
 *     run tests, etc. Same safety checks (file lock, safety reviewer, luau
 *     validator, impact analyzer) apply to its writes.
 *
 * POWERFUL mode is for parallel task execution:
 *   - Main agent: implements InventoryService.luau
 *   - Sub-agent 1: writes InventoryService.spec.luau (tests)
 *   - Sub-agent 2: researches current ProfileStore API
 *
 * When POWERFUL:
 *   - System prompt = main agent's getSystemPrompt() (inherits effort, mode, etc)
 *   - Tools = all main agent's tools (write, edit, git, test, MCP, etc)
 *   - Tool dispatch = same dispatchToolCallPublic (with all safety hooks)
 *   - CLAUDE_KILLER_AGENT_ID env var = "sub-N" (for rollback tracking)
 *   - File locks prevent concurrent edits to same file
 *   - Max 15 tool calls (vs 8 in read-only)
 *
 * When READ_ONLY:
 *   - System prompt = focused exploration prompt (40 lines, fixed)
 *   - Tools = 4 read-only (ler_arquivo, buscar_arquivos, buscar_texto, parse_ast)
 *   - Max 8 tool calls
 *
 * Both modes:
 *   - Clean history (don't inherit main agent's conversation)
 *   - No recursion (sub-agent can't spawn sub-agents)
 *   - Return 1-2k token summary to main agent
 *   - Reuse same API key pool as main agent
 *
 * Activation:
 *   - READ_ONLY: effort high/max (shouldUseSubAgents)
 *   - POWERFUL: effort max only (shouldUsePowerfulSubAgents) - costs more
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { chat, isTransientNetworkErrorPublic, is429ErrorPublic, SUB_AGENT_MAX_CHAT_RETRIES } from "./apiClient.js";
import { getPoolSize } from "./apiKeyPool.js";
import { lerArquivo } from "./tools.js";
import { globSearch } from "./fileSearch.js";
import { grepSearch, formatGrepResults } from "./contentSearch.js";
import { parseFile } from "./lspAst.js";
import { shouldUseSubAgents, getEffortLevel } from "./effortLevels.js";
import { getSystemPrompt } from "./history.js";
import * as log from "./logger.js";
import { pushActivity } from "./activityTracker.js";
// FIX-SCOUT (BH9 HIGH 2): share resolveAndCheckPath/validateCwd with the
// scout agent so sub-agents have the same hard path-traversal boundary.
import { resolveAndCheckPath, validateCwd } from "./pathSecurity.js";

// FIX-SCOUT (BH9 HIGH 3): anti-recursion tracking via AsyncLocalStorage.
//
// Why ALS instead of process.env.CLAUDE_KILLER_AGENT_ID?
// process.env is process-global. If two sub-agents run in parallel (Promise.all
// of explorar_subagente calls), they share process.env. A naive guard at the
// top of runSubAgent that checks `if (process.env.CLAUDE_KILLER_AGENT_ID)`
// would BLOCK the second sibling (incorrectly), because the first sibling's
// runSubAgentInner has already set the env var to "sub-1". Parallel execution
// is a supported feature (§10.1 MAX_CONCURRENT_SUB_AGENTS).
//
// ALS gives each async execution chain its own store. Siblings don't share
// ALS contexts, so they're not blocked. A nested call (sub-agent calls
// runSubAgent directly) would inherit the parent's ALS context, so the guard
// correctly blocks it. The dispatcher-level guard in agent.ts
// (explorar_subagente handler) still uses process.env because it's checked
// synchronously at the top of the handler — before any runSubAgentInner has
// set the env var — so it doesn't have the parallel issue.
const subAgentAls = new AsyncLocalStorage<string | undefined>();

// --- Sub-agent ID counter (for tracking in rollback) ----------------------

let subAgentCounter = 0;

/** Generate a unique sub-agent ID like "sub-1", "sub-2", etc. */
function nextSubAgentId(): string {
  subAgentCounter++;
  return `sub-${subAgentCounter}`;
}

// --- System prompts --------------------------------------------------------

const SUB_AGENT_SYSTEM_PROMPT = `You are a focused code-exploration sub-agent for Claude-Killer.
Your job: answer the main agent's question by reading code, then return a CONCISE summary.

RULES:
- You have ONLY read tools: ler_arquivo, buscar_arquivos, buscar_texto, parse_ast.
- You CANNOT edit, write, or run commands. Just read and report.
- Do AT MOST 8 tool calls. If you can't answer in 8, give your best guess.
- Return a summary of 500-2000 tokens. Be specific: file paths, line numbers, key code snippets.
- Format your final answer as:

## Summary
[concise answer to the main agent's question]

## Files Inspected
- [path]: [what's relevant there]

## Key Findings
- [bullet points with file:line references]

If you can't find the answer, say so explicitly - don't invent.`;

/**
 * System prompt for POWERFUL sub-agents.
 *
 * Inherits the main agent's system prompt (with effort level, mode, skills,
 * project memory, etc) and prepends a "you are a sub-agent" context block
 * that explains the constraints (no recursion, return summary, etc).
 */
function buildPowerfulSubAgentPrompt(mainPrompt: string, subAgentId: string, question: string): string {
  return `## SUB-AGENT CONTEXT

You are a POWERFUL sub-agent (ID: ${subAgentId}) spawned by the main Claude-Killer agent.
You have the SAME tools, system prompt, and safety checks as the main agent.

CONSTRAINTS (different from main agent):
- You CANNOT spawn your own sub-agents (no recursion).
- You MUST return a summary of your work at the end (1-2k tokens max).
- Your file edits will acquire file locks - if another agent (main or sibling)
  is editing the same file, you will wait. Don't deadlock by holding locks.
- All safety checks (read-before-write, schema validation, safety reviewer,
  luau validator, impact analyzer) apply to YOUR writes too.
- Release any locks promptly - don't hold a lock across multiple tool calls
  unless you're actively editing that file.

YOUR TASK (from main agent):
${question}

When done, format your final answer as:

## Summary
[concise summary of what you did]

## Files Modified
- [path]: [what you changed and why]

## Key Findings
- [any relevant info for the main agent to know]

## Issues / Warnings
- [anything the main agent should watch out for]

If you can't complete the task, say so explicitly in the summary.

---

## INHERITED MAIN AGENT SYSTEM PROMPT (follow all rules below)

${mainPrompt}`;
}

// --- Read-only tools (fixed set) -------------------------------------------

const SUB_AGENT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "ler_arquivo",
      description: "Read a file's content. Returns the full text.",
      parameters: {
        type: "object",
        properties: { caminho: { type: "string", description: "File path to read." } },
        required: ["caminho"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "buscar_arquivos",
      description: "Find files by glob pattern (e.g. **/*.ts).",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string", description: "Glob pattern." } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "buscar_texto",
      description: "Grep for a regex pattern across files.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex to search for." },
          path: { type: "string", description: "Directory or file to search in." },
          include: { type: "string", description: "File pattern filter." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "parse_ast",
      description: "Parse a source file and extract symbols (functions, classes, imports).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File to parse." } },
        required: ["path"],
      },
    },
  },
  // Sub-agentes também pensam — pensar() sempre disponível
  {
    type: "function" as const,
    function: {
      name: "pensar",
      description: "Structured thinking. Call before exploring, before reporting findings. Think about what you're looking for and what you found.",
      parameters: {
        type: "object",
        properties: {
          pensamento: {
            type: "string",
            description: "Your thought: what am I looking for, what did I find, what's the pattern.",
          },
          categoria: {
            type: "string",
            description: "Category.",
            enum: ["planning", "pre_edit", "pre_research", "pre_response", "debugging", "architecture", "general"],
          },
        },
        required: ["pensamento"],
      },
    },
  },
];

// --- Args ------------------------------------------------------------------

interface SubAgentArgs {
  /** The task/question to answer */
  question: string;
  /** Starting directory for the search (defaults to cwd) */
  cwd?: string;
  /** Max tool calls before giving up (default 8 for read-only, 15 for powerful) */
  maxToolCalls?: number;
  /**
   * If true, the sub-agent inherits the main agent's system prompt + all tools
   * (write, edit, git, test, etc) and can perform real work in parallel.
   * Default: false (read-only mode).
   *
   * Powerful mode only activates at /effort max (see shouldUsePowerfulSubAgents).
   */
  powerful?: boolean;
}

// --- Main entry point ------------------------------------------------------

/**
 * Run a sub-agent to answer a question or complete a task.
 * Returns the sub-agent's final summary as a string.
 *
 * Returns null if sub-agents are disabled (effort too low) or if the
 * sub-agent failed to produce a useful answer.
 *
 * Modes:
 *   - powerful=false (default): read-only, 4 tools, 8 max calls
 *   - powerful=true: inherits main agent's tools + system prompt, 15 max calls
 */
export async function runSubAgent(args: SubAgentArgs): Promise<string | null> {
  // FIX-SCOUT (BH9 HIGH 3): anti-recursion guard (defense-in-depth).
  //
  // §10.7 mandates "scout não pode ser chamado de dentro de sub-agentes
  // (guard via CLAUDE_KILLER_AGENT_ID)." The same principle applies to
  // explorar_subagente — a powerful sub-agent that calls explorar_subagente
  // would acquire another sub-agent slot, overwrite CLAUDE_KILLER_AGENT_ID,
  // and spawn a child sub-agent. With MAX_CONCURRENT_SUB_AGENTS=2, just 2
  // levels of recursion exhaust the pool — the 3rd level waits forever for
  // a slot the parent will never release. DEADLOCK.
  //
  // The dispatcher-level guard in agent.ts (explorar_subagente handler)
  // catches the common case (sub-agent calls explorar_subagente via merged
  // tools). This function-level guard catches DIRECT calls to runSubAgent
  // from inside a sub-agent context (e.g., dynamicWorkflow, future callers).
  //
  // We use AsyncLocalStorage (not process.env) so parallel siblings aren't
  // blocked — see the subAgentAls comment above for the race-condition
  // rationale.
  const parentSubAgentId = subAgentAls.getStore();
  if (parentSubAgentId !== undefined) {
    log.warn(`[SUB_AGENT] Anti-recursion: blocked direct runSubAgent call from inside sub-agent ${parentSubAgentId}`);
    return null;
  }

  const powerful = args.powerful === true;

  // Check effort level requirements
  if (powerful) {
    if (!shouldUsePowerfulSubAgents()) {
      log.debug(`[SUB_AGENT] Skipped - powerful mode requires /effort max`);
      return null;
    }
  } else if (!shouldUseSubAgents()) {
    log.debug(`[SUB_AGENT] Skipped - effort level too low`);
    return null;
  }

  // FIX-SCOUT (BH9 HIGH 2): validate args.cwd against process.cwd() to
  // prevent a prompt-injected model from passing `cwd: "/etc"` and then
  // reading any file under /etc via relative paths. Same logic as the
  // scout's cwd validation (scoutAgent.ts:424-440).
  const cwdValidation = validateCwd(args.cwd, process.cwd());
  if (!cwdValidation.ok) {
    log.warn(`[SUB_AGENT] ${cwdValidation.error} — blocking`);
    return null;
  }
  const cwd = cwdValidation.cwd;

  const maxCalls = args.maxToolCalls ?? (powerful ? 15 : 8);
  const subAgentId = nextSubAgentId();
  const poolInfo = getPoolSize() > 0 ? ` (pool: ${getPoolSize()} keys)` : " (single key)";
  log.info(`[SUB_AGENT:${subAgentId}] Starting ${powerful ? "POWERFUL" : "READ-ONLY"}: "${args.question.slice(0, 80)}..." (cwd=${cwd}, maxCalls=${maxCalls}${poolInfo})`);

  // Surface sub-agent activity in the TUI so the user sees the agent is
  // delegating work to a sub-agent (not just "thinking forever").
  const shortQ = args.question.length > 60 ? args.question.slice(0, 59) + "…" : args.question;
  const subActivityDone = pushActivity("subagent", `#${subAgentId}: ${shortQ}`);

  try {
    // Wrap the inner call in subAgentAls.run(...) so any direct nested
    // call to runSubAgent (from inside the sub-agent context) is detected
    // by the anti-recursion guard at the top of this function.
    return await subAgentAls.run(subAgentId, () => runSubAgentInner(args, powerful, cwd, maxCalls, subAgentId));
  } finally {
    subActivityDone();
  }
}

/** Inner implementation of runSubAgent — separated so we can wrap it with activity tracking. */
async function runSubAgentInner(
  args: SubAgentArgs,
  powerful: boolean,
  cwd: string,
  maxCalls: number,
  subAgentId: string,
): Promise<string | null> {
  // Build initial history
  const systemPrompt = powerful
    ? buildPowerfulSubAgentPrompt(getSystemPrompt(), subAgentId, args.question)
    : SUB_AGENT_SYSTEM_PROMPT;

  const initialHistory: SubAgentMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Working directory: ${cwd}\n\nQuestion: ${args.question}` },
  ];

  let subHistory = [...initialHistory];
  let callNum = 0;
  let consecutiveFailures = 0;

  // Set agent ID env var for rollback tracking (fileLock.ts reads this)
  //
  // BUG (known limitation): process.env is process-global, NOT per-async-
  // task. If two sub-agents run in parallel (e.g. via dynamicWorkflow's
  // parallel() which uses Promise.all), they will overwrite each other's
  // CLAUDE_KILLER_AGENT_ID. Sub-agent A's file-lock acquisitions would be
  // attributed to sub-agent B, and the finally-block restore below would
  // clobber the still-running sibling's ID.
  //
  // The proper fix is AsyncLocalStorage (node:async_hooks) — store the
  // agent ID there and have fileLock.ts/rollbackStore.ts read from the
  // ALS instead of process.env. That requires coordinated changes across
  // three modules and is out of scope for this audit. Sequential
  // sub-agents (the common case) work correctly; only parallel powerful
  // sub-agents at /effort max are affected.
  const previousAgentId = process.env.CLAUDE_KILLER_AGENT_ID;
  process.env.CLAUDE_KILLER_AGENT_ID = subAgentId;

  try {
    // Lazy-import agent.ts to avoid circular dependency at module load time.
    // Only needed in powerful mode (read-only mode uses its own tool executor).
    const agentMod = powerful ? await import("./agent.js") : null;

    while (callNum < maxCalls) {
      const checkpoint = [...subHistory];
      try {
        // Choose tool set: powerful mode uses all main agent's tools
        const tools = powerful && agentMod ? agentMod.getMergedToolsPublic() : SUB_AGENT_TOOLS;
        const response = await chatWithRetry(subHistory, callNum, tools);
        const choice = response.choices[0];
        if (!choice) break;

        subHistory.push(choice.message as SubAgentMessage);
        consecutiveFailures = 0;

        const finalSummary = tryExtractFinalSummary(choice, callNum);
        if (finalSummary.done) return finalSummary.summary;

        for (const tc of choice.message.tool_calls ?? []) {
          let result: string;
          if (powerful && agentMod) {
            // Use main agent's dispatcher (with all safety hooks, file locks, etc)
            const toolResult = await agentMod.dispatchToolCallPublic(tc);
            result = toolResult.resultStr;
          } else {
            // Use read-only sub-agent tool executor.
            // BUG FIX: previously JSON.parse(tc.function.arguments) was
            // called inline, OUTSIDE executeSubAgentTool's own try/catch.
            // If the model emitted malformed JSON arguments (rare but it
            // happens — truncated streaming, model errors), the parse
            // threw synchronously, aborted the entire tool-call loop, and
            // propagated to the outer catch — which would retry the whole
            // chat() call, get the same malformed args again, and burn
            // all retries before giving up. Parse here with a local
            // try/catch so one bad tool call becomes an error string the
            // model can recover from, instead of killing the sub-agent.
            let parsedArgs: unknown;
            try {
              parsedArgs = JSON.parse(tc.function.arguments);
            } catch (parseErr) {
              result = `[ERROR] Invalid JSON arguments for ${tc.function.name}: ${(parseErr as Error).message}`;
              subHistory.push({ role: "tool", tool_call_id: tc.id, content: result });
              continue;
            }
            result = await executeSubAgentTool(tc.function.name, parsedArgs, cwd);
          }
          subHistory.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
        callNum++;
      } catch (err) {
        const retryDecision = handleSubAgentError(err, callNum, consecutiveFailures);
        if (retryDecision.shouldRetry) {
          subHistory = [...checkpoint];
          consecutiveFailures = retryDecision.newConsecutiveFailures;
          await new Promise((r) => setTimeout(r, retryDecision.waitMs));
          continue;
        }
        log.error(`[SUB_AGENT:${subAgentId}] Giving up at call ${callNum + 1} after ${consecutiveFailures + 1} failures: ${(err as Error).message}`);
        return null;
      }
    }

    log.warn(`[SUB_AGENT:${subAgentId}] Hit maxToolCalls (${maxCalls}) without finishing`);
    return null;
  } finally {
    // Restore previous agent ID (or clear if there was none)
    if (previousAgentId !== undefined) {
      process.env.CLAUDE_KILLER_AGENT_ID = previousAgentId;
    } else {
      delete process.env.CLAUDE_KILLER_AGENT_ID;
    }
  }
}

type SubAgentMessage = { role: string; content: string; tool_call_id?: string; tool_calls?: any[] };

/**
 * If the choice represents the final answer (no more tool_calls), extract it.
 * Returns { done: true, summary } on success, { done: true, summary: null } on empty/invalid,
 * { done: false, summary: null } if there are still tool_calls to execute.
 */
function tryExtractFinalSummary(choice: any, callNum: number): { done: boolean; summary: string | null } {
  if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
    return { done: false, summary: null };
  }
  const summary = choice.message.content ?? "";
  if (!summary || summary.trim().length < 10) {
    log.warn(`[SUB_AGENT] Model returned empty/too-short summary`);
    return { done: true, summary: null };
  }
  log.debug(`[SUB_AGENT] Done in ${callNum + 1} calls (${summary.length} chars)`);
  return { done: true, summary };
}

async function executeSubAgentTool(name: string, args: any, cwd: string): Promise<string> {
  try {
    switch (name) {
      case "ler_arquivo": {
        // FIX-SCOUT (BH9 HIGH 2): use resolveAndCheckPath to block path
        // traversal (../../../etc/passwd, absolute paths outside cwd,
        // symlinks escaping cwd). Previously the sub-agent used
        // `args.caminho?.startsWith("/") ? args.caminho : \`${cwd}/${args.caminho}\``
        // which allowed BOTH absolute paths anywhere on the filesystem
        // AND `../` escape. A prompt-injected sub-agent could read
        // /etc/passwd or ~/.ssh/id_rsa. Now it shares the same hard
        // boundary as the scout (§10.7).
        const rawPath = String(args.caminho ?? args.path ?? "");
        if (!rawPath) return "[ERROR] No path provided";
        const resolved = resolveAndCheckPath(rawPath, cwd);
        return await lerArquivo({ caminho: resolved });
      }
      case "buscar_arquivos": {
        const results = globSearch({ pattern: args.pattern ?? "**/*", cwd });
        return results.length > 0 ? results.join("\n") : "No files found.";
      }
      case "buscar_texto": {
        // FIX-SCOUT (BH9 HIGH 2): same resolveAndCheckPath boundary as
        // ler_arquivo. buscar_texto's `path` arg (formerly resolved via
        // resolveSearchPath) could previously be any absolute path.
        const rawPath = String(args.path ?? args.caminho ?? cwd);
        const searchPath = resolveAndCheckPath(rawPath, cwd);
        const matches = grepSearch({
          pattern: args.pattern,
          path: searchPath,
          include: args.include,
        });
        return formatGrepResults(matches);
      }
      case "parse_ast": {
        // FIX-SCOUT (BH9 HIGH 2): same resolveAndCheckPath boundary.
        const rawPath = String(args.path ?? args.caminho ?? "");
        if (!rawPath) return "[ERROR] No path provided";
        const resolved = resolveAndCheckPath(rawPath, cwd);
        const result = await parseFile(resolved);
        return [
          `Language: ${result.language}`,
          `Lines: ${result.lineCount}`,
          `Symbols: ${result.symbols.length}`,
          ...result.symbols.map((s: any) => `  ${s.type} ${s.name} (line ${s.line})`),
        ].join("\n");
      }
      case "pensar": {
        // Sub-agente pensa também — retorna confirmação simples
        const cat = args.categoria ?? args.category ?? "general";
        return `[THINK] ✓ Pensamento registrado (${cat}). Continue sua análise.`;
      }
      default:
        return `[ERROR] Unknown tool: ${name}`;
    }
  } catch (err) {
    return `[ERROR] ${name} failed: ${(err as Error).message}`;
  }
}

/** Decide whether to retry after an error, and how long to wait. */
function handleSubAgentError(err: unknown, callNum: number, consecutiveFailures: number): {
  shouldRetry: boolean;
  newConsecutiveFailures: number;
  waitMs: number;
} {
  const newConsecutive = consecutiveFailures + 1;
  const isTransient = isTransientNetworkErrorPublic(err) || is429ErrorPublic(err);
  log.warn(`[SUB_AGENT] Call ${callNum + 1} failed (attempt ${newConsecutive}/${SUB_AGENT_MAX_CHAT_RETRIES + 1}): ${(err as Error).message}`);

  if (!isTransient || newConsecutive > SUB_AGENT_MAX_CHAT_RETRIES) {
    return { shouldRetry: false, newConsecutiveFailures: newConsecutive, waitMs: 0 };
  }

  const waitMs = 1000 * (2 ** (newConsecutive - 1));
  log.warn(`[SUB_AGENT] Restoring checkpoint and retrying in ${waitMs}ms (call ${callNum + 1})`);
  return { shouldRetry: true, newConsecutiveFailures: newConsecutive, waitMs };
}

/**
 * Wrapper around chat() that re-throws transient errors for the outer loop to handle.
 * The inner chat() already retries ECONNRESET (8x) and 429 (4x) - this just classifies
 * the error for the outer retry loop.
 *
 * Now accepts an optional tools parameter - in powerful mode, sub-agents pass the
 * full main agent tool list (so they can call write/edit/git tools too).
 */
async function chatWithRetry(subHistory: any[], callNum: number, tools?: any) {
  try {
    return await chat(subHistory, undefined, undefined, undefined, tools);
  } catch (err) {
    if (!isTransientNetworkErrorPublic(err) && !is429ErrorPublic(err)) {
      throw err; // non-transient - let caller give up immediately
    }
    log.warn(`[SUB_AGENT] chat() exhausted inner retries at call ${callNum + 1}: ${(err as Error).message}`);
    throw err;
  }
}

/**
 * Decide whether a user message looks like it would benefit from sub-agent exploration.
 * Heuristic: mentions multiple files, "understand how X works", "find all places that Y", etc.
 */
export function shouldDelegateToSubAgent(userMessage: string): boolean {
  if (!shouldUseSubAgents()) return false;
  const lower = userMessage.toLowerCase();
  const triggers = [
    "understand how",
    "entenda como",
    "find all",
    "encontre todos",
    "where is",
    "onde está",
    "trace through",
    "map the",
    "what does the",
    "how does",
    "explore",
    "investigate",
  ];
  return triggers.some((t) => lower.includes(t));
}

// FIX-SCOUT (BH9 HIGH 2): resolveSearchPath was removed — it allowed absolute
// paths anywhere on the filesystem AND `../` escape. buscar_texto now uses
// resolveAndCheckPath from pathSecurity.ts (same boundary as ler_arquivo and
// parse_ast). See executeSubAgentTool's buscar_texto case.

/**
 * Whether powerful sub-agents should be used.
 * Only at /effort max - powerful sub-agents cost more (more tool calls,
 * safety reviewer on each write, etc) but enable true parallel task execution.
 */
export function shouldUsePowerfulSubAgents(): boolean {
  return getEffortLevel() === "max";
}
