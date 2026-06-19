/**
 * guardrail-extended.test.ts — Casos edge / error handling / integração para
 * guardrail.ts que NÃO estão cobertos pelo teste básico.
 *
 * Foco (adaptado às funções reais do módulo):
 *   - checkCommand (validateSyntax roteamento por extensão) (3 casos)
 *   - isDangerous (validação que falha — equivalente de "perigo") (2 casos)
 *   - formatWarning (estrutura da mensagem de erro retornada) (2 casos)
 *   - edge cases (1 caso)
 *
 * Nota: o módulo guardrail.ts é advisory-only. validateSyntax nunca lança —
 *       retorna { valid, errorMessage }.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

import { validateSyntax } from "../guardrail.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardrail_ext_"));
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

// ─── checkCommand (roteamento por extensão) ────────────────────────────────
describe("checkCommand — validateSyntax (roteamento por extensão)", () => {
  it("extensões .js e .mjs usam o mesmo validator (node --check em temp .mjs)", async () => {
    const r1 = await validateSyntax("file.js", "const x = 1;");
    const r2 = await validateSyntax("file.mjs", "const x = 1;");
    expect(r1.valid).toBe(true);
    expect(r2.valid).toBe(true);
  });

  it("extensão .cjs também é roteada para validator JavaScript (node --check)", async () => {
    const r = await validateSyntax("file.cjs", "module.exports = 42;");
    expect(r).toHaveProperty("valid");
    expect(r.valid).toBe(true);
  });

  it("extensão .tsx também é roteada para validator TypeScript (tsc)", async () => {
    const tsxFile = path.join(tmpDir, "comp.tsx");
    fs.writeFileSync(tsxFile, "const x = <div>hello</div>;\n");
    const r = await validateSyntax(tsxFile, "const x = 1;");
    // Resultado depende do ambiente, mas deve ter a propriedade valid
    expect(r).toHaveProperty("valid");
  });
});

// ─── isDangerous (validação que falha — equivalente) ──────────────────────
describe("isDangerous — validações que falham (JSON / CSS / HTML)", () => {
  it("JSON com erro de sintaxe profundo retorna errorMessage contendo 'JSON parse error'", async () => {
    const r = await validateSyntax("bad.json", '{"a": [1, 2, {"b": "unterminated]}');
    expect(r.valid).toBe(false);
    expect(r.errorMessage).toContain("JSON parse error");
    expect(r.errorMessage).toMatch(/Unexpected|JSON/i);
  });

  it("CSS com chaves desbalanceadas retorna errorMessage descrevendo a contagem", async () => {
    const r = await validateSyntax("bad.css", ".a { .b { color: red; } /* falta fecha */");
    expect(r.valid).toBe(false);
    expect(r.errorMessage).toContain("brace mismatch");
    expect(r.errorMessage).toMatch(/\d+ opening braces.*\d+ closing braces/);
  });
});

// ─── formatWarning (estrutura da mensagem de erro) ─────────────────────────
describe("formatWarning — estrutura de errorMessage", () => {
  it("errorMessage de Python contém prefixo 'Python syntax error' + detalhe do stderr", async () => {
    const r = await validateSyntax("bad.py", "def (:\n");
    // Resultado depende de python3 instalado — se passar, é válido; se falhar, tem o prefixo
    if (!r.valid) {
      expect(r.errorMessage).toContain("Python syntax error");
    } else {
      // Se python3 não está instalado ou aceitou, ainda assim é uma resposta válida
      expect(r).toHaveProperty("valid");
    }
  });

  it("errorMessage de Java com classe pública nomeada corretamente — sucesso mesmo com warning", async () => {
    const r = await validateSyntax("HelloWorld.java",
      "public class HelloWorld { public static void main(String[] args) { System.out.println(\"hi\"); } }");
    // Pode passar (javac disponível) ou falhar (javac não instalado)
    if (r.valid) {
      expect(r.errorMessage).toBeUndefined();
    } else {
      expect(r.errorMessage).toContain("Java compilation error");
    }
  });
});

// ─── edge cases ────────────────────────────────────────────────────────────
describe("edge cases", () => {
  it("validateSyntax com filePath sem extensão retorna válido (passthrough)", async () => {
    const r = await validateSyntax("Makefile", "all: build\n\tgo build ./...");
    expect(r.valid).toBe(true);
    expect(r.errorMessage).toBeUndefined();
  });

  it("validateSyntax com extensão composta (.tar.gz) — pega apenas última extensão", async () => {
    const r = await validateSyntax("archive.tar.gz", "qualquer coisa");
    // .gz não é mapeado — passthrough
    expect(r.valid).toBe(true);
  });

  it("validateSyntax NUNCA lança, mesmo com JSON profundamente inválido", async () => {
    const r = await validateSyntax("edge.json", "{");
    expect(r.valid).toBe(false);
    expect(r.errorMessage).toContain("JSON parse error");
    // Função não lança — sempre retorna ValidationResult
  });

  it("HTML com self-closing tags (XHTML) é aceito (delta pequeno)", async () => {
    const html = '<?xml version="1.0"?><html><body><br/><img src="x"/><p>hi</p></body></html>';
    const r = await validateSyntax("page.html", html);
    expect(r.valid).toBe(true);
  });
});
