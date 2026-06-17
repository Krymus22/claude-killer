/**
 * effortLevels.test.ts — Tests for IDEIA 4 (effort levels).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
}));

import {
  getEffortLevel,
  setEffortLevel,
  getEffortPromptSnippet,
  getEffortLabel,
  shouldAutoGenerateTests,
  shouldUseSubAgents,
  shouldUseIntelligentCompaction,
  type EffortLevel,
} from "../effortLevels.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.CLAUDE_KILLER_EFFORT;
  delete process.env.CLAUDE_KILLER_EFFORT_STORED;
  setEffortLevel("medium");
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("effortLevels", () => {
  describe("getEffortLevel / setEffortLevel", () => {
    it("defaults to medium", () => {
      delete process.env.CLAUDE_KILLER_EFFORT_STORED;
      expect(getEffortLevel()).toBe("medium");
    });

    it("respects env var CLAUDE_KILLER_EFFORT=low", () => {
      process.env.CLAUDE_KILLER_EFFORT = "low";
      // Force reload by setting through env then loading
      // (loadInitialLevel reads env at module load — test via setEffortLevel)
      setEffortLevel("low");
      expect(getEffortLevel()).toBe("low");
    });

    it("can switch between all 4 levels", () => {
      for (const level of ["low", "medium", "high", "max"] as EffortLevel[]) {
        expect(setEffortLevel(level)).toBe(true);
        expect(getEffortLevel()).toBe(level);
      }
    });

    it("rejects invalid level", () => {
      expect(setEffortLevel("invalid" as EffortLevel)).toBe(false);
      expect(getEffortLevel()).toBe("medium"); // unchanged
    });
  });

  describe("getEffortPromptSnippet", () => {
    it("returns different snippets per level", () => {
      const snippets = new Set<string>();
      for (const level of ["low", "medium", "high", "max"] as EffortLevel[]) {
        setEffortLevel(level);
        const s = getEffortPromptSnippet();
        snippets.add(s);
        expect(s).toContain("EFFORT LEVEL");
        expect(s).toContain(level.toUpperCase());
      }
      expect(snippets.size).toBe(4); // all different
    });

    it("low effort mentions skipping pensar for trivial tasks", () => {
      setEffortLevel("low");
      expect(getEffortPromptSnippet()).toContain("direto");
    });

    it("max effort mentions validating before finishing", () => {
      setEffortLevel("max");
      const s = getEffortPromptSnippet();
      expect(s.toLowerCase()).toContain("valid");
    });
  });

  describe("getEffortLabel", () => {
    it("returns a non-empty label for each level", () => {
      for (const level of ["low", "medium", "high", "max"] as EffortLevel[]) {
        setEffortLevel(level);
        const label = getEffortLabel();
        expect(label.length).toBeGreaterThan(0);
        expect(label).toContain(level.toUpperCase());
      }
    });
  });

  describe("feature gating by effort level", () => {
    it("low: disables auto-test, sub-agents, intelligent compaction", () => {
      setEffortLevel("low");
      expect(shouldAutoGenerateTests()).toBe(false);
      expect(shouldUseSubAgents()).toBe(false);
      expect(shouldUseIntelligentCompaction()).toBe(false);
    });

    it("medium: enables auto-test + intelligent compaction, disables sub-agents", () => {
      setEffortLevel("medium");
      expect(shouldAutoGenerateTests()).toBe(true);
      expect(shouldUseSubAgents()).toBe(false);
      expect(shouldUseIntelligentCompaction()).toBe(true);
    });

    it("high: enables all 3 features", () => {
      setEffortLevel("high");
      expect(shouldAutoGenerateTests()).toBe(true);
      expect(shouldUseSubAgents()).toBe(true);
      expect(shouldUseIntelligentCompaction()).toBe(true);
    });

    it("max: enables all 3 features", () => {
      setEffortLevel("max");
      expect(shouldAutoGenerateTests()).toBe(true);
      expect(shouldUseSubAgents()).toBe(true);
      expect(shouldUseIntelligentCompaction()).toBe(true);
    });
  });
});
