/**
 * logger-extended.test.ts — Casos edge que NÃO estão no teste básico.
 * Foco em: log levels (3 extras), TUI mode suppression (2 extras),
 * colorOutput (2 extras) e edge cases (1).
 *
 * PT-BR nos comentários.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { debug: false },
}));

import {
  banner,
  info,
  success,
  warn,
  error,
  reply,
  toolCall,
  toolResult,
  throttle,
  debug,
  divider,
  statusBar,
  formatMarkdown,
  setTuiMode,
  isTuiMode,
  type StatusBarInput,
} from "../logger.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let debugSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  setTuiMode(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  setTuiMode(false);
});

describe("logger — extended", () => {
  // ─── Log levels (3 extras) ─────────────────────────────────────────────────

  describe("log levels — extras", () => {
    it("banner usa console.log (não console.warn/error)", () => {
      banner("TEXTO_BANNER");
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("success prefixa com '[SUCCESS]'", () => {
      success("operação ok");
      const arg = String(logSpy.mock.calls[0]?.[0] ?? "");
      expect(arg).toContain("[SUCCESS]");
      expect(arg).toContain("operação ok");
    });

    it("error usa console.error e prefixa com '[ERROR]'", () => {
      error("falhou");
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const arg = String(errorSpy.mock.calls[0]?.[0] ?? "");
      expect(arg).toContain("[ERROR]");
    });
  });

  // ─── TUI mode suppression (2 extras) ───────────────────────────────────────

  describe("TUI mode suppression — extras", () => {
    it("isTuiMode reflete o estado setado por setTuiMode", () => {
      setTuiMode(true);
      expect(isTuiMode()).toBe(true);
      setTuiMode(false);
      expect(isTuiMode()).toBe(false);
    });

    it("reply, toolCall e toolResult são suprimidos em TUI mode", () => {
      setTuiMode(true);
      reply("texto resposta");
      toolCall("bash", { cmd: "ls" });
      toolResult("bash", true);
      // Em TUI mode, nenhum console.log deve ser emitido por essas funções
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("banner NÃO é suprimido em TUI mode (apenas tool/reply são)", () => {
      setTuiMode(true);
      banner("banner em TUI");
      expect(logSpy).toHaveBeenCalled();
    });
  });

  // ─── Color output (2 extras) ───────────────────────────────────────────────

  describe("colorOutput — extras", () => {
    it("toolCall trunca argumentos longos (>=120 chars) com '...'", () => {
      const huge = { data: "x".repeat(300) };
      toolCall("tool_grande", huge);
      const arg = String(logSpy.mock.calls[0]?.[0] ?? "");
      expect(arg).toContain("...");
    });

    it("toolCall mostra argumentos curtos sem '...'", () => {
      toolCall("t", { a: 1 });
      const arg = String(logSpy.mock.calls[0]?.[0] ?? "");
      expect(arg).not.toContain("...");
      expect(arg).toContain("t(");
    });
  });

  // ─── Edge cases (1) ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("statusBar não lança com contextWindow=0 e tokens=0", () => {
      const input: StatusBarInput = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        contextWindow: 0,
        warnThreshold: 0.7,
        compactThreshold: 0.9,
        costPerKPrompt: 0,
        costPerKCompletion: 0,
      };
      expect(() => statusBar(input)).not.toThrow();
      expect(logSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("formatMarkdown renderiza markdown composto (heading + lista + code)", () => {
      const md = `# Título
- item 1
- item 2
\`\`\`ts
const x = 1;
\`\`\``;
      const r = formatMarkdown(md);
      expect(typeof r).toBe("string");
      expect(r.length).toBeGreaterThan(0);
    });

    it("throttle e divider não conflitam (ambos chamam console.log)", () => {
      throttle("motivo");
      divider();
      expect(logSpy).toHaveBeenCalledTimes(2);
    });

    it("debug() com config.debug=false é silencioso", () => {
      debug("mensagem interna");
      expect(debugSpy).not.toHaveBeenCalled();
    });
  });
});
