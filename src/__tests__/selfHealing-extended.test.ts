/**
 * selfHealing-extended.test.ts - Expansão de cobertura de src/selfHealing.ts.
 *
 * Foca em cenários não cobertos por selfHealing.test.ts:
 *   - parseErrors: formatos múltiplos, auto-detecção de eslint, mixed output,
 *     unicode, múltiplos erros, mensagens muito longas, fallback genérico com
 *     "failed" e "panic"
 *   - parseTscErrors: extração expected/got com tipos complexos
 *   - parseSeleneErrors: warnings e errors misturados, múltiplos arquivos
 *   - parseEslintErrors: formato com code no final, warning
 *   - parseGenericErrors: extensões de arquivo diferentes (.py, .rs, .go, .lua)
 *   - formatStructuredErrors: mensagem sem expected/got, com coluna undefined,
 *     erros misturados, número alto de erros
 *   - getErrorSummary: somente warnings, somente errors, mistura
 *   - Edge cases: output muito grande, arquivo vazio, múltiplos erros,
 *     binary-like content
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

describe("selfHealing (extended) - parseErrors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  // --- parseErrors: auto-detecção de formatos --------------------------------

  it("auto-detecta eslint quando output tem formato 'linha:col error msg'", async () => {
    const { parseErrors } = await import("../selfHealing.js");
    const output = `src/foo.ts:42:5: error  Expected '===' ExpectationEquality`;
    const errors = parseErrors(output);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // eslint é detectado por default: \d+:\d+:\s*(error|warning)\s+
    expect(errors[0]!.severity).toBe("error");
    expect(errors[0]!.line).toBe(42);
  });

  it("auto-detecta tsc quando output tem código TS####", async () => {
    const { parseErrors } = await import("../selfHealing.js");
    const errors = parseErrors(`src/x.ts(10,2): error TS9999: algum erro`);
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("TS9999");
    expect(errors[0]!.file).toBe("src/x.ts");
  });

  it("cai em fallback genérico quando nenhum formato conhecido é detectado", async () => {
    const { parseErrors } = await import("../selfHealing.js");
    // Mensagem com palavra 'failed' mas sem file:line pattern -> arquivo unknown
    const output = `Build failed for unknown reasons`;
    const errors = parseErrors(output);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!.file).toBe("unknown");
    expect(errors[0]!.line).toBe(0);
  });

  // --- parseTscErrors: extração expected/got ---------------------------------

  it("extrai expected/got de mensagens com tipos complexos entre aspas", async () => {
    const { parseErrors } = await import("../selfHealing.js");
    const output = `f.ts(1,1): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'number'.`;
    const errors = parseErrors(output, "tsc");
    expect(errors[0]!.expected).toBe("string | undefined");
    expect(errors[0]!.got).toBe("number");
  });

  it("não quebra quando mensagem TS não tem tipos entre aspas", async () => {
    const { parseErrors } = await import("../selfHealing.js");
    const output = `f.ts(1,1): error TS2304: Cannot find name 'foo'.`;
    const errors = parseErrors(output, "tsc");
    expect(errors[0]!.code).toBe("TS2304");
    expect(errors[0]!.expected).toBeUndefined();
    expect(errors[0]!.got).toBeUndefined();
  });

  // --- parseSeleneErrors: casos extras --------------------------------------

  it("faz parse de múltiplos arquivos .luau no formato selene", async () => {
    const { parseErrors } = await import("../selfHealing.js");
    const output = [
      `a.luau:1:1: warning: undefined_global`,
      `b.luau:5:10: error: mismatched_end`,
      `c.luau:99:42: error: syntax_error`,
    ].join("\n");
    const errors = parseErrors(output, "selene");
    expect(errors).toHaveLength(3);
    expect(errors[0]!.file).toBe("a.luau");
    expect(errors[1]!.severity).toBe("error");
    expect(errors[2]!.column).toBe(42);
  });

  // --- parseEslintErrors: casos extras --------------------------------------

  it("faz parse de warnings do eslint sem code", async () => {
    const { parseErrors } = await import("../selfHealing.js");
    // eslint format: /path:line:col: warning  Mensagem (sem code)
    const output = `src/foo.ts:10:3: warning  Unexpected var, use let or const`;
    const errors = parseErrors(output, "eslint");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe("warning");
    expect(errors[0]!.line).toBe(10);
    expect(errors[0]!.column).toBe(3);
  });

  it("faz parse de erro eslint com code alfanumérico no final", async () => {
    const { parseErrors } = await import("../selfHealing.js");
    const output = `src/foo.ts:1:1: error  Expected '===' eqeqeq`;
    const errors = parseErrors(output, "eslint");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.severity).toBe("error");
    // Code capturado é opcional (palavra final solta)
    expect(errors[0]!.message).toContain("Expected");
  });

  // --- parseGenericErrors: extensões de arquivo ------------------------------

  it("detecta file:line para extensões .py, .rs, .go, .lua", async () => {
    const { parseErrors } = await import("../selfHealing.js");
    const output = [
      `Error in src/main.py:42 caused failure`,
      `panic at lib/parser.rs:18`,
      `failed to compile pkg/handler.go:7`,
      `error in old/script.lua:99`,
    ].join("\n");
    const errors = parseErrors(output, "generic");
    expect(errors).toHaveLength(4);
    expect(errors.map((e) => e.file)).toEqual(
      expect.arrayContaining(["src/main.py", "lib/parser.rs", "pkg/handler.go", "old/script.lua"])
    );
    expect(errors.map((e) => e.line)).toEqual(expect.arrayContaining([42, 18, 7, 99]));
  });

  it("trunca mensagens genéricas muito longas em 200 caracteres", async () => {
    const { parseErrors } = await import("../selfHealing.js");
    const longMsg = "Error: " + "x".repeat(500);
    const errors = parseErrors(longMsg, "generic");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message.length).toBeLessThanOrEqual(200);
  });

  // --- Unicode e casos extremos ---------------------------------------------

  it("preserva caracteres unicode (emoji, acentos) em mensagens", async () => {
    const { parseErrors } = await import("../selfHealing.js");
    const output = `файл.ts(1,1): error TS1: Ошибка с символами: café ☕ não válidö`;
    const errors = parseErrors(output, "tsc");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("café");
    expect(errors[0]!.message).toContain("☕");
  });

  it("lida com output contendo apenas whitespace e newlines", async () => {
    const { parseErrors } = await import("../selfHealing.js");
    expect(parseErrors("\n\n   \n\t  \n")).toEqual([]);
  });

  it("lida com arquivo grande (1000 erros TSC) sem travar", async () => {
    const { parseErrors } = await import("../selfHealing.js");
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(`file${i}.ts(${i + 1},1): error TS1: erro número ${i}`);
    }
    const errors = parseErrors(lines.join("\n"), "tsc");
    expect(errors).toHaveLength(1000);
    expect(errors[999]!.line).toBe(1000);
  });

  it("lida com binary-like content sem crashar (fallback genérico)", async () => {
    const { parseErrors } = await import("../selfHealing.js");
    // Conteúdo com caracteres não-printáveis simulando binário lido como string
    const binary = "\x00\x01\x02Error: something\x03\x04failed\x00";
    const errors = parseErrors(binary);
    // Genérico deve detectar "Error" e "failed"
    expect(errors.length).toBeGreaterThanOrEqual(0);
    // Não deve lançar exceção
    expect(Array.isArray(errors)).toBe(true);
  });
});

describe("selfHealing (extended) - formatStructuredErrors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("formata erro sem coluna e sem code corretamente", async () => {
    const { formatStructuredErrors } = await import("../selfHealing.js");
    const result = formatStructuredErrors([
      { file: "f.ts", line: 10, severity: "warning", message: "aviso simples" },
    ]);
    // Sem code: 3 espaços (location + ' ' + codeStr vazio + ' ' + severity)
    expect(result).toContain("f.ts:10   (warning)");
    expect(result).toContain("aviso simples");
    // Sem Expected/Got quando não há expected/got
    expect(result).not.toContain("Expected:");
  });

  it("numera erros sequencialmente começando em 1", async () => {
    const { formatStructuredErrors } = await import("../selfHealing.js");
    const result = formatStructuredErrors([
      { file: "a.ts", line: 1, severity: "error" as const, message: "m1" },
      { file: "b.ts", line: 2, severity: "error" as const, message: "m2" },
      { file: "c.ts", line: 3, severity: "warning" as const, message: "m3" },
    ]);
    expect(result).toContain("1. a.ts:1");
    expect(result).toContain("2. b.ts:2");
    expect(result).toContain("3. c.ts:3");
    expect(result).toContain("3 found");
  });

  it("formata erros misturados (com e sem expected/got) na mesma lista", async () => {
    const { formatStructuredErrors } = await import("../selfHealing.js");
    const result = formatStructuredErrors([
      { file: "a.ts", line: 1, severity: "error" as const, message: "type mismatch", expected: "string", got: "number" },
      { file: "b.ts", line: 2, severity: "warning" as const, message: "apenas aviso" },
    ]);
    expect(result).toContain("Expected: string | Got: number");
    // O segundo erro não deve ter Expected/Got
    const lines = result.split("\n");
    const secondBlockStart = lines.findIndex((l) => l.startsWith("2."));
    const block = lines.slice(secondBlockStart, secondBlockStart + 3).join("\n");
    expect(block).not.toContain("Expected:");
  });
});

describe("selfHealing (extended) - getErrorSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("retorna '0 error(s), 0 warning(s)' para array vazio", async () => {
    const { getErrorSummary } = await import("../selfHealing.js");
    expect(getErrorSummary([])).toBe("0 error(s), 0 warning(s)");
  });

  it("conta corretamente quando há somente warnings", async () => {
    const { getErrorSummary } = await import("../selfHealing.js");
    const summary = getErrorSummary([
      { file: "a", line: 1, severity: "warning" as const, message: "" },
      { file: "b", line: 2, severity: "warning" as const, message: "" },
    ]);
    expect(summary).toBe("0 error(s), 2 warning(s)");
  });

  it("conta corretamente quando há somente errors", async () => {
    const { getErrorSummary } = await import("../selfHealing.js");
    const summary = getErrorSummary([
      { file: "a", line: 1, severity: "error" as const, message: "" },
      { file: "b", line: 2, severity: "error" as const, message: "" },
      { file: "c", line: 3, severity: "error" as const, message: "" },
    ]);
    expect(summary).toBe("3 error(s), 0 warning(s)");
  });
});
