/**
 * honestySystem.test.ts - Tests for the 10-layer anti-sycophancy system.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
}));

// Mock extensionCenter to control feature enable/disable
vi.mock("./../extensionCenter.js", () => ({
  getExtension: vi.fn((id: string) => ({ enabled: true, triggerMode: "always" })),
}));

describe("honestySystem", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("Feature registry", () => {
    it("should have 10 honesty features", async () => {
      const { getHonestyFeatures } = await import("./../honestySystem.js");
      const features = getHonestyFeatures();
      expect(features.length).toBe(10);
    });

    it("should include all 10 feature IDs", async () => {
      const { getHonestyFeatures } = await import("./../honestySystem.js");
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
    });
  });

  describe("Diff Reality Check", () => {
    it("should detect missing keywords when AI claims it added try-catch but file doesnt have it", async () => {
      const { diffRealityCheck } = await import("./../honestySystem.js");
      const tmpFile = path.join(os.tmpdir(), `honesty-test-${Date.now()}.luau`);
      fs.writeFileSync(tmpFile, "local x = 1\nprint(x)\n", "utf8");

      const result = await diffRealityCheck(tmpFile, "I added a try-catch block around the code");
      expect(result.matches).toBe(false);
      expect(result.missingKeywords).toContain("try");
      expect(result.missingKeywords).toContain("catch");

      fs.unlinkSync(tmpFile);
    });

    it("should pass when keywords are present", async () => {
      const { diffRealityCheck } = await import("./../honestySystem.js");
      const tmpFile = path.join(os.tmpdir(), `honesty-test-${Date.now()}.luau`);
      fs.writeFileSync(tmpFile, "try\n  print(x)\ncatch e\nend\n", "utf8");

      const result = await diffRealityCheck(tmpFile, "I added a try-catch block");
      expect(result.matches).toBe(true);

      fs.unlinkSync(tmpFile);
    });

    it("should pass when no code claims are made", async () => {
      const { diffRealityCheck } = await import("./../honestySystem.js");
      const tmpFile = path.join(os.tmpdir(), `honesty-test-${Date.now()}.luau`);
      fs.writeFileSync(tmpFile, "local x = 1\n", "utf8");

      const result = await diffRealityCheck(tmpFile, "I changed the variable name");
      expect(result.matches).toBe(true);

      fs.unlinkSync(tmpFile);
    });
  });

  describe("Read-Back Verification", () => {
    it("should track edited files", async () => {
      const { markFileAsEdited, getUnreadBackFiles, clearAllHonestyState } = await import("./../honestySystem.js");
      clearAllHonestyState();
      markFileAsEdited("/test/file1.luau");
      markFileAsEdited("/test/file2.luau");
      const unread = getUnreadBackFiles();
      expect(unread.length).toBe(2);
    });

    it("should clear file when read back", async () => {
      const { markFileAsEdited, markFileAsReadBack, getUnreadBackFiles, clearAllHonestyState } = await import("./../honestySystem.js");
      clearAllHonestyState();
      markFileAsEdited("/test/file1.luau");
      markFileAsReadBack("/test/file1.luau");
      expect(getUnreadBackFiles().length).toBe(0);
    });

    it("should generate warning message for unread files", async () => {
      const { markFileAsEdited, getReadBackWarning, clearAllHonestyState } = await import("./../honestySystem.js");
      clearAllHonestyState();
      markFileAsEdited("/test/InventoryService.luau");
      const warning = getReadBackWarning();
      expect(warning).toContain("READ-BACK REQUIRED");
      expect(warning).toContain("InventoryService.luau");
    });

    it("should return empty string when no unread files", async () => {
      const { getReadBackWarning, clearAllHonestyState } = await import("./../honestySystem.js");
      clearAllHonestyState();
      expect(getReadBackWarning()).toBe("");
    });
  });

  describe("Hallucination Detector", () => {
    it("should detect symbols that dont exist in the file", async () => {
      const { detectHallucinations } = await import("./../honestySystem.js");
      const content = `
local function realFunction()
    return 1
end
local result = fakeFunction()
local x = anotherFakeOne()
`;
      const result = await detectHallucinations("test.luau", content);
      expect(result.hallucinatedSymbols).toContain("fakeFunction");
      expect(result.hallucinatedSymbols).toContain("anotherFakeOne");
      expect(result.verifiedSymbols).toContain("realFunction");
    });

    it("should not flag Roblox built-in APIs (Instance)", async () => {
      const { detectHallucinations } = await import("./../honestySystem.js");
      const content = `
local players = game:GetService("Players")
local part = Instance.new("Part")
`;
      const result = await detectHallucinations("test.luau", content);
      // Instance should be verified as built-in API
      // Note: "game" is a local variable, not a function definition - may be flagged.
      // GetService is captured as part of game:GetService(...) where "game" is group 1.
      // This is a known limitation of the heuristic regex.
      expect(result.verifiedSymbols).toContain("Instance");
      expect(result.hallucinatedSymbols).not.toContain("Instance");
    });

    it("should not flag language keywords", async () => {
      const { detectHallucinations } = await import("./../honestySystem.js");
      const content = `
if x then
  for i = 1, 10 do
    while true do
      return
    end
  end
end
`;
      const result = await detectHallucinations("test.luau", content);
      expect(result.hallucinatedSymbols.length).toBe(0);
    });
  });

  describe("Evidence Requirement", () => {
    it('should flag "testes passam" claim without executar_testes', async () => {
      const { checkEvidenceRequirement } = await import("./../honestySystem.js");
      const result = await checkEvidenceRequirement(
        "Os testes passaram sem erros",
        ["ler_arquivo"]  // no executar_testes
      );
      expect(result.unverifiedClaims.length).toBeGreaterThan(0);
      expect(result.message).toContain("EVIDENCE");
    });

    it("should pass when test claim has executar_testes in history", async () => {
      const { checkEvidenceRequirement } = await import("./../honestySystem.js");
      const result = await checkEvidenceRequirement(
        "Os testes passaram",
        ["executar_testes"]
      );
      expect(result.unverifiedClaims.length).toBe(0);
    });

    it('should flag "sem erros" claim without verification tools', async () => {
      const { checkEvidenceRequirement } = await import("./../honestySystem.js");
      const result = await checkEvidenceRequirement(
        "O código está sem erros",
        []
      );
      expect(result.unverifiedClaims.length).toBeGreaterThan(0);
    });
  });

  describe("User Claim Verification", () => {
    it('should detect "tem X linhas" claims', async () => {
      const { checkUserClaims } = await import("./../honestySystem.js");
      const result = await checkUserClaims("O arquivo tem 500 linhas");
      expect(result.claims.length).toBeGreaterThan(0);
      expect(result.message).toContain("VERIFY");
    });

    it('should detect "usa react" claims', async () => {
      const { checkUserClaims } = await import("./../honestySystem.js");
      const result = await checkUserClaims("O projeto usa react");
      expect(result.claims.length).toBeGreaterThan(0);
    });

    it("should not flag non-claim messages", async () => {
      const { checkUserClaims } = await import("./../honestySystem.js");
      const result = await checkUserClaims("Faz um sistema de inventário");
      expect(result.claims.length).toBe(0);
    });
  });

  describe("Confidence-Action Mapping", () => {
    it("should extract confidence from pensar content", async () => {
      const { extractConfidence } = await import("./../honestySystem.js");
      expect(extractConfidence("Vou editar. confianca: 8")).toBe(8);
      expect(extractConfidence("confiança: 3")).toBe(3);
      expect(extractConfidence("no confidence provided")).toBe(0);
    });

    it("should block writes with confidence <= 3", async () => {
      const { checkConfidenceAction } = await import("./../honestySystem.js");
      const result = await checkConfidenceAction(2, "write");
      expect(result.blocked).toBe(true);
      expect(result.message).toContain("CONFIDENCE LOW");
    });

    it("should warn but not block writes with confidence 4-6", async () => {
      const { checkConfidenceAction } = await import("./../honestySystem.js");
      const result = await checkConfidenceAction(5, "write");
      expect(result.blocked).toBe(false);
    });

    it("should allow writes with confidence >= 7", async () => {
      const { checkConfidenceAction } = await import("./../honestySystem.js");
      const result = await checkConfidenceAction(9, "write");
      expect(result.blocked).toBe(false);
    });
  });

  describe("Contradiction Tracker", () => {
    it("should detect contradictory version claims", async () => {
      const { checkContradictions, clearAllHonestyState, incrementTurn } = await import("./../honestySystem.js");
      clearAllHonestyState();

      // First turn: claim selene is 0.31.0
      incrementTurn();
      await checkContradictions("selene version 0.31.0 is the latest");

      // Second turn: claim selene is 0.29.0
      incrementTurn();
      const result = await checkContradictions("selene 0.29.0 is the current version");
      expect(result.contradictions.length).toBeGreaterThan(0);
      expect(result.message).toContain("CONTRADICTION");
    });

    it("should not flag non-contradictory claims", async () => {
      const { checkContradictions, clearAllHonestyState, incrementTurn } = await import("./../honestySystem.js");
      clearAllHonestyState();
      incrementTurn();
      const result = await checkContradictions("The project has 100 files");
      expect(result.contradictions.length).toBe(0);
    });

    it("should not flag same-value claims across turns", async () => {
      const { checkContradictions, clearAllHonestyState, incrementTurn } = await import("./../honestySystem.js");
      clearAllHonestyState();
      incrementTurn();
      await checkContradictions("selene version 0.31.0");
      incrementTurn();
      const result = await checkContradictions("selene 0.31.0 is good");
      expect(result.contradictions.length).toBe(0);
    });
  });

  describe("Reset / cleanup", () => {
    it("clearAllHonestyState should clear everything", async () => {
      const { markFileAsEdited, getUnreadBackFiles, clearAllHonestyState } = await import("./../honestySystem.js");
      markFileAsEdited("/test/file.luau");
      clearAllHonestyState();
      expect(getUnreadBackFiles().length).toBe(0);
    });

    it("resetHonestyTurn should clear edited-but-not-read files", async () => {
      const { markFileAsEdited, getUnreadBackFiles, resetHonestyTurn } = await import("./../honestySystem.js");
      markFileAsEdited("/test/file.luau");
      resetHonestyTurn();
      expect(getUnreadBackFiles().length).toBe(0);
    });
  });
});
