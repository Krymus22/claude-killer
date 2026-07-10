/**
 * plannerAgent.ts — Heavy model agent for planning.
 *
 * Called by the orchestrator via chamar_planejador. Uses GLM 5.2 with a
 * planning-specific system prompt to produce high-quality structured plans.
 *
 * Tools: pensar, buscar_web, ler_url, usar_scout, pesquisar_api
 * (NO edit tools — planner only PLANS, doesn't code)
 *
 * The plan is returned to the orchestrator RAW (never compacted).
 *
 * FEATURE TOGGLE: implicit — only invoked when ORCHESTRATOR_MODE=1 (the
 * orchestrator gates its own entry; the planner is reachable only via
 * chamar_planejador).
 * MODEL: HEAVY_MODEL env var (default: z-ai/glm-5.2).
 *
 * ANTI-RECURSION: CLAUDE_KILLER_AGENT_ID = "planner". The planner is a
 * heavy model and is ALLOWED to call usar_scout (the scout's anti-recursion
 * guard only blocks "scout" / "sub-agent" / "small-task-agent"). The
 * planner sets its own ID, so the scout's check (in agent.ts) lets it
 * through. We also clear the env var temporarily before calling runScout
 * as defense-in-depth — in case any future code path checks for ANY
 * non-empty CLAUDE_KILLER_AGENT_ID.
 */

import type OpenAI from "openai";
import { chatWithModel, clearModelOverride } from "./apiClient.js";
import type { Message } from "./apiClient.js";
import * as log from "./logger.js";
import { pushActivity } from "./activityTracker.js";
import { think, THINK_TOOL_DEFINITION } from "./thinkTool.js";
import { isScoutEnabled, runScout, formatScoutResult, type ScoutArgs, type ScoutTask } from "./scoutAgent.js";
import { resolveAndCheckPath } from "./pathSecurity.js";
import { executarComando } from "./tools.js";

// --- Config -----------------------------------------------------------------

/** Heavy model ID (default: z-ai/glm-5.2). Mirrors orchestratorAgent. */
function getHeavyModel(): string {
  return process.env.HEAVY_MODEL ?? "z-ai/glm-5.2";
}

/** Max planner iterations (tool-call rounds). Prevents runaway loops. */
const PLANNER_MAX_ITERATIONS = parseInt(process.env.PLANNER_MAX_ITERATIONS ?? "20", 10);

/** Per-iteration global timeout (ms). Default 5 min — heavy model is slow. */
const PLANNER_TIMEOUT_MS = parseInt(process.env.PLANNER_TIMEOUT_MS ?? "300000", 10);

// --- Anti-recursion ---------------------------------------------------------

const PLANNER_AGENT_ID = "planner";

// --- System prompt ----------------------------------------------------------

const PLANNER_SYSTEM_PROMPT = `Você é um ARQUITETO SÊNIOR especializado em planejamento de software.

Sua tarefa é criar um PLANO ESTRUTURADO para a tarefa do usuário.

REGRAS:
1. Use as tools (pensar, buscar_web, ler_url, usar_scout, pesquisar_api) para coletar contexto.
2. Crie um plano com passos numbered, claros e específicos.
3. Considere edge cases, dependências e riscos.
4. O plano deve ser executável por outro agente — seja específico sobre arquivos, funções, e mudanças.
5. NÃO escreva código — apenas planeje.
6. NÃO edite arquivos — apenas leia e analise.
7. Use pesquisar_api para verificar a assinatura atual de APIs (ex: TweenService:Create, React.useState) antes de planejar usá-las — útil para APIs que mudam frequentemente.

FORMATO DO PLANO:
[PLAN - N steps]
1. <passo específico com arquivo e mudança>
2. <passo específico>
...
N. <passo final>

Seja ESPECÍFICO: cite nomes de arquivos, funções, e mudanças exatas.`;

// --- Tool definitions -------------------------------------------------------

/**
 * Planner tools: pensar (structured thinking), buscar_web, ler_url, usar_scout.
 *
 * NO edit tools — the planner only PLANS. It can read/search (via scout) and
 * think, but never writes code. This enforces the orchestrator architecture's
 * separation of concerns: planner plans, coder codes.
 */
