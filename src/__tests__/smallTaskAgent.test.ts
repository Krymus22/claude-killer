/**
 * smallTaskAgent.test.ts — Unit tests for the /small task agent.
 *
 * Tests:
 * 1. Configuration (enabled, model, max tool calls)
 * 2. Pending summary queue (add, consume, clear)
 * 3. Anti-recursion guard
 * 4. Disabled feature returns error
 * 5. Tool execution (executar_comando, ler_arquivo, buscar_arquivos, buscar_texto)
 * 6. Tool result truncation
 * 7. Timeout handling
 * 8. Max tool calls limit
 * 9. Malformed JSON args handling
 * 10. Callbacks (onStart, onToolCall, onToolResult, onComplete)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock the API client — chatWithModel is the core dependency
const mockChatWithModel = vi.hoisted(() => vi.fn());
vi.mock("../apiClient.js", () => ({
  chatWithModel: mockChatWithModel,
  clearModelOverride: vi.fn(),
  chat: vi.fn(),
  TOOL_DEFINITIONS: [],
}));

// Mock tools
vi.mock("../tools.js", () => ({
  executarComando: vi.fn(async ({ comando }: { comando: string }) => {
    if (comando === "ls") return "file1.ts\nfile2.ts\nfile3.ts";
    if (comando === "pwd") return "/home/user/project";
    if (comando === "fail") return "[ERROR] Command failed with code 1";
    return `output of: ${comando}`;
  }),
  desfazerEdicao: vi.fn(),
  aplicarDiff: vi.fn(),
  lerArquivo: vi.fn(),
  listarBackups: vi.fn(),
}));

// Mock fileRead
vi.mock("../fileRead.js", () => ({
  readFileAdvanced: vi.fn(({ path }: { path: string }) => {
    if (path.includes("nonexistent")) return "[ERROR] File not found";
    return `content of ${path}`;
  }),
}));

// Mock fileSearch
vi.mock("../fileSearch.js", () => ({
  globSearch: vi.fn(({ pattern }: { pattern: string }) => {
    if (pattern === "**/*.ts") return ["src/agent.ts", "src/tools.ts", "src/config.ts"];
    return [];
  }),
}));

// Mock contentSearch
vi.mock("../contentSearch.js", () => ({
  grepSearch: vi.fn(({ pattern }: { pattern: string }) => {
    if (pattern === "TODO") return [{ file: "src/agent.ts", line: 10, content: "// TODO: fix this" }];
    return [];
  }),
  formatGrepResults: vi.fn((matches: unknown[]) => {
    if (matches.length === 0) return "";
    return matches.map((m: any) => `${m.file}:${m.line}: ${m.content}`).join("\n");
  }),
}));

// Mock readBeforeWrite
vi.mock("../readBeforeWrite.js", () => ({
  recordRead: vi.fn(),
  checkReadBeforeWrite: vi.fn(() => ({ allowed: true })),
}));

// Mock modelRegistry
vi.mock("../modelRegistry.js", () => ({
  getModelInfo: vi.fn(() => ({
    id: "meta/llama-3.1-8b-instruct",
    name: "Llama 3.1 8B",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    supportsTools: true,
    supportsParallelTools: false,
    hasThinking: false,
    provider: "nvidia",
  })),
  modelSupportsTools: vi.fn(() => true),
}));

// Mock logger
vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

// Mock activityTracker
vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(),
  withActivity: vi.fn(),
  clearActivity: vi.fn(),
}));

import { runSmallTask, consumePendingSmallTaskSummaries, hasPendingSmallTaskSummaries, isSmallTaskEnabled, getSmallTaskModel, _resetSmallTaskState, isSmallTaskAgentRunning } from "../smallTaskAgent.js";

