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

// Mock spawn so we control tsc/lint outcomes deterministically
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
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "gate_test_"));
  fs.writeFileSync(path.join(tmpProject, "package.json"), JSON.stringify({
    name: "test",
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

describe("strictQualityGate", () => {
  describe("getQualityGateConfig", () => {
    it("returns defaults when env not set", () => {
      delete process.env.STRICT_MODE;
      delete process.env.STRICT_GATE_TSC;
      delete process.env.STRICT_GATE_LINT;
      delete process.env.STRICT_GATE_MAX_BLOCKS;
      const cfg = getQualityGateConfig();
      expect(cfg.strictMode).toBe(true);
      expect(cfg.runTsc).toBe(true);
      expect(cfg.runLint).toBe(true);
      expect(cfg.maxBlocks).toBe(8);
    });

    it("respects STRICT_MODE=false", () => {
      process.env.STRICT_MODE = "false";
      expect(getQualityGateConfig().strictMode).toBe(false);
    });

    it("respects STRICT_GATE_MAX_BLOCKS override", () => {
      process.env.STRICT_GATE_MAX_BLOCKS = "3";
      expect(getQualityGateConfig().maxBlocks).toBe(3);
    });
  });

  describe("isStrictModeEnabled", () => {
    it("returns true by default", () => {
      delete process.env.STRICT_MODE;
      expect(isStrictModeEnabled()).toBe(true);
    });
    it("returns false when STRICT_MODE=false", () => {
      process.env.STRICT_MODE = "false";
      expect(isStrictModeEnabled()).toBe(false);
    });
  });

  describe("runQualityGate", () => {
    it("allows finish when STRICT_MODE is off", async () => {
      process.env.STRICT_MODE = "false";
      const result = await runQualityGate(["/tmp/foo.ts"]);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("disabled");
    });

    it("allows finish when no files were touched", async () => {
      process.env.STRICT_MODE = "true";
      const result = await runQualityGate([]);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("no files touched");
    });

    it("allows finish when tsc + lint both pass (mocked)", async () => {
      process.env.STRICT_MODE = "true";
      // First spawn = tsc, second spawn = lint — both succeed
      mockSpawn.mockImplementation(() => makeFakeChild({ exitCode: 0 }));
      const result = await runQualityGate([path.join(tmpProject, "foo.ts")]);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("passed");
    });

    it("blocks finish when tsc fails (mocked)", async () => {
      process.env.STRICT_MODE = "true";
      // First spawn = tsc (fails), second spawn = lint (won't run because tsc failed first; but our code runs both)
      mockSpawn.mockImplementation((cmd: string) => {
        if (cmd === "npx") return makeFakeChild({ stdout: "TS2322: Type mismatch", exitCode: 1 });
        return makeFakeChild({ exitCode: 0 });
      });
      const result = await runQualityGate([path.join(tmpProject, "broken.ts")]);
      expect(result.allowed).toBe(false);
      expect(result.errorLog).toContain("TypeScript errors");
      expect(result.consecutiveBlocks).toBe(1);
    });

    it("blocks finish when lint fails (mocked)", async () => {
      process.env.STRICT_MODE = "true";
      mockSpawn.mockImplementation((cmd: string) => {
        if (cmd === "npm") return makeFakeChild({ stdout: "eslint: 2 errors", exitCode: 1 });
        return makeFakeChild({ exitCode: 0 });
      });
      const result = await runQualityGate([path.join(tmpProject, "x.ts")]);
      expect(result.allowed).toBe(false);
      expect(result.errorLog).toContain("Lint errors");
    });

    it("resets consecutive counter on success", async () => {
      process.env.STRICT_MODE = "true";
      mockSpawn.mockImplementation(() => makeFakeChild({ exitCode: 0 }));
      await runQualityGate([path.join(tmpProject, "foo.ts")]);
      expect(getGateState().consecutiveBlocks).toBe(0);
    });

    it("gives up after max consecutive blocks", async () => {
      process.env.STRICT_MODE = "true";
      process.env.STRICT_GATE_MAX_BLOCKS = "2";
      mockSpawn.mockImplementation((cmd: string) => {
        if (cmd === "npx") return makeFakeChild({ stdout: "error", exitCode: 1 });
        return makeFakeChild({ exitCode: 0 });
      });

      // First block
      let result = await runQualityGate([path.join(tmpProject, "broken.ts")]);
      expect(result.allowed).toBe(false);
      expect(result.consecutiveBlocks).toBe(1);

      // Second block
      result = await runQualityGate([path.join(tmpProject, "broken.ts")]);
      expect(result.allowed).toBe(false);
      expect(result.consecutiveBlocks).toBe(2);

      // Third call — should give up and allow finish
      result = await runQualityGate([path.join(tmpProject, "broken.ts")]);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("max consecutive blocks");
    });

    it("skips tsc when tsconfig.json is missing", async () => {
      process.env.STRICT_MODE = "true";
      fs.unlinkSync(path.join(tmpProject, "tsconfig.json"));
      // lint passes
      mockSpawn.mockImplementation(() => makeFakeChild({ exitCode: 0 }));
      const result = await runQualityGate([path.join(tmpProject, "foo.ts")]);
      expect(result.allowed).toBe(true);
    });

    it("skips lint when package.json has no lint script", async () => {
      process.env.STRICT_MODE = "true";
      fs.writeFileSync(path.join(tmpProject, "package.json"), JSON.stringify({ name: "test" }), "utf8");
      mockSpawn.mockImplementation(() => makeFakeChild({ exitCode: 0 }));
      const result = await runQualityGate([path.join(tmpProject, "foo.ts")]);
      expect(result.allowed).toBe(true);
    });
  });
});
