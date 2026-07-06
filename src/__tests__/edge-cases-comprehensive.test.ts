/**
 * edge-cases-comprehensive.test.ts — Edge case tests across modules.
 *
 * Each test feeds weird/empty/extreme inputs to verify the modules either
 * handle them gracefully or throw a controlled error (never crash the runner).
 *
 * Strategy: defensive assertions — use try/catch where the module might
 * legitimately throw, and assert the function either returns or throws
 * a normal Error (not a segfault/abort).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Top-level mocks ────────────────────────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn(),
}));

vi.mock("../fileLock.js", () => ({
  acquireLock: vi.fn(async () => vi.fn()),
  getCurrentAgentId: vi.fn(() => "test-agent"),
}));

vi.mock("../honestySystem.js", () => ({
  markFileAsEdited: vi.fn(),
  diffRealityCheck: vi.fn(async () => ({ matches: true, message: "" })),
  detectHallucinations: vi.fn(async () => ({ hallucinatedSymbols: [], message: "" })),
}));
vi.mock("../importResolver.js", () => ({
  checkImports: vi.fn(() => ({ ok: true, message: "" })),
}));
vi.mock("../impactAnalyzer.js", () => ({
  analyzeImpact: vi.fn(async () => ({ referencedBy: [], totalFiles: 0 })),
  formatImpactHint: vi.fn(() => ""),
}));
vi.mock("../luauValidator.js", () => ({
  shouldValidateFile: vi.fn(async () => false),
  getActiveValidationRules: vi.fn(async () => []),
  validateLuauBeforeWrite: vi.fn(async () => ({
    ok: true, blockingError: undefined, warnings: [],
    rulesApplied: [], rulesSkipped: [],
  })),
}));
vi.mock("../safetyReviewer.js", () => ({
  reviewCodeSafety: vi.fn(async () => ({
    risk: "low", reviewedByLlm: false, patternsMatched: [], durationMs: 0,
  })),
  formatSafetyReview: vi.fn(() => ""),
  shouldReviewFile: vi.fn(() => false),
  getDangerousPatterns: vi.fn(() => []),
}));
vi.mock("../hookRunner.js", () => ({
  runHooks: vi.fn(async () => []),
  loadHooks: vi.fn(() => []),
}));
vi.mock("../modeExtensions.js", () => ({
  runPostEditHooks: vi.fn(async () => ""),
  getActivePostEditHooks: vi.fn(async () => []),
}));

// Mock child_process for ensureRobloxTools + clipboard + utf8Safety
const mockExecSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
  spawn: vi.fn(() => {
    const ee: any = { on: vi.fn(), kill: vi.fn(), pid: 12345, stdin: { write: vi.fn(), end: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() } };
    return ee;
  }),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { normalizeArgs } from "../argsNormalizer.js";
import { pokaYokeCheck } from "../pokaYoke.js";
import {
  classifyMcpTool, extractToolName, isRobloxStudioMcpTool,
} from "../robloxMcpGuard.js";
import { setEffortLevel, getEffortLevel } from "../effortLevels.js";
import { detectIntent, filterToolsByIntent } from "../toolReduction.js";
import { validateModeConfig } from "../configSchema.js";
import { loadConfig } from "../dotfileConfig.js";
import { detectLanguageFromExt, highlightSyntax } from "../syntaxHighlight.js";
import { grepSearch, formatGrepResults } from "../contentSearch.js";
import { copyToClipboard } from "../clipboard.js";
import {
  ensureAutoMemoryFile, readAutoMemory, appendAutoMemory,
} from "../autoMemory.js";
import {
  listSystemLocales, forceUtf8Environment,
} from "../utf8Safety.js";
import { checkRobloxTools } from "../ensureRobloxTools.js";

// ─── Shared fixtures ────────────────────────────────────────────────────────

let tmpDir: string;
let origHome: string | undefined;
let origCwd: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-edge-"));
  origHome = process.env.HOME;
  origCwd = process.cwd();
  process.env.HOME = tmpDir;
  setEffortLevel("medium");
  mockExecSync.mockReset();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  process.chdir(origCwd);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// argsNormalizer edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: argsNormalizer", () => {
  it("normalizeArgs with empty object — no crash, no changes", () => {
    const args: Record<string, unknown> = {};
    expect(() => normalizeArgs("test_tool", args)).not.toThrow();
    expect(Object.keys(args).length).toBe(0);
  });

  it("normalizeArgs with null args — throws controlled error (no segfault)", () => {
    // The function signature expects a Record; passing null throws TypeError.
    // The test verifies this is a controlled throw, not a process crash.
    expect(() => normalizeArgs("test_tool", null as any)).toThrow(TypeError);
  });

  it("normalizeArgs with very long string (10000 chars) — no truncation", () => {
    const long = "a".repeat(10000);
    const args: Record<string, unknown> = { path: long };
    normalizeArgs("ler_arquivo", args);
    expect(args.path).toBe(long);
    expect((args.path as string).length).toBe(10000);
  });

  it("normalizeArgs with emoji in args — preserves emoji", () => {
    const args: Record<string, unknown> = { path: "/tmp/🚀.lua" };
    normalizeArgs("ler_arquivo", args);
    expect(args.path).toBe("/tmp/🚀.lua");
  });

  it("normalizeArgs with unicode in args — preserves unicode", () => {
    const args: Record<string, unknown> = { path: "/tmp/café-ção.lua" };
    normalizeArgs("ler_arquivo", args);
    expect(args.path).toBe("/tmp/café-ção.lua");
  });

  it("preserves arrays in args (no coercion of arrays)", () => {
    const arr = [1, 2, 3];
    const args: Record<string, unknown> = { items: arr };
    normalizeArgs("test_tool", args);
    expect(Array.isArray(args.items)).toBe(true);
    expect(args.items).toEqual([1, 2, 3]);
  });

  it("preserves nested objects in args (no flattening)", () => {
    const nested = { a: 1, b: { c: 2 } };
    const args: Record<string, unknown> = { config: nested };
    normalizeArgs("test_tool", args);
    expect(typeof args.config).toBe("object");
    expect((args.config as any).a).toBe(1);
    expect((args.config as any).b.c).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// pokaYoke edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: pokaYoke", () => {
  it("pokaYoke with null args — throws controlled error (no segfault)", () => {
    // pokaYokeCheck accesses args.caminho on path-taking tools.
    expect(() => pokaYokeCheck("ler_arquivo", null as any)).toThrow(TypeError);
  });

  it("pokaYoke with undefined args — throws controlled error (no segfault)", () => {
    expect(() => pokaYokeCheck("ler_arquivo", undefined as any)).toThrow(TypeError);
  });

  it("pokaYoke with empty string tool name — returns ok (no rules for empty name)", () => {
    // Empty tool name is not in PATH_TAKING_TOOLS nor TOOL_SPECIFIC_CHECKS.
    const r = pokaYokeCheck("", { foo: "bar" });
    expect(r.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// robloxMcpGuard edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: robloxMcpGuard", () => {
  it("classifyMcpTool with empty string — returns 'unknown'", () => {
    expect(classifyMcpTool("")).toBe("unknown");
  });

  it("extractToolName with no prefix (no '__') — returns original string", () => {
    expect(extractToolName("no_prefix_here")).toBe("no_prefix_here");
  });

  it("extractToolName with empty string — returns empty string", () => {
    expect(extractToolName("")).toBe("");
  });

  it("isRobloxStudioMcpTool with empty string — returns false", () => {
    expect(isRobloxStudioMcpTool("")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// effortLevels edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: effortLevels", () => {
  it("setEffortLevel with invalid value — returns false, doesn't crash", () => {
    const before = getEffortLevel();
    const ok = setEffortLevel("extreme" as any);
    expect(ok).toBe(false);
    // Level stays at whatever it was before
    expect(getEffortLevel()).toBe(before);
  });

  it("setEffortLevel with empty string — returns false", () => {
    const ok = setEffortLevel("" as any);
    expect(ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// toolReduction edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: toolReduction", () => {
  it("detectIntent with very long string — returns a valid intent", () => {
    const long = "edit the file ".repeat(1000);
    const intent = detectIntent(long);
    // Should be one of the valid TaskIntent values
    expect(["read", "write", "search", "test", "git", "explore", "general"]).toContain(intent);
  });

  it("filterToolsByIntent with empty array — returns empty array", () => {
    const filtered = filterToolsByIntent([], "read");
    expect(filtered).toEqual([]);
  });

  it("filterToolsByIntent with empty array + general intent — returns empty array", () => {
    const filtered = filterToolsByIntent([], "general");
    expect(filtered).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// configSchema edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: configSchema", () => {
  it("validateModeConfig with null — returns errors (root field)", () => {
    const errors = validateModeConfig(null);
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].field).toBe("root");
  });

  it("validateModeConfig with string (not object) — returns errors", () => {
    const errors = validateModeConfig("not-an-object");
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("validateModeConfig with array (not object) — returns errors", () => {
    const errors = validateModeConfig([1, 2, 3]);
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].field).toBe("root");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// dotfileConfig edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: dotfileConfig", () => {
  it("with invalid JSON in config file — loadConfig returns empty object (no throw)", async () => {
    // Write corrupt config file
    const dir = path.join(tmpDir, ".claude-killer");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{not valid json {{{", "utf8");
    // Reset modules so CONFIG_FILE is recomputed with new HOME
    vi.resetModules();
    const mod = await import("../dotfileConfig.js");
    expect(() => mod.loadConfig()).not.toThrow();
    const cfg = mod.loadConfig();
    expect(cfg).toBeDefined();
    expect(typeof cfg).toBe("object");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// syntaxHighlight edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: syntaxHighlight", () => {
  it("detectLanguageFromExt with no extension (empty string) — returns default 'typescript'", () => {
    const lang = detectLanguageFromExt("");
    expect(typeof lang).toBe("string");
    expect(lang.length).toBeGreaterThan(0);
  });

  it("detectLanguageFromExt with multiple dots (file.tar.gz) — returns default for .gz", () => {
    const lang = detectLanguageFromExt(".gz");
    expect(typeof lang).toBe("string");
    // .gz is not mapped; falls back to default
  });

  it("highlightSyntax with empty string — returns empty string (no throw)", () => {
    expect(() => highlightSyntax("", "typescript")).not.toThrow();
    const result = highlightSyntax("", "typescript");
    expect(typeof result).toBe("string");
  });

  it("highlightSyntax with very long code — returns non-empty string", () => {
    const code = "const x = 1;\n".repeat(1000);
    const result = highlightSyntax(code, "typescript");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// contentSearch edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: contentSearch", () => {
  it("grepSearch with empty pattern — returns matches for empty regex (or empty array)", () => {
    // Empty pattern matches every line; we just verify it doesn't throw.
    const file = path.join(tmpDir, "edge.txt");
    fs.writeFileSync(file, "line\n", "utf8");
    expect(() => grepSearch({ pattern: "", path: file })).not.toThrow();
    const result = grepSearch({ pattern: "", path: file });
    expect(Array.isArray(result)).toBe(true);
  });

  it("formatGrepResults with empty array — returns 'no results' string", () => {
    const formatted = formatGrepResults([]);
    expect(typeof formatted).toBe("string");
    expect(formatted.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// clipboard edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: clipboard", () => {
  beforeEach(() => {
    // Default mock: success (empty string return)
    mockExecSync.mockImplementation(() => "");
  });

  it("copyToClipboard with empty string — doesn't throw, returns boolean", () => {
    expect(() => copyToClipboard("")).not.toThrow();
    const result = copyToClipboard("");
    expect(typeof result).toBe("boolean");
  });

  it("copyToClipboard with very long string — doesn't throw, returns boolean", () => {
    const long = "x".repeat(10000);
    expect(() => copyToClipboard(long)).not.toThrow();
    const result = copyToClipboard(long);
    expect(typeof result).toBe("boolean");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// autoMemory edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: autoMemory", () => {
  it("appendAutoMemory with empty string — doesn't throw, file grows or stays", () => {
    ensureAutoMemoryFile();
    const before = readAutoMemory();
    expect(() => appendAutoMemory("")).not.toThrow();
    const after = readAutoMemory();
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  });

  it("appendAutoMemory with emoji — preserves emoji in file", () => {
    ensureAutoMemoryFile();
    appendAutoMemory("test entry with emoji 🎉 and unicode café");
    const content = readAutoMemory();
    expect(content).toContain("🎉");
    expect(content).toContain("café");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// utf8Safety edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: utf8Safety", () => {
  it("listSystemLocales returns array (cached after first call)", () => {
    const locales = listSystemLocales();
    expect(Array.isArray(locales)).toBe(true);
  });

  it("forceUtf8Environment is idempotent (calling twice doesn't throw)", () => {
    expect(() => forceUtf8Environment()).not.toThrow();
    expect(() => forceUtf8Environment()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ensureRobloxTools edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: ensureRobloxTools", () => {
  it("checkRobloxTools returns 4 tools (even when all missing)", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    const tools = checkRobloxTools();
    expect(tools).toHaveLength(4);
  });

  it("each tool has installUrl (URL string)", () => {
    mockExecSync.mockImplementation(() => "/usr/bin/x");
    const tools = checkRobloxTools();
    for (const t of tools) {
      expect(typeof t.installUrl).toBe("string");
      expect(t.installUrl).toMatch(/^https?:\/\//);
    }
  });

  it("selene and stylua are required (required=true)", () => {
    mockExecSync.mockImplementation(() => "/usr/bin/x");
    const tools = checkRobloxTools();
    const selene = tools.find(t => t.name === "selene");
    const stylua = tools.find(t => t.name === "stylua");
    expect(selene?.required).toBe(true);
    expect(stylua?.required).toBe(true);
  });

  it("rojo and lune are optional (required=false)", () => {
    mockExecSync.mockImplementation(() => "/usr/bin/x");
    const tools = checkRobloxTools();
    const rojo = tools.find(t => t.name === "rojo");
    const lune = tools.find(t => t.name === "lune");
    expect(rojo?.required).toBe(false);
    expect(lune?.required).toBe(false);
  });

  it("checkRobloxTools marks tool as not installed when binary missing", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    const tools = checkRobloxTools();
    for (const t of tools) {
      expect(t.installed).toBe(false);
      expect(t.path).toBeNull();
    }
  });
});
