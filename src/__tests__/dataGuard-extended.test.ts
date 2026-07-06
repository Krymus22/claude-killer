/**
 * dataGuard-extended.test.ts — Extended tests for dataGuard.ts
 *
 * Covers:
 *   - resetDataGuardState()
 *   - runDataGuard: empty filesModified → returns early, no API call
 *   - runDataGuard: LLM API failure → returns shouldBlock=false, completed=false
 *   - runDataGuard: success path with no findings → returns shouldBlock=false
 *   - runDataGuard: success path with findings → shouldBlock=true
 *   - DataGuardResult type contract
 *
 * Mocks: logger, apiClient.chat, activityTracker.pushActivity, bugHunter.formatBugHuntMessage
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
}));

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(() => () => {}),
}));

vi.mock("../bugHunter.js", () => ({
  formatBugHuntMessage: vi.fn((findings: any[]) =>
    `[DATAGUARD MSG] ${findings.length} finding(s)`),
}));

import { runDataGuard, resetDataGuardState, type DataGuardResult } from "../dataGuard.js";
import { chat } from "../apiClient.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetDataGuardState();
});

describe("runDataGuard — empty filesModified", () => {
  it("returns shouldBlock=false and completed=false without calling chat", async () => {
    const result = await runDataGuard([], "request", "response");
    expect(result.shouldBlock).toBe(false);
    expect(result.completed).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.message).toBe("");
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("runDataGuard — LLM API failure", () => {
  it("returns shouldBlock=false, completed=false when all retries fail", async () => {
    (chat as any).mockRejectedValue(new Error("API unavailable"));
    const result = await runDataGuard(["/tmp/x.luau"], "req", "resp");
    expect(result.shouldBlock).toBe(false);
    expect(result.completed).toBe(false);
    expect(chat).toHaveBeenCalled();
  });

  it("returns shouldBlock=false when chat returns no choices", async () => {
    (chat as any).mockResolvedValue({});
    const result = await runDataGuard(["/tmp/x.luau"], "req", "resp");
    expect(result.shouldBlock).toBe(false);
    expect(result.completed).toBe(false);
  });
});

describe("runDataGuard — short response (rejected)", () => {
  it("returns completed=false when final content is too short", async () => {
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });
    const result = await runDataGuard(["/tmp/x.luau"], "req", "resp");
    expect(result.completed).toBe(false);
    expect(result.shouldBlock).toBe(false);
  });
});

describe("runDataGuard — PASS verdict (no findings)", () => {
  it("returns shouldBlock=false when LLM says VERDICT: PASS", async () => {
    (chat as any).mockResolvedValue({
      choices: [{
        message: {
          content: "I reviewed the file. No data protection issues found. VERDICT: PASS",
        },
        finish_reason: "stop",
      }],
    });
    const result = await runDataGuard(["/tmp/x.luau"], "req", "resp");
    expect(result.shouldBlock).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.completed).toBe(true);
  });

  it("returns message containing 'No data protection' when no findings", async () => {
    (chat as any).mockResolvedValue({
      choices: [{
        message: { content: "Clean code. No issues. VERDICT: PASS" },
        finish_reason: "stop",
      }],
    });
    const result = await runDataGuard(["/tmp/x.luau"], "req", "resp");
    expect(result.message).toContain("No data protection");
  });
});

describe("runDataGuard — BLOCK verdict (with findings)", () => {
  it("returns shouldBlock=true when LLM returns findings", async () => {
    (chat as any).mockResolvedValue({
      choices: [{
        message: {
          content:
            "[CRITICAL] file.luau:5 — SetAsync without GetAsync\n" +
            "Fix: use UpdateAsync instead\n" +
            "VERDICT: BLOCK",
        },
        finish_reason: "stop",
      }],
    });
    const result = await runDataGuard(["/tmp/x.luau"], "req", "resp");
    expect(result.shouldBlock).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.completed).toBe(true);
  });

  it("formats a message containing the DATAGUARD prefix when blocking", async () => {
    (chat as any).mockResolvedValue({
      choices: [{
        message: {
          content:
            "[HIGH] file.luau:10 — RemoveAsync without backup\n" +
            "Fix: add backup\n" +
            "VERDICT: BLOCK",
        },
        finish_reason: "stop",
      }],
    });
    const result = await runDataGuard(["/tmp/x.luau"], "req", "resp");
    expect(result.message).toContain("[DATAGUARD]");
  });
});

describe("runDataGuard — result shape", () => {
  it("always returns an object with required fields", async () => {
    (chat as any).mockResolvedValue({
      choices: [{
        message: { content: "Clean. VERDICT: PASS" },
        finish_reason: "stop",
      }],
    });
    const result = await runDataGuard(["/tmp/x.luau"], "req", "resp");
    expect(result).toHaveProperty("shouldBlock");
    expect(result).toHaveProperty("findings");
    expect(result).toHaveProperty("message");
    expect(result).toHaveProperty("completed");
  });

  it("findings is always an array", async () => {
    (chat as any).mockResolvedValue({
      choices: [{
        message: { content: "Clean. VERDICT: PASS" },
        finish_reason: "stop",
      }],
    });
    const result = await runDataGuard(["/tmp/x.luau"], "req", "resp");
    expect(Array.isArray(result.findings)).toBe(true);
  });
});

describe("resetDataGuardState", () => {
  it("does not throw", () => {
    expect(() => resetDataGuardState()).not.toThrow();
  });

  it("can be called multiple times", () => {
    resetDataGuardState();
    resetDataGuardState();
    expect(true).toBe(true);
  });
});

describe("DataGuardResult type contract", () => {
  it("accepts the documented shape", () => {
    const r: DataGuardResult = {
      shouldBlock: false,
      findings: [],
      message: "",
      completed: false,
    };
    expect(r.shouldBlock).toBe(false);
    expect(r.findings).toEqual([]);
    expect(r.message).toBe("");
    expect(r.completed).toBe(false);
  });

  it("accepts a blocked result with findings", () => {
    const r: DataGuardResult = {
      shouldBlock: true,
      findings: [
        {
          severity: "critical",
          file: "x.luau",
          line: "5",
          description: "SetAsync without GetAsync",
          suggestion: "use UpdateAsync",
        },
      ],
      message: "[DATAGUARD] blocked",
      completed: true,
    };
    expect(r.shouldBlock).toBe(true);
    expect(r.findings.length).toBe(1);
  });
});

describe("runDataGuard — handles non-existent files", () => {
  it("does not crash when filesModified contains non-existent paths", async () => {
    (chat as any).mockResolvedValue({
      choices: [{
        message: { content: "No issues found in the (non-existent) file. VERDICT: PASS" },
        finish_reason: "stop",
      }],
    });
    const result = await runDataGuard(
      ["/tmp/__definitely_not_here__.luau"],
      "req",
      "resp",
    );
    expect(result.completed).toBe(true);
    expect(result.findings).toEqual([]);
  });
});

describe("runDataGuard — truncates userRequest and agentResponse in context", () => {
  it("does not throw with very long request/response strings", async () => {
    (chat as any).mockResolvedValue({
      choices: [{
        message: { content: "Clean. VERDICT: PASS" },
        finish_reason: "stop",
      }],
    });
    const longReq = "R".repeat(10_000);
    const longResp = "A".repeat(10_000);
    const result = await runDataGuard(["/tmp/x.luau"], longReq, longResp);
    expect(result.completed).toBe(true);
    // Verify chat was called
    expect(chat).toHaveBeenCalled();
    // The first chat call's second message (user) should NOT contain the full 10000-char strings
    const firstCallArgs = (chat as any).mock.calls[0][0];
    const userMsg = firstCallArgs[1].content;
    expect(userMsg).not.toContain("R".repeat(600));
    expect(userMsg).not.toContain("A".repeat(600));
  });
});
