/**
 * goalVerifier-extended.test.ts — Extended tests for goalVerifier.ts
 *
 * Covers:
 *   - verifyGoalCompletion: JSON parse success, fallback keyword path, API failure
 *   - verifyGoalCompletion: truncation of long inputs
 *   - verifyGoalCompletion: edge cases (empty content, no choices, malformed JSON)
 *   - formatGoalVerification: done=true, done=false with missing items, done=false without missing items
 *   - GoalVerifyResult type contract
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

import { verifyGoalCompletion, formatGoalVerification, type GoalVerifyResult } from "../goalVerifier.js";
import { chat } from "../apiClient.js";

describe("verifyGoalCompletion — JSON parse path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns done=true when LLM JSON confirms done", async () => {
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: '{"done": true, "missing": [], "reasoning": "ok"}' } }],
    });
    const r = await verifyGoalCompletion("task", ["f.ts"], "done");
    expect(r.done).toBe(true);
    expect(r.missingItems).toEqual([]);
    expect(r.verified).toBe(true);
    expect(r.reasoning).toBe("ok");
  });

  it("returns done=false with missing items list", async () => {
    (chat as any).mockResolvedValue({
      choices: [{
        message: {
          content: '{"done": false, "missing": ["a", "b"], "reasoning": "incomplete"}',
        },
      }],
    });
    const r = await verifyGoalCompletion("task", ["f.ts"], "partial");
    expect(r.done).toBe(false);
    expect(r.missingItems).toEqual(["a", "b"]);
    expect(r.verified).toBe(true);
  });

  it("extracts JSON even when surrounded by markdown fences", async () => {
    (chat as any).mockResolvedValue({
      choices: [{
        message: {
          content: 'Here is the verdict:\n```json\n{"done": true, "missing": [], "reasoning": "x"}\n```\nThanks.',
        },
      }],
    });
    const r = await verifyGoalCompletion("task", ["f.ts"], "done");
    expect(r.done).toBe(true);
    expect(r.verified).toBe(true);
  });

  it("coerces non-boolean 'done' to false (only true === true)", async () => {
    (chat as any).mockResolvedValue({
      choices: [{
        message: { content: '{"done": "yes", "missing": [], "reasoning": "x"}' },
      }],
    });
    const r = await verifyGoalCompletion("task", ["f.ts"], "done");
    expect(r.done).toBe(false); // "yes" !== true
  });

  it("coerces non-array 'missing' to empty array", async () => {
    (chat as any).mockResolvedValue({
      choices: [{
        message: { content: '{"done": true, "missing": "not an array", "reasoning": "x"}' },
      }],
    });
    const r = await verifyGoalCompletion("task", ["f.ts"], "done");
    expect(r.missingItems).toEqual([]);
  });

  it("coerces non-string 'reasoning' to empty string", async () => {
    (chat as any).mockResolvedValue({
      choices: [{
        message: { content: '{"done": true, "missing": [], "reasoning": 123}' },
      }],
    });
    const r = await verifyGoalCompletion("task", ["f.ts"], "done");
    expect(r.reasoning).toBe("");
  });
});

describe("verifyGoalCompletion — fallback keyword path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses keyword fallback when content has no JSON", async () => {
    (chat as any).mockResolvedValue({
      choices: [{
        message: { content: "After review, the task is NOT_COMPLETE because tests are missing." },
      }],
    });
    const r = await verifyGoalCompletion("task", ["f.ts"], "done");
    expect(r.done).toBe(false);
    expect(r.verified).toBe(true);
  });

  it("keyword fallback returns done=true when no negative keywords present", async () => {
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: "Everything looks good, task is complete." } }],
    });
    const r = await verifyGoalCompletion("task", ["f.ts"], "done");
    expect(r.done).toBe(true);
    expect(r.verified).toBe(true);
  });

  it("keyword fallback treats 'missing' as not-done", async () => {
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: "There are missing items." } }],
    });
    const r = await verifyGoalCompletion("task", ["f.ts"], "done");
    expect(r.done).toBe(false);
  });
});

describe("verifyGoalCompletion — error / edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns done=true + verified=false when chat() throws", async () => {
    (chat as any).mockRejectedValue(new Error("net error"));
    const r = await verifyGoalCompletion("task", ["f.ts"], "done");
    expect(r.done).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.reasoning).toContain("VERIFIER UNAVAILABLE");
    expect(r.reasoning).toContain("net error");
  });

  it("returns done=true + verified=true when choices is empty/undefined", async () => {
    (chat as any).mockResolvedValue({});
    const r = await verifyGoalCompletion("task", ["f.ts"], "done");
    expect(r.done).toBe(true);
    expect(r.verified).toBe(true);
  });

  it("returns done=true when content is empty string", async () => {
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: "" } }],
    });
    const r = await verifyGoalCompletion("task", ["f.ts"], "done");
    expect(r.done).toBe(true);
    expect(r.verified).toBe(true);
  });

  it("returns done=true when content is malformed JSON without keywords", async () => {
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: "{'bad json': true," } }],
    });
    const r = await verifyGoalCompletion("task", ["f.ts"], "done");
    // indexOf("{") finds it, lastIndexOf("}") doesn't (no closing) → fallback path
    // lower content has no negative keywords → done=true
    expect(r.done).toBe(true);
  });

  it("handles very long user request (truncated to 500 chars)", async () => {
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: '{"done": true, "missing": [], "reasoning": "ok"}' } }],
    });
    const longRequest = "R".repeat(2000);
    await verifyGoalCompletion(longRequest, ["f.ts"], "done");
    expect(chat).toHaveBeenCalledTimes(1);
    const callArgs = (chat as any).mock.calls[0][0];
    const userMessage = callArgs[1].content;
    expect(userMessage).toContain("USER REQUEST:");
    // The 2000-char request should be truncated to 500 chars in the prompt
    expect(userMessage).not.toContain("R".repeat(600));
  });

  it("handles very long agent response (truncated to 2000 chars)", async () => {
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: '{"done": true, "missing": [], "reasoning": "ok"}' } }],
    });
    const longResp = "A".repeat(10_000);
    await verifyGoalCompletion("task", ["f.ts"], longResp);
    const callArgs = (chat as any).mock.calls[0][0];
    const userMessage = callArgs[1].content;
    expect(userMessage).not.toContain("A".repeat(2500));
  });

  it("includes all modified files in the prompt", async () => {
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: '{"done": true, "missing": [], "reasoning": "ok"}' } }],
    });
    await verifyGoalCompletion("task", ["a.ts", "b.ts", "c.ts"], "done");
    const callArgs = (chat as any).mock.calls[0][0];
    const userMessage = callArgs[1].content;
    expect(userMessage).toContain("a.ts");
    expect(userMessage).toContain("b.ts");
    expect(userMessage).toContain("c.ts");
  });

  it("handles empty modifiedFiles array", async () => {
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: '{"done": true, "missing": [], "reasoning": "ok"}' } }],
    });
    const r = await verifyGoalCompletion("task", [], "done");
    expect(r.verified).toBe(true);
  });
});

describe("formatGoalVerification — done=true", () => {
  it("returns a string containing 'GOAL VERIFIED'", () => {
    const msg = formatGoalVerification({
      done: true,
      missingItems: [],
      reasoning: "all good",
      verified: true,
    });
    expect(typeof msg).toBe("string");
    expect(msg).toContain("GOAL VERIFIED");
  });

  it("does not include missing items when done=true even if provided", () => {
    const msg = formatGoalVerification({
      done: true,
      missingItems: ["ghost"],
      reasoning: "ok",
      verified: true,
    });
    expect(msg).not.toContain("ghost");
  });

  it("does not include reasoning when done=true", () => {
    const msg = formatGoalVerification({
      done: true,
      missingItems: [],
      reasoning: "secret reasoning",
      verified: true,
    });
    expect(msg).not.toContain("secret reasoning");
  });
});

describe("formatGoalVerification — done=false", () => {
  it("returns a string containing 'GOAL NOT VERIFIED'", () => {
    const msg = formatGoalVerification({
      done: false,
      missingItems: [],
      reasoning: "incomplete",
      verified: true,
    });
    expect(msg).toContain("GOAL NOT VERIFIED");
  });

  it("includes reasoning text", () => {
    const msg = formatGoalVerification({
      done: false,
      missingItems: [],
      reasoning: "tests not run",
      verified: true,
    });
    expect(msg).toContain("tests not run");
  });

  it("includes missing items when present", () => {
    const msg = formatGoalVerification({
      done: false,
      missingItems: ["alpha", "beta"],
      reasoning: "x",
      verified: true,
    });
    expect(msg).toContain("alpha");
    expect(msg).toContain("beta");
    expect(msg).toContain("Itens faltantes");
  });

  it("does not include 'Itens faltantes' section when missingItems is empty", () => {
    const msg = formatGoalVerification({
      done: false,
      missingItems: [],
      reasoning: "x",
      verified: true,
    });
    expect(msg).not.toContain("Itens faltantes");
  });

  it("includes 'NÃO finalize' instruction", () => {
    const msg = formatGoalVerification({
      done: false,
      missingItems: ["x"],
      reasoning: "x",
      verified: true,
    });
    expect(msg).toMatch(/N[Ãã]O finalize/i);
  });
});

describe("GoalVerifyResult type contract", () => {
  it("accepts the documented shape", () => {
    const r: GoalVerifyResult = {
      done: true,
      missingItems: [],
      reasoning: "x",
      verified: true,
    };
    expect(r.done).toBe(true);
    expect(r.missingItems).toEqual([]);
    expect(r.reasoning).toBe("x");
    expect(r.verified).toBe(true);
  });
});
