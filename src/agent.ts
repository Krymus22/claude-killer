/**
 * agent.ts — The core agentic query loop.
 *
 * Orchestrates the full ReAct-style cycle:
 *   User message → API call → tool execution (if needed) → repeat → final reply
 *
 * Also handles the auto-heal sub-loop for escrever_arquivo:
 *   guardrail fail → inject error → retry API → up to MAX_HEAL_RETRIES times
 *
 * Architecture:
 *   runAgentLoop(userInput)
 *     └── sendAndProcess()               ← recursive until no more tool calls
 *           ├── chat(history)            ← throttled API call
 *           ├── dispatchToolCall()       ← routes to all tools via handler table
 *           │     └── [escrever] healLoop() ← up to 3 retries on guardrail fail
 *           └── recurse until finish_reason === "stop"
 */

import OpenAI from "openai";
import { chat, TOOL_DEFINITIONS } from "./apiClient.js";
import * as history from "./history.js";
import { lerArquivo, aplicarDiff, executarComando } from "./tools.js";
import { executePreToolCallHooks, executePostToolCallHooks } from "./hooks.js";
import { getMCPToolDefinitions, callMCPTool } from "./extensions.js";
import * as log from "./logger.js";
import { config } from "./config.js";
import { readFileAdvanced } from "./fileRead.js";
import { editFile, type EditOperation } from "./fileEdit.js";
import { globSearch } from "./fileSearch.js";
import { grepSearch, formatGrepResults } from "./contentSearch.js";
import { gitStatus, gitDiff, gitLog, gitCommit, gitBlame, gitShow, gitBranch, gitCheckout } from "./gitTool.js";
import { multiFileEdit, type FileEditRequest } from "./multiFileEdit.js";
import { saveSession, loadSession, listSessions } from "./session.js";
import { parseFile } from "./lspAst.js";
import { withRetry, isRetryableError } from "./retry.js";
import { readOnlyCache, shouldCacheResult } from "./toolCache.js";
import { executeParallelTools, type ParallelToolCall } from "./parallelTools.js";
import { startSession, endSession, recordToolCall, recordMessage } from "./telemetry.js";
import { smartCompact } from "./contextCompaction.js";
import {
  getMemoryConfig,
  ensureMemoryDirs,
  injectMemory,
  formatInjectedMemory,
  createCheckpoint,
  saveSessionTrace,
  shouldWriteCheckpoint,
  type FileChange,
  type SessionTrace,
} from "./memory.js";
import { runTests, formatTestResult, suggestFixes, formatFixSuggestions } from "./testRunner.js";
import {
  getRegistry,
  getDetector,
  getExecutor,
  getSuggester,
  initializeTools,
  type Tool,
} from "./externalTools.js";
import { executeTrigger, type TriggerContext } from "./extensionCenter.js";

type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
type ToolResult = { resultStr: string; usedHeal: boolean };

// ─── Memory State ─────────────────────────────────────────────────────────────

const memoryConfig = getMemoryConfig();
ensureMemoryDirs(memoryConfig);

let sessionFileChanges: FileChange[] = [];
let sessionToolsUsed: string[] = [];
let sessionStartTime = "";
let lastCheckpointTokens = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function asString(val: unknown, fallback = ""): string {
  if (typeof val === "string") return val;
  if (val == null) return fallback;
  if (typeof val === "number" || typeof val === "boolean" || typeof val === "symbol") return String(val);
  if (typeof val === "object") return JSON.stringify(val);
  return fallback;
}

function getMergedTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const mcpTools = getMCPToolDefinitions();
  const externalTools = getExternalToolDefinitions();
  
  const allTools = [...TOOL_DEFINITIONS, ...externalTools];
  
  if (mcpTools.length > 0) {
    allTools.push(...mcpTools);
  }
  
  return allTools;
}

function getExternalToolDefinitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return [
    {
      type: "function",
      function: {
        name: "executar_tool",
        description: "Execute an external tool (Rojo, Wally, pytest, cargo, npm, etc). Use this to run external CLI tools for building, testing, linting, or any other development task.",
        parameters: {
          type: "object",
          properties: {
            tool: { type: "string", description: "Tool name (e.g., 'rojo_build', 'pytest_run', 'cargo_test')" },
            args: { type: "object", description: "Tool arguments" },
            dir: { type: "string", description: "Working directory" }
          },
          required: ["tool"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "listar_tools",
        description: "List all available external tools, optionally filtered by category",
        parameters: {
          type: "object",
          properties: {
            category: { type: "string", description: "Filter by category: roblox, python, node, rust, go, docker" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "adicionar_tool",
        description: "Add a new external tool to the system. Use this to extend Claude-Killer with new CLI tools.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Tool name" },
            description: { type: "string", description: "Tool description" },
            command: { type: "string", description: "CLI command to execute" },
            args: { type: "array", items: { type: "string" }, description: "Default arguments" },
            flags: { type: "array", items: { type: "object" }, description: "Tool flags" },
            check_command: { type: "string", description: "Command to check if tool is installed" },
            when_to_use: { type: "array", items: { type: "string" }, description: "Intent patterns" },
            examples: { type: "array", items: { type: "string" }, description: "Example commands" }
          },
          required: ["name", "description", "command"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "sugerir_tool",
        description: "Suggest which tool to use based on a message or intent",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "Message or intent to analyze" }
          },
          required: ["message"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "detectar_tools",
        description: "Detect which tools are available based on intent and project context",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "User message to analyze" },
            dir: { type: "string", description: "Project directory" }
          }
        }
      }
    }
  ];
}

function alreadyInHistory(toolCallId: string): boolean {
  const lastMsg = history.getHistory().at(-1) as { role?: string; tool_call_id?: string } | undefined;
  return lastMsg?.role === "tool" && lastMsg?.tool_call_id === toolCallId;
}

// ─── Tool Handlers ────────────────────────────────────────────────────────────

type ToolHandler = (
  args: Record<string, unknown>,
  toolCall: ToolCall,
  healRetry: number,
) => Promise<ToolResult>;

