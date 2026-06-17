/**
 * autoTestGenerator.test.ts — Tests for IDEIA 7 (auto-test suggestion).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
}));

vi.mock("../effortLevels.js", () => ({
  shouldAutoGenerateTests: vi.fn().mockReturnValue(true),
}));

import { generateTestSuggestionForFile, resetAutoTestSuggestions } from "../autoTestGenerator.js";
import { shouldAutoGenerateTests } from "../effortLevels.js";

const mockedShouldGen = shouldAutoGenerateTests as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetAutoTestSuggestions();
  mockedShouldGen.mockReturnValue(true);
});

describe("autoTestGenerator", () => {
  describe("generateTestSuggestionForFile — supported languages", () => {
    it("suggests vitest for .ts files", () => {
      const result = generateTestSuggestionForFile("/abs/path/foo.ts");
      expect(result).toContain("vitest");
      expect(result).toContain("foo.test.ts");
      expect(result).toContain("SUGESTÃO DE TESTE");
    });

    it("suggests vitest for .tsx files", () => {
      const result = generateTestSuggestionForFile("/abs/path/Component.tsx");
      expect(result).toContain("vitest");
      expect(result).toContain("Component.test.tsx");
    });

    it("suggests jest for .js files", () => {
      const result = generateTestSuggestionForFile("/abs/path/foo.js");
      expect(result).toContain("jest");
      expect(result).toContain("foo.test.js");
    });

    it("suggests pytest for .py files", () => {
      const result = generateTestSuggestionForFile("/abs/path/foo.py");
      expect(result).toContain("pytest");
      expect(result).toContain("test_foo.py");
    });

    it("suggests cargo test for .rs files", () => {
      const result = generateTestSuggestionForFile("/abs/path/foo.rs");
      expect(result).toContain("cargo test");
    });

    it("suggests go test for .go files", () => {
      const result = generateTestSuggestionForFile("/abs/path/foo.go");
      expect(result).toContain("go test");
      expect(result).toContain("foo_test.go");
    });

    it("suggests JUnit for .java files", () => {
      const result = generateTestSuggestionForFile("/abs/path/Foo.java");
      expect(result).toContain("JUnit");
      expect(result).toContain("FooTest.java");
    });
  });

  describe("generateTestSuggestionForFile — explicitly skipped languages", () => {
    it("returns empty for .luau (Roblox Luau)", () => {
      expect(generateTestSuggestionForFile("/abs/path/foo.luau")).toBe("");
    });

    it("returns empty for .rbxl (Roblox place file)", () => {
      expect(generateTestSuggestionForFile("/abs/path/game.rbxl")).toBe("");
    });

    it("returns empty for .rbxmx (Roblox model file)", () => {
      expect(generateTestSuggestionForFile("/abs/path/Model.rbxmx")).toBe("");
    });

    it("returns empty for .cs (too project-specific)", () => {
      expect(generateTestSuggestionForFile("/abs/path/Foo.cs")).toBe("");
    });

    it("returns empty for .cpp", () => {
      expect(generateTestSuggestionForFile("/abs/path/foo.cpp")).toBe("");
    });

    it("returns empty for .md (not code)", () => {
      expect(generateTestSuggestionForFile("/abs/path/README.md")).toBe("");
    });

    it("returns empty for .json", () => {
      expect(generateTestSuggestionForFile("/abs/path/config.json")).toBe("");
    });

    it("returns empty for .sh (shell)", () => {
      expect(generateTestSuggestionForFile("/abs/path/deploy.sh")).toBe("");
    });

    it("returns empty for .env", () => {
      expect(generateTestSuggestionForFile("/abs/path/.env")).toBe("");
    });
  });

  describe("generateTestSuggestionForFile — gating by effort level", () => {
    it("returns empty when shouldAutoGenerateTests() is false (low effort)", () => {
      mockedShouldGen.mockReturnValue(false);
      expect(generateTestSuggestionForFile("/abs/path/foo.ts")).toBe("");
    });
  });

  describe("generateTestSuggestionForFile — throttling", () => {
    it("suggests only once per file per turn", () => {
      const first = generateTestSuggestionForFile("/abs/path/foo.ts");
      expect(first).toContain("vitest");
      const second = generateTestSuggestionForFile("/abs/path/foo.ts");
      expect(second).toBe("");
    });

    it("allows multiple different files in the same turn", () => {
      const first = generateTestSuggestionForFile("/abs/path/foo.ts");
      const second = generateTestSuggestionForFile("/abs/path/bar.ts");
      expect(first).toContain("vitest");
      expect(second).toContain("vitest");
    });

    it("resetAutoTestSuggestions clears the throttle", () => {
      const first = generateTestSuggestionForFile("/abs/path/foo.ts");
      expect(first).toContain("vitest");
      expect(generateTestSuggestionForFile("/abs/path/foo.ts")).toBe("");
      resetAutoTestSuggestions();
      const after = generateTestSuggestionForFile("/abs/path/foo.ts");
      expect(after).toContain("vitest");
    });
  });

  describe("generateTestSuggestionForFile — content of suggestion", () => {
    it("includes 3 coverage points (happy path, edge case, error case)", () => {
      const result = generateTestSuggestionForFile("/abs/path/foo.ts");
      expect(result).toContain("caminho feliz");
      expect(result).toContain("edge case");
      expect(result).toContain("caso de erro");
    });

    it("allows the model to ignore if not needed (config/refactor)", () => {
      const result = generateTestSuggestionForFile("/abs/path/foo.ts");
      expect(result).toContain("NÃO merece teste");
      expect(result).toContain("ignore esta sugestão");
    });
  });
});
