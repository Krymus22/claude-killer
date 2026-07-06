/**
 * safetyReviewer-extended.test.ts — Extended tests for safetyReviewer.ts
 *
 * Covers:
 *   - scanDangerousPatterns: all built-in patterns (RemoveAsync, SetAsync, Destroy, etc.)
 *   - scanDangerousPatterns: returns matched list and hasHighSeverity flag
 *   - shouldReviewFile: .luau, .lua, .ts, .py
 *   - getDangerousPatterns: returns a non-empty array copy
 *   - formatSafetyReview: returns a string for high/low/none risks
 *   - reviewCodeSafety: heuristic-only path (no patterns → no LLM call)
 *   - SafetyRisk / SafetyReviewResult / HeuristicResult type contracts
 *
 * Mocks: apiClient.chat (so reviewCodeSafety never makes real calls when patterns match),
 *        logger, i18n (returns non-empty strings), modeExtensions.getActiveSafetyPatterns
 *        (returns the built-in list so we don't depend on a loaded mode).
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

vi.mock("../i18n.js", () => ({
  t: vi.fn((key: string) => `[i18n:${key}]`),
  default: { t: vi.fn((key: string) => `[i18n:${key}]`) },
}));

// modeExtensions returns the built-in list (re-exported from safetyReviewer source)
vi.mock("../modeExtensions.js", () => ({
  getActiveSafetyPatterns: vi.fn(async () => {
    // Dynamically import to avoid circular dependency issues
    const { getDangerousPatterns } = await import("../safetyReviewer.js");
    return getDangerousPatterns();
  }),
}));

import {
  scanDangerousPatterns,
  scanDangerousPatternsAsync,
  reviewCodeSafety,
  formatSafetyReview,
  shouldReviewFile,
  getDangerousPatterns,
  type SafetyRisk,
  type SafetyReviewResult,
  type HeuristicResult,
} from "../safetyReviewer.js";

describe("scanDangerousPatterns — no matches", () => {
  it("returns empty matched array for safe code", () => {
    const result = scanDangerousPatterns("local x = 1\nprint(x)");
    expect(result.matched).toEqual([]);
    expect(result.hasHighSeverity).toBe(false);
  });

  it("returns empty for empty string", () => {
    const result = scanDangerousPatterns("");
    expect(result.matched).toEqual([]);
  });
});

describe("scanDangerousPatterns — DataStore patterns", () => {
  it("detects :RemoveAsync (high severity)", () => {
    const result = scanDangerousPatterns(`store:RemoveAsync("user_1")`);
    expect(result.matched.length).toBeGreaterThan(0);
    expect(result.hasHighSeverity).toBe(true);
  });

  it("detects :RemoveAllAsync (high severity)", () => {
    const result = scanDangerousPatterns(`store:RemoveAllAsync()`);
    expect(result.hasHighSeverity).toBe(true);
  });

  it("detects :SetAsync (medium severity, not high)", () => {
    const result = scanDangerousPatterns(`store:SetAsync("k", "v")`);
    expect(result.matched.length).toBeGreaterThan(0);
    // SetAsync alone is medium — should not flag high
    // But if RemoveAllAsync etc are not present, hasHighSeverity is false
    expect(result.hasHighSeverity).toBe(false);
  });

  it("detects :UpdateAsync", () => {
    const result = scanDangerousPatterns(`store:UpdateAsync("k", function() end)`);
    expect(result.matched.length).toBeGreaterThan(0);
  });

  it("detects multiple patterns at once", () => {
    const code = `
      store:SetAsync("k", "v")
      store:RemoveAsync("k2")
    `;
    const result = scanDangerousPatterns(code);
    expect(result.matched.length).toBeGreaterThanOrEqual(2);
    expect(result.hasHighSeverity).toBe(true);
  });
});

describe("scanDangerousPatterns — instance destruction", () => {
  it("detects :ClearAllChildren (high severity)", () => {
    const result = scanDangerousPatterns(`parent:ClearAllChildren()`);
    expect(result.hasHighSeverity).toBe(true);
  });

  it("detects :Destroy (medium severity)", () => {
    const result = scanDangerousPatterns(`part:Destroy()`);
    expect(result.matched.length).toBeGreaterThan(0);
  });

  it("detects :Remove (medium severity, deprecated)", () => {
    const result = scanDangerousPatterns(`part:Remove()`);
    expect(result.matched.length).toBeGreaterThan(0);
  });
});

describe("scanDangerousPatterns — ProfileStore / Replica patterns", () => {
  it("detects profile.Data = (high severity)", () => {
    const result = scanDangerousPatterns(`profile.Data = {}`);
    expect(result.hasHighSeverity).toBe(true);
  });

  it("detects profile.Data.X = (medium severity)", () => {
    const result = scanDangerousPatterns(`profile.Data.gold = 100`);
    expect(result.matched.length).toBeGreaterThan(0);
  });

  it("detects replica.Data = (high severity)", () => {
    const result = scanDangerousPatterns(`replica.Data = {}`);
    expect(result.hasHighSeverity).toBe(true);
  });
});

describe("scanDangerousPatterns — HTTP patterns", () => {
  it("detects :PostAsync", () => {
    const result = scanDangerousPatterns(`http:PostAsync(url, data)`);
    expect(result.matched.length).toBeGreaterThan(0);
  });

  it("detects :DeleteAsync (high severity)", () => {
    const result = scanDangerousPatterns(`http:DeleteAsync(url)`);
    expect(result.hasHighSeverity).toBe(true);
  });
});

describe("scanDangerousPatterns — loop patterns", () => {
  it("detects 'while true do'", () => {
    const result = scanDangerousPatterns(`while true do\n  print("x")\nend`);
    expect(result.matched.length).toBeGreaterThan(0);
  });
});

describe("scanDangerousPatterns — idempotency with /g regex", () => {
  it("returns the same result on multiple calls (regex state reset)", () => {
    const code = `store:RemoveAsync("k")`;
    const r1 = scanDangerousPatterns(code);
    const r2 = scanDangerousPatterns(code);
    const r3 = scanDangerousPatterns(code);
    expect(r1.matched.length).toBe(r2.matched.length);
    expect(r2.matched.length).toBe(r3.matched.length);
    expect(r1.hasHighSeverity).toBe(true);
    expect(r3.hasHighSeverity).toBe(true);
  });
});

describe("scanDangerousPatterns — return shape", () => {
  it("returns an object with `matched` array and `hasHighSeverity` boolean", () => {
    const r = scanDangerousPatterns("");
    expect(Array.isArray(r.matched)).toBe(true);
    expect(typeof r.hasHighSeverity).toBe("boolean");
  });

  it("matched entries have description and severity fields", () => {
    const r = scanDangerousPatterns(`store:RemoveAsync("k")`);
    for (const m of r.matched) {
      expect(typeof m.description).toBe("string");
      expect(["low", "medium", "high"]).toContain(m.severity);
    }
  });
});

describe("scanDangerousPatternsAsync", () => {
  it("returns the same shape as the sync version", async () => {
    const r = await scanDangerousPatternsAsync(`store:RemoveAsync("k")`);
    expect(Array.isArray(r.matched)).toBe(true);
    expect(typeof r.hasHighSeverity).toBe("boolean");
    expect(r.hasHighSeverity).toBe(true);
  });

  it("returns empty for safe code", async () => {
    const r = await scanDangerousPatternsAsync("local x = 1");
    expect(r.matched).toEqual([]);
  });
});

describe("shouldReviewFile", () => {
  it("returns true for .luau files", () => {
    expect(shouldReviewFile("foo.luau")).toBe(true);
  });

  it("returns true for .lua files", () => {
    expect(shouldReviewFile("foo.lua")).toBe(true);
  });

  it("returns false for .ts files", () => {
    expect(shouldReviewFile("foo.ts")).toBe(false);
  });

  it("returns false for .py files", () => {
    expect(shouldReviewFile("foo.py")).toBe(false);
  });

  it("returns false for .js files", () => {
    expect(shouldReviewFile("foo.js")).toBe(false);
  });

  it("is case-insensitive for .LUAU", () => {
    expect(shouldReviewFile("FOO.LUAU")).toBe(true);
  });

  it("is case-insensitive for .LUA", () => {
    expect(shouldReviewFile("FOO.LUA")).toBe(true);
  });
});

describe("getDangerousPatterns", () => {
  it("returns a non-empty array", () => {
    const patterns = getDangerousPatterns();
    expect(Array.isArray(patterns)).toBe(true);
    expect(patterns.length).toBeGreaterThan(0);
  });

  it("returns a copy (mutating doesn't affect future calls)", () => {
    const p1 = getDangerousPatterns();
    const originalLen = p1.length;
    p1.pop();
    p1.push({ regex: /x/g, description: "x", severity: "low" });
    const p2 = getDangerousPatterns();
    expect(p2.length).toBe(originalLen);
  });

  it("each pattern has regex, description, severity", () => {
    for (const p of getDangerousPatterns()) {
      expect(p.regex).toBeInstanceOf(RegExp);
      expect(typeof p.description).toBe("string");
      expect(["low", "medium", "high"]).toContain(p.severity);
    }
  });
});

describe("reviewCodeSafety — no patterns path (no LLM call)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns risk=none when no patterns matched and does NOT call LLM", async () => {
    const { chat } = await import("../apiClient.js");
    const result = await reviewCodeSafety("local x = 1\nprint(x)", "f.luau");
    expect(result.risk).toBe("none");
    expect(result.reviewedByLlm).toBe(false);
    expect(result.patternsMatched).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it("returns a numeric durationMs >= 0", async () => {
    const result = await reviewCodeSafety("local x = 1", "f.luau");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns a non-empty reasoning string", async () => {
    const result = await reviewCodeSafety("local x = 1", "f.luau");
    expect(typeof result.reasoning).toBe("string");
    expect(result.reasoning.length).toBeGreaterThan(0);
  });
});

describe("reviewCodeSafety — with patterns (LLM call)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls LLM when patterns match and returns its verdict (low risk)", async () => {
    const { chat } = await import("../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{
        message: { content: '{"risk": "low", "reasoning": "safe read"}' },
      }],
    });
    const result = await reviewCodeSafety(`store:SetAsync("k", "v")`, "f.luau");
    expect(chat).toHaveBeenCalled();
    expect(result.reviewedByLlm).toBe(true);
    expect(result.risk).toBe("low");
    expect(result.patternsMatched.length).toBeGreaterThan(0);
  });

  it("calls LLM and returns high risk verdict", async () => {
    const { chat } = await import("../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{
        message: { content: '{"risk": "high", "reasoning": "destructive op"}' },
      }],
    });
    const result = await reviewCodeSafety(`store:RemoveAsync("k")`, "f.luau");
    expect(result.risk).toBe("high");
    expect(result.reviewedByLlm).toBe(true);
  });

  it("falls back to 'low' risk when LLM throws (does not block)", async () => {
    const { chat } = await import("../apiClient.js");
    (chat as any).mockRejectedValue(new Error("net"));
    const result = await reviewCodeSafety(`store:RemoveAsync("k")`, "f.luau");
    expect(result.risk).toBe("low");
    expect(result.reviewedByLlm).toBe(true);
    expect(result.reasoning).toContain("REVIEWER LLM UNAVAILABLE");
  });

  it("parses LLM JSON even when surrounded by prose", async () => {
    const { chat } = await import("../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{
        message: {
          content: 'Here is my review:\n```json\n{"risk": "high", "reasoning": "destructive"}\n```\nDone.',
        },
      }],
    });
    const result = await reviewCodeSafety(`store:RemoveAsync("k")`, "f.luau");
    expect(result.risk).toBe("high");
  });

  it("falls back to keyword matching when JSON parse fails", async () => {
    const { chat } = await import("../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{
        message: { content: "Risk: high — destructive operation detected" },
      }],
    });
    const result = await reviewCodeSafety(`store:RemoveAsync("k")`, "f.luau");
    expect(result.risk).toBe("high");
  });
});

describe("formatSafetyReview — high risk", () => {
  it("returns a non-empty string", () => {
    const result: SafetyReviewResult = {
      risk: "high",
      reasoning: "destructive",
      patternsMatched: ["DataStore:RemoveAsync"],
      reviewedByLlm: true,
      durationMs: 100,
    };
    const msg = formatSafetyReview(result);
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });

  it("includes 'Risk: HIGH'", () => {
    const result: SafetyReviewResult = {
      risk: "high",
      reasoning: "destructive",
      patternsMatched: [],
      reviewedByLlm: true,
      durationMs: 0,
    };
    expect(formatSafetyReview(result)).toContain("Risk: HIGH");
  });

  it("includes the reasoning text", () => {
    const result: SafetyReviewResult = {
      risk: "high",
      reasoning: "permanent deletion risk",
      patternsMatched: [],
      reviewedByLlm: true,
      durationMs: 0,
    };
    expect(formatSafetyReview(result)).toContain("permanent deletion risk");
  });

  it("lists matched patterns", () => {
    const result: SafetyReviewResult = {
      risk: "high",
      reasoning: "x",
      patternsMatched: ["DataStore:RemoveAsync", "Instance:Destroy"],
      reviewedByLlm: true,
      durationMs: 0,
    };
    const msg = formatSafetyReview(result);
    expect(msg).toContain("DataStore:RemoveAsync");
    expect(msg).toContain("Instance:Destroy");
  });
});

describe("formatSafetyReview — low risk", () => {
  it("returns a non-empty string", () => {
    const result: SafetyReviewResult = {
      risk: "low",
      reasoning: "safe read",
      patternsMatched: [],
      reviewedByLlm: false,
      durationMs: 0,
    };
    const msg = formatSafetyReview(result);
    expect(typeof msg).toBe("string");
  });

  it("includes the reasoning", () => {
    const result: SafetyReviewResult = {
      risk: "low",
      reasoning: "additive only",
      patternsMatched: [],
      reviewedByLlm: true,
      durationMs: 0,
    };
    expect(formatSafetyReview(result)).toContain("additive only");
  });
});

describe("formatSafetyReview — none risk", () => {
  it("returns empty string when not reviewed by LLM", () => {
    const result: SafetyReviewResult = {
      risk: "none",
      reasoning: "no patterns",
      patternsMatched: [],
      reviewedByLlm: false,
      durationMs: 0,
    };
    expect(formatSafetyReview(result)).toBe("");
  });

  it("returns a non-empty string when reviewed by LLM (LLM said safe)", () => {
    const result: SafetyReviewResult = {
      risk: "none",
      reasoning: "LLM confirmed safe",
      patternsMatched: ["DataStore:GetAsync"],
      reviewedByLlm: true,
      durationMs: 0,
    };
    const msg = formatSafetyReview(result);
    expect(msg.length).toBeGreaterThan(0);
  });
});

describe("Type contracts", () => {
  it("SafetyRisk union accepts none/low/high", () => {
    const r1: SafetyRisk = "none";
    const r2: SafetyRisk = "low";
    const r3: SafetyRisk = "high";
    expect([r1, r2, r3]).toEqual(["none", "low", "high"]);
  });

  it("SafetyReviewResult has all required fields", () => {
    const r: SafetyReviewResult = {
      risk: "none",
      reasoning: "",
      patternsMatched: [],
      reviewedByLlm: false,
      durationMs: 0,
    };
    expect(r.risk).toBe("none");
  });

  it("HeuristicResult has matched and hasHighSeverity", () => {
    const h: HeuristicResult = { matched: [], hasHighSeverity: false };
    expect(Array.isArray(h.matched)).toBe(true);
    expect(typeof h.hasHighSeverity).toBe("boolean");
  });
});
