/**
 * strictQualityGate-extended.test.ts — Cobertura adicional para strictQualityGate.ts.
 *
 * Expande os casos do strictQualityGate.test.ts original cobrindo:
 *   - runQualityGate: tsc + lint ambos passam, tsc falha, lint falha
 *     (estes já existem — focus em NEW cenários: ambos falham, spawn erro)
 *   - isStrictModeEnabled: STRICT_MODE=0 (false), STRICT_MODE=1 (true)
 *   - parseSkipPatterns (via getQualityGateConfig): parsing de múltiplos
 *     padrões, padrões com whitespace, valor vazio
 *   - max blocks: comportamento no limite (maxBlocks=1)
 *   - skip patterns aplicados a arquivos touched
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

// Mock selfHealing para evitar dependência externa
vi.mock("../selfHealing.js", () => ({
  parseErrors: vi.fn(() => []),
  formatStructuredErrors: vi.fn(() => ""),
}));

// Mock activityTracker para evitar efeitos colaterais
vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(() => () => {}),
}));

// Mock spawn determinístico
const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("node:child_process", () => ({
  get spawn() { return mockSpawn; },
}));

function makeFakeChild(opts: { stdout?: string; stderr?: string; exitCode?: number; error?: Error }) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => true };
  child.kill = () => {};
  setTimeout(() => {
    if (opts.error) { child.emit("error", opts.error); return; }
    if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
    child.emit("close", opts.exitCode ?? 0);
  }, 1);
  return child;
}

import {
  getQualityGateConfig,
  runQualityGate,
  resetGateState,
  getGateState,
  isStrictModeEnabled,
} from "../strictQualityGate.js";

let tmpProject: string;
let originalCwd: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalCwd = process.cwd();
  originalEnv = { ...process.env };
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "gate_ext_"));
  fs.writeFileSync(path.join(tmpProject, "package.json"), JSON.stringify({
    name: "test-ext",
    scripts: { lint: "echo lint-ok" },
  }), "utf8");
  fs.writeFileSync(path.join(tmpProject, "tsconfig.json"), "{}", "utf8");
  process.chdir(tmpProject);
  resetGateState();
  mockSpawn.mockReset();
});

afterEach(() => {
  process.chdir(originalCwd);
  process.env = originalEnv;
  try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("strictQualityGate (extended)", () => {
  describe("runQualityGate — cenários novos", () => {
    it("tsc E lint ambos passam: permite finish (caminho feliz)", async () => {
      process.env.STRICT_MODE = "true";
      mockSpawn.mockImplementation(() => makeFakeChild({ exitCode: 0 }));
      const result = await runQualityGate([path.join(tmpProject, "ok.ts")]);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("passed");
      expect(result.consecutiveBlocks).toBe(0);
    });

    it("tsc falha: bloqueia finish e incrementa consecutiveBlocks", async () => {
      process.env.STRICT_MODE = "true";
      mockSpawn.mockImplementation((cmd: string) => {
        if (cmd === "npx") return makeFakeChild({ stdout: "TS2322: erro de tipo", exitCode: 1 });
        return makeFakeChild({ exitCode: 0 });
      });
      const result = await runQualityGate([path.join(tmpProject, "broken.ts")]);
      expect(result.allowed).toBe(false);
      expect(result.errorLog).toContain("TypeScript errors");
      expect(result.consecutiveBlocks).toBe(1);
      const state = getGateState();
      expect(state.totalBlocks).toBe(1);
      expect(state.consecutiveBlocks).toBe(1);
    });

    it("lint falha: bloqueia finish e inclui 'Lint errors' no log", async () => {
      process.env.STRICT_MODE = "true";
      mockSpawn.mockImplementation((cmd: string) => {
        if (cmd === "npm") return makeFakeChild({ stdout: "eslint: 3 errors", exitCode: 2 });
        return makeFakeChild({ exitCode: 0 });
      });
      const result = await runQualityGate([path.join(tmpProject, "lint-bad.ts")]);
      expect(result.allowed).toBe(false);
      expect(result.errorLog).toContain("Lint errors");
    });

    it("tsc E lint ambos falham: erroLog contém ambas as seções", async () => {
      process.env.STRICT_MODE = "true";
      mockSpawn.mockImplementation((cmd: string) => {
        if (cmd === "npx") return makeFakeChild({ stdout: "TS1234: tipo errado", exitCode: 1 });
        if (cmd === "npm") return makeFakeChild({ stdout: "eslint: 1 error", exitCode: 1 });
        return makeFakeChild({ exitCode: 0 });
      });
      const result = await runQualityGate([path.join(tmpProject, "all-bad.ts")]);
      expect(result.allowed).toBe(false);
      expect(result.errorLog).toContain("TypeScript errors");
      expect(result.errorLog).toContain("Lint errors");
      expect(result.reason).toContain("validator(s) failed");
    });

    it("spawn emite erro (comando not found): gate bloqueia com erro de spawn", async () => {
      process.env.STRICT_MODE = "true";
      mockSpawn.mockImplementation(() => makeFakeChild({ error: new Error("spawn npx ENOENT") }));
      const result = await runQualityGate([path.join(tmpProject, "foo.ts")]);
      // Como o spawn falhou, ok=false → deve bloquear
      expect(result.allowed).toBe(false);
      expect(result.errorLog).toBeTruthy();
    });
  });

  describe("isStrictModeEnabled — valores numéricos", () => {
    it("STRICT_MODE=1 retorna true", () => {
      process.env.STRICT_MODE = "1";
      expect(isStrictModeEnabled()).toBe(true);
    });

    it("STRICT_MODE=0 retorna false", () => {
      process.env.STRICT_MODE = "0";
      expect(isStrictModeEnabled()).toBe(false);
    });

    it("STRICT_MODE=TRUE (maiúsculo) retorna true", () => {
      process.env.STRICT_MODE = "TRUE";
      expect(isStrictModeEnabled()).toBe(true);
    });

    it("STRICT_MODE valor não reconhecido usa default (true)", () => {
      process.env.STRICT_MODE = "maybe";
      expect(isStrictModeEnabled()).toBe(true);
    });
  });

  describe("parseSkipPatterns (via STRICT_GATE_SKIP_PATTERNS)", () => {
    it("faz parse de múltiplos padrões separados por vírgula", () => {
      process.env.STRICT_GATE_SKIP_PATTERNS = "src/test/*,docs/*,*.md";
      const cfg = getQualityGateConfig();
      expect(cfg.skipPatterns).toEqual(["src/test/*", "docs/*", "*.md"]);
    });

    it("faz trim de whitespace ao redor de cada padrão", () => {
      process.env.STRICT_GATE_SKIP_PATTERNS = "  src/test/*  ,  docs/*  ";
      const cfg = getQualityGateConfig();
      expect(cfg.skipPatterns).toEqual(["src/test/*", "docs/*"]);
    });

    it("ignora padrões vazios (vírgulas consecutivas)", () => {
      process.env.STRICT_GATE_SKIP_PATTERNS = "a/*,,b/*,";
      const cfg = getQualityGateConfig();
      expect(cfg.skipPatterns).toEqual(["a/*", "b/*"]);
    });

    it("retorna array vazia quando env var é string vazia", () => {
      process.env.STRICT_GATE_SKIP_PATTERNS = "";
      const cfg = getQualityGateConfig();
      expect(cfg.skipPatterns).toEqual([]);
    });

    it("skip pattern aplicado: todos arquivos touched casam → permite finish", async () => {
      process.env.STRICT_MODE = "true";
      process.env.STRICT_GATE_SKIP_PATTERNS = "test/*";
      // Mesmo com spawn falhando, gate não roda porque todos arquivos casam
      mockSpawn.mockImplementation(() => makeFakeChild({ exitCode: 1 }));
      const result = await runQualityGate(["test/foo.ts", "test/bar.ts"]);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("skip patterns");
    });

    it("skip pattern aplicado: apenas ALGUNS arquivos casam → gate roda normalmente", async () => {
      process.env.STRICT_MODE = "true";
      process.env.STRICT_GATE_SKIP_PATTERNS = "test/*";
      mockSpawn.mockImplementation(() => makeFakeChild({ exitCode: 0 }));
      const result = await runQualityGate(["test/foo.ts", "src/main.ts"]);
      // src/main.ts não casa → gate roda → spawn passa → allowed=true
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("passed");
    });
  });

  describe("max blocks — limite", () => {
    it("com maxBlocks=1, primeira falha bloqueia e segunda chamada já permite finish", async () => {
      process.env.STRICT_MODE = "true";
      process.env.STRICT_GATE_MAX_BLOCKS = "1";
      mockSpawn.mockImplementation((cmd: string) => {
        if (cmd === "npx") return makeFakeChild({ stdout: "err", exitCode: 1 });
        return makeFakeChild({ exitCode: 0 });
      });

      // 1ª chamada: consecutiveBlocks era 0, ainda < 1, roda e falha
      const r1 = await runQualityGate([path.join(tmpProject, "broken.ts")]);
      expect(r1.allowed).toBe(false);
      expect(r1.consecutiveBlocks).toBe(1);

      // 2ª chamada: consecutiveBlocks == 1 >= maxBlocks(1) → permite finish
      const r2 = await runQualityGate([path.join(tmpProject, "broken.ts")]);
      expect(r2.allowed).toBe(true);
      expect(r2.reason).toContain("max consecutive blocks");
    });

    it("getGateState reflete totalBlocks acumulado após múltiplos blocos", async () => {
      process.env.STRICT_MODE = "true";
      process.env.STRICT_GATE_MAX_BLOCKS = "5";
      mockSpawn.mockImplementation((cmd: string) => {
        if (cmd === "npx") return makeFakeChild({ stdout: "err", exitCode: 1 });
        return makeFakeChild({ exitCode: 0 });
      });

      await runQualityGate([path.join(tmpProject, "a.ts")]);
      await runQualityGate([path.join(tmpProject, "b.ts")]);
      await runQualityGate([path.join(tmpProject, "c.ts")]);

      const state = getGateState();
      expect(state.totalBlocks).toBe(3);
      expect(state.consecutiveBlocks).toBe(3);
      expect(state.lastErrorLog).toBeTruthy();
    });
  });

  describe("passGate reseta contador", () => {
    it("após blocos consecutivos, um sucesso zera consecutiveBlocks", async () => {
      process.env.STRICT_MODE = "true";
      // Primeiro falha, depois passa
      let callCount = 0;
      mockSpawn.mockImplementation((cmd: string) => {
        callCount++;
        if (cmd === "npx" && callCount === 1) {
          return makeFakeChild({ stdout: "TS1", exitCode: 1 });
        }
        return makeFakeChild({ exitCode: 0 });
      });

      const r1 = await runQualityGate([path.join(tmpProject, "x.ts")]);
      expect(r1.allowed).toBe(false);
      expect(r1.consecutiveBlocks).toBe(1);

      const r2 = await runQualityGate([path.join(tmpProject, "x.ts")]);
      expect(r2.allowed).toBe(true);
      expect(r2.consecutiveBlocks).toBe(0);
      expect(getGateState().consecutiveBlocks).toBe(0);
    });
  });
});