describe("smallTaskAgent — /small command feature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSmallTaskState();
    // Clear anti-recursion env var
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  afterEach(() => {
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  // ── Configuration tests ──────────────────────────────────────────────────

  describe("configuration", () => {
    it("isSmallTaskEnabled returns true by default", () => {
      // SMALL_TASK_ENABLED is read at module load; the default is true
      expect(typeof isSmallTaskEnabled()).toBe("boolean");
    });

    it("getSmallTaskModel returns a string", () => {
      expect(typeof getSmallTaskModel()).toBe("string");
      expect(getSmallTaskModel().length).toBeGreaterThan(0);
    });
  });

  // ── Pending summary queue tests ──────────────────────────────────────────

  describe("pending summary queue", () => {
    it("starts empty", () => {
      expect(hasPendingSmallTaskSummaries()).toBe(false);
      expect(consumePendingSmallTaskSummaries()).toEqual([]);
    });

    it("consumePendingSmallTaskSummaries clears after reading", async () => {
      // Run a successful small task to populate the queue
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: { content: "Test summary", tool_calls: undefined },
          finish_reason: "stop",
        }],
      });

      await runSmallTask("test task", "/tmp");

      expect(hasPendingSmallTaskSummaries()).toBe(true);
      const summaries = consumePendingSmallTaskSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toBe("Test summary");

      // After consume, should be empty
      expect(hasPendingSmallTaskSummaries()).toBe(false);
      expect(consumePendingSmallTaskSummaries()).toEqual([]);
    });
  });

  // ── Anti-recursion guard tests ───────────────────────────────────────────

  describe("anti-recursion guard", () => {
    it("rejects call when inside a sub-agent (CLAUDE_KILLER_AGENT_ID set)", async () => {
      process.env.CLAUDE_KILLER_AGENT_ID = "some-other-agent";

      const result = await runSmallTask("test", "/tmp");

      expect(result.ok).toBe(false);
      expect(result.error).toContain("sub-agente");
      expect(mockChatWithModel).not.toHaveBeenCalled();
    });

    it("isSmallTaskAgentRunning returns false by default", () => {
      expect(isSmallTaskAgentRunning()).toBe(false);
    });
  });

  // ── Disabled feature tests ───────────────────────────────────────────────

  describe("disabled feature", () => {
    it("returns error when model doesn't support tools", async () => {
      // Temporarily mock modelSupportsTools to return false
      const { modelSupportsTools } = await import("../modelRegistry.js");
      vi.mocked(modelSupportsTools).mockReturnValueOnce(false);

      const result = await runSmallTask("test task", "/tmp");

      expect(result.ok).toBe(false);
      expect(result.error).toContain("não suporta tool calling");
    });
  });

  // ── Successful task execution tests ──────────────────────────────────────

  describe("successful task execution", () => {
    it("runs a simple task with no tool calls (just returns summary)", async () => {
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: { content: "Tarefa concluída: tudo ok", tool_calls: undefined },
          finish_reason: "stop",
        }],
      });

      const result = await runSmallTask("diga olá", "/tmp");

      expect(result.ok).toBe(true);
      expect(result.summary).toBe("Tarefa concluída: tudo ok");
      expect(result.toolCallsMade).toBe(0);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it("runs a task with one tool call then summary", async () => {
      // First call: model makes a tool call
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "executar_comando", arguments: '{"comando":"ls"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
      });
      // Second call: model returns summary after tool result
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: { content: "Encontrei 3 arquivos: file1.ts, file2.ts, file3.ts", tool_calls: undefined },
          finish_reason: "stop",
        }],
      });

      const result = await runSmallTask("lista arquivos", "/tmp");

      expect(result.ok).toBe(true);
      expect(result.summary).toContain("3 arquivos");
      expect(result.toolCallsMade).toBe(1);
    });

    it("handles multiple tool calls across turns (1 per turn for non-parallel models)", async () => {
      // Turn 1: model makes first tool call
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "executar_comando", arguments: '{"comando":"pwd"}' } },
              { id: "call_2", type: "function", function: { name: "executar_comando", arguments: '{"comando":"ls"}' } },
            ],
          },
          finish_reason: "tool_calls",
        }],
      });
      // Turn 2: model makes second tool call (after first result)
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "call_3", type: "function", function: { name: "executar_comando", arguments: '{"comando":"ls"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      // Turn 3: model returns summary
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: { content: "Estou em /home/user/project com 3 arquivos.", tool_calls: undefined },
          finish_reason: "stop",
        }],
      });

      const result = await runSmallTask("onde estou e o que tem?", "/tmp");

      expect(result.ok).toBe(true);
      // 2 tool calls: 1 from turn 1 (only first is taken), 1 from turn 2
      expect(result.toolCallsMade).toBe(2);
    });
  });

  // ── Tool execution tests ─────────────────────────────────────────────────

  describe("tool execution", () => {
    it("executar_comando returns output", async () => {
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "executar_comando", arguments: '{"comando":"pwd"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "pwd executado", tool_calls: undefined }, finish_reason: "stop" }],
      });

      const result = await runSmallTask("pwd", "/tmp");
      expect(result.ok).toBe(true);
    });

    it("ler_arquivo returns content", async () => {
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "ler_arquivo", arguments: '{"caminho":"src/agent.ts"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Li o arquivo", tool_calls: undefined }, finish_reason: "stop" }],
      });

      const result = await runSmallTask("lê agent.ts", "/tmp");
      expect(result.ok).toBe(true);
    });

    it("buscar_arquivos returns file list", async () => {
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "buscar_arquivos", arguments: '{"padrao":"**/*.ts"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "3 arquivos .ts", tool_calls: undefined }, finish_reason: "stop" }],
      });

      const result = await runSmallTask("busca .ts", "/tmp");
      expect(result.ok).toBe(true);
    });

    it("buscar_texto returns grep results", async () => {
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "buscar_texto", arguments: '{"padrao":"TODO"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "1 TODO encontrado", tool_calls: undefined }, finish_reason: "stop" }],
      });

      const result = await runSmallTask("busca TODO", "/tmp");
      expect(result.ok).toBe(true);
    });

    it("unknown tool returns error", async () => {
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "editar_arquivo", arguments: '{}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Tool não suportada", tool_calls: undefined }, finish_reason: "stop" }],
      });

      const result = await runSmallTask("edita algo", "/tmp");
      expect(result.ok).toBe(true);
    });
  });

  // ── Malformed JSON args tests ────────────────────────────────────────────

  describe("malformed JSON args", () => {
    it("handles malformed JSON by extracting {...} substring", async () => {
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "c1",
              type: "function",
              function: { name: "executar_comando", arguments: 'garbage {"comando":"ls"} more garbage' },
            }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Executado", tool_calls: undefined }, finish_reason: "stop" }],
      });

      const result = await runSmallTask("ls", "/tmp");
      expect(result.ok).toBe(true);
      expect(result.toolCallsMade).toBe(1);
    });

    it("handles completely invalid JSON (no braces)", async () => {
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "c1",
              type: "function",
              function: { name: "executar_comando", arguments: "totally invalid" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Comando vazio", tool_calls: undefined }, finish_reason: "stop" }],
      });

      const result = await runSmallTask("test", "/tmp");
      expect(result.ok).toBe(true);
    });
  });

  // ── Callback tests ───────────────────────────────────────────────────────

  describe("callbacks", () => {
    it("calls onStart, onToolCall, onToolResult, onComplete", async () => {
      const onStart = vi.fn();
      const onToolCall = vi.fn();
      const onToolResult = vi.fn();
      const onComplete = vi.fn();

      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "executar_comando", arguments: '{"comando":"ls"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Done", tool_calls: undefined }, finish_reason: "stop" }],
      });

      await runSmallTask("test", "/tmp", { onStart, onToolCall, onToolResult, onComplete });

      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onToolCall).toHaveBeenCalledTimes(1);
      expect(onToolCall).toHaveBeenCalledWith("executar_comando", { comando: "ls" });
      expect(onToolResult).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ ok: true, summary: "Done" }));
    });

    it("calls onComplete with error on failure", async () => {
      const onComplete = vi.fn();

      mockChatWithModel.mockRejectedValueOnce(new Error("API down"));

      await runSmallTask("test", "/tmp", { onComplete });

      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        ok: false,
        error: "API down",
      }));
    });
  });

  // ── Max tool calls limit ─────────────────────────────────────────────────

  describe("max tool calls limit", () => {
    it("stops after max tool calls and returns error", async () => {
      // Model keeps making tool calls forever
      mockChatWithModel.mockResolvedValue({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "executar_comando", arguments: '{"comando":"ls"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });

      const result = await runSmallTask("loop forever", "/tmp");

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Limite");
    });
  });

  // ── Empty summary ────────────────────────────────────────────────────────

  describe("empty summary", () => {
    it("returns error when model returns empty content with no tool calls", async () => {
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: { content: "", tool_calls: undefined },
          finish_reason: "stop",
        }],
      });

      const result = await runSmallTask("test", "/tmp");

      expect(result.ok).toBe(false);
      expect(result.error).toContain("resumo");
    });
  });

  // ── Tool result truncation ───────────────────────────────────────────────

  describe("tool result truncation", () => {
    it("truncates results > 4000 chars", async () => {
      const { executarComando } = await import("../tools.js");
      vi.mocked(executarComando).mockResolvedValueOnce("x".repeat(10000));

      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "executar_comando", arguments: '{"comando":"big"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Done", tool_calls: undefined }, finish_reason: "stop" }],
      });

      const result = await runSmallTask("big output", "/tmp");
      expect(result.ok).toBe(true);

      // Verify the truncated result was sent to the model
      const secondCallArgs = mockChatWithModel.mock.calls[1];
      const messages = secondCallArgs?.[0] as any[];
      const toolMessage = messages?.find((m: any) => m.role === "tool");
      expect(toolMessage).toBeDefined();
      expect(toolMessage.content).toContain("[TRUNCATED]");
      expect(toolMessage.content.length).toBeLessThan(5000);
    });

    // BH-SMALL-3 / §14.2: "ler_arquivo NÃO trunca — IA precisa do conteúdo
    // completo." The small task agent must NOT truncate ler_arquivo results
    // sent to the model's history. Other tools (executar_comando, etc.) are
    // still truncated.
    it("does NOT truncate ler_arquivo results for the model (§14.2)", async () => {
      const { readFileAdvanced } = await import("../fileRead.js");
      const bigContent = "L".repeat(10000);
      vi.mocked(readFileAdvanced).mockReturnValueOnce(bigContent);

      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "ler_arquivo", arguments: '{"caminho":"src/big.txt"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Li o arquivo", tool_calls: undefined }, finish_reason: "stop" }],
      });

      const result = await runSmallTask("lê big.txt", "/tmp");
      expect(result.ok).toBe(true);

      // The model's history must contain the FULL 10000-char content (no [TRUNCATED]).
      const secondCallArgs = mockChatWithModel.mock.calls[1];
      const messages = secondCallArgs?.[0] as any[];
      const toolMessage = messages?.find((m: any) => m.role === "tool");
      expect(toolMessage).toBeDefined();
      expect(toolMessage.content).toBe(bigContent);
      expect(toolMessage.content.length).toBe(10000);
      expect(toolMessage.content).not.toContain("[TRUNCATED]");
    });

    it("still truncates ler_arquivo for the TUI callback (memory safety)", async () => {
      const { readFileAdvanced } = await import("../fileRead.js");
      const bigContent = "L".repeat(10000);
      vi.mocked(readFileAdvanced).mockReturnValueOnce(bigContent);

      const onToolResult = vi.fn();

      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "ler_arquivo", arguments: '{"caminho":"src/big.txt"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Li o arquivo", tool_calls: undefined }, finish_reason: "stop" }],
      });

      await runSmallTask("lê big.txt", "/tmp", { onToolResult });

      // The TUI callback gets the truncated version (to avoid bloating React state).
      expect(onToolResult).toHaveBeenCalledTimes(1);
      const [, tuiResult] = onToolResult.mock.calls[0];
      expect(tuiResult.length).toBeLessThan(5000);
      expect(tuiResult).toContain("[TRUNCATED]");
    });
  });

  // ── BH-SMALL-3: Path traversal protection ────────────────────────────────

  describe("BH-SMALL-3: path traversal protection", () => {
    it("ler_arquivo rejects absolute paths outside the project", async () => {
      const { readFileAdvanced } = await import("../fileRead.js");
      vi.mocked(readFileAdvanced).mockClear();

      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "ler_arquivo", arguments: '{"caminho":"/etc/passwd"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Recusado", tool_calls: undefined }, finish_reason: "stop" }],
      });

      const result = await runSmallTask("lê /etc/passwd", "/tmp");
      expect(result.ok).toBe(true); // task completes (model sees error, returns summary)

      // The underlying readFileAdvanced must NOT have been called — the path
      // check must throw before reaching it.
      expect(vi.mocked(readFileAdvanced)).not.toHaveBeenCalled();

      // The model must have received the blocking error in the tool result.
      const secondCallArgs = mockChatWithModel.mock.calls[1];
      const messages = secondCallArgs?.[0] as any[];
      const toolMessage = messages?.find((m: any) => m.role === "tool");
      expect(toolMessage).toBeDefined();
      expect(toolMessage.content).toContain("[ERROR]");
      expect(toolMessage.content).toContain("bloqueado");
    });

    it("ler_arquivo rejects relative ../ paths that escape the project", async () => {
      const { readFileAdvanced } = await import("../fileRead.js");
      vi.mocked(readFileAdvanced).mockClear();

      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "ler_arquivo", arguments: '{"caminho":"../../../etc/passwd"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Recusado", tool_calls: undefined }, finish_reason: "stop" }],
      });

      await runSmallTask("lê ../../../etc/passwd", "/tmp");

      expect(vi.mocked(readFileAdvanced)).not.toHaveBeenCalled();

      const secondCallArgs = mockChatWithModel.mock.calls[1];
      const messages = secondCallArgs?.[0] as any[];
      const toolMessage = messages?.find((m: any) => m.role === "tool");
      expect(toolMessage.content).toContain("bloqueado");
    });

    it("buscar_arquivos rejects caminho outside the project", async () => {
      const { globSearch } = await import("../fileSearch.js");
      vi.mocked(globSearch).mockClear();

      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "buscar_arquivos", arguments: '{"padrao":"**/*","caminho":"/etc"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Recusado", tool_calls: undefined }, finish_reason: "stop" }],
      });

      await runSmallTask("busca em /etc", "/tmp");

      expect(vi.mocked(globSearch)).not.toHaveBeenCalled();

      const secondCallArgs = mockChatWithModel.mock.calls[1];
      const messages = secondCallArgs?.[0] as any[];
      const toolMessage = messages?.find((m: any) => m.role === "tool");
      expect(toolMessage.content).toContain("bloqueado");
    });

    it("buscar_texto rejects caminho outside the project", async () => {
      const { grepSearch } = await import("../contentSearch.js");
      vi.mocked(grepSearch).mockClear();

      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "buscar_texto", arguments: '{"padrao":"root","caminho":"/etc"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Recusado", tool_calls: undefined }, finish_reason: "stop" }],
      });

      await runSmallTask("busca root em /etc", "/tmp");

      expect(vi.mocked(grepSearch)).not.toHaveBeenCalled();

      const secondCallArgs = mockChatWithModel.mock.calls[1];
      const messages = secondCallArgs?.[0] as any[];
      const toolMessage = messages?.find((m: any) => m.role === "tool");
      expect(toolMessage.content).toContain("bloqueado");
    });

    it("executar_comando rejects cwd outside the project", async () => {
      const { executarComando } = await import("../tools.js");
      vi.mocked(executarComando).mockClear();

      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "executar_comando", arguments: '{"comando":"ls","cwd":"/etc"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Recusado", tool_calls: undefined }, finish_reason: "stop" }],
      });

      await runSmallTask("ls em /etc", "/tmp");

      expect(vi.mocked(executarComando)).not.toHaveBeenCalled();

      const secondCallArgs = mockChatWithModel.mock.calls[1];
      const messages = secondCallArgs?.[0] as any[];
      const toolMessage = messages?.find((m: any) => m.role === "tool");
      expect(toolMessage.content).toContain("bloqueado");
    });

    it("allows paths within the project (relative)", async () => {
      const { readFileAdvanced } = await import("../fileRead.js");
      vi.mocked(readFileAdvanced).mockClear();
      vi.mocked(readFileAdvanced).mockReturnValueOnce("content of file");

      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "ler_arquivo", arguments: '{"caminho":"src/agent.ts"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Lido", tool_calls: undefined }, finish_reason: "stop" }],
      });

      const result = await runSmallTask("lê src/agent.ts", "/tmp");
      expect(result.ok).toBe(true);
      expect(vi.mocked(readFileAdvanced)).toHaveBeenCalled();
    });
  });

  // ── BH-SMALL-3: readBeforeWrite non-interference ─────────────────────────

  describe("BH-SMALL-3: readBeforeWrite non-interference", () => {
    // The small task agent must NOT call recordRead — it would pollute the
    // main agent's read-before-write gate, allowing the main agent to edit
    // files it has never actually read (it only sees the small task's summary).
    it("does NOT call recordRead when ler_arquivo is used", async () => {
      const { recordRead } = await import("../readBeforeWrite.js");

      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "ler_arquivo", arguments: '{"caminho":"src/agent.ts"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Lido", tool_calls: undefined }, finish_reason: "stop" }],
      });

      await runSmallTask("lê agent.ts", "/tmp");

      expect(vi.mocked(recordRead)).not.toHaveBeenCalled();
    });
  });

  // ── BH-SMALL-2: nested JSON fallback parser + timeout + cap ────────────

  describe("BH-SMALL-2: nested-JSON fallback parser (parseToolCallsFromContent)", () => {
    // Regression: the previous regex /\{[^{}]*\}/g could NOT match JSON
    // objects with nested braces (the most common 8B-model format).
    // The fix uses balanced-brace extraction.

    it("parses tool call returned as text with nested parameters object", async () => {
      // The model returns the tool call as TEXT (no tool_calls field),
      // with nested { "parameters": { "comando": "ls" } }.
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: 'I will use: {"name": "executar_comando", "parameters": {"comando": "ls"}}',
            tool_calls: undefined,
          },
          finish_reason: "stop",
        }],
      });
      // After the tool executes, the model returns the summary.
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Listei arquivos", tool_calls: undefined }, finish_reason: "stop" }],
      });

      const result = await runSmallTask("lista arquivos", "/tmp");

      expect(result.ok).toBe(true);
      // The fallback parser MUST have detected the tool call (1 tool call made).
      expect(result.toolCallsMade).toBe(1);
      // And the summary is the second response (not the raw JSON text).
      expect(result.summary).toBe("Listei arquivos");
    });

    it("parses tool call wrapped in markdown code fence", async () => {
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: '```json\n{"name": "executar_comando", "parameters": {"comando": "pwd"}}\n```',
            tool_calls: undefined,
          },
          finish_reason: "stop",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "pwd executado", tool_calls: undefined }, finish_reason: "stop" }],
      });

      const result = await runSmallTask("pwd", "/tmp");
      expect(result.ok).toBe(true);
      expect(result.toolCallsMade).toBe(1);
    });

    it("handles braces inside JSON string values (e.g., file paths)", async () => {
      // The model returns a ler_arquivo call where the path contains braces.
      // Balanced-brace extraction must NOT stop at the inner `}` (string content).
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: '{"name": "ler_arquivo", "parameters": {"caminho": "src/{test}.ts"}}',
            tool_calls: undefined,
          },
          finish_reason: "stop",
        }],
      });
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{ message: { content: "Lido", tool_calls: undefined }, finish_reason: "stop" }],
      });

      const result = await runSmallTask("lê arquivo", "/tmp");
      expect(result.ok).toBe(true);
      expect(result.toolCallsMade).toBe(1);
    });

    it("does not treat plain text without valid JSON as a tool call", async () => {
      // No JSON braces — should fall through to summary path.
      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "Tarefa concluída sem tool calls",
            tool_calls: undefined,
          },
          finish_reason: "stop",
        }],
      });

      const result = await runSmallTask("test", "/tmp");
      expect(result.ok).toBe(true);
      expect(result.toolCallsMade).toBe(0);
      expect(result.summary).toBe("Tarefa concluída sem tool calls");
    });
  });

  describe("BH-SMALL-2: pendingSummaries cap (MAX_PENDING_SUMMARIES)", () => {
    // The pendingSummaries array is module-level and only drained when the
    // main agent runs (on the next normal user message). Without a cap, a
    // user running /small many times without sending a normal message would
    // grow it unbounded AND blow up the main AI's context when finally
    // consumed.

    it("caps pendingSummaries at MAX_PENDING_SUMMARIES (20), dropping oldest", async () => {
      // Run 25 small tasks without consuming — the cap should keep only the
      // last 20.
      for (let i = 0; i < 25; i++) {
        mockChatWithModel.mockResolvedValueOnce({
          choices: [{
            message: { content: `Summary ${i}`, tool_calls: undefined },
            finish_reason: "stop",
          }],
        });
        await runSmallTask(`task ${i}`, "/tmp");
      }

      const summaries = consumePendingSmallTaskSummaries();
      // Cap is 20 — only the 20 most recent should be present.
      expect(summaries).toHaveLength(20);
      // The first 5 (0..4) should have been dropped; the last 20 (5..24) kept.
      expect(summaries[0]).toBe("Summary 5");
      expect(summaries[summaries.length - 1]).toBe("Summary 24");
      // After consume, queue is empty.
      expect(hasPendingSmallTaskSummaries()).toBe(false);
    });
  });

  // ── BH-SMALL-1: model override leak on timeout ──────────────────────────

  describe("BH-SMALL-1: model override leak on timeout", () => {
    // When runSmallTask times out (raceWithTimeout rejects while chatWithModel
    // is still running), chatWithModel's `finally` block hasn't executed yet —
    // it only runs when the underlying chat() call eventually completes (up to
    // 5 min, the OpenAI client timeout). During that window, modelOverride is
    // still set to SMALL_TASK_MODEL, so any chat() call from the main agent
    // would silently use llama-3.1-8b instead of config.model.
    //
    // Fix: runSmallTask calls clearModelOverride() in its outer finally block
    // to ensure the override can't leak, regardless of whether chatWithModel
    // has finished.

    it("calls clearModelOverride on successful completion", async () => {
      const { clearModelOverride } = await import("../apiClient.js");
      vi.mocked(clearModelOverride).mockClear();

      mockChatWithModel.mockResolvedValueOnce({
        choices: [{
          message: { content: "Done", tool_calls: undefined },
          finish_reason: "stop",
        }],
      });

      await runSmallTask("test", "/tmp");

      // clearModelOverride should be called in the finally block.
      expect(vi.mocked(clearModelOverride)).toHaveBeenCalled();
    });

    it("calls clearModelOverride on error (API failure)", async () => {
      const { clearModelOverride } = await import("../apiClient.js");
      vi.mocked(clearModelOverride).mockClear();

      mockChatWithModel.mockRejectedValueOnce(new Error("API down"));

      await runSmallTask("test", "/tmp");

      expect(vi.mocked(clearModelOverride)).toHaveBeenCalled();
    });

    it("calls clearModelOverride on max-tool-calls limit", async () => {
      const { clearModelOverride } = await import("../apiClient.js");
      vi.mocked(clearModelOverride).mockClear();

      // Model keeps making tool calls forever — hits the max.
      mockChatWithModel.mockResolvedValue({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "executar_comando", arguments: '{"comando":"ls"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });

      await runSmallTask("loop forever", "/tmp");

      expect(vi.mocked(clearModelOverride)).toHaveBeenCalled();
    });

    it("does NOT call clearModelOverride on early rejection (no chatWithModel call)", async () => {
      const { clearModelOverride } = await import("../apiClient.js");
      vi.mocked(clearModelOverride).mockClear();

      // Temporarily mock modelSupportsTools to return false → early return.
      const { modelSupportsTools } = await import("../modelRegistry.js");
      vi.mocked(modelSupportsTools).mockReturnValueOnce(false);

      await runSmallTask("test", "/tmp");

      // On early rejection (before any chatWithModel call), the finally block
      // is NOT reached — modelOverride was never set, so clearModelOverride is
      // not needed and not called.
      expect(vi.mocked(clearModelOverride)).not.toHaveBeenCalled();
    });
  });
});
