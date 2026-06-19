/**
 * history-extended.test.ts — Casos edge que NÃO estão no teste básico.
 * Foco em: addMessage (3 extras), getHistory (2 extras), compactHistory (2)
 * e edge cases (1).
 *
 * PT-BR nos comentários.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const mockGetActiveSkills = vi.fn().mockReturnValue([]);
vi.mock("../extensions.js", () => ({
  getActiveSkills: (...args: any[]) => mockGetActiveSkills(...args),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortPromptSnippet: vi.fn().mockReturnValue(""),
}));

import {
  addUserMessage,
  addRawAssistantMessage,
  addToolResult,
  addSystemMessage,
  getHistory,
  historyLength,
  resetHistory,
  compactHistory,
  historySummary,
  estimateTokens,
  replaceHistory,
  optimizeContext,
} from "../history.js";

afterEach(() => {
  mockGetActiveSkills.mockReturnValue([]);
});

describe("history — extended", () => {
  beforeEach(() => {
    resetHistory();
  });

  // ─── addMessage (3 extras) ─────────────────────────────────────────────────

  describe("addMessage — extras", () => {
    it("addRawAssistantMessage preserva tool_calls no histórico", () => {
      const fakeMsg: any = {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc_1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } }],
      };
      addRawAssistantMessage(fakeMsg);
      const h = getHistory();
      const asst = h.find((m: any) => m.role === "assistant");
      expect(asst).toBeDefined();
      expect(asst?.tool_calls).toHaveLength(1);
      expect(asst?.tool_calls?.[0].id).toBe("tc_1");
    });

    it("addToolResult adiciona mensagem com tool_call_id correto", () => {
      addToolResult("call_xyz", "resultado da tool");
      const h = getHistory();
      const tool = h.find((m: any) => m.role === "tool");
      expect(tool).toBeDefined();
      expect((tool as any).tool_call_id).toBe("call_xyz");
      expect((tool as any).content).toBe("resultado da tool");
    });

    it("addSystemMessage adiciona system após o system prompt inicial", () => {
      addSystemMessage("memória injetada");
      const h = getHistory();
      // system prompt + system message adicional
      const systems = h.filter((m: any) => m.role === "system");
      expect(systems.length).toBeGreaterThanOrEqual(2);
      expect(systems.some((s: any) => s.content === "memória injetada")).toBe(true);
    });
  });

  // ─── getHistory (2 extras) ─────────────────────────────────────────────────

  describe("getHistory — extras", () => {
    it("retorna a mesma referência enquanto nada é resetado", () => {
      addUserMessage("x");
      const h1 = getHistory();
      const h2 = getHistory();
      expect(h1).toBe(h2); // singleton
    });

    it("historyLength cresce ao adicionar mensagens", () => {
      const before = historyLength();
      addUserMessage("a");
      addUserMessage("b");
      const after = historyLength();
      expect(after).toBe(before + 2);
    });
  });

  // ─── compactHistory (2) ────────────────────────────────────────────────────

  describe("compactHistory — extras", () => {
    it("retorna null quando histórico é curto demais", () => {
      addUserMessage("curto");
      const r = compactHistory();
      expect(r).toBeNull();
    });

    it("após compaction, primeiro item ainda é system e último é preservado", () => {
      // Adiciona muitas mensagens
      for (let i = 0; i < 20; i++) {
        addUserMessage(`msg-${i}`);
      }
      const beforeLast = getHistory()[getHistory().length - 1];
      const r = compactHistory();
      expect(r).not.toBeNull();
      const h = getHistory();
      expect(h[0].role).toBe("system");
      expect(h[h.length - 1]).toEqual(beforeLast);
    });
  });

  // ─── Edge cases (1) ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("estimateTokens sempre retorna >= 1 (mesmo histórico vazio)", () => {
      resetHistory();
      const t = estimateTokens();
      expect(t).toBeGreaterThanOrEqual(1);
    });

    it("replaceHistory com array não-system no início prepended com system prompt", () => {
      replaceHistory([{ role: "user", content: "x" }] as any);
      const h = getHistory();
      expect(h[0].role).toBe("system");
      expect(h[1].role).toBe("user");
    });

    it("historySummary agrega contagem por role", () => {
      resetHistory();
      addUserMessage("u1");
      addUserMessage("u2");
      addSystemMessage("sys");
      const s = historySummary();
      expect(s).toContain("user:2");
      expect(s).toContain("system:"); // system prompt + 1 adicional
    });

    it("optimizeContext não lança nem remove mensagens do usuário", () => {
      addUserMessage("importante");
      addUserMessage("outra instrução");
      expect(() => optimizeContext()).not.toThrow();
      const h = getHistory();
      // Mensagens user não devem ser removidas
      const userMsgs = h.filter((m: any) => m.role === "user");
      expect(userMsgs.length).toBe(2);
    });
  });
});