const toolHandlers: Record<string, ToolHandler> = {
  "ler_arquivo": async (args) => {
    const result = await lerArquivo({ caminho: asString(args.caminho) });
    return { resultStr: result, usedHeal: false };
  },

  "executar_comando": async (args) => {
    const result = await executarComando({ comando: asString(args.comando) });
    return { resultStr: result, usedHeal: false };
  },

  "aplicar_diff": async (args, toolCall, healRetry) => {
    const result = await aplicarDiff({
      caminho: asString(args.caminho),
      bloco_diff: asString(args.bloco_diff),
    });

    if (!result.written && healRetry < config.maxHealRetries) {
      log.warn(
        `Falha ao aplicar diff ou guardrail rejeitou o código. Auto-cura iniciada ` +
          `(tentativa ${healRetry + 1}/${config.maxHealRetries})…`
      );
      history.addToolResult(toolCall.id, result.toolMessage);
      history.optimizeContext();
      const allTools = getMergedTools();
      const apiResponse = await chat(history.getHistory(), undefined, undefined, undefined, allTools);
      const choice = apiResponse.choices[0];
      if (!choice) throw new Error("Empty response from API during auto-heal");
      history.addRawAssistantMessage(choice.message);

      if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
        const nextCall = choice.message.tool_calls[0];
        if (nextCall?.function.name === "aplicar_diff") {
          return dispatchToolCall(nextCall, healRetry + 1);
        }
        const sub = await dispatchToolCall(nextCall, 0);
        return { ...sub, usedHeal: true };
      }

      const finalText = choice.message.content ?? "(sem resposta)";
      log.warn("Claude-Killer encerrou o loop de auto-cura sem reescrever o arquivo.");
      return { resultStr: finalText, usedHeal: true };
    }

    if (!result.written && healRetry >= config.maxHealRetries) {
      log.error(`Limite de tentativas de auto-cura atingido (${config.maxHealRetries}). Diff NÃO foi aplicado.`);
    }

    return { resultStr: result.toolMessage, usedHeal: healRetry > 0 };
  },

  "ler_arquivo_avancado": async (args) => {
    const result = readFileAdvanced({
      path: asString(args.path ?? args.caminho),
      offset: args.offset as number | undefined,
      limit: args.limit as number | undefined,
      grep: args.grep as string | undefined,
      contextLines: args.contextLines as number | undefined,
    });
    return { resultStr: result, usedHeal: false };
  },

  "editar_arquivo": async (args) => {
    const edits = args.edits as EditOperation[] | undefined;
    if (edits && Array.isArray(edits)) {
      const result = editFile(
        asString(args.path ?? args.caminho),
        edits,
        { createIfMissing: args.createIfMissing as boolean | undefined }
      );
      readOnlyCache.invalidate("ler_arquivo", { caminho: args.path ?? args.caminho });
      return { resultStr: result, usedHeal: false };
    }
    const edit: EditOperation = {
      search: asString(args.search ?? args.oldString),
      replace: asString(args.replace ?? args.newString),
      all: args.all as boolean | undefined,
    };
    const result = editFile(
      asString(args.path ?? args.caminho),
      [edit],
      { createIfMissing: args.createIfMissing as boolean | undefined }
    );
    return { resultStr: result, usedHeal: false };
  },

  "buscar_arquivos": async (args) => {
    const results = globSearch({
      pattern: asString(args.pattern ?? args.glob, "**/*"),
      cwd: args.cwd as string | undefined,
      maxDepth: args.maxDepth as number | undefined,
      ignore: args.ignore as string[] | undefined,
    });
    const output = results.length > 0 ? results.join("\n") : "Nenhum arquivo encontrado.";
    return { resultStr: output, usedHeal: false };
  },

  "buscar_texto": async (args) => {
    const matches = grepSearch({
      pattern: asString(args.pattern),
      path: args.path as string | undefined,
      include: args.include as string | undefined,
      ignore: args.ignore as string[] | undefined,
      maxResults: args.maxResults as number | undefined,
      contextLines: args.contextLines as number | undefined,
      caseInsensitive: args.caseInsensitive as boolean | undefined,
      wholeWord: args.wholeWord as boolean | undefined,
    });
    const output = formatGrepResults(matches);
    return { resultStr: output, usedHeal: false };
  },

  "git_status": async (args) => {
    const status = await gitStatus(args.cwd as string | undefined);
    const output = [
      `Branch: ${status.branch}`,
      status.ahead > 0 ? `Ahead: ${status.ahead}` : "",
      status.behind > 0 ? `Behind: ${status.behind}` : "",
      status.staged.length > 0 ? `Staged: ${status.staged.join(", ")}` : "",
      status.modified.length > 0 ? `Modified: ${status.modified.join(", ")}` : "",
      status.untracked.length > 0 ? `Untracked: ${status.untracked.join(", ")}` : "",
      status.conflicted.length > 0 ? `Conflicted: ${status.conflicted.join(", ")}` : "",
    ].filter(Boolean).join("\n");
    return { resultStr: output ?? "Clean working tree.", usedHeal: false };
  },

  "git_diff": async (args) => {
    const result = await gitDiff(
      args.cwd as string | undefined,
      args.file as string | undefined,
      args.staged as boolean | undefined
    );
    return { resultStr: result ?? "No changes.", usedHeal: false };
  },

  "git_log": async (args) => {
    const result = await gitLog(
      args.cwd as string | undefined,
      (args.count as number) ?? 10,
      args.file as string | undefined
    );
    return { resultStr: result, usedHeal: false };
  },

  "git_commit": async (args) => {
    const result = await gitCommit(
      asString(args.message),
      args.cwd as string | undefined,
      args.files as string[] | undefined
    );
    readOnlyCache.invalidate("git_status");
    readOnlyCache.invalidate("git_log");
    return { resultStr: result, usedHeal: false };
  },

  "git_blame": async (args) => {
    const result = await gitBlame(
      asString(args.file ?? args.filePath),
      args.cwd as string | undefined,
      args.startLine as number | undefined,
      args.endLine as number | undefined
    );
    return { resultStr: result, usedHeal: false };
  },

  "git_show": async (args) => {
    const result = await gitShow(asString(args.commitHash), args.cwd as string | undefined);
    return { resultStr: result, usedHeal: false };
  },

  "git_branch": async (args) => {
    const result = await gitBranch(args.cwd as string | undefined);
    return { resultStr: result, usedHeal: false };
  },

  "git_checkout": async (args) => {
    const result = await gitCheckout(asString(args.branch), args.cwd as string | undefined);
    return { resultStr: result, usedHeal: false };
  },

  "editar_multi_arquivos": async (args) => {
    const requests = args.requests as FileEditRequest[] | undefined;
    if (!requests || !Array.isArray(requests)) {
      return { resultStr: "[ERRO] 'requests' array is required", usedHeal: false };
    }
    const result = multiFileEdit(requests);
    const errorList = result.errors.map((e) => `${e.file}: ${e.error}`).join("; ");
    const output = result.success
      ? `[SUCESSO] Editados: ${result.filesEdited.join(", ")}`
      : `[ERRO] Falhas: ${errorList}`;
    return { resultStr: output, usedHeal: false };
  },

  "salvar_sessao": async (args) => {
    const id = saveSession(args.id as string | undefined);
    return { resultStr: `[SUCESSO] Sessão salva: ${id}`, usedHeal: false };
  },

  "carregar_sessao": async (args) => {
    const ok = loadSession(asString(args.id));
    return {
      resultStr: ok ? `[SUCESSO] Sessão carregada: ${String(args.id)}` : `[ERRO] Sessão não encontrada: ${String(args.id)}`,
      usedHeal: false,
    };
  },

  "listar_sessoes": async () => {
    const sessions = listSessions();
    const output = sessions.length === 0
      ? "Nenhuma sessão salva."
      : sessions.map((s) => `  ${s.id} (${s.messageCount} msgs, ${s.lastModified})`).join("\n");
    return { resultStr: output, usedHeal: false };
  },

  "parse_ast": async (args) => {
    const result = await parseFile(asString(args.path ?? args.filePath));
    const output = [
      `Language: ${result.language}`,
      `Lines: ${result.lineCount}`,
      `Symbols: ${result.symbols.length}`,
      ...result.symbols.map((s: { type: string; name: string; line: number; exported: boolean }) => `  ${s.type} ${s.name} (line ${s.line})${s.exported ? " [exported]" : ""}`),
      `Imports: ${result.imports.length}`,
      ...result.imports.map((i: { module: string }) => `  ${i.module}`),
    ].join("\n");
    return { resultStr: output, usedHeal: false };
  },

  "executar_paralelo": async (args) => {
    const toolNames = args.tools as string[] | undefined;
    const toolArgsList = args.args as Record<string, unknown>[] | undefined;
    if (!toolNames?.length || !toolArgsList?.length || toolNames.length !== toolArgsList.length) {
      return { resultStr: "[ERRO] 'tools' and 'args' arrays required", usedHeal: false };
    }
    const parallelTools: ParallelToolCall[] = toolNames.map((tn, i) => ({
      id: `parallel_${i}`,
      name: tn,
      args: toolArgsList[i],
      execute: async () => `[Placeholder for ${tn}]`,
    }));
    const results = await executeParallelTools(parallelTools);
    const output = results.map((r) => `${r.name}: ${r.success ? r.result.slice(0, 100) : r.error}`).join("\n");
    return { resultStr: output, usedHeal: false };
  },

  "executar_testes": async (args) => {
    const dir = asString(args.dir, process.cwd());
    const filePath = args.path ? asString(args.path) : undefined;
    const result = await runTests(dir, filePath);
    return { resultStr: formatTestResult(result), usedHeal: false };
  },

  "sugerir_fixes": async (args) => {
    const dir = asString(args.dir, process.cwd());
    const result = await runTests(dir);
    const suggestions = suggestFixes(result);
    return { resultStr: formatFixSuggestions(suggestions), usedHeal: false };
  },

  // ─── External Tools ────────────────────────────────────────────────────

  "executar_tool": async (args) => {
    const toolName = asString(args.tool);
    const toolArgs = (args.args as Record<string, any>) ?? {};
    const cwd = args.dir ? asString(args.dir) : undefined;
    
    const executor = getExecutor();
    const result = await executor.execute(toolName, toolArgs, { cwd });
    
    const output = [
      result.success ? "✅ Sucesso" : "❌ Falha",
      result.output,
      result.errors?.length ? `Erros:\n${result.errors.join("\n")}` : "",
      result.suggestions?.length ? `Sugestões:\n${result.suggestions.join("\n")}` : "",
      result.duration ? `Duração: ${result.duration}ms` : ""
    ].filter(Boolean).join("\n");
    
    return { resultStr: output, usedHeal: false };
  },

  "listar_tools": async (args) => {
    const registry = getRegistry();
    const category = args.category ? asString(args.category) : undefined;
    
    const tools = category ? registry.getByCategory(category as any) : registry.getAll();
    const installed = tools.filter(t => registry.isInstalled(t.name));
    const notInstalled = tools.filter(t => !registry.isInstalled(t.name));
    
    const output = [
      `📊 Total: ${tools.length} tools`,
      `✅ Instaladas: ${installed.length}`,
      `❌ Não instaladas: ${notInstalled.length}`,
      "",
      "Tools instaladas:",
      ...installed.map(t => `  • ${t.name} (${t.category}) - ${t.description}`),
      "",
      "Tools não instaladas:",
      ...notInstalled.map(t => `  • ${t.name} (${t.category}) - ${t.description}`)
    ].filter(Boolean).join("\n");
    
    return { resultStr: output, usedHeal: false };
  },

  "adicionar_tool": async (args) => {
    const registry = getRegistry();
    
    const newTool: Tool = {
      name: asString(args.name),
      description: asString(args.description),
      category: "custom",
      command: asString(args.command),
      args: (args.args as string[]) ?? [],
      flags: (args.flags as any[]) ?? [],
      detection: {
        method: "binary",
        check: asString(args.check_command, `${asString(args.command)} --version`)
      },
      context: {
        whenToUse: (args.when_to_use as string[]) ?? [],
        examples: (args.examples as string[]) ?? []
      },
      outputParser: "raw"
    };
    
    const result = registry.addTool(newTool);
    return { resultStr: result.message, usedHeal: false };
  },

  "sugerir_tool": async (args) => {
    const suggester = getSuggester();
    const message = asString(args.message);
    
    const suggestions = suggester.suggest(message);
    
    if (suggestions.length === 0) {
      return { resultStr: "Nenhuma tool sugerida para esta mensagem.", usedHeal: false };
    }
    
    const output = [
      "🔍 Tools sugeridas:",
      ...suggestions.slice(0, 5).map((s, i) => 
        `${i + 1}. ${s.tool.name} (${s.tool.category}) - Confiança: ${(s.confidence * 100).toFixed(0)}%\n   Motivo: ${s.reason}`
      )
    ].join("\n");
    
    return { resultStr: output, usedHeal: false };
  },

  "detectar_tools": async (args) => {
    const detector = getDetector();
    const message = args.message ? asString(args.message) : "";
    const dir = args.dir ? asString(args.dir) : undefined;
    
    const detection = detector.detect(message, dir);
    
    const output = [
      "🔍 Detecção de Tools:",
      "",
      "Por intenção:",
      detection.intent ? `  • ${detection.intent.tool}` : "  • Nenhuma",
      "",
      "Por contexto do projeto:",
      detection.context.length > 0 
        ? detection.context.map(t => `  • ${t.name} (${t.category})`).join("\n")
        : "  • Nenhuma"
    ].join("\n");
    
    return { resultStr: output, usedHeal: false };
  },
};

