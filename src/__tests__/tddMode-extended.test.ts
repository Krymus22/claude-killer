/**
 * tddMode-extended.test.ts — Cobertura adicional para tddMode.ts.
 *
 * Os nomes pedidos no enunciado (shouldRunTestFirst, recordTestResult,
 * getTddState, resetTddState) NÃO existem no módulo real. As funções
 * reais são: isTestable, registerTDD, getTDD, hasTDD, testFileExists,
 * clearTDD, formatTDD, getTestFilePath. Este arquivo expande a cobertura
 * dessas funções com casos edge não cobertos pelo tddMode.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

describe("tddMode (extended)", () => {
  beforeEach(async () => {
    const { clearTDD } = await import("./../tddMode.js");
    clearTDD();
  });

  describe("getTDD / estado (equivalente a getTddState)", () => {
    it("getTDD retorna null inicialmente quando nenhum spec foi registrado", async () => {
      const { getTDD } = await import("./../tddMode.js");
      expect(getTDD()).toBeNull();
    });

    it("getTDD retorna o spec mais recente após múltiplos registerTDD (sobrescreve)", async () => {
      const { registerTDD, getTDD } = await import("./../tddMode.js");
      registerTDD("first.spec.ts", "first.ts", "typescript", ["t1"]);
      registerTDD("second.spec.ts", "second.ts", "rust", ["t2", "t3"]);

      const current = getTDD();
      expect(current).not.toBeNull();
      // O segundo registerTDD deve ter sobrescrito o primeiro
      expect(current!.testFile).toBe("second.spec.ts");
      expect(current!.implFile).toBe("second.ts");
      expect(current!.language).toBe("rust");
      expect(current!.testCases).toEqual(["t2", "t3"]);
    });

    it("registerTDD registra createdAt como timestamp recente", async () => {
      const { registerTDD, getTDD } = await import("./../tddMode.js");
      const before = Date.now();
      registerTDD("t.spec.ts", "i.ts", "typescript", []);
      const after = Date.now();
      const ts = getTDD()!.createdAt;
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });

  describe("clearTDD / reset (equivalente a resetTddState)", () => {
    it("clearTDD é no-op quando nenhum TDD está ativo (não lança)", async () => {
      const { clearTDD, hasTDD } = await import("./../tddMode.js");
      expect(() => clearTDD()).not.toThrow();
      expect(hasTDD()).toBe(false);
    });

    it("clearTDD seguido de registerTDD permite reativar TDD", async () => {
      const { registerTDD, clearTDD, hasTDD, getTDD } = await import("./../tddMode.js");
      registerTDD("a.spec.ts", "a.ts", "typescript", ["x"]);
      clearTDD();
      expect(hasTDD()).toBe(false);
      registerTDD("b.spec.ts", "b.ts", "go", ["y"]);
      expect(hasTDD()).toBe(true);
      expect(getTDD()!.testFile).toBe("b.spec.ts");
    });
  });

  describe("formatTDD — casos edge", () => {
    it("formatTDD retorna string vazia quando não há TDD ativo", async () => {
      const { formatTDD } = await import("./../tddMode.js");
      expect(formatTDD()).toBe("");
    });

    it("formatTDD com array de testCases vazio NÃO inclui a seção 'Test cases'", async () => {
      const { registerTDD, formatTDD } = await import("./../tddMode.js");
      registerTDD("t.spec.ts", "i.ts", "typescript", []);
      const out = formatTDD();
      expect(out).toContain("[TDD ACTIVE]");
      expect(out).toContain("Test file: t.spec.ts");
      expect(out).toContain("Implementation file: i.ts");
      expect(out).toContain("Language: typescript");
      // Se testCases é vazio, a seção não deve aparecer
      expect(out).not.toContain("Test cases that MUST pass");
      // Mas o aviso final deve estar presente
      expect(out).toContain("Do NOT modify the tests");
    });

    it("formatTDD numera os testCases em ordem crescente a partir de 1", async () => {
      const { registerTDD, formatTDD } = await import("./../tddMode.js");
      registerTDD("t.spec.ts", "i.ts", "typescript", ["primeiro", "segundo", "terceiro"]);
      const out = formatTDD();
      expect(out).toContain("1. primeiro");
      expect(out).toContain("2. segundo");
      expect(out).toContain("3. terceiro");
    });
  });

  describe("getTestFilePath — casos edge", () => {
    it("preserva subdiretório do arquivo de implementação", async () => {
      const { getTestFilePath } = await import("./../tddMode.js");
      const result = getTestFilePath("src/services/InventoryService.luau");
      // Deve manter src/services + adicionar __tests__
      expect(result).toContain("services");
      expect(result).toContain("__tests__");
      expect(result).toContain("InventoryService.spec.luau");
    });

    it("lida com extensões compostas (ex.: .spec.ts)", async () => {
      const { getTestFilePath } = await import("./../tddMode.js");
      // path.extname só pega a última extensão, então .ts é removido e .spec.ts vira .spec.spec.ts
      const result = getTestFilePath("foo.spec.ts");
      expect(result).toContain("__tests__");
      // base = "foo.spec" (basename sem .ts)
      expect(result).toContain("foo.spec.spec.ts");
    });
  });

  describe("testFileExists — caso edge", () => {
    it("testFileExists retorna false quando nenhum TDD está registrado", async () => {
      const { testFileExists } = await import("./../tddMode.js");
      expect(testFileExists()).toBe(false);
    });
  });

  describe("isTestable — cobertura completa de extensões", () => {
    it("aceita todas as extensões testáveis documentadas", async () => {
      const { isTestable } = await import("./../tddMode.js");
      for (const ext of [".ts", ".tsx", ".js", ".py", ".rs", ".go", ".luau", ".lua"]) {
        expect(isTestable(`foo${ext}`)).toBe(true);
      }
    });

    it("rejeita extensões não testáveis e caminhos sem extensão", async () => {
      const { isTestable } = await import("./../tddMode.js");
      expect(isTestable("README.md")).toBe(false);
      expect(isTestable("Dockerfile")).toBe(false);
      expect(isTestable("config.yml")).toBe(false);
      expect(isTestable("semext")).toBe(false);
    });

    it("é case-insensitive para extensões", async () => {
      const { isTestable } = await import("./../tddMode.js");
      expect(isTestable("foo.TS")).toBe(true);
      expect(isTestable("foo.PY")).toBe(true);
    });
  });

  describe("integração estado + disco", () => {
    it("testFileExists usa o caminho registrado em registerTDD", async () => {
      const { registerTDD, testFileExists } = await import("./../tddMode.js");
      // Cria um arquivo temporário real
      const tmpFile = path.join(os.tmpdir(), `tdd-ext-${Date.now()}-${Math.random().toString(36).slice(2)}.spec.ts`);
      fs.writeFileSync(tmpFile, "// test", "utf8");
      try {
        registerTDD(tmpFile, "impl.ts", "typescript", []);
        expect(testFileExists()).toBe(true);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });
});