const PLANNER_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  THINK_TOOL_DEFINITION,
  {
    type: "function",
    function: {
      name: "buscar_web",
      description: "Busca na web por informações. Retorna títulos, URLs e snippets. Útil para pesquisar documentação, exemplos de código, ou informações atuais.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Termo de busca" },
          maxResults: { type: "number", description: "Máximo de resultados (default: 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ler_url",
      description: "Lê o conteúdo de uma URL. Extrai texto de páginas web (remove HTML). Útil para ler documentação ou artigos.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL para ler" },
          maxLength: { type: "number", description: "Tamanho máximo do conteúdo (default: 10000 chars)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "usar_scout",
      description:
        "Delega leituras e buscas de código para um modelo ultra-rápido. " +
        "Use para ler arquivos, buscar padrões, ou explorar a estrutura do projeto. " +
        "O scout retorna o conteúdo RAW dos arquivos (não resumido).",
      parameters: {
        type: "object",
        properties: {
          objetivo: {
            type: "string",
            description: "O que você precisa ler/buscar e por quê.",
          },
          tarefas: {
            type: "array",
            description: "Lista de tarefas de leitura/busca.",
            items: {
              type: "object",
              properties: {
                tipo: {
                  type: "string",
                  description: "Tipo de tarefa.",
                  enum: ["read_file", "search_files", "search_text", "explore"],
                },
                descricao: {
                  type: "string",
                  description: "Descrição específica da tarefa (ex: 'ler src/foo.ts', 'buscar todas as chamadas a bar()').",
                },
              },
              required: ["descricao"],
            },
          },
          max_tool_calls: {
            type: "number",
            description: "Max tool calls (default 50, max 100).",
          },
        },
        required: ["objetivo", "tarefas"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "pesquisar_api",
      description: "Pesquisa a documentação de uma API específica (ex: TweenService:Create, React.useState, DataStoreService). Retorna assinatura, exemplos, e melhores práticas. Útil para planejar como usar uma API que você não conhece bem.",
      parameters: {
        type: "object",
        properties: {
          apiName: { type: "string", description: "Nome da API (ex: 'TweenService:Create', 'FindFirstChild', 'React.useState')" },
          language: { type: "string", description: "Linguagem/plataforma (ex: 'roblox', 'typescript', 'python')" },
          context: { type: "string", description: "Contexto: o que você está tentando fazer (opcional)" },
        },
        required: ["apiName", "language"],
      },
    },
  },
];

// --- Helpers ----------------------------------------------------------------

/**
 * Safely convert an unknown value to string. Returns fallback for non-string
 * primitives and objects (avoids `[object Object]`). Mirrors agent.ts
 * `asString` (which isn't exported).
 */
function asString(val: unknown, fallback = ""): string {
  if (typeof val === "string") return val;
  if (val == null) return fallback;
  if (typeof val === "number" || typeof val === "boolean" || typeof val === "symbol") return String(val);
  return fallback;
}

// --- Tool execution --------------------------------------------------------

/**
 * Execute a planner tool call. Returns the result string + success flag.
 *
 * The planner's tools are read-only + pensar + scout. It CANNOT edit files.
 * Anti-recursion: when calling usar_scout, temporarily clear the agent ID so
 * any downstream check that blocks on ANY non-empty CLAUDE_KILLER_AGENT_ID
 * doesn't trip (defense-in-depth — the scout itself only blocks
 * "scout"/"sub-agent"/"small-task-agent").
 */
async function executePlannerTool(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  callbacks?: PlannerCallbacks,
): Promise<{ result: string; ok: boolean }> {
  try {
    switch (toolName) {
      case "pensar": {
        const pensamento = typeof args.pensamento === "string" ? args.pensamento : "";
        if (!pensamento) return { result: "[ERROR] pensamento vazio", ok: false };
        const result = await think({
          pensamento,
          categoria: typeof args.categoria === "string" ? args.categoria : undefined,
        });
        return { result: result.message, ok: true };
      }
      case "buscar_web": {
        const query = asString(args.query);
        if (!query) return { result: "[ERROR] query vazia", ok: false };
        const maxResults = typeof args.maxResults === "number" ? args.maxResults : 5;
        const { webSearch } = await import("./apiResearcher.js");
        const results = await webSearch(query, maxResults);
        if (results.length === 0) return { result: "Nenhum resultado encontrado.", ok: true };
        const formatted = results.map((r: { url: string; title: string; snippet: string }, i: number) =>
          `${i + 1}. ${r.title ?? "Sem título"}\n   URL: ${r.url}\n   ${r.snippet ?? ""}`,
        ).join("\n\n");
        return { result: formatted, ok: true };
      }
      case "ler_url": {
        const url = asString(args.url);
        if (!url) return { result: "[ERROR] url vazia", ok: false };
        const maxLength = typeof args.maxLength === "number" ? args.maxLength : 10000;
        const { webRead } = await import("./apiResearcher.js");
        const content = await webRead(url);
        const truncated = content.length > maxLength
          ? content.slice(0, maxLength) + "\n[TRUNCATED]"
          : content;
        return { result: truncated || "[ERROR] Conteúdo vazio", ok: !!content };
      }
      case "usar_scout": {
        // Feature gate
        if (!isScoutEnabled()) {
          return {
            result: "[ERROR] Scout desabilitado. Set SCOUT_ENABLED=1. Use ler arquivos via outra estratégia.",
            ok: false,
          };
        }
        const objective = asString(args.objetivo ?? args.objective);
        if (!objective) {
          return { result: "[ERROR] 'objetivo' é obrigatório.", ok: false };
        }
        const rawTasks = args.tarefas ?? args.tasks;
        if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
          return { result: "[ERROR] 'tarefas' deve ser um array não-vazio.", ok: false };
        }
        const tasks: ScoutTask[] = rawTasks.map((t: any) => ({
          type: (t.tipo ?? t.type ?? "explore") as ScoutTask["type"],
          description: String(t.descricao ?? t.description ?? ""),
        })).filter((t: ScoutTask) => t.description);
        if (tasks.length === 0) {
          return { result: "[ERROR] Nenhuma tarefa válida.", ok: false };
        }
        const maxCalls = typeof args.max_tool_calls === "number" ? args.max_tool_calls : undefined;
        const scoutArgs: ScoutArgs = {
          objective,
          tasks,
          cwd,
          maxToolCalls: maxCalls,
          onToolCall: callbacks?.onToolCall,
          onToolResult: callbacks?.onToolResult,
        };
        // Defense-in-depth: clear agent ID while scout runs so any check that
        // blocks on ANY non-empty ID doesn't trip. Restored in finally.
        const savedAgentId = process.env.CLAUDE_KILLER_AGENT_ID;
        delete process.env.CLAUDE_KILLER_AGENT_ID;
        try {
          const scoutResult = await runScout(scoutArgs);
          if (scoutResult === null) {
            return { result: "[SCOUT] Desabilitado ou falhou ao iniciar.", ok: false };
          }
          if (!scoutResult.completed) {
            return {
              result: `[SCOUT FAILED] ${scoutResult.error ?? "unknown"}`,
              ok: false,
            };
          }
          return { result: formatScoutResult(scoutResult), ok: true };
        } finally {
          if (savedAgentId !== undefined) {
            process.env.CLAUDE_KILLER_AGENT_ID = savedAgentId;
          }
        }
      }
      case "pesquisar_api": {
        const apiName = String(args.apiName ?? "");
        const language = String(args.language ?? "");
        if (!apiName || !language) {
          return { result: "[ERROR] apiName and language are required", ok: false };
        }
        const { researchApi } = await import("./apiResearcher.js");
        const result = await researchApi({
          apiName,
          language,
          context: typeof args.context === "string" ? args.context : undefined,
        });
        if ("error" in result) {
          return {
            result: `[ERROR] API research failed: ${result.error}`,
            ok: false,
          };
        }
        const examples = result.examples ?? [];
        return {
          result:
            `API: ${result.apiName} (${result.language})\n` +
            `Signature: ${result.signature}\n` +
            `Summary: ${result.summary}\n\n` +
            `Examples:\n${examples.join("\n")}`,
          ok: true,
        };
      }
      default:
        return { result: `[ERROR] Tool desconhecida: ${toolName}`, ok: false };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: `[ERROR] ${msg}`, ok: false };
  }
}

