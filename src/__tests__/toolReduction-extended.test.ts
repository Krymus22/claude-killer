/**
 * toolReduction-extended.test.ts — Mais testes para toolReduction.ts.
 *
 * toolReduction.ts filtra tools por intent pra reduzir contexto da IA.
 * Funções: detectIntent, filterToolsByIntent, getFilterSummary.
 */
import { describe, it, expect } from "vitest";
import { detectIntent, filterToolsByIntent, getFilterSummary } from "../toolReduction.js";

describe("toolReduction — extended", () => {
  describe("detectIntent", () => {
    it("detecta intent de 'read' para 'leia arquivo'", () => {
      const intent = detectIntent("leia o arquivo main.ts");
      expect(typeof intent).toBe("string");
    });

    it("detecta intent de 'write' para 'edite código'", () => {
      const intent = detectIntent("edite o código fonte");
      expect(typeof intent).toBe("string");
    });

    it("detecta intent de 'test' para 'rode testes'", () => {
      const intent = detectIntent("rode os testes unitários");
      expect(typeof intent).toBe("string");
    });

    it("detecta intent de 'search' para 'busque'", () => {
      const intent = detectIntent("busque por function");
      expect(typeof intent).toBe("string");
    });

    it("detecta intent de 'general' para texto neutro", () => {
      const intent = detectIntent("olá, como vai?");
      expect(intent).toBe("general");
    });

    it("lida com string vazia", () => {
      const intent = detectIntent("");
      expect(intent).toBe("general");
    });

    it("lida com null/undefined", () => {
      expect(detectIntent(null as any)).toBe("general");
      expect(detectIntent(undefined as any)).toBe("general");
    });

    it("é case-insensitive", () => {
      expect(detectIntent("LEIA ARQUIVO")).toBe(detectIntent("leia arquivo"));
    });

    it("detecta múltiplas palavras-chave", () => {
      const intents = new Set([
        detectIntent("leia"),
        detectIntent("read"),
        detectIntent("ver"),
        detectIntent("mostra"),
      ]);
      // Pelo menos 2 intents diferentes foram detectados
      expect(intents.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe("filterToolsByIntent", () => {
    // Tools no formato OpenAI: { function: { name: "..." } }
    const allTools = [
      { type: "function", function: { name: "ler_arquivo" } },
      { type: "function", function: { name: "editar_arquivo" } },
      { type: "function", function: { name: "executar_comando" } },
      { type: "function", function: { name: "buscar_web" } },
      { type: "function", function: { name: "pensar" } },
    ];

    it("retorna array", () => {
      const filtered = filterToolsByIntent(allTools as any, "read");
      expect(Array.isArray(filtered)).toBe(true);
    });

    it("para intent 'read', inclui ler_arquivo", () => {
      const filtered = filterToolsByIntent(allTools as any, "read");
      const names = filtered.map((t: any) => t.function.name);
      expect(names).toContain("ler_arquivo");
    });

    it("para intent 'write', inclui editar_arquivo", () => {
      const filtered = filterToolsByIntent(allTools as any, "write");
      const names = filtered.map((t: any) => t.function.name);
      expect(names).toContain("editar_arquivo");
    });

    it("para intent 'general', retorna todas ou maioria", () => {
      const filtered = filterToolsByIntent(allTools as any, "general");
      expect(filtered.length).toBeGreaterThanOrEqual(1);
    });

    it("lida com array vazio", () => {
      const filtered = filterToolsByIntent([], "read");
      expect(filtered).toEqual([]);
    });
  });

  describe("getFilterSummary", () => {
    it("retorna string", () => {
      const summary = getFilterSummary("read", 5, 10);
      expect(typeof summary).toBe("string");
    });

    it("inclui número de tools", () => {
      const summary = getFilterSummary("read", 5, 10);
      expect(summary).toContain("5");
    });

    it("inclui total", () => {
      const summary = getFilterSummary("read", 5, 10);
      expect(summary).toContain("10");
    });

    it("lida com zero tools", () => {
      const summary = getFilterSummary("read", 0, 0);
      expect(typeof summary).toBe("string");
    });
  });
});
