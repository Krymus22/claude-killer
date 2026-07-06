/**
 * honestySystem-extended.test.ts — Extended tests for honestySystem.ts
 *
 * Focuses on defensive/type-correct tests for:
 *   - getHonestyFeatures() — registry contents and shape
 *   - extractConfidence() — pure function, multiple formats
 *   - markFileAsEdited / markFileAsReadBack / getUnreadBackFiles / getReadBackWarning
 *   - clearAllHonestyState / resetHonestyTurn
 *   - checkConfidenceAction (feature disabled returns no-block)
 *   - formatGoalVerification not applicable here, but checks message fields
 *   - Type-only checks on interfaces
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

// --- Hoisted mock state for extensionCenter so we can toggle features ---
const featureState = vi.hoisted(() => ({
  enabled: new Set<string>(),
  reset() { this.enabled.clear(); },
  enable(id: string) { this.enabled.add(id); },
  disable(id: string) { this.enabled.delete(id); },
  isEnabled(id: string) { return this.enabled.has(id); },
}));

vi.mock("../extensionCenter.js", () => ({
  getExtension: vi.fn((id: string) => ({
    enabled: featureState.isEnabled(id),
    triggerMode: featureState.isEnabled(id) ? "always" : "disabled",
  })),
}));

import {
  getHonestyFeatures,
  extractConfidence,
  markFileAsEdited,
  markFileAsReadBack,
  getUnreadBackFiles,
  getReadBackWarning,
  hasUnreadBackFiles,
  clearAllHonestyState,
  resetHonestyTurn,
  checkConfidenceAction,
  isHonestyFeatureEnabled,
  checkContradictions,
  checkUserClaims,
  type HonestyFeature,
  type DevilAdvocateResult,
  type DiffCheckResult,
  type HallucinationCheckResult,
  type EvidenceCheckResult,
  type ContradictionResult,
} from "../honestySystem.js";

describe("getHonestyFeatures", () => {
  it("returns an array of HonestyFeature", () => {
    const features = getHonestyFeatures();
    expect(Array.isArray(features)).toBe(true);
    expect(features.length).toBeGreaterThan(0);
    for (const f of features) {
      expect(typeof f.id).toBe("string");
      expect(typeof f.name).toBe("string");
      expect(typeof f.description).toBe("string");
      expect(typeof f.enabled).toBe("boolean");
    }
  });

  it("returns a fresh copy each call (no mutation bleed)", () => {
    const f1 = getHonestyFeatures();
    const f2 = getHonestyFeatures();
    expect(f1).not.toBe(f2);
    expect(f1).toEqual(f2);
  });

  it("contains the 10 known feature IDs", () => {
    const ids = getHonestyFeatures().map((f) => f.id);
    expect(ids).toContain("feature:devils_advocate");
    expect(ids).toContain("feature:diff_reality_check");
    expect(ids).toContain("feature:read_back_verify");
    expect(ids).toContain("feature:hallucination_detector");
    expect(ids).toContain("feature:evidence_requirement");
    expect(ids).toContain("feature:user_claim_verify");
    expect(ids).toContain("feature:confidence_mapping");
    expect(ids).toContain("feature:anonymous_review");
    expect(ids).toContain("feature:contradiction_tracker");
    expect(ids).toContain("feature:prove_it_mode");
    expect(ids.length).toBe(10);
  });

  it("all features start disabled (enabled=false) by default", () => {
    const features = getHonestyFeatures();
    for (const f of features) {
      expect(f.enabled).toBe(false);
    }
  });
});

describe("isHonestyFeatureEnabled", () => {
  beforeEach(() => {
    featureState.reset();
  });

  it("returns false when feature is not enabled", async () => {
    const enabled = await isHonestyFeatureEnabled("feature:devils_advocate");
    expect(enabled).toBe(false);
  });

  it("returns true when feature is enabled in extensionCenter", async () => {
    featureState.enable("feature:devils_advocate");
    const enabled = await isHonestyFeatureEnabled("feature:devils_advocate");
    expect(enabled).toBe(true);
  });

  it("returns false for an unknown feature id", async () => {
    const enabled = await isHonestyFeatureEnabled("feature:does_not_exist");
    expect(enabled).toBe(false);
  });
});

describe("extractConfidence — numeric patterns", () => {
  it("returns 0 when no confidence is mentioned", () => {
    expect(extractConfidence("no confidence mentioned")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(extractConfidence("")).toBe(0);
  });

  it("parses 'confianca: 8' (PT, integer 1-10)", () => {
    expect(extractConfidence("confianca: 8")).toBe(8);
  });

  it("parses 'confiança: 8' (PT with cedilla)", () => {
    expect(extractConfidence("confiança: 8")).toBe(8);
  });

  it("parses 'confidence: 8' (EN)", () => {
    expect(extractConfidence("confidence: 8")).toBe(8);
  });

  it("parses 'confidence: 8/10' (fraction)", () => {
    expect(extractConfidence("confidence: 8/10")).toBe(8);
  });

  it("parses 'confianca: 80%' (percent, normalized to /10)", () => {
    expect(extractConfidence("confianca: 80%")).toBe(8);
  });

  it("parses 'confidence: 0.8' (decimal 0-1)", () => {
    expect(extractConfidence("confidence: 0.8")).toBe(8);
  });

  it("distinguishes integer '1' from decimal '1.0' (audit fix)", () => {
    // 1 means 1/10 (low), 1.0 means 10/10 (max) — see comment in source
    expect(extractConfidence("confianca: 1")).toBe(1);
    expect(extractConfidence("confianca: 1.0")).toBe(10);
  });

  it("clamps values to [1, 10]", () => {
    expect(extractConfidence("confianca: 100")).toBe(10);
    expect(extractConfidence("confianca: 999")).toBe(10);
    expect(extractConfidence("confianca: 0")).toBe(1);
  });

  it("accepts '=' as separator", () => {
    expect(extractConfidence("confidence=7")).toBe(7);
  });
});

describe("extractConfidence — qualitative patterns", () => {
  it("parses 'confidence: high'", () => {
    expect(extractConfidence("confidence: high")).toBe(9);
  });

  it("parses 'confidence: medium'", () => {
    expect(extractConfidence("confidence: medium")).toBe(6);
  });

  it("parses 'confidence: low'", () => {
    expect(extractConfidence("confidence: low")).toBe(3);
  });

  it("parses PT 'confianca: alta'", () => {
    expect(extractConfidence("confianca: alta")).toBe(9);
  });

  it("parses PT 'confianca: baixa'", () => {
    expect(extractConfidence("confianca: baixa")).toBe(3);
  });

  it("returns 0 for unknown qualitative word", () => {
    expect(extractConfidence("confidence: maybe")).toBe(0);
  });
});

describe("extractConfidence — edge cases", () => {
  it("is case-insensitive for confidence label", () => {
    expect(extractConfidence("CONFIDENCE: 7")).toBe(7);
    expect(extractConfidence("Confidence: 7")).toBe(7);
  });

  it("returns a number always", () => {
    expect(typeof extractConfidence("anything")).toBe("number");
  });

  it("handles strings without colons", () => {
    expect(extractConfidence("confidence 7")).toBe(0); // no separator
  });

  it("returns 0 for totally unrelated text", () => {
    expect(extractConfidence("the quick brown fox")).toBe(0);
  });
});

describe("Read-back verification state", () => {
  beforeEach(() => {
    clearAllHonestyState();
    featureState.reset();
    featureState.enable("feature:read_back_verify");
  });

  it("starts with empty unread list", () => {
    expect(getUnreadBackFiles()).toEqual([]);
    expect(getReadBackWarning()).toBe("");
  });

  it("markFileAsEdited adds file to unread list", () => {
    markFileAsEdited("/tmp/file_a.ts");
    const unread = getUnreadBackFiles();
    expect(unread.length).toBe(1);
    expect(unread.some((f) => f.endsWith("file_a.ts"))).toBe(true);
  });

  it("markFileAsReadBack removes file from unread list", () => {
    markFileAsEdited("/tmp/file_b.ts");
    expect(getUnreadBackFiles().length).toBe(1);
    markFileAsReadBack("/tmp/file_b.ts");
    expect(getUnreadBackFiles().length).toBe(0);
  });

  it("getReadBackWarning returns non-empty string when files are unread", () => {
    markFileAsEdited("/tmp/file_c.ts");
    const warning = getReadBackWarning();
    expect(typeof warning).toBe("string");
    expect(warning.length).toBeGreaterThan(0);
    expect(warning).toContain("file_c.ts");
  });

  it("hasUnreadBackFiles returns true when feature enabled and files exist", async () => {
    markFileAsEdited("/tmp/file_d.ts");
    expect(await hasUnreadBackFiles()).toBe(true);
  });

  it("hasUnreadBackFiles returns false when feature is disabled", async () => {
    featureState.disable("feature:read_back_verify");
    markFileAsEdited("/tmp/file_e.ts");
    expect(await hasUnreadBackFiles()).toBe(false);
  });

  it("clearAllHonestyState empties the unread list", () => {
    markFileAsEdited("/tmp/file_f.ts");
    markFileAsEdited("/tmp/file_g.ts");
    expect(getUnreadBackFiles().length).toBe(2);
    clearAllHonestyState();
    expect(getUnreadBackFiles().length).toBe(0);
  });

  it("resetHonestyTurn clears files and does not throw", () => {
    markFileAsEdited("/tmp/file_h.ts");
    expect(() => resetHonestyTurn()).not.toThrow();
    expect(getUnreadBackFiles().length).toBe(0);
  });
});

describe("checkConfidenceAction", () => {
  beforeEach(() => {
    featureState.reset();
  });

  it("returns blocked=false when feature is disabled", async () => {
    const result = await checkConfidenceAction(5, "write");
    expect(result.blocked).toBe(false);
    expect(result.message).toBe("");
  });

  it("returns blocked=false when feature enabled but confidence is 0 (warns)", async () => {
    featureState.enable("feature:confidence_mapping");
    const result = await checkConfidenceAction(0, "write");
    expect(result.blocked).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("blocks writes when confidence <= 3", async () => {
    featureState.enable("feature:confidence_mapping");
    const result = await checkConfidenceAction(2, "write");
    expect(result.blocked).toBe(true);
  });

  it("does not block writes when confidence > 3", async () => {
    featureState.enable("feature:confidence_mapping");
    const result = await checkConfidenceAction(8, "write");
    expect(result.blocked).toBe(false);
  });

  it("returns a warning (not block) for finish with low confidence", async () => {
    featureState.enable("feature:confidence_mapping");
    const result = await checkConfidenceAction(4, "finish");
    expect(result.blocked).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("returns no message for finish with high confidence", async () => {
    featureState.enable("feature:confidence_mapping");
    const result = await checkConfidenceAction(8, "finish");
    expect(result.blocked).toBe(false);
    expect(result.message).toBe("");
  });
});

describe("checkUserClaims (feature disabled returns empty)", () => {
  beforeEach(() => {
    featureState.reset();
  });

  it("returns empty result when feature disabled", async () => {
    const result = await checkUserClaims("the file has 100 lines");
    expect(result.claims).toEqual([]);
    expect(result.message).toBe("");
  });
});

describe("checkContradictions (feature disabled returns empty)", () => {
  beforeEach(() => {
    featureState.reset();
    clearAllHonestyState();
  });

  it("returns empty contradictions when feature disabled", async () => {
    const result = await checkContradictions("I have 100 tests");
    expect(result.contradictions).toEqual([]);
    expect(result.message).toBe("");
  });
});

describe("Type contracts", () => {
  it("HonestyFeature has required fields", () => {
    const f: HonestyFeature = {
      id: "x", name: "X", description: "D", enabled: false,
    };
    expect(f.id).toBe("x");
  });

  it("DevilAdvocateResult severity union includes 'none'", () => {
    const r: DevilAdvocateResult = { issues: [], severity: "none", reviewed: false };
    expect(r.severity).toBe("none");
  });

  it("DiffCheckResult has the documented shape", () => {
    const r: DiffCheckResult = { matches: true, missingKeywords: [], message: "" };
    expect(r.matches).toBe(true);
  });

  it("HallucinationCheckResult has the documented shape", () => {
    const r: HallucinationCheckResult = {
      hallucinatedSymbols: [], verifiedSymbols: [], message: "",
    };
    expect(r.hallucinatedSymbols).toEqual([]);
  });

  it("EvidenceCheckResult has the documented shape", () => {
    const r: EvidenceCheckResult = {
      unverifiedClaims: [], verifiedClaims: [], message: "",
    };
    expect(r.unverifiedClaims).toEqual([]);
  });

  it("ContradictionResult has the documented shape", () => {
    const r: ContradictionResult = { contradictions: [], message: "" };
    expect(r.contradictions).toEqual([]);
  });
});
