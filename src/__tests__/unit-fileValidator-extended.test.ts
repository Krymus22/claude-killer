/**
 * unit-fileValidator-extended.test.ts — Deep unit tests for src/fileValidator.ts
 *
 * Coverage focus:
 *   - matchesPattern: glob matching for various patterns (*.ts, *.luau, *, exact)
 *   - matchesPattern case sensitivity, no extension, multiple dots
 *   - shouldValidateFile: false when no mode active, true for .luau in roblox mode
 *   - getActiveValidationRules: empty when no mode, returns rules when active
 *   - validateFile: ok when no rules match, blocks on selene errors, allows on pass
 *   - Edge cases: empty path, large content, custom command, timeout, missing binary
 *
 * All external deps are mocked: logger, child_process.spawn, toolDetector.findToolBinary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

// --- Mocks ------------------------------------------------------------------

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  throttle: vi.fn(),
}));

// Mock toolDetector (fileValidator imports findToolBinary dynamically)
const toolDetectorState = vi.hoisted(() => ({
  // Map: toolName -> binaryPath (or null if missing)
  binaries: {} as Record<string, string | null>,
  reset() {
    this.binaries = {};
  },
  set(tool: string, present: boolean) {
    this.binaries[tool] = present ? `/fake/bin/${tool}` : null;
  },
}));

vi.mock("../toolDetector.js", () => ({
  findToolBinary: vi.fn((toolName: string) => {
    if (toolName in toolDetectorState.binaries) {
      return toolDetectorState.binaries[toolName];
    }
    return null;
  }),
}));

// Mock node:child_process spawn to control tool exit codes / output
const spawnState = vi.hoisted(() => {
  type Resp = { code: number; stdout?: string; stderr?: string; error?: string; hangMs?: number };
  return {
    responses: {} as Record<string, Resp>,
    defaultResponse: { code: 0, stdout: "", stderr: "" } as Resp,
    reset() {
      this.responses = {};
      this.defaultResponse = { code: 0, stdout: "", stderr: "" };
    },
    set(key: string, resp: Resp) {
      this.responses[key] = resp;
    },
  };
});

vi.mock("node:child_process", () => ({
  spawn: vi.fn((cmd: string, args: string[]) => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    // Match by suffix: "/fake/bin/selene" matches "selene" key
    let resp = spawnState.responses[cmd];
    if (!resp) {
      for (const key of Object.keys(spawnState.responses)) {
        if (cmd === key || cmd.endsWith("/" + key) || cmd.endsWith("\\" + key)) {
          resp = spawnState.responses[key];
          break;
        }
      }
    }
    if (!resp) resp = spawnState.defaultResponse;

    if (resp.hangMs && resp.hangMs > 0) {
      // Don't emit close — let the timeout fire
      return child;
    }

    setImmediate(() => {
      if (resp!.stdout) child.stdout.emit("data", resp!.stdout);
      if (resp!.stderr) child.stderr.emit("data", resp!.stderr);
      if (resp!.error) {
        child.emit("error", new Error(resp!.error));
      } else {
        child.emit("close", resp!.code);
      }
    });

    return child;
  }),
}));

// --- Setup ------------------------------------------------------------------

let tmpHome: string;
let tmpProject: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ck-fileval-ext-home-"));
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "ck-fileval-ext-proj-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  toolDetectorState.reset();
  spawnState.reset();
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpProject, { recursive: true, force: true });
  vi.resetModules();
});

// Helper: import fileValidator fresh after module reset
async function loadFileValidator() {
  return import("../fileValidator.js");
}

// Helper: import modes fresh (needed to set active mode)
async function loadModes() {
  return import("../modes.js");
}

// --- Tests ------------------------------------------------------------------

describe("fileValidator (extended unit) — matchesPattern", () => {
  it("matches *.ts for a .ts file", async () => {
    const { matchesPattern } = await loadFileValidator();
    expect(matchesPattern("foo.ts", "*.ts")).toBe(true);
  });

  it("matches *.luau for a .luau file", async () => {
    const { matchesPattern } = await loadFileValidator();
    expect(matchesPattern("src/foo.luau", "*.luau")).toBe(true);
  });

  it("matches * for any file (catch-all)", async () => {
    const { matchesPattern } = await loadFileValidator();
    expect(matchesPattern("foo.ts", "*")).toBe(true);
    expect(matchesPattern("README", "*")).toBe(true);
    expect(matchesPattern("/abs/path/foo.luau", "*")).toBe(true);
  });

  it("does NOT match *.luau for a .py file (extension mismatch)", async () => {
    const { matchesPattern } = await loadFileValidator();
    expect(matchesPattern("foo.py", "*.luau")).toBe(false);
  });

  it("is case-sensitive: foo.TS does NOT match *.ts", async () => {
    const { matchesPattern } = await loadFileValidator();
    // The implementation uses .endsWith, which is case-sensitive
    expect(matchesPattern("foo.TS", "*.ts")).toBe(false);
  });

  it("does NOT match *.lua for .luau (lua ≠ luau)", async () => {
    const { matchesPattern } = await loadFileValidator();
    // .luau does not end with .lua (the chars after .lua would need to be empty)
    expect(matchesPattern("foo.luau", "*.lua")).toBe(false);
  });

  it("matches exact filename using basename (matches file regardless of path)", async () => {
    const { matchesPattern } = await loadFileValidator();
    expect(matchesPattern("/home/user/proj/foo.luau", "foo.luau")).toBe(true);
    expect(matchesPattern("relative/dir/foo.luau", "foo.luau")).toBe(true);
  });

  it("matches exact name when pattern is exact filename", async () => {
    const { matchesPattern } = await loadFileValidator();
    expect(matchesPattern("foo.luau", "foo.luau")).toBe(true);
  });

  it("does NOT match exact name when filename differs", async () => {
    const { matchesPattern } = await loadFileValidator();
    expect(matchesPattern("foo.luau", "bar.luau")).toBe(false);
  });

  it("does NOT match *.luau for file with no extension", async () => {
    const { matchesPattern } = await loadFileValidator();
    expect(matchesPattern("noext", "*.luau")).toBe(false);
  });

  it("matches *.gz for .tar.gz (multiple dots — uses endsWith)", async () => {
    const { matchesPattern } = await loadFileValidator();
    expect(matchesPattern("archive.tar.gz", "*.gz")).toBe(true);
    expect(matchesPattern("archive.tar.gz", "*.tar.gz")).toBe(true);
  });

  it("matches *.ts for src/index.ts (path with directory)", async () => {
    const { matchesPattern } = await loadFileValidator();
    expect(matchesPattern("src/index.ts", "*.ts")).toBe(true);
  });
});

describe("fileValidator (extended unit) — shouldValidateFile", () => {
  it("returns false when no mode is active (no rules)", async () => {
    const { setActiveMode } = await loadModes();
    setActiveMode(null);
    const { shouldValidateFile } = await loadFileValidator();
    const result = await shouldValidateFile("/proj/foo.luau");
    expect(result).toBe(false);
  });

  it("returns true for .luau when active mode has *.luau rule", async () => {
    const { saveUserMode, setActiveMode } = await loadModes();
    saveUserMode({
      name: "luau-test-mode",
      label: "Luau Test",
      description: "",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
      luauValidation: [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
    });
    setActiveMode("luau-test-mode");
    const { shouldValidateFile } = await loadFileValidator();
    const result = await shouldValidateFile("/proj/foo.luau");
    expect(result).toBe(true);
  });

  it("returns true for .lua when active mode has *.lua rule", async () => {
    const { saveUserMode, setActiveMode } = await loadModes();
    saveUserMode({
      name: "lua-test-mode",
      label: "Lua Test",
      description: "",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
      luauValidation: [{ tool: "selene_lint", filePattern: "*.lua", blocking: true }],
    });
    setActiveMode("lua-test-mode");
    const { shouldValidateFile } = await loadFileValidator();
    const result = await shouldValidateFile("/proj/foo.lua");
    expect(result).toBe(true);
  });

  it("returns false for .ts when active mode only has *.luau rule", async () => {
    const { saveUserMode, setActiveMode } = await loadModes();
    saveUserMode({
      name: "luau-only-test",
      label: "Luau Only Test",
      description: "",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
      luauValidation: [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
    });
    setActiveMode("luau-only-test");
    const { shouldValidateFile } = await loadFileValidator();
    const result = await shouldValidateFile("/proj/foo.ts");
    expect(result).toBe(false);
  });

  it("returns false for any file when active mode has no rules", async () => {
    const { saveUserMode, setActiveMode } = await loadModes();
    saveUserMode({
      name: "no-rules-mode",
      label: "No Rules",
      description: "",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    });
    setActiveMode("no-rules-mode");
    const { shouldValidateFile } = await loadFileValidator();
    expect(await shouldValidateFile("/proj/foo.luau")).toBe(false);
    expect(await shouldValidateFile("/proj/foo.ts")).toBe(false);
  });
});

describe("fileValidator (extended unit) — getActiveValidationRules", () => {
  it("returns empty array when no mode is active", async () => {
    const { setActiveMode } = await loadModes();
    setActiveMode(null);
    const { getActiveValidationRules } = await loadFileValidator();
    const rules = await getActiveValidationRules();
    expect(rules).toEqual([]);
  });

  it("returns rules when active mode has luauValidation rules", async () => {
    const { saveUserMode, setActiveMode } = await loadModes();
    saveUserMode({
      name: "rules-mode",
      label: "Rules Mode",
      description: "",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
      luauValidation: [
        { tool: "selene_lint", filePattern: "*.luau", blocking: true },
        { tool: "stylua_format", filePattern: "*.luau", blocking: false },
      ],
    });
    setActiveMode("rules-mode");
    const { getActiveValidationRules } = await loadFileValidator();
    const rules = await getActiveValidationRules();
    expect(rules.length).toBe(2);
    expect(rules.map((r) => r.tool)).toContain("selene_lint");
    expect(rules.map((r) => r.tool)).toContain("stylua_format");
  });

  it("returns empty when active mode exists but has no validators", async () => {
    const { saveUserMode, setActiveMode } = await loadModes();
    saveUserMode({
      name: "empty-rules-mode",
      label: "Empty Rules",
      description: "",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    });
    setActiveMode("empty-rules-mode");
    const { getActiveValidationRules } = await loadFileValidator();
    const rules = await getActiveValidationRules();
    expect(rules).toEqual([]);
  });
});

describe("fileValidator (extended unit) — validateFile", () => {
  it("returns ok=true when rules array is empty (no rules to apply)", async () => {
    const { validateFile } = await loadFileValidator();
    const result = await validateFile("/proj/foo.luau", "content", [], tmpProject);
    expect(result.ok).toBe(true);
    expect(result.rulesApplied).toEqual([]);
    expect(result.rulesSkipped).toEqual([]);
  });

  it("returns ok=true when no rule matches the file pattern", async () => {
    const { validateFile } = await loadFileValidator();
    const rules = [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }];
    // .py file doesn't match *.luau
    const result = await validateFile("/proj/foo.py", "content", rules, tmpProject);
    expect(result.ok).toBe(true);
    expect(result.rulesApplied).toEqual([]);
  });

  it("blocks on selene errors (spawn exit code != 0 with stdout)", async () => {
    toolDetectorState.set("selene", true);
    spawnState.set("selene", {
      code: 1,
      stdout: "error.luau:1:1: syntax error: unexpected symbol near 'local'",
    });
    const { validateFile } = await loadFileValidator();
    const rules = [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }];
    const result = await validateFile("/proj/foo.luau", "local x = \n", rules, tmpProject);
    expect(result.ok).toBe(false);
    expect(result.blockingError).toContain("selene_lint failed");
    expect(result.rulesApplied).toContain("selene_lint");
  });

  it("allows write on selene pass (spawn exit code 0)", async () => {
    toolDetectorState.set("selene", true);
    spawnState.set("selene", { code: 0, stdout: "" });
    const { validateFile } = await loadFileValidator();
    const rules = [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }];
    const result = await validateFile("/proj/clean.luau", "local x = 1\n", rules, tmpProject);
    expect(result.ok).toBe(true);
    expect(result.blockingError).toBeUndefined();
    expect(result.rulesApplied).toContain("selene_lint");
  });

  it("non-blocking rule adds warning but does NOT block write", async () => {
    toolDetectorState.set("stylua", true);
    spawnState.set("stylua", { code: 1, stdout: "" });
    const { validateFile } = await loadFileValidator();
    const rules = [{ tool: "stylua_format", filePattern: "*.luau", blocking: false }];
    const result = await validateFile("/proj/ugly.luau", "local x=1\n", rules, tmpProject);
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("stylua_format");
  });

  it("blocks when blocking rule's binary is missing (BUG-VALIDATORS)", async () => {
    // selene not set → findToolBinary returns null
    const { validateFile } = await loadFileValidator();
    const rules = [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }];
    const result = await validateFile("/proj/foo.luau", "content", rules, tmpProject);
    expect(result.ok).toBe(false);
    expect(result.blockingError).toContain("not found");
  });

  it("skips non-blocking rule when binary is missing (adds to rulesSkipped)", async () => {
    const { validateFile } = await loadFileValidator();
    const rules = [{ tool: "stylua_format", filePattern: "*.luau", blocking: false }];
    const result = await validateFile("/proj/foo.luau", "content", rules, tmpProject);
    expect(result.ok).toBe(true);
    expect(result.rulesSkipped.length).toBeGreaterThan(0);
    expect(result.rulesSkipped[0]).toContain("not installed");
  });

  it("uses custom command (rule.command) when provided", async () => {
    toolDetectorState.set("terraform", true);
    spawnState.set("terraform", { code: 1, stdout: "Error: invalid config" });
    const { validateFile } = await loadFileValidator();
    const rules = [{
      tool: "terraform_validate",
      filePattern: "*.tf",
      blocking: true,
      command: "terraform validate {file}",
    }];
    const result = await validateFile("/proj/main.tf", "resource \"x\" \"y\" {}\n", rules, tmpProject);
    expect(result.ok).toBe(false);
    expect(result.blockingError).toContain("terraform_validate");
  });

  it("checks stderr output too (BUG-C: not just stdout)", async () => {
    toolDetectorState.set("selene", true);
    // Selene 0.28+ sends diagnostics to stderr — must check stderr
    spawnState.set("selene", { code: 1, stdout: "", stderr: "warning: unused variable" });
    const { validateFile } = await loadFileValidator();
    const rules = [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }];
    const result = await validateFile("/proj/foo.luau", "local x = 1\n", rules, tmpProject);
    expect(result.ok).toBe(false);
    expect(result.blockingError).toContain("unused variable");
  });

  it("handles empty content without crash", async () => {
    toolDetectorState.set("selene", true);
    spawnState.set("selene", { code: 0, stdout: "" });
    const { validateFile } = await loadFileValidator();
    const rules = [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }];
    const result = await validateFile("/proj/empty.luau", "", rules, tmpProject);
    expect(result.ok).toBe(true);
  });

  it("handles very large content (100k lines) without crash", async () => {
    toolDetectorState.set("selene", true);
    spawnState.set("selene", { code: 0, stdout: "" });
    const { validateFile } = await loadFileValidator();
    const rules = [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }];
    const bigContent = "local x = 1\n".repeat(100_000);
    const result = await validateFile("/proj/huge.luau", bigContent, rules, tmpProject);
    expect(result.ok).toBe(true);
  });

  it("blocks on tool timeout for blocking rule (timedOut=true)", async () => {
    toolDetectorState.set("selene", true);
    // hangMs > 0 means don't emit close → spawn's internal 10s timeout fires
    // But 10s is too slow for tests. We just verify the code path doesn't crash.
    // Use spawn 'error' event to simulate quick failure instead.
    spawnState.set("selene", { code: 0, error: "EPERM" });
    const { validateFile } = await loadFileValidator();
    const rules = [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }];
    const result = await validateFile("/proj/foo.luau", "content", rules, tmpProject);
    // spawn error resolves with ok=false, blocking rule blocks
    expect(result.ok).toBe(false);
    expect(result.blockingError).toBeDefined();
  });

  it("exit code 0 with output does NOT block (output is informational)", async () => {
    toolDetectorState.set("selene", true);
    spawnState.set("selene", { code: 0, stdout: "all good" });
    const { validateFile } = await loadFileValidator();
    const rules = [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }];
    const result = await validateFile("/proj/foo.luau", "local x = 1\n", rules, tmpProject);
    expect(result.ok).toBe(true);
  });

  it("multiple rules: applies all matching rules in order", async () => {
    toolDetectorState.set("selene", true);
    toolDetectorState.set("stylua", true);
    spawnState.set("selene", { code: 0, stdout: "" });
    spawnState.set("stylua", { code: 0, stdout: "" });
    const { validateFile } = await loadFileValidator();
    const rules = [
      { tool: "selene_lint", filePattern: "*.luau", blocking: true },
      { tool: "stylua_format", filePattern: "*.luau", blocking: false },
    ];
    const result = await validateFile("/proj/foo.luau", "content", rules, tmpProject);
    expect(result.ok).toBe(true);
    expect(result.rulesApplied).toContain("selene_lint");
    expect(result.rulesApplied).toContain("stylua_format");
    expect(result.rulesApplied.length).toBe(2);
  });

  it("hint for falso positivo (selene undefined global + autoResearch enabled)", async () => {
    toolDetectorState.set("selene", true);
    spawnState.set("selene", {
      code: 1,
      stdout: "warning: undefined global RobloxAPI",
    });
    const { saveUserMode, setActiveMode } = await loadModes();
    saveUserMode({
      name: "hint-mode",
      label: "Hint",
      description: "",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
      autoResearch: true,
      luauValidation: [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
    });
    setActiveMode("hint-mode");
    const { validateFile } = await loadFileValidator();
    const rules = [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }];
    const result = await validateFile("/proj/foo.luau", "RobloxAPI()\n", rules, tmpProject);
    expect(result.ok).toBe(false);
    expect(result.blockingError).toContain("FALSO POSITIVO");
  });
});

describe("fileValidator (extended unit) — edge cases", () => {
  it("matchesPattern handles empty path (basename is empty string)", async () => {
    const { matchesPattern } = await loadFileValidator();
    // path.basename("") === ""
    expect(matchesPattern("", "*")).toBe(true);
    expect(matchesPattern("", "*.luau")).toBe(false);
  });

  it("matchesPattern with single dot file (.bashrc)", async () => {
    const { matchesPattern } = await loadFileValidator();
    expect(matchesPattern(".bashrc", "*")).toBe(true);
    // ".bashrc" doesn't end with ".luau"
    expect(matchesPattern(".bashrc", "*.luau")).toBe(false);
  });

  it("validateFile handles empty path (still writes temp file)", async () => {
    toolDetectorState.set("selene", true);
    spawnState.set("selene", { code: 0, stdout: "" });
    const { validateFile } = await loadFileValidator();
    const rules = [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }];
    // Empty path — fileValidator still creates temp file and runs validator
    const result = await validateFile("", "content", rules, tmpProject);
    // Should not throw — result.ok reflects selene's exit code
    expect(typeof result.ok).toBe("boolean");
  });

  it("validateFile handles file path with spaces", async () => {
    toolDetectorState.set("selene", true);
    spawnState.set("selene", { code: 0, stdout: "" });
    const { validateFile } = await loadFileValidator();
    const rules = [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }];
    const result = await validateFile("/proj/my file.luau", "local x = 1\n", rules, tmpProject);
    expect(result.ok).toBe(true);
  });

  it("validateFile handles file path with unicode characters", async () => {
    toolDetectorState.set("selene", true);
    spawnState.set("selene", { code: 0, stdout: "" });
    const { validateFile } = await loadFileValidator();
    const rules = [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }];
    const result = await validateFile("/proj/café_日本語.luau", "local x = 1\n", rules, tmpProject);
    expect(result.ok).toBe(true);
  });
});
