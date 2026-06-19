/**
 * useTerminal-hooks.test.tsx — Testes dos hooks React de useTerminal.ts.
 *
 * O arquivo existente (useTerminal.test.ts) só cobre as funções puras
 * (calculateCardWidth, truncateStr, truncateMiddle). Aqui cobrimos os
 * hooks React que dependem do stdout do Ink:
 *   - useTerminalWidth
 *   - useSeparator
 *   - useMaxContentWidth
 *
 * Estratégia: mockar `useStdout` do Ink para retornar um emitter
 * controlável com `columns` mutável. Renderizamos componentes Probe que
 * invocam o hook e exibem o resultado via <Text>, permitindo verificar o
 * output com ink-testing-library.
 *
 * Nota: o ink-testing-library usa um stdout interno com `columns=100`
 * fixo (hardcoded). Ink wrapping acontece nessa largura — para evitar
 * wrap inesperado, mantemos os testes com widths < 100 quando o tamanho
 * exato do output importa.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { act } from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";

// Configura o ambiente React para que act() funcione sem warnings.
// (React 19 exige IS_REACT_ACT_ENVIRONMENT=true para usar act em testes.)
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Mock useStdout para retornar um stdout controlável ────────────────────
// Usamos vi.hoisted para que o mockStdout esteja disponível quando o factory
// do vi.mock rodar (ele é hoisted para o topo do arquivo). Não podemos usar
// `EventEmitter` de node:events aqui porque imports ainda não rodaram —
// implementamos um emitter mínimo inline.
const { mockStdout, mockState } = vi.hoisted(() => {
  // Emitter mínimo: só o que o useTerminal precisa (on/off/emit).
  class MockStdout {
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    columns: number | undefined = 80;

    on(event: string, fn: (...args: unknown[]) => void): this {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(fn);
      return this;
    }
    off(event: string, fn: (...args: unknown[]) => void): this {
      this.listeners.get(event)?.delete(fn);
      return this;
    }
    emit(event: string, ...args: unknown[]): boolean {
      const set = this.listeners.get(event);
      if (!set) return false;
      for (const fn of set) fn(...args);
      return true;
    }
  }
  return {
    mockStdout: new MockStdout(),
    // `noStdout=true` faz useStdout retornar undefined (simula non-TTY).
    mockState: { noStdout: false as boolean },
  };
});

vi.mock("ink", async () => {
  const actual = await vi.importActual<typeof import("ink")>("ink");
  return {
    ...actual,
    // useStdout pode retornar undefined (non-TTY) ou o mockStdout.
    useStdout: () => ({
      stdout: mockState.noStdout ? undefined : mockStdout,
      write: () => {},
    }),
  };
});

// Imports DEPOIS do mock.
import {
  useTerminalWidth,
  useSeparator,
  useMaxContentWidth,
  MIN_TERMINAL_WIDTH,
  DEFAULT_TERMINAL_WIDTH,
} from "../tui/useTerminal.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Probe que renderiza o valor retornado por useTerminalWidth como "W=<n>". */
function WidthProbe() {
  const w = useTerminalWidth();
  return <Text>{`W=${w}`}</Text>;
}

/** Probe que renderiza o separador retornado por useSeparator. */
function SeparatorProbe({ char = "=", width }: { char?: string; width?: number }) {
  const sep = useSeparator(char, width);
  return <Text>{sep}</Text>;
}

/** Probe que usa useMaxContentWidth e trunca uma string de teste. */
function MaxContentProbe({ prefixLen, testStr }: { prefixLen: number; testStr: string }) {
  const truncate = useMaxContentWidth(prefixLen);
  return <Text>{truncate(testStr)}</Text>;
}

// ─── Testes ───────────────────────────────────────────────────────────────

