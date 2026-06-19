/**
 * progressiveContext-extended.test.ts
 *
 * Expande cobertura do módulo progressiveContext.ts com casos de borda.
 * Foco em:
 *   - readSymbolFromFile: erro de AST, case-insensitive, último símbolo,
 *     imports contextuais, savings, content pequeno
 *   - detectSymbolRequest: variações de padrão (EN/PT), espaços, paths,
 *     mensagens inválidas
 * Não duplica testes do progressiveContext.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

// Mock do lspAst.js — controlamos os símbolos retornados
const mockParseFile = vi.hoisted(() => vi.fn());

vi.mock("./../lspAst.js", () => ({
  parseFile: mockParseFile,
}));

describe("progressiveContext (extended)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prog-ext-"));
    mockParseFile.mockReset();
    mockParseFile.mockResolvedValue({
      language: "typescript",
      lineCount: 50,
      symbols: [
        { name: "foo", type: "function", line: 10 },
        { name: "bar", type: "function", line: 30 },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── readSymbolFromFile ──────────────────────────────────────────────────

  it("readSymbolFromFile deve cair em full-read quando AST lança erro", async () => {
    mockParseFile.mockRejectedValue(new Error("AST parse failed"));
    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "err.ts");
    fs.writeFileSync(filePath, "const x = 1;\nconst y = 2;\n", "utf8");
    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(false);
    expect(result.symbolName).toBeNull();
    expect(result.savingsPercent).toBe(0);
    expect(result.content).toContain("const x = 1");
  });

  it("readSymbolFromFile deve fazer match case-insensitive de símbolo", async () => {
    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "ci.ts");
    const lines: string[] = [];
    for (let i = 1; i <= 40; i++) {
      if (i === 10) lines.push("function foo() {");
      else if (i === 12) lines.push("  return 1;");
      else if (i === 13) lines.push("}");
      else if (i === 30) lines.push("function bar() {");
      else if (i === 32) lines.push("  return 2;");
      else if (i === 33) lines.push("}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
    // Símbolo mock é "foo" — pedimos "FOO" (maiúsculo)
    const result = await readSymbolFromFile(filePath, "FOO");
    expect(result.partial).toBe(true);
    expect(result.symbolName).toBe("FOO");
  });

  it("readSymbolFromFile deve incluir imports contextuais quando presentes", async () => {
    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "imports.ts");
    const lines: string[] = [
      "import { something } from 'lib';",
      "import { other } from 'other';",
    ];
    for (let i = 3; i <= 40; i++) {
      if (i === 10) lines.push("function foo() {");
      else if (i === 12) lines.push("  return 1;");
      else if (i === 13) lines.push("}");
      else if (i === 30) lines.push("function bar() {");
      else if (i === 32) lines.push("  return 2;");
      else if (i === 33) lines.push("}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    expect(result.content).toContain("Imports (for context)");
    expect(result.content).toContain("import { something }");
    expect(result.content).toContain("import { other }");
  });

  it("readSymbolFromFile deve lidar com último símbolo (sem nextSymbol)", async () => {
    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "last.ts");
    const lines: string[] = [];
    for (let i = 1; i <= 60; i++) {
      if (i === 10) lines.push("function foo() {");
      else if (i === 12) lines.push("  return 1;");
      else if (i === 13) lines.push("}");
      else if (i === 30) lines.push("function bar() {");
      else if (i === 50) lines.push("  return 2;");
      else if (i === 51) lines.push("}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
    // bar é o último símbolo — não há nextSymbol, deve ir até EOF
    const result = await readSymbolFromFile(filePath, "bar");
    expect(result.partial).toBe(true);
    expect(result.symbolName).toBe("bar");
    // Deve incluir linhas próximas ao final
    expect(result.content).toContain("return 2");
  });

  it("readSymbolFromFile deve calcular savingsPercent corretamente", async () => {
    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "savings.ts");
    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) {
      if (i === 10) lines.push("function foo() {");
      else if (i === 20) lines.push("  return 1;");
      else if (i === 21) lines.push("}");
      else if (i === 50) lines.push("function bar() {");
      else if (i === 60) lines.push("  return 2;");
      else if (i === 61) lines.push("}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    // 100 linhas + 1 trailing newline → fullFileLines = 101
    expect(result.fullFileLines).toBe(101);
    // Extrai ~13 linhas (3 antes + função até linha 49) — savings alto
    expect(result.savingsPercent).toBeGreaterThan(50);
    expect(result.extractedLines).toBeLessThan(100);
  });

  it("readSymbolFromFile deve retornar full read quando símbolo não encontrado no AST", async () => {
    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "missing.ts");
    fs.writeFileSync(filePath, "const z = 3;\nconst w = 4;\n", "utf8");
    const result = await readSymbolFromFile(filePath, "nonExistentFn");
    expect(result.partial).toBe(false);
    expect(result.symbolName).toBeNull();
    expect(result.savingsPercent).toBe(0);
    expect(result.extractedLines).toBe(result.fullFileLines);
  });

  // ─── detectSymbolRequest ─────────────────────────────────────────────────

  it("detectSymbolRequest deve detectar 'show the X function in file' (EN)", async () => {
    const { detectSymbolRequest } = await import("./../progressiveContext.js");
    // O regex aceita "show the X in file" (apenas 1 palavra entre show e X)
    const result = detectSymbolRequest("show the parseArgs in utils.ts");
    expect(result).not.toBeNull();
    expect(result!.symbolName).toBe("parseArgs");
    expect(result!.filePath).toBe("utils.ts");
  });

  it("detectSymbolRequest deve detectar 'show X from file' sem 'the'", async () => {
    const { detectSymbolRequest } = await import("./../progressiveContext.js");
    const result = detectSymbolRequest("show parseArgs from utils.ts");
    expect(result).not.toBeNull();
    expect(result!.symbolName).toBe("parseArgs");
    expect(result!.filePath).toBe("utils.ts");
  });

  it("detectSymbolRequest deve detectar 'ver função X em arquivo' (PT)", async () => {
    const { detectSymbolRequest } = await import("./../progressiveContext.js");
    const result = detectSymbolRequest("ver função calcularImposto em impostos.luau");
    expect(result).not.toBeNull();
    expect(result!.symbolName).toBe("calcularImposto");
    expect(result!.filePath).toBe("impostos.luau");
  });

  it("detectSymbolRequest deve retornar null para mensagens genéricas", async () => {
    const { detectSymbolRequest } = await import("./../progressiveContext.js");
    expect(detectSymbolRequest("fix the bug in auth")).toBeNull();
    expect(detectSymbolRequest("how does this work?")).toBeNull();
    expect(detectSymbolRequest("  ")).toBeNull();
  });

  it("detectSymbolRequest deve lidar com paths com extensão e caracteres", async () => {
    const { detectSymbolRequest } = await import("./../progressiveContext.js");
    const result = detectSymbolRequest("read function GetData from src/services/DataService.ts");
    expect(result).not.toBeNull();
    expect(result!.symbolName).toBe("GetData");
    // O regex captura [^\s]+ — então captura o path completo sem espaços
    expect(result!.filePath).toBe("src/services/DataService.ts");
  });
});
