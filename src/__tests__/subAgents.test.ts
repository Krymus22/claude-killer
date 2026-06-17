/**
 * subAgents.test.ts — Tests for IDEIA 5 (sub-agents in-process).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
}));

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
  isTransientNetworkErrorPublic: vi.fn((err: any) => {
    const code = err?.code ?? err?.cause?.code;
    return typeof code === "string" && ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "ECONNREFUSED", "EAI_AGAIN"].includes(code);
  }),
  is429ErrorPublic: vi.fn((err: any) => err?.status === 429),
  SUB_AGENT_MAX_CHAT_RETRIES: 2,
}));

vi.mock("../tools.js", () => ({
  lerArquivo: vi.fn().mockResolvedValue("file content mock"),
}));

vi.mock("../fileSearch.js", () => ({
  globSearch: vi.fn(),
}));

vi.mock("../contentSearch.js", () => ({
  grepSearch: vi.fn(),
  formatGrepResults: vi.fn(),
}));

vi.mock("../lspAst.ts", () => ({
  parseFile: vi.fn(),
}));

vi.mock("../effortLevels.js", () => ({
  shouldUseSubAgents: vi.fn().mockReturnValue(true),
}));

import { runSubAgent, shouldDelegateToSubAgent } from "../subAgents.js";
import { chat } from "../apiClient.js";
import { shouldUseSubAgents } from "../effortLevels.js";

const mockedChat = chat as ReturnType<typeof vi.fn>;
const mockedShouldUse = shouldUseSubAgents as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedChat.mockReset();
  mockedShouldUse.mockReturnValue(true);
});

describe("subAgents", () => {
  describe("shouldDelegateToSubAgent", () => {
    it("returns true for exploration triggers", () => {
      mockedShouldUse.mockReturnValue(true);
      expect(shouldDelegateToSubAgent("understand how the auth system works")).toBe(true);
      expect(shouldDelegateToSubAgent("find all places that call function X")).toBe(true);
      expect(shouldDelegateToSubAgent("entenda como o parser funciona")).toBe(true);
      expect(shouldDelegateToSubAgent("encontre todos os usos de foo")).toBe(true);
      expect(shouldDelegateToSubAgent("explore the codebase structure")).toBe(true);
      expect(shouldDelegateToSubAgent("investigate the bug")).toBe(true);
    });

    it("returns false for non-exploration messages", () => {
      expect(shouldDelegateToSubAgent("fix this bug")).toBe(false);
      expect(shouldDelegateToSubAgent("add a new function")).toBe(false);
      expect(shouldDelegateToSubAgent("hello")).toBe(false);
    });

    it("returns false when effort is too low", () => {
      mockedShouldUse.mockReturnValue(false);
      expect(shouldDelegateToSubAgent("understand how X works")).toBe(false);
    });
  });

  describe("runSubAgent", () => {
    it("returns null when sub-agents are disabled (low effort)", async () => {
      mockedShouldUse.mockReturnValue(false);
      const result = await runSubAgent({ question: "test" });
      expect(result).toBeNull();
      expect(mockedChat).not.toHaveBeenCalled();
    });

    it("returns the model's final answer when finish_reason is not tool_calls", async () => {
      mockedChat.mockResolvedValueOnce({
        choices: [{
          message: { content: "## Summary\nFound X in foo.ts", tool_calls: undefined },
          finish_reason: "stop",
        }],
      });
      const result = await runSubAgent({ question: "where is X defined?" });
      expect(result).toBe("## Summary\nFound X in foo.ts");
    });

    it("returns null when model produces empty content", async () => {
      mockedChat.mockResolvedValueOnce({
        choices: [{
          message: { content: "", tool_calls: undefined },
          finish_reason: "stop",
        }],
      });
      const result = await runSubAgent({ question: "where is X?" });
      expect(result).toBeNull();
    });

    it("returns null when chat throws", async () => {
      mockedChat.mockRejectedValueOnce(new Error("API down"));
      const result = await runSubAgent({ question: "test" });
      expect(result).toBeNull();
    });

    it("returns null when maxToolCalls is exceeded without finishing", async () => {
      // Always returns another tool call — never finishes
      mockedChat.mockResolvedValue({
        choices: [{
          message: {
            content: "",
            tool_calls: [{ id: "tc1", type: "function", function: { name: "ler_arquivo", arguments: '{"caminho":"/x"}' } }],
          },
          finish_reason: "tool_calls",
        }],
      });
      const result = await runSubAgent({ question: "explore", maxToolCalls: 2 });
      expect(result).toBeNull();
    });

    it("passes the question in the user message", async () => {
      mockedChat.mockResolvedValueOnce({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
      });
      await runSubAgent({ question: "find all TODO comments" });
      const callArgs = mockedChat.mock.calls[0];
      const messages = callArgs[0];
      const userMsg = messages.find((m: any) => m.role === "user");
      expect(userMsg.content).toContain("find all TODO comments");
    });

    it("includes the system prompt that limits the sub-agent to read-only tools", async () => {
      mockedChat.mockResolvedValueOnce({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
      });
      await runSubAgent({ question: "test" });
      const callArgs = mockedChat.mock.calls[0];
      const messages = callArgs[0];
      const systemMsg = messages.find((m: any) => m.role === "system");
      expect(systemMsg.content).toContain("read tools");
      expect(systemMsg.content).toContain("CANNOT edit");
      expect(systemMsg.content).toContain("500-2000 tokens");
    });
  });

  describe("runSubAgent — retry wrapper (Ponto 1)", () => {
    it("retries the same call after transient network error (ECONNRESET)", async () => {
      const err: any = new Error("socket hang up");
      err.code = "ECONNRESET";
      mockedChat
        .mockRejectedValueOnce(err) // call 1: ECONNRESET (transient)
        .mockResolvedValueOnce({   // retry call 1: success
          choices: [{ message: { content: "## Summary\nRecovered" }, finish_reason: "stop" }],
        });
      const result = await runSubAgent({ question: "test", maxToolCalls: 3 });
      expect(result).toBe("## Summary\nRecovered");
      // chat() was called 2 times (1 fail + 1 success)
      expect(mockedChat).toHaveBeenCalledTimes(2);
    });

    it("retries the same call after 429 error", async () => {
      const err: any = new Error("rate limited");
      err.status = 429;
      mockedChat
        .mockRejectedValueOnce(err) // call 1: 429
        .mockResolvedValueOnce({   // retry: success
          choices: [{ message: { content: "## Summary\nOK" }, finish_reason: "stop" }],
        });
      const result = await runSubAgent({ question: "test" });
      expect(result).toBe("## Summary\nOK");
      expect(mockedChat).toHaveBeenCalledTimes(2);
    });

    it("gives up after SUB_AGENT_MAX_CHAT_RETRIES (2) consecutive transient failures", async () => {
      const err: any = new Error("socket hang up");
      err.code = "ECONNRESET";
      mockedChat
        .mockRejectedValue(err) // all calls fail with ECONNRESET
      ;
      const result = await runSubAgent({ question: "test" });
      expect(result).toBeNull();
      // 1 initial attempt + 2 retries = 3 total chat() calls
      expect(mockedChat).toHaveBeenCalledTimes(3);
    });

    it("does NOT retry on non-transient errors (e.g. model error)", async () => {
      const err = new Error("model returned malformed response");
      mockedChat.mockRejectedValueOnce(err);
      const result = await runSubAgent({ question: "test" });
      expect(result).toBeNull();
      // Only 1 call — no retry on non-transient error
      expect(mockedChat).toHaveBeenCalledTimes(1);
    });

    it("resets consecutiveFailures counter after a successful call", async () => {
      const err: any = new Error("socket hang up");
      err.code = "ECONNRESET";
      mockedChat
        .mockRejectedValueOnce(err)              // call 1: fail (transient)
        .mockResolvedValueOnce({                 // retry call 1: success with tool_calls
          choices: [{
            message: { content: "", tool_calls: [{ id: "tc1", type: "function", function: { name: "ler_arquivo", arguments: '{"caminho":"/x"}' } }] },
            finish_reason: "tool_calls",
          }],
        })
        .mockResolvedValueOnce({                 // call 2: success (final)
          choices: [{ message: { content: "## Summary\nDone" }, finish_reason: "stop" }],
        });
      const result = await runSubAgent({ question: "test", maxToolCalls: 5 });
      expect(result).toBe("## Summary\nDone");
      expect(mockedChat).toHaveBeenCalledTimes(3);
    });
  });

  describe("runSubAgent — checkpoint restore (Ponto 2)", () => {
    it("does NOT lose history from previous successful calls when retrying", async () => {
      const err: any = new Error("socket hang up");
      err.code = "ECONNRESET";
      mockedChat
        .mockResolvedValueOnce({  // call 1: success with tool_calls
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "tc1", type: "function", function: { name: "ler_arquivo", arguments: '{"caminho":"/x"}' } }],
            },
            finish_reason: "tool_calls",
          }],
        })
        .mockRejectedValueOnce(err)  // call 2: transient failure
        .mockResolvedValueOnce({     // retry call 2: success (final)
          choices: [{ message: { role: "assistant", content: "## Summary\nRecovered with prior context" }, finish_reason: "stop" }],
        });

      const result = await runSubAgent({ question: "test", maxToolCalls: 5 });

      expect(result).toBe("## Summary\nRecovered with prior context");

      // The 3rd call to chat() (the retry) should include the history from call 1:
      // [system, user, assistant(tool_calls), tool(result), ...]
      const retryCallArgs = mockedChat.mock.calls[2];
      const retryMessages = retryCallArgs[0];
      // Should have at least 4 messages: system + user + assistant + tool result
      expect(retryMessages.length).toBeGreaterThanOrEqual(4);
      // The assistant message with tool_calls should still be there (preserved by checkpoint)
      const assistantMsg = retryMessages.find((m: any) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.tool_calls).toBeDefined();
      expect(assistantMsg.tool_calls.length).toBeGreaterThan(0);
      // The tool result should be there too
      const toolMsg = retryMessages.find((m: any) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg.tool_call_id).toBe("tc1");
    });
  });
});