// ─── Tool Dispatcher ──────────────────────────────────────────────────────────

async function dispatchToolCall(
  toolCall: ToolCall,
  healRetry: number = 0
): Promise<ToolResult> {
  const name = toolCall.function.name;
  const startTime = Date.now();

  const rawArgs = parseArgs(toolCall.function.arguments);
  const preResult = await executePreToolCallHooks(name, rawArgs);
  if (preResult.skip) {
    return { resultStr: preResult.resultOverride ?? `[HOOK] Tool "${name}" skipped by pre-hook.`, usedHeal: false };
  }
  const finalArgs = preResult.modifiedArgs ?? rawArgs;

  const cached = shouldCacheResult(name) ? readOnlyCache.get(name, finalArgs) : null;
  if (cached !== null) {
    recordToolCall(name, Date.now() - startTime, true);
    return { resultStr: cached, usedHeal: false };
  }

  const handler = toolHandlers[name];
  let result: ToolResult;
  if (handler) {
    result = await handler(finalArgs, toolCall, healRetry);
  } else if (name.includes("__")) {
    result = { resultStr: await callMCPTool(name, finalArgs), usedHeal: false };
  } else {
    const unknown = `[ERRO] Ferramenta desconhecida: "${name}"`;
    log.error(unknown);
    result = { resultStr: unknown, usedHeal: false };
  }

  if (shouldCacheResult(name)) {
    readOnlyCache.set(name, finalArgs, result.resultStr);
  }

  recordToolCall(name, Date.now() - startTime, true);

  const postResult = await executePostToolCallHooks(name, finalArgs, result.resultStr);
  if (postResult.modifiedResult) {
    result.resultStr = postResult.modifiedResult;
  }

  return result;
}