// --- Public API ------------------------------------------------------------

export interface PlannerCallbacks {
  /** Called before each tool call (for TUI display). */
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  /** Called after each tool call completes. */
  onToolResult?: (toolName: string, ok: boolean, resultStr: string) => void;
}

export interface PlannerResult {
  /** The structured plan (raw text). Never compacted — passed to coder as-is. */
  plan: string;
  /** Whether the planner completed successfully. */
  success: boolean;
  /** Error message if success=false. */
  error?: string;
  /** Time taken in ms. */
  elapsedMs: number;
  /** Number of tool calls made. */
  toolCallsMade: number;
}

/**
 * Run the planner agent to produce a structured plan for a task.
 *
 * The planner uses the HEAVY_MODEL (GLM 5.2) with read-only tools + pensar +
 * scout. It returns the plan as raw text — the orchestrator stores it
 * separately and never compacts it (it's passed verbatim to the coder via
 * chamar_programador).
 *
 * @param task       The task description (what the user wants done).
 * @param callbacks  Optional TUI callbacks.
 * @returns          The plan + status.
 */
export async function runPlanner(
  task: string,
  callbacks?: PlannerCallbacks,
): Promise<PlannerResult> {
  const start = Date.now();
  const heavyModel = getHeavyModel();

  if (typeof task !== "string" || task.length === 0) {
    return {
      plan: "",
      success: false,
      error: "Invalid task (must be non-empty string)",
      elapsedMs: 0,
      toolCallsMade: 0,
    };
  }

  // Anti-recursion guard: planner can't be called from inside another planner
  // (would deadlock via shared modelOverride state).
  if (process.env.CLAUDE_KILLER_AGENT_ID === PLANNER_AGENT_ID) {
    return {
      plan: "",
      success: false,
      error: "Planner não pode ser chamado de dentro de outro planner (recursão)",
      elapsedMs: 0,
      toolCallsMade: 0,
    };
  }

  const cwd = process.cwd();
  const shortTask = task.length > 60 ? task.slice(0, 59) + "…" : task;
  const activityDone = pushActivity("subagent", `planner: ${shortTask}`);

  // Set anti-recursion env var (preserve previous to restore in finally).
  const prevAgentId = process.env.CLAUDE_KILLER_AGENT_ID;
  process.env.CLAUDE_KILLER_AGENT_ID = PLANNER_AGENT_ID;

  let toolCallsMade = 0;

  try {
    const messages: Message[] = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Working directory: ${cwd}\n\n` +
          `Tarefa: ${task}\n\n` +
          `Use as tools para coletar contexto (usar_scout para ler arquivos, buscar_web para pesquisar). ` +
          `Quando tiver contexto suficiente, produza o PLANO no formato especificado.`,
      },
    ];

    const deadline = start + PLANNER_TIMEOUT_MS;

    for (let iter = 0; iter < PLANNER_MAX_ITERATIONS; iter++) {
      if (Date.now() > deadline) {
        throw new Error(`Planner timeout após ${PLANNER_TIMEOUT_MS}ms`);
      }

      log.debug(`[PLANNER] Iteração ${iter + 1}/${PLANNER_MAX_ITERATIONS}, model=${heavyModel}`);

      const response = await chatWithModel(
        messages,
        PLANNER_TOOLS,
        heavyModel,
        false, // thinking ENABLED — planner needs reasoning
      );

      const choice = response.choices?.[0];
      if (!choice) {
        throw new Error("Resposta vazia do modelo");
      }

      const msg = choice.message;

      // Add assistant message to local history (preserve tool_calls + content).
      // Some APIs reject empty assistant content — use a placeholder if empty.
      messages.push({
        role: "assistant",
        content: msg.content || "(executando tools)",
        ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
      });

      // If tool calls, execute them and continue the loop.
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          toolCallsMade++;
          const toolName = tc.function?.name ?? "unknown";
          const tcId = tc.id ?? `planner-tc-${iter}-${toolCallsMade}-${Date.now()}`;

          // Parse args (handle malformed JSON gracefully — mirrors scout pattern).
          let parsedArgs: Record<string, unknown> = {};
          try {
            const argStr = tc.function?.arguments?.trim() || "{}";
            try {
              parsedArgs = JSON.parse(argStr);
            } catch {
              const firstBrace = argStr.indexOf("{");
              const lastBrace = argStr.lastIndexOf("}");
              if (firstBrace >= 0 && lastBrace > firstBrace) {
                parsedArgs = JSON.parse(argStr.slice(firstBrace, lastBrace + 1));
              } else {
                throw new Error("No valid JSON object found");
              }
            }
          } catch (parseErr) {
            const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            log.warn(`[PLANNER] Malformed JSON args for ${toolName}: ${parseMsg}`);
            const errResult = `[ERROR] Malformed JSON arguments: ${parseMsg}`;
            messages.push({ role: "tool", tool_call_id: tcId, content: errResult });
            callbacks?.onToolResult?.(toolName, false, errResult);
            continue;
          }

          log.info(`[PLANNER] Tool: ${toolName}(${JSON.stringify(parsedArgs).slice(0, 80)})`);
          callbacks?.onToolCall?.(toolName, parsedArgs);

          const { result, ok } = await executePlannerTool(toolName, parsedArgs, cwd, callbacks);

          // Truncate very large results to prevent context overflow.
          // (Planner is a heavy model with a large context window, but
          // unbounded file reads can still OOM it.)
          const forModel = result.length > 32_000
            ? result.slice(0, 16_000) + "\n[TRUNCATED]\n" + result.slice(-16_000)
            : result;
          const forTui = result.length > 4000
            ? result.slice(0, 2000) + "\n[TRUNCATED]\n" + result.slice(-2000)
            : result;

          callbacks?.onToolResult?.(toolName, ok, forTui);

          messages.push({
            role: "tool",
            tool_call_id: tcId,
            content: forModel,
          });
        }
        continue; // recurse — model will process tool results
      }

      // No tool calls — this is the final plan.
      const plan = (msg.content ?? "").trim();
      if (!plan) {
        throw new Error("Planner não retornou um plano");
      }

      const result: PlannerResult = {
        plan,
        success: true,
        elapsedMs: Date.now() - start,
        toolCallsMade,
      };
      log.info(`[PLANNER] Concluído: ${toolCallsMade} tool calls, ${plan.length} chars`);
      return result;
    }

    // Max iterations reached
    throw new Error(`Planner excedeu ${PLANNER_MAX_ITERATIONS} iterações`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[PLANNER] Falhou: ${msg}`);
    return {
      plan: "",
      success: false,
      error: msg,
      elapsedMs: Date.now() - start,
      toolCallsMade,
    };
  } finally {
    // Restore previous agent ID. If it was undefined, DELETE the env var
    // (setting process.env.X = undefined sets the STRING "undefined", which
    // is truthy and would trip the anti-recursion guard on the next call).
    if (prevAgentId === undefined) {
      delete process.env.CLAUDE_KILLER_AGENT_ID;
    } else {
      process.env.CLAUDE_KILLER_AGENT_ID = prevAgentId;
    }

    // Safety net: clear model override in case chatWithModel's own finally
    // didn't run (e.g., timeout raced the call — mirrors smallTaskAgent).
    clearModelOverride();

    activityDone();
  }
}

/**
 * Reset planner state (for tests).
 * Currently no module-level mutable state — placeholder for future use.
 */
export function _resetPlannerForTests(): void {
  // No-op — no module-level state to reset.
}

// Suppress unused-import warnings for utilities imported for type-safety /
// future use (resolveAndCheckPath, executarComando) — they're available to
// the planner's tool executor if needed in the future without re-importing.
void resolveAndCheckPath;
void executarComando;
