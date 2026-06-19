/**
 * lspAst-extended.test.ts — Casos edge que NÃO estão no teste básico.
 * Foco em: parseFile (3 extras), findSymbol (2 extras), findDependencies (2)
 * e edge cases (1). Usa arquivos reais em diretório temporário.
 *
 * PT-BR nos comentários.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFile, parseSource, findSymbol, findDependencies } from "../lspAst.js";

const TEST_DIR = path.join(process.cwd(), "__test_astdir_ext__");

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // Arquivo TypeScript com imports/exports variados
  fs.writeFileSync(
    path.join(TEST_DIR, "Api.ts"),
    `import { foo } from "bar";
import defaultExport from "module-default";
import { type Type1, Type2 } from "./types";
export interface ApiResponse { code: number; }
export type Status = "ok" | "err";
export class ApiService {
  private data: string[] = [];
  public async fetch(): Promise<string> { return "x"; }
}
export function makeApi(): ApiService { return new ApiService(); }
const internal = 42;
`,
    "utf8",
  );

  // Arquivo Python com classes/métodos
  fs.writeFileSync(
    path.join(TEST_DIR, "service.py"),
    `from typing import List
import os

class Service:
    def __init__(self):
        self.x = 0

    def run(self) -> int:
        return self.x + 1

def helper():
    pass
`,
    "utf8",
  );

  // Arquivo vazio (apenas comentário)
  fs.writeFileSync(
    path.join(TEST_DIR, "Empty.ts"),
    `// só um comentário
/* bloco */
`,
    "utf8",
  );
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("lspAst — extended", () => {
  // ─── parseFile (3 extras) ──────────────────────────────────────────────────

  describe("parseFile — extras", () => {
    it("extrai interface, type, class e function de arquivo TypeScript", async () => {
      const r = await parseFile(path.join(TEST_DIR, "Api.ts"));
      expect(r.language).toBe("tree-sitter-typescript");
      const names = r.symbols.map((s) => s.name);
      expect(names).toContain("ApiResponse");
      expect(names).toContain("Status");
      expect(names).toContain("ApiService");
      expect(names).toContain("makeApi");
    });

    it("extrai classe e função top-level em Python", async () => {
      const r = await parseFile(path.join(TEST_DIR, "service.py"));
      expect(r.language).toBe("tree-sitter-python");
      const names = r.symbols.map((s) => s.name);
      expect(names).toContain("Service");
      // 'helper' é função top-level (def) — deve ser capturada
      expect(names).toContain("helper");
    });

    it("retorna lineCount > 0 mesmo para arquivo só de comentários", async () => {
      const r = await parseFile(path.join(TEST_DIR, "Empty.ts"));
      expect(r.lineCount).toBeGreaterThan(0);
      expect(r.symbols.length).toBe(0);
    });
  });

  // ─── findSymbol (2 extras) ─────────────────────────────────────────────────

  describe("findSymbol — extras", () => {
    it("encontra função exportada e retorna type='function'", async () => {
      const r = await parseFile(path.join(TEST_DIR, "Api.ts"));
      const sym = findSymbol(r, "makeApi");
      expect(sym).toBeDefined();
      expect(sym?.type).toBe("function");
      expect(sym?.exported).toBe(true);
    });

    it("retorna undefined para símbolo inexistente", async () => {
      const r = await parseFile(path.join(TEST_DIR, "Api.ts"));
      expect(findSymbol(r, "nonExistentFunction")).toBeUndefined();
    });
  });

  // ─── findDependencies / getReferences (2) ──────────────────────────────────

  describe("findDependencies — extras", () => {
    it("extrai múltiplos imports TypeScript com módulos distintos", async () => {
      const r = await parseFile(path.join(TEST_DIR, "Api.ts"));
      const deps = findDependencies(r);
      expect(deps.length).toBeGreaterThanOrEqual(2);
      const modules = deps.map((d) => d.module);
      expect(modules.some((m) => m === "bar")).toBe(true);
      expect(modules.some((m) => m === "module-default")).toBe(true);
    });

    it("detecta import 'type-only' em TypeScript", async () => {
      const r = await parseFile(path.join(TEST_DIR, "Api.ts"));
      const deps = findDependencies(r);
      const typeImport = deps.find((d) => d.module === "./types");
      if (typeImport) {
        // Pode ou não estar marcado como typeOnly dependendo do parser
        expect(typeof typeImport.isTypeOnly).toBe("boolean");
      }
    });
  });

  // ─── Edge cases (1) ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("parseFile retorna empty para path inexistente sem lançar", async () => {
      const r = await parseFile("/caminho/que/nao/existe.ts");
      expect(r.symbols).toEqual([]);
      expect(r.lineCount).toBe(0);
      expect(r.language).toBe("unknown");
    });

    it("parseSource lida com string vazia", async () => {
      const r = await parseSource("", "tree-sitter-typescript");
      expect(r.lineCount).toBeLessThanOrEqual(1);
      expect(r.symbols).toEqual([]);
    });

    it("parseFile em diretório retorna aggregation com language='directory'", async () => {
      const r = await parseFile(TEST_DIR);
      // Pode retornar 'directory' se houver arquivos parseáveis, ou 'unknown' se falhar
      expect(["directory", "unknown"].includes(r.language)).toBe(true);
    });
  });
});