// ─── Tool Call Processing ─────────────────────────────────────────────────────

const READ_ONLY_TOOLS = new Set([
  "ler_arquivo", "ler_arquivo_avancado", "buscar_arquivos", "buscar_texto",
  "git_status", "git_log", "git_diff",
]);

const FILE_TOOLS = new Set([
  "aplicar_diff", "editar_arquivo", "multi_edit",
]);

async function executeReadOnlyCallsInParallel(toolCalls: ToolCall[]): Promise<void> {
  if (toolCalls.length <= 1) return;

  const parallelTools: ParallelToolCall[] = toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    args: parseArgs(tc.function.arguments),
    execute: async () => {
      const result = await dispatchToolCall(tc);
      return result.resultStr;
    },
  }));
  const results = await executeParallelTools(parallelTools);
  for (const result of results) {
    const tc = toolCalls.find((t) => t.id === result.id);
    if (tc) {
      history.addToolResult(tc.id, result.result);
    }
  }
}

async function executeToolCallsSequentially(toolCalls: ToolCall[]): Promise<void> {
  for (const toolCall of toolCalls) {
    const { resultStr } = await dispatchToolCall(toolCall);
    if (!alreadyInHistory(toolCall.id)) {
      history.addToolResult(toolCall.id, resultStr);
    }
  }
}

