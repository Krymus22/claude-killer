/**
 * contextInjector.test.ts — Tests for IDEIA 1 (auto-read TASK_STATE).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
}));

vi.mock("../taskState.js", () => ({
  getTaskStateSummary: vi.fn(),
}));

import { getContextInjection, resetContextInjection } from "../contextInjector.js";
import { getTaskStateSummary } from "../taskState.js";

const mockedGetSummary = getTaskStateSummary as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetContextInjection();
  mockedGetSummary.mockReset();
});

describe("contextInjector", () => {
  describe("getContextInjection", () => {
    it("returns empty for read-only tools (ler_arquivo)", () => {
      mockedGetSummary.mockReturnValue("## TASK_STATE\nTitle: test");
      expect(getContextInjection("ler_arquivo")).toBe("");
    });

    it("returns empty when TASK_STATE is empty", () => {
      mockedGetSummary.mockReturnValue(null);
      expect(getContextInjection("aplicar_diff")).toBe("");
    });

    it("throttles: skips first 2 calls, returns on 3rd", () => {
      mockedGetSummary.mockReturnValue("## TASK_STATE\nTodo:\n  ○ item 1\n  ○ item 2");
      // Call 1: skipped (counter becomes 1)
      expect(getContextInjection("aplicar_diff")).toBe("");
      // Call 2: skipped (counter becomes 2)
      expect(getContextInjection("aplicar_diff")).toBe("");
      // Call 3: returns (counter resets to 0)
      const result = getContextInjection("aplicar_diff");
      expect(result).toContain("CURRENT CONTEXT");
      expect(result).toContain("item 1");
      expect(result).toContain("item 2");
    });

    it("injection only includes decision-relevant sections (Todo/Decisions/Bugs/Dependencies)", () => {
      mockedGetSummary.mockReturnValue(`## TASK_STATE (auto-maintained)
Title: Test
Started: 2026-01-01 — Updated: 2026-01-02
Done:
  ✓ already done
Todo:
  ○ to do next
Decisions:
  • use approach X
Bugs:
  ! bug at foo.ts:1
Dependencies:
  ⚠ need libfoo
Notes: random notes here`);
      // Skip first 2 calls to get to the 3rd
      getContextInjection("executar_comando");
      getContextInjection("executar_comando");
      const result = getContextInjection("executar_comando");
      expect(result).toContain("Todo");
      expect(result).toContain("Decisions");
      expect(result).toContain("Bugs");
      expect(result).toContain("Dependencies");
      expect(result).toContain("to do next");
      expect(result).toContain("use approach X");
      expect(result).toContain("bug at foo.ts:1");
      expect(result).toContain("need libfoo");
      // Done section is dropped (past, not decision-relevant)
      expect(result).not.toContain("already done");
      // Notes also dropped
      expect(result).not.toContain("random notes");
    });

    it("injection works for all decision-critical tools", () => {
      mockedGetSummary.mockReturnValue("## TASK_STATE\nTodo:\n  ○ test item");
      const tools = ["aplicar_diff", "editar_arquivo", "editar_multi_arquivos", "desfazer_edicao", "executar_comando"];
      for (const tool of tools) {
        resetContextInjection();
        // 3 calls to trigger injection
        getContextInjection(tool);
        getContextInjection(tool);
        const result = getContextInjection(tool);
        expect(result).toContain("CURRENT CONTEXT");
      }
    });

    it("truncates very long summaries to 1500 chars", () => {
      const longItem = "x".repeat(200);
      const items = Array.from({ length: 20 }, (_, i) => `  ○ item ${i} ${longItem}`).join("\n");
      mockedGetSummary.mockReturnValue(`## TASK_STATE\nTodo:\n${items}`);
      // 3 calls
      getContextInjection("aplicar_diff");
      getContextInjection("aplicar_diff");
      const result = getContextInjection("aplicar_diff");
      expect(result.length).toBeLessThan(2200); // 1500 + overhead
      expect(result).toContain("truncado");
    });

    it("resetContextInjection clears the throttle", () => {
      mockedGetSummary.mockReturnValue("## TASK_STATE\nTodo:\n  ○ x");
      // Call 1
      expect(getContextInjection("aplicar_diff")).toBe("");
      resetContextInjection();
      // After reset, counter starts over — first 2 calls skip
      expect(getContextInjection("aplicar_diff")).toBe("");
      expect(getContextInjection("aplicar_diff")).toBe("");
      expect(getContextInjection("aplicar_diff")).toContain("CURRENT CONTEXT");
    });
  });
});
