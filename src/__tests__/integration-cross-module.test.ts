/**
 * integration-cross-module.test.ts — Integration tests that verify multiple
 * modules work together correctly.
 *
 * Each test crosses module boundaries: e.g. argsNormalizer output feeds
 * pokaYoke; effortLevels affects feature flags; robloxMcpGuard blocks calls
 * inside agent flow; toolReduction filters tools based on detected intent.
 *
 * Strategy: use REAL modules where possible (they are pure / file-based),
 * mock only logger/child_process/fileLock to avoid touching real disk/network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Top-level mocks (vitest 4.x requirement: all vi.mock at module top) ────

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

vi.mock("../taskState.js", () => ({
  getTaskStateSummary: vi.fn(() => null),
}));

// Mock child_process so clipboard / utf8Safety don't actually invoke commands
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  spawn: vi.fn(() => {
    const ee: any = { on: vi.fn(), kill: vi.fn(), pid: 12345, stdin: { write: vi.fn(), end: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() } };
    return ee;
  }),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { normalizeArgs } from "../argsNormalizer.js";
import { pokaYokeCheck } from "../pokaYoke.js";
import {
  classifyMcpTool, evaluateMcpToolCall, extractToolName, isRobloxStudioMcpTool,
  getAllowedRobloxMcpTools, getBlockedRobloxMcpTools,
} from "../robloxMcpGuard.js";
import {
  getEffortLevel, setEffortLevel, shouldAutoGenerateTests,
  shouldUseSubAgents, shouldUseIntelligentCompaction, getEffortLabel,
  getEffortPromptSnippet,
} from "../effortLevels.js";
import { detectIntent, filterToolsByIntent } from "../toolReduction.js";
import { validateModeConfig, isValidModeConfig } from "../configSchema.js";
import {
  loadConfig, saveConfig, updateConfig, getConfigValue, ensureConfigDir,
} from "../dotfileConfig.js";
import {
  detectLanguageFromExt, highlightSyntax,
} from "../syntaxHighlight.js";
import { grepSearch, formatGrepResults } from "../contentSearch.js";
import { copyToClipboard, pasteFromClipboard } from "../clipboard.js";
import {
  ensureAutoMemoryFile, readAutoMemory, appendAutoMemory, getAutoMemoryPath,
} from "../autoMemory.js";
import {
  listSystemLocales, pickBestUtf8Locale, forceUtf8Environment, diagnoseUtf8,
} from "../utf8Safety.js";

// ─── Shared fixtures ────────────────────────────────────────────────────────

let tmpDir: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-int-"));
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
  setEffortLevel("medium");
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.clearAllMocks();
});

// ─── Helper: 35 tests in this file ──────────────────────────────────────────

describe("Integration: argsNormalizer + pokaYoke", () => {
  it("normalized args pass pokaYoke (path alias caminho → path)", () => {
    const args: Record<string, unknown> = { caminho: "/tmp/x.txt" };
    normalizeArgs("ler_arquivo", args);
    // After normalization, pokaYoke should pass
    const r = pokaYokeCheck("ler_arquivo", args);
    expect(r.ok).toBe(true);
  });

  it("caminho alias normalized to path BEFORE pokaYoke checks empty path", () => {
    // Path-taking tools: pokaYoke reads args.caminho ?? args.path
    // Without normalization, the model passes `caminho` and pokaYoke still sees it.
    const args: Record<string, unknown> = { caminho: "/tmp/valid.lua" };
    normalizeArgs("ler_arquivo", args);
    const r = pokaYokeCheck("ler_arquivo", args);
    expect(r.ok).toBe(true);
    expect(args.path).toBe("/tmp/valid.lua");
  });
});

describe("Integration: robloxMcpGuard (classify + extract + isRobloxStudio)", () => {
  it("evaluateMcpToolCall + classifyMcpTool: consistent classification for write tool", () => {
    const r = evaluateMcpToolCall("Roblox_Studio__multi_edit", { path: "/x.luau" });
    expect(r.allowed).toBe(false);
    expect(r.category).toBe(classifyMcpTool("multi_edit"));
    expect(r.category).toBe("write");
  });

  it("extractToolName + isRobloxStudioMcpTool work together", () => {
    const full = "Roblox_Studio__script_read";
    expect(isRobloxStudioMcpTool(full)).toBe(true);
    expect(extractToolName(full)).toBe("script_read");
    // Classification of the extracted name should be "read"
    expect(classifyMcpTool(extractToolName(full))).toBe("read");
  });

  it("multi_edit blocked, script_read allowed (partition by category)", () => {
    expect(evaluateMcpToolCall("Roblox_Studio__multi_edit", {}).allowed).toBe(false);
    expect(evaluateMcpToolCall("Roblox_Studio__script_read", {}).allowed).toBe(true);
  });

  it("unknown Roblox tool allowed (default-allow policy)", () => {
    const r = evaluateMcpToolCall("Roblox_Studio__brand_new_unclassified_tool", {});
    expect(r.allowed).toBe(true);
    expect(r.category).toBe("unknown");
  });

  it("getAllowedRobloxMcpTools + getBlockedRobloxMcpTools partition all tools", () => {
    const allowed = getAllowedRobloxMcpTools();
    const blocked = getBlockedRobloxMcpTools();
    // No tool appears in both lists
    for (const t of allowed) {
      expect(blocked).not.toContain(t);
    }
    for (const t of blocked) {
      expect(allowed).not.toContain(t);
    }
    // Sanity: multi_edit is in blocked, script_read in allowed
    expect(blocked).toContain("multi_edit");
    expect(allowed).toContain("script_read");
  });
});

describe("Integration: effortLevels (set + get + feature flags)", () => {
  it("setEffortLevel + getEffortLevel: roundtrip", () => {
    setEffortLevel("high");
    expect(getEffortLevel()).toBe("high");
    setEffortLevel("low");
    expect(getEffortLevel()).toBe("low");
    setEffortLevel("medium");
    expect(getEffortLevel()).toBe("medium");
    setEffortLevel("max");
    expect(getEffortLevel()).toBe("max");
  });

  it("high/max enable sub-agents, low/medium don't", () => {
    setEffortLevel("low");
    expect(shouldUseSubAgents()).toBe(false);
    setEffortLevel("medium");
    expect(shouldUseSubAgents()).toBe(false);
    setEffortLevel("high");
    expect(shouldUseSubAgents()).toBe(true);
    setEffortLevel("max");
    expect(shouldUseSubAgents()).toBe(true);
  });

  it("all 4 levels produce different labels", () => {
    const labels = new Set<string>();
    setEffortLevel("low"); labels.add(getEffortLabel());
    setEffortLevel("medium"); labels.add(getEffortLabel());
    setEffortLevel("high"); labels.add(getEffortLabel());
    setEffortLevel("max"); labels.add(getEffortLabel());
    expect(labels.size).toBe(4);
  });

  it("all 4 levels produce different prompt snippets", () => {
    const snippets = new Set<string>();
    setEffortLevel("low"); snippets.add(getEffortPromptSnippet());
    setEffortLevel("medium"); snippets.add(getEffortPromptSnippet());
    setEffortLevel("high"); snippets.add(getEffortPromptSnippet());
    setEffortLevel("max"); snippets.add(getEffortPromptSnippet());
    expect(snippets.size).toBe(4);
  });
});

describe("Integration: toolReduction (detectIntent + filterToolsByIntent)", () => {
  const allTools = [
    { type: "function" as const, function: { name: "ler_arquivo", parameters: {} } },
    { type: "function" as const, function: { name: "editar_arquivo", parameters: {} } },
    { type: "function" as const, function: { name: "executar_comando", parameters: {} } },
    { type: "function" as const, function: { name: "executar_testes", parameters: {} } },
    { type: "function" as const, function: { name: "pensar", parameters: {} } },
    { type: "function" as const, function: { name: "buscar_texto", parameters: {} } },
  ];

  it("intent drives filtering (write intent excludes executar_testes)", () => {
    const filtered = filterToolsByIntent(allTools, "write");
    const names = filtered.map(t => t.function.name);
    expect(names).toContain("editar_arquivo");
    expect(names).not.toContain("executar_testes");
  });

  it("'general' intent returns ALL tools (no filtering)", () => {
    const filtered = filterToolsByIntent(allTools, "general");
    expect(filtered.length).toBe(allTools.length);
  });

  it("detectIntent returns 'general' for null/empty message", () => {
    // detectIntent expects a string; we pass "" which is the safe default
    expect(detectIntent("")).toBe("general");
    expect(detectIntent("hello world")).toBe("general");
  });
});

describe("Integration: configSchema (validate + isValid)", () => {
  it("validateModeConfig + isValidModeConfig: consistent results", () => {
    const good = { name: "x", label: "X" };
    const bad = { label: "X" };
    expect(validateModeConfig(good)).toEqual([]);
    expect(isValidModeConfig(good)).toBe(true);
    expect(validateModeConfig(bad).length).toBeGreaterThan(0);
    expect(isValidModeConfig(bad)).toBe(false);
  });

  it("valid config with all fields passes", () => {
    const cfg = {
      name: "roblox-custom",
      label: "Roblox Custom",
      toolsDir: "tools",
      tools: ["tool:rojo_build"],
      skills: ["selene"],
      hooks: [],
      validators: [],
    };
    const errors = validateModeConfig(cfg);
    expect(errors).toEqual([]);
  });

  it("invalid config returns errors array (non-empty)", () => {
    const errors = validateModeConfig({});
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("Integration: dotfileConfig (save + load + update)", () => {
  it("saveConfig + loadConfig: roundtrip preserves data", async () => {
    vi.resetModules();
    const mod = await import("../dotfileConfig.js");
    const cfg = { model: "test-model", rateLimitRpm: 100 };
    mod.saveConfig(cfg);
    const loaded = mod.loadConfig();
    expect(loaded.model).toBe("test-model");
    expect(loaded.rateLimitRpm).toBe(100);
  });

  it("updateConfig: merge preserves existing keys", async () => {
    vi.resetModules();
    const mod = await import("../dotfileConfig.js");
    mod.saveConfig({ model: "original", rateLimitRpm: 50 });
    mod.updateConfig({ rateLimitRpm: 100 });
    const loaded = mod.loadConfig();
    // model preserved, rateLimitRpm updated
    expect(loaded.model).toBe("original");
    expect(loaded.rateLimitRpm).toBe(100);
  });

  it("getConfigValue returns undefined for missing key", () => {
    const v = getConfigValue("maxHealRetries");
    // Either undefined (no file) or whatever was loaded — but a fresh tmp dir has no config
    expect(v).toBeUndefined();
  });

  it("ensureConfigDir creates directory", async () => {
    vi.resetModules();
    const mod = await import("../dotfileConfig.js");
    mod.ensureConfigDir();
    const dir = path.join(tmpDir, ".claude-killer");
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe("Integration: syntaxHighlight (detect + highlight)", () => {
  it("detectLanguageFromExt + highlightSyntax: language detection drives highlighting", () => {
    const lang = detectLanguageFromExt(".ts");
    expect(lang).toBe("typescript");
    const highlighted = highlightSyntax("const x = 1;", lang);
    // Should produce ANSI codes
    expect(typeof highlighted).toBe("string");
    expect(highlighted.length).toBeGreaterThan(0);
  });

  it(".ts returns 'typescript'", () => {
    expect(detectLanguageFromExt(".ts")).toBe("typescript");
  });

  it(".luau returns a non-empty string (language detection works)", () => {
    // .luau is not in the map; falls back to "typescript". Either way, must be non-empty.
    const lang = detectLanguageFromExt(".luau");
    expect(typeof lang).toBe("string");
    expect(lang.length).toBeGreaterThan(0);
  });
});

describe("Integration: contentSearch (grepSearch + formatGrepResults)", () => {
  it("search results formatted correctly (file:line: content)", () => {
    const file = path.join(tmpDir, "search-test.txt");
    fs.writeFileSync(file, "line one\nfoo bar\nline three", "utf8");
    const matches = grepSearch({ pattern: "foo", path: file });
    expect(matches.length).toBe(1);
    expect(matches[0].content).toContain("foo");
    const formatted = formatGrepResults(matches);
    expect(formatted).toContain(file);
    expect(formatted).toContain("foo");
  });

  it("formatGrepResults with empty array returns no-results message", () => {
    const formatted = formatGrepResults([]);
    expect(typeof formatted).toBe("string");
    expect(formatted.length).toBeGreaterThan(0);
  });
});

describe("Integration: clipboard (copy + paste don't throw)", () => {
  it("copyToClipboard + pasteFromClipboard don't throw", () => {
    expect(() => copyToClipboard("hello world")).not.toThrow();
    expect(() => pasteFromClipboard()).not.toThrow();
  });
});

describe("Integration: autoMemory (ensure + read + append)", () => {
  it("ensureAutoMemoryFile + readAutoMemory + appendAutoMemory work together", () => {
    expect(() => ensureAutoMemoryFile()).not.toThrow();
    const before = readAutoMemory();
    expect(typeof before).toBe("string");
    expect(() => appendAutoMemory("integration test entry")).not.toThrow();
    const after = readAutoMemory();
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  });

  it("appendAutoMemory preserves previous entries", () => {
    ensureAutoMemoryFile();
    appendAutoMemory("first entry marker");
    const mid = readAutoMemory();
    appendAutoMemory("second entry marker");
    const after = readAutoMemory();
    // Both should be present in the file (or at least the file should grow)
    expect(after.length).toBeGreaterThanOrEqual(mid.length);
    expect(after).toContain("first entry marker");
    expect(after).toContain("second entry marker");
  });

  it("getAutoMemoryPath contains .claude-killer", () => {
    const p = getAutoMemoryPath();
    expect(p).toContain(".claude-killer");
  });
});

describe("Integration: utf8Safety (force + diagnose)", () => {
  it("forceUtf8Environment + diagnoseUtf8 work together", () => {
    expect(() => forceUtf8Environment()).not.toThrow();
    const diag = diagnoseUtf8();
    expect(typeof diag).toBe("string");
    expect(diag).toContain("UTF-8");
  });
});

describe("Integration: argsNormalizer (JSON + coercion + defaults)", () => {
  it("JSON string parsing + type coercion work together", () => {
    const args: Record<string, unknown> = {
      maxResults: "5",
      items: '["a", "b"]',
    };
    const schema = {
      properties: {
        maxResults: { type: "number" },
        items: { type: "array" },
      },
    };
    normalizeArgs("test_tool", args, schema);
    expect(args.maxResults).toBe(5);
    expect(Array.isArray(args.items)).toBe(true);
    expect(args.items).toEqual(["a", "b"]);
  });

  it("defaults filled from schema", () => {
    const args: Record<string, unknown> = { query: "test" };
    const schema = {
      properties: {
        query: { type: "string" },
        maxResults: { type: "number", default: 10 },
      },
    };
    normalizeArgs("test_tool", args, schema);
    expect(args.maxResults).toBe(10);
  });
});

describe("Integration: pokaYoke — specific tool checks", () => {
  it("blocks on empty path for editar_arquivo", () => {
    const r = pokaYokeCheck("editar_arquivo", { search: "x", replace: "y" });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });

  it("blocks on empty comando for executar_comando", () => {
    const r = pokaYokeCheck("executar_comando", {});
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });

  it("allows unknown tools (passthrough)", () => {
    const r = pokaYokeCheck("some_unknown_tool", { foo: "bar" });
    expect(r.ok).toBe(true);
  });
});

describe("Integration: dotfileConfig — invalid JSON handling", () => {
  it("loadConfig with invalid JSON in config file returns empty object", () => {
    // Write a corrupt config file in tmpDir/.claude-killer/config.json
    const dir = path.join(tmpDir, ".claude-killer");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{not valid json", "utf8");
    // Use dynamic import with resetModules so CONFIG_FILE is computed fresh
    vi.resetModules();
    // Re-import to pick up new HOME
    return import("../dotfileConfig.js").then((mod) => {
      const cfg = mod.loadConfig();
      // On error, loadConfig catches and returns {} (empty object)
      expect(cfg).toBeDefined();
      expect(typeof cfg).toBe("object");
    });
  });
});

describe("Integration: robloxMcpGuard — get_studio_state classification", () => {
  it("get_studio_state classified as 'read'", () => {
    expect(classifyMcpTool("get_studio_state")).toBe("read");
  });

  it("execute_luau classified as 'execute'", () => {
    expect(classifyMcpTool("execute_luau")).toBe("execute");
  });
});

describe("Integration: effortLevels — auto-test + compaction flags", () => {
  it("high/max enable shouldAutoGenerateTests, low disables it", () => {
    setEffortLevel("low");
    expect(shouldAutoGenerateTests()).toBe(false);
    setEffortLevel("medium");
    expect(shouldAutoGenerateTests()).toBe(true);
    setEffortLevel("high");
    expect(shouldAutoGenerateTests()).toBe(true);
    setEffortLevel("max");
    expect(shouldAutoGenerateTests()).toBe(true);
  });

  it("high/max enable shouldUseIntelligentCompaction, low disables it", () => {
    setEffortLevel("low");
    expect(shouldUseIntelligentCompaction()).toBe(false);
    setEffortLevel("medium");
    expect(shouldUseIntelligentCompaction()).toBe(true);
    setEffortLevel("high");
    expect(shouldUseIntelligentCompaction()).toBe(true);
    setEffortLevel("max");
    expect(shouldUseIntelligentCompaction()).toBe(true);
  });
});

describe("Integration: toolReduction — detectIntent pattern coverage", () => {
  it("detectIntent for 'ler o arquivo' returns non-general (read intent)", () => {
    const i = detectIntent("ler o arquivo");
    expect(i).not.toBe("general");
  });

  it("detectIntent for 'edit the file' returns 'write'", () => {
    expect(detectIntent("edit the file")).toBe("write");
  });

  it("detectIntent for 'run the tests' returns 'test'", () => {
    expect(detectIntent("run the tests")).toBe("test");
  });

  it("detectIntent for 'git commit' returns 'git'", () => {
    expect(detectIntent("git commit")).toBe("git");
  });

  it("detectIntent for 'find all usages of foo' returns 'search'", () => {
    expect(detectIntent("find all usages of foo")).toBe("search");
  });

  it("detectIntent for 'explore the codebase' returns 'explore'", () => {
    expect(detectIntent("explore the codebase")).toBe("explore");
  });
});

describe("Integration: configSchema — array/string/null inputs", () => {
  it("rejects null input", () => {
    const errors = validateModeConfig(null);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].field).toBe("root");
  });

  it("rejects string input", () => {
    const errors = validateModeConfig("not-an-object");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects array input", () => {
    const errors = validateModeConfig([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].field).toBe("root");
  });
});

describe("Integration: utf8Safety — listSystemLocales + pickBestUtf8Locale", () => {
  it("listSystemLocales returns an array", () => {
    const locales = listSystemLocales();
    expect(Array.isArray(locales)).toBe(true);
  });

  it("pickBestUtf8Locale returns {locale, tried} object", () => {
    const result = pickBestUtf8Locale();
    expect(result).toHaveProperty("locale");
    expect(result).toHaveProperty("tried");
    expect(Array.isArray(result.tried)).toBe(true);
  });
});
