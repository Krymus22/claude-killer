/**
 * sideBySideDiff-extended.test.ts — Casos de borda para diff visual.
 *
 * Expande cobertura de generateUnifiedDiff (gera diff unificado), renderSideBySide
 * (renderiza com cores ANSI), truncamento de linhas longas, diff vazio e
 * comportamento com conteúdo binário (caracteres de controle).
 *
 * Evita duplicar testes já existentes em sideBySideDiff.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  computeSideBySideDiff,
  renderSideBySide,
  generateUnifiedDiff,
  type DiffLine,
} from "../sideBySideDiff.js";

// === generateUnifiedDiff (casos: modificado + novo) ==========================

describe("generateUnifiedDiff — arquivo modificado", () => {
  it("gera unified diff marcando linhas removidas e adicionadas", () => {
    const old = "function foo() {\n  return 1;\n}";
    const neu = "function foo() {\n  return 2;\n}";
    const result = generateUnifiedDiff(old, neu, "src/foo.ts");

    // Cabeçalhos a/ e b/ devem estar presentes
    expect(result).toContain("--- a/src/foo.ts");
    expect(result).toContain("+++ b/src/foo.ts");

    // A linha antiga "return 1;" deve aparecer como removida (com -)
    expect(result).toContain("-   return 1;");
    // A nova "return 2;" deve aparecer como adicionada (com +)
    expect(result).toContain("+   return 2;");
    // A linha "function foo() {" deve aparecer como contexto (sem prefixo - ou +)
    expect(result).toContain("  function foo() {");
  });

  it("gera unified diff para arquivo novo (todo conteúdo é adicionado)", () => {
    // Arquivo novo: old="" e new tem conteúdo — todas as linhas são "added"
    const novo = "export const x = 1;\nexport const y = 2;";
    const result = generateUnifiedDiff("", novo, "src/novo.ts");

    expect(result).toContain("--- a/src/novo.ts");
    expect(result).toContain("+++ b/src/novo.ts");
    // Cada linha do novo arquivo deve ser uma adição
    expect(result).toContain("+ export const x = 1;");
    expect(result).toContain("+ export const y = 2;");
  });
});

// === renderSideBySide (cores por tipo) =======================================

describe("renderSideBySide — cores ANSI por tipo de linha", () => {
  it("renderiza linhas removidas com fundo vermelho (\\x1b[41m)", () => {
    const diff: DiffLine[] = [
      { oldNum: 1, newNum: null, oldContent: "linha removida", newContent: "", type: "removed" },
    ];
    const rendered = renderSideBySide(diff);
    // Código ANSI 41 = fundo vermelho
    expect(rendered).toContain("\x1b[41m");
    expect(rendered).toContain("\x1b[37m"); // texto branco
    expect(rendered).toContain("linha removida");
  });

  it("renderiza linhas adicionadas com fundo verde (\\x1b[42m)", () => {
    const diff: DiffLine[] = [
      { oldNum: null, newNum: 1, oldContent: "", newContent: "linha nova", type: "added" },
    ];
    const rendered = renderSideBySide(diff);
    // Código ANSI 42 = fundo verde
    expect(rendered).toContain("\x1b[42m");
    expect(rendered).toContain("\x1b[37m"); // texto branco
    expect(rendered).toContain("linha nova");
  });
});

// === Truncamento de linhas longas ============================================

describe("renderSideBySide — truncamento de linhas longas", () => {
  it("trunca conteúdo antigo maior que halfWidth", () => {
    const longLine = "X".repeat(500);
    const diff: DiffLine[] = [
      {
        oldNum: 1,
        newNum: 1,
        oldContent: longLine,
        newContent: "short",
        type: "same",
      },
    ];
    // maxLineWidth = 40 -> halfWidth = (40-5)/2 = 17
    const rendered = renderSideBySide(diff, 40);

    // A linha longa deve ser truncada — não pode conter os 500 'X's
    expect(rendered).not.toContain("X".repeat(500));
    // Mas deve conter parte do conteúdo truncado
    expect(rendered).toContain("X".repeat(17));
  });

  it("trunca conteúdo novo maior que halfWidth mantendo o separador |", () => {
    const longNew = "Y".repeat(300);
    const diff: DiffLine[] = [
      {
        oldNum: 1,
        newNum: 1,
        oldContent: "old",
        newContent: longNew,
        type: "same",
      },
    ];
    const rendered = renderSideBySide(diff, 30);

    // O separador | deve aparecer
    expect(rendered).toContain(" | ");
    // Não pode conter os 300 'Y's completos
    expect(rendered).not.toContain("Y".repeat(300));
  });
});

// === Empty diff ==============================================================

describe("renderSideBySide — diff vazio", () => {
  it("renderiza apenas o cabeçalho quando diff é array vazio", () => {
    const rendered = renderSideBySide([]);
    // Deve conter o cabeçalho OLD/NEW e a linha separadora
    expect(rendered).toContain("OLD");
    expect(rendered).toContain("NEW");
    expect(rendered).toContain("---");
    // Não deve conter linhas adicionais além do cabeçalho
    const lines = rendered.split("\n");
    expect(lines.length).toBe(2);
  });
});

// === Binary file (caracteres de controle / null bytes) =======================

describe("computeSideBySideDiff — conteúdo binário", () => {
  it("não quebra com caracteres nulos e bytes de controle", () => {
    // Conteúdo binário simulado com null bytes e caracteres não-printáveis
    const bin1 = "header\x00\x01\x02footer";
    const bin2 = "header\x00\x01\x02changed";

    // Não deve lançar exceção — diff deve processar como texto
    expect(() => computeSideBySideDiff(bin1, bin2)).not.toThrow();

    const diff = computeSideBySideDiff(bin1, bin2);
    // Como "footer" muda para "changed", deve haver pelo menos uma alteração
    expect(diff.length).toBeGreaterThan(0);

    // Deve conseguir renderizar também sem quebrar
    expect(() => renderSideBySide(diff, 60)).not.toThrow();
  });
});