// ─── Auto-Heal: detect test/lint failures and inject retry context ────────────

const TEST_TOOLS = new Set(["executar_testes", "executar_comando", "sugerir_fixes"]);
const MAX_AUTO_HEAL_RETRIES = 2;

function isTestFailure(resultStr: string): boolean {
  const lower = resultStr.toLowerCase();
  return (
    lower.includes("fail") ||
    lower.includes("error") ||
    lower.includes("failed") ||
    lower.includes("❌") ||
    lower.includes("failing")
  ) && (
    lower.includes("test") ||
    lower.includes("lint") ||
    lower.includes("vitest") ||
    lower.includes("jest") ||
    lower.includes("pytest") ||
    lower.includes("cargo") ||
    lower.includes("eslint") ||
    lower.includes("tsc")
  );
}

async function processToolCalls(toolCalls: ToolCall[]): Promise<void> {
  const readOnlyCalls = toolCalls.filter((tc) => READ_ONLY_TOOLS.has(tc.function.name));
  const writeCalls = toolCalls.filter((tc) => !READ_ONLY_TOOLS.has(tc.function.name));

  await executeReadOnlyCallsInParallel(readOnlyCalls);

  if (writeCalls.length > 0) {
    await executeToolCallsSequentially(writeCalls);
    fireOnFileTrigger(writeCalls);
  } else if (readOnlyCalls.length <= 1) {
    await executeToolCallsSequentially(readOnlyCalls);
  }

  checkAutoHeal(toolCalls);
}

function fireOnFileTrigger(writeCalls: ToolCall[]): void {
  const fileTools = writeCalls.filter((tc) => FILE_TOOLS.has(tc.function.name));
  if (fileTools.length === 0) return;
  const triggerCtx: TriggerContext = { cwd: process.cwd() };
  for (const tc of fileTools) {
    const args = parseArgs(tc.function.arguments);
    triggerCtx.filePath = asString(args.path ?? args.caminho);
    triggerCtx.toolName = tc.function.name;
  }
  executeTrigger("on_file", triggerCtx).catch((err) => {
    log.warn(`On-file trigger failed: ${(err as Error).message}`);
  });
}

function checkAutoHeal(toolCalls: ToolCall[]): void {
  const testCalls = toolCalls.filter((tc) => TEST_TOOLS.has(tc.function.name));
  for (const tc of testCalls) {
    const historyArr = history.getHistory();
    for (let i = historyArr.length - 1; i >= 0; i--) {
      const m = historyArr[i];
      if (m.role === "tool" && (m as { tool_call_id?: string }).tool_call_id === tc.id) {
        const content = (m as { content?: string }).content;
        if (content && isTestFailure(content)) {
          history.addSystemMessage(
            `[AUTO-HEAL] A ferramenta "${tc.function.name}" retornou falhas. ` +
            `Analise o erro acima, corrija o código usando aplicar_diff, e rode os testes novamente. ` +
            `Máximo de ${MAX_AUTO_HEAL_RETRIES} tentativas automáticas.`
          );
          log.debug(`Auto-heal triggered for ${tc.function.name}`);
        }
        break;
      }
    }
  }
}

// ─── Main Agent Loop ─────────────────────────────────────────────────────────