describe("useTerminal hooks", () => {
  beforeEach(() => {
    // Reset estado do mock entre testes.
    mockStdout.columns = 80;
    mockState.noStdout = false;
  });

  // ─── useTerminalWidth ────────────────────────────────────────────────

  describe("useTerminalWidth", () => {
    it("retorna número ≥ 60 (MIN_TERMINAL_WIDTH) em TTY normal", () => {
      mockStdout.columns = 90;
      const { lastFrame } = render(<WidthProbe />);
      const out = stripAnsi(lastFrame() ?? "");
      const match = out.match(/W=(\d+)/);
      expect(match).not.toBeNull();
      const w = parseInt(match![1], 10);
      expect(w).toBeGreaterThanOrEqual(MIN_TERMINAL_WIDTH);
    });

    it("sempre retorna pelo menos MIN_TERMINAL_WIDTH mesmo com columns muito baixo", () => {
      mockStdout.columns = 10; // abaixo do mínimo
      const { lastFrame } = render(<WidthProbe />);
      const out = stripAnsi(lastFrame() ?? "");
      const match = out.match(/W=(\d+)/);
      expect(match).not.toBeNull();
      const w = parseInt(match![1], 10);
      expect(w).toBe(MIN_TERMINAL_WIDTH);
    });

    it("re-renderiza quando stdout emite evento 'resize'", () => {
      mockStdout.columns = 70;
      const { lastFrame } = render(<WidthProbe />);
      expect(stripAnsi(lastFrame() ?? "")).toBe("W=70");

      // Simula usuário redimensionando o terminal para 80 colunas.
      // Usamos act() para garantir que o setState dentro do handler seja
      // flusheado antes da próxima asserção (React 19 batch updates).
      act(() => {
        mockStdout.columns = 80;
        mockStdout.emit("resize");
      });

      // Após o resize, o hook deve ter re-renderizado com o novo valor.
      expect(stripAnsi(lastFrame() ?? "")).toBe("W=80");
    });

    it("re-renderiza múltiplas vezes em múltiplos 'resize'", () => {
      mockStdout.columns = 60;
      const { lastFrame } = render(<WidthProbe />);
      expect(stripAnsi(lastFrame() ?? "")).toBe("W=60");

      act(() => {
        mockStdout.columns = 70;
        mockStdout.emit("resize");
      });
      expect(stripAnsi(lastFrame() ?? "")).toBe("W=70");

      act(() => {
        mockStdout.columns = 80;
        mockStdout.emit("resize");
      });
      expect(stripAnsi(lastFrame() ?? "")).toBe("W=80");
    });

    it("fallback pra DEFAULT_TERMINAL_WIDTH quando stdout.columns é undefined (non-TTY)", () => {
      // Testa o cenário "non-TTY": stdout.columns undefined E process.stdout.columns undefined.
      const originalDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
      Object.defineProperty(process.stdout, "columns", {
        value: undefined,
        configurable: true,
      });
      mockStdout.columns = undefined;

      const { lastFrame } = render(<WidthProbe />);
      const out = stripAnsi(lastFrame() ?? "");
      const match = out.match(/W=(\d+)/);
      expect(match).not.toBeNull();
      const w = parseInt(match![1], 10);
      expect(w).toBe(DEFAULT_TERMINAL_WIDTH);

      // Restaura o descritor original.
      if (originalDesc) {
        Object.defineProperty(process.stdout, "columns", originalDesc);
      }
    });

    it("usa process.stdout.columns quando stdout.columns é undefined", () => {
      // Cenário: stdout não tem columns, mas process.stdout tem (fallback parcial).
      const originalDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
      Object.defineProperty(process.stdout, "columns", {
        value: 72,
        configurable: true,
      });
      mockStdout.columns = undefined;

      const { lastFrame } = render(<WidthProbe />);
      const out = stripAnsi(lastFrame() ?? "");
      const match = out.match(/W=(\d+)/);
      expect(match).not.toBeNull();
      const w = parseInt(match![1], 10);
      expect(w).toBe(72); // caiu no fallback de process.stdout.columns

      if (originalDesc) {
        Object.defineProperty(process.stdout, "columns", originalDesc);
      }
    });

    it("quando stdout é undefined (null), ainda retorna valor válido (≥ MIN_TERMINAL_WIDTH)", () => {
      // Simula non-TTY total: useStdout retorna undefined.
      mockState.noStdout = true;
      const { lastFrame } = render(<WidthProbe />);
      const out = stripAnsi(lastFrame() ?? "");
      const match = out.match(/W=(\d+)/);
      expect(match).not.toBeNull();
      const w = parseInt(match![1], 10);
      expect(w).toBeGreaterThanOrEqual(MIN_TERMINAL_WIDTH);
    });

    it("respeita MIN_TERMINAL_WIDTH mesmo se process.stdout.columns for muito baixo (stdout undefined)", () => {
      const originalDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
      Object.defineProperty(process.stdout, "columns", {
        value: 5,
        configurable: true,
      });
      mockState.noStdout = true; // força fallback pra process.stdout

      const { lastFrame } = render(<WidthProbe />);
      const out = stripAnsi(lastFrame() ?? "");
      const match = out.match(/W=(\d+)/);
      expect(match).not.toBeNull();
      const w = parseInt(match![1], 10);
      // Mesmo process.stdout.columns=5, o hook clampa pra MIN_TERMINAL_WIDTH.
      expect(w).toBe(MIN_TERMINAL_WIDTH);

      if (originalDesc) {
        Object.defineProperty(process.stdout, "columns", originalDesc);
      }
    });
  });

  // ─── useSeparator ───────────────────────────────────────────────────

  describe("useSeparator", () => {
    it("retorna string de tamanho = terminalWidth quando chamado sem width", () => {
      mockStdout.columns = 80;
      const { lastFrame } = render(<SeparatorProbe char="=" />);
      const out = stripAnsi(lastFrame() ?? "");
      // Output deve ser exatamente 80 `=` chars (sem wrap, pois 80 < 100).
      expect(out).toBe("=".repeat(80));
    });

    it("retorna string fixa de 50 chars quando width=50 (ignora terminalWidth)", () => {
      mockStdout.columns = 90; // mesmo com terminal largo, deve usar 50
      const { lastFrame } = render(<SeparatorProbe char="-" width={50} />);
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toBe("-".repeat(50));
    });

    it("usa char customizado (ex.: '*', '#', '=')", () => {
      mockStdout.columns = 80;
      const { lastFrame: r1 } = render(<SeparatorProbe char="*" width={10} />);
      expect(stripAnsi(r1() ?? "")).toBe("*".repeat(10));

      const { lastFrame: r2 } = render(<SeparatorProbe char="#" width={5} />);
      expect(stripAnsi(r2() ?? "")).toBe("#".repeat(5));
    });

    it("sempre retorna pelo menos 1 char mesmo com width=0", () => {
      mockStdout.columns = 80;
      const { lastFrame } = render(<SeparatorProbe char="=" width={0} />);
      const out = stripAnsi(lastFrame() ?? "");
      // Math.max(1, 0) = 1
      expect(out).toBe("=");
    });

    it("repete o char corretamente quando terminal é redimensionado", () => {
      mockStdout.columns = 60;
      const { lastFrame } = render(<SeparatorProbe char="=" />);
      expect(stripAnsi(lastFrame() ?? "")).toBe("=".repeat(60));

      act(() => {
        mockStdout.columns = 80;
        mockStdout.emit("resize");
      });
      expect(stripAnsi(lastFrame() ?? "")).toBe("=".repeat(80));
    });
  });

  // ─── useMaxContentWidth ─────────────────────────────────────────────

  describe("useMaxContentWidth", () => {
    it("retorna função que trunca strings baseado em (terminalWidth - prefixLen)", () => {
      mockStdout.columns = 80;
      // prefixLen=10 → maxChars = max(20, 80-10) = 70
      const longStr = "A".repeat(120);
      const { lastFrame } = render(<MaxContentProbe prefixLen={10} testStr={longStr} />);
      const out = stripAnsi(lastFrame() ?? "");
      // truncateStr adiciona "..." quando trunca: 70 chars total.
      expect(out.length).toBe(70);
      expect(out).toContain("...");
      expect(out.startsWith("A")).toBe(true);
    });

    it("retorna função que NÃO trunca strings curtas", () => {
      mockStdout.columns = 80;
      const shortStr = "hello";
      const { lastFrame } = render(<MaxContentProbe prefixLen={10} testStr={shortStr} />);
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toBe("hello"); // string curta é retornada inalterada
    });

    it("com prefixLen=0, trunca para ~terminalWidth chars", () => {
      mockStdout.columns = 60;
      // prefixLen=0 → maxChars = max(20, 60-0) = 60
      const longStr = "B".repeat(100);
      const { lastFrame } = render(<MaxContentProbe prefixLen={0} testStr={longStr} />);
      const out = stripAnsi(lastFrame() ?? "");
      // 60 chars total (57 + "..."), então truncou pra 60.
      expect(out.length).toBe(60);
      expect(out).toContain("...");
    });

    it("sempre permite pelo menos 20 chars (clamp mínimo)", () => {
      // prefixLen maior que terminalWidth → maxChars = max(20, ...)
      mockStdout.columns = 60;
      const longStr = "C".repeat(100);
      const { lastFrame } = render(<MaxContentProbe prefixLen={80} testStr={longStr} />);
      const out = stripAnsi(lastFrame() ?? "");
      // max(20, 60-80=-20) = 20 → string truncada pra 20 chars (17 + "...")
      expect(out.length).toBe(20);
      expect(out).toContain("...");
    });

    it("a função retornada é estável entre renders (memoized via useCallback)", () => {
      mockStdout.columns = 80;
      const fnRefs: Array<(s: string) => string> = [];
      function Probe() {
        const fn = useMaxContentWidth(10);
        fnRefs.push(fn);
        return <Text>probe</Text>;
      }
      const { rerender } = render(<Probe />);
      rerender(<Probe />);
      // Como maxChars é o mesmo, useCallback deve retornar a mesma instância.
      expect(fnRefs.length).toBeGreaterThanOrEqual(2);
      expect(fnRefs[0]).toBe(fnRefs[1]);
    });

    it("a função mudará de instância quando terminalWidth mudar", () => {
      mockStdout.columns = 80;
      const fnRefs: Array<(s: string) => string> = [];
      function Probe() {
        const fn = useMaxContentWidth(10);
        fnRefs.push(fn);
        return <Text>probe</Text>;
      }
      const { rerender } = render(<Probe />);

      act(() => {
        mockStdout.columns = 90;
        mockStdout.emit("resize");
      });

      rerender(<Probe />);
      // maxChars mudou (80-10=70 → 90-10=80), então nova instância.
      expect(fnRefs.length).toBeGreaterThanOrEqual(2);
      expect(fnRefs[0]).not.toBe(fnRefs[fnRefs.length - 1]);
    });
  });
});