async function sendAndProcess(
  depth: number = 0,
  onStreamStart?: () => void,
  onToken?: (token: string) => void,
  onThinking?: () => void,
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void
): Promise<string> {
  if (depth > 20) {
    throw new Error("Agent loop exceeded maximum depth (20). Possible runaway detected.");
  }

  const compaction = smartCompact(config.contextWindowTokens * 0.75);
  if (compaction.compacted) {
    log.debug(`Context compacted: saved ${compaction.savedTokens} tokens`);
  }

  // Check if we should write a checkpoint
  const currentTokens = history.estimateTokens?.() ?? 0;
  if (shouldWriteCheckpoint(currentTokens) && currentTokens > lastCheckpointTokens + 1000) {
    const checkpoint = createCheckpoint(
      sessionStartTime,
      history.getHistory().map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "" })),
      sessionFileChanges,
      sessionToolsUsed
    );
    const { writeCheckpoint } = await import("./memory.js");
    writeCheckpoint(memoryConfig, checkpoint);
    lastCheckpointTokens = currentTokens;
    log.debug(`Checkpoint saved at ${currentTokens} tokens`);
  }

  history.optimizeContext();

  const response = await withRetry(
    () => chat(history.getHistory(), onStreamStart, onToken, onThinking, getMergedTools()),
    {
      maxRetries: 2,
      baseDelayMs: 1000,
      retryOn: isRetryableError,
      onRetry: (attempt, err, delay) => log.warn(`Retry ${attempt} after ${delay}ms: ${(err as Error).message}`),
    }
  );

  if (response.usage && onUsage) onUsage(response.usage);
  const choice = response.choices[0];
  if (!choice) {
    throw new Error("Empty response from NVIDIA NIM API");
  }

  const { message, finish_reason } = choice;
  history.addRawAssistantMessage(message);

  // ── Trigger: always (every iteration) ────────────────────────────────
  const triggerCtx: TriggerContext = { cwd: process.cwd() };
  executeTrigger("always", triggerCtx).catch((err) => {
    log.warn(`Always trigger failed: ${(err as Error).message}`);
  });

  if (finish_reason === "tool_calls" && message.tool_calls?.length) {
    log.debug(`Model requested ${message.tool_calls.length} tool call(s)`);
    await processToolCalls(message.tool_calls);
    return sendAndProcess(depth + 1, onStreamStart, onToken, onThinking, onUsage);
  }

  // ── Trigger: on_task (task complete) ─────────────────────────────────
  executeTrigger("on_task", triggerCtx).catch((err) => {
    log.warn(`On-task trigger failed: ${(err as Error).message}`);
  });

  return message.content ?? "(resposta vazia)";
}

// ─── Public Entry Point ───────────────────────────────────────────────────────

export async function runAgentLoop(
  userInput: string,
  onStreamStart?: () => void,
  onToken?: (token: string) => void,
  onThinking?: () => void,
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void
): Promise<string> {
  startSession();
  sessionStartTime = new Date().toISOString();
  sessionFileChanges = [];
  sessionToolsUsed = [];
  lastCheckpointTokens = 0;

  // Initialize external tools system
  await initializeTools();
  
  // Detect tools from project context
  const detector = getDetector();
  const contextTools = detector.detectFromContext();
  if (contextTools.length > 0) {
    log.debug(`Detected ${contextTools.length} tools from project context`);
  }

  // Inject memory into context
  const memory = injectMemory(memoryConfig);
  if (memory.totalTokensEstimate > 100) {
    const memoryStr = formatInjectedMemory(memory);
    history.addSystemMessage(`## Persistent Memory\n\n${memoryStr}`);
    log.debug(`Injected memory: ~${memory.totalTokensEstimate} tokens`);
  }

  history.addUserMessage(userInput);
  recordMessage(userInput.length);
  log.debug(`History: ${history.historySummary()}`);

  const result = await sendAndProcess(0, onStreamStart, onToken, onThinking, onUsage);

  // Save session trace
  const trace: SessionTrace = {
    id: sessionStartTime,
    startTime: sessionStartTime,
    endTime: new Date().toISOString(),
    summary: userInput.slice(0, 200),
    decisions: [],
    fileChanges: sessionFileChanges,
    toolsUsed: [...new Set(sessionToolsUsed)],
    tokensUsed: 0,
    messages: history.getHistory().map((m) => ({
      role: m.role as "user" | "assistant" | "tool",
      content: typeof m.content === "string" ? m.content : "",
      timestamp: new Date().toISOString(),
    })),
  };
  saveSessionTrace(memoryConfig, trace);

  recordMessage(result.length);
  endSession();

  return result;
}
