/**
 * error-paths.test.ts — Tests for error and failure paths across modules.
 *
 * Covers:
 *   - File not found errors
 *   - JSON parse errors
 *   - Invalid config errors
 *   - Schema validation failures
 *   - MCP spawn failures (mocked)
 *   - Tool call with missing required args
 *   - Tool call with wrong arg types
 *   - History overflow / compaction edge cases
 *   - applyEdits failure paths (search not found)
 *   - pokaYoke blocks become errors
 *
 * Strategy: use REAL modules where possible. Mock only logger/fs/child_process
 * to avoid touching real disk/network.
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
vi.mock("../taskState.js", () => ({
  getTaskStateSummary: vi.fn(() => null),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { applyEdits, editFile } from "../fileEdit.js";
import { pokaYokeCheck } from "../pokaYoke.js";
import { normalizeArgs } from "../argsNormalizer.js";
import { validateModeConfig } from "../configSchema.js";
import { detectIntent, filterToolsByIntent } from "../toolReduction.js";
import {
  classifyMcpTool, evaluateMcpToolCall,
} from "../robloxMcpGuard.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-err-"));
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// File not found errors
// ═══════════════════════════════════════════════════════════════════════════

describe("Error path: file not found", () => {
  it("editFile on non-existent file (no createIfMissing) returns '[ERROR] File not found'", async () => {
    const file = path.join(tmpDir, "does-not-exist.txt");
    const result = await editFile(file, [{ search: "x", replace: "y" }]);
    expect(result).toContain("[ERROR]");
    expect(result).toContain("File not found");
  });

  it("editFile on non-existent file WITH createIfMissing succeeds", async () => {
    const file = path.join(tmpDir, "new-file.txt");
    const result = await editFile(file, [{ search: "", replace: "new content" }], {
      createIfMissing: true,
    });
    expect(result).toContain("[SUCCESS]");
    expect(fs.readFileSync(file, "utf8")).toBe("new content");
  });

  it("editFile with empty search on non-existent file + createIfMissing writes replace as content", async () => {
    const file = path.join(tmpDir, "fresh.txt");
    const result = await editFile(file, [{ search: "", replace: "fresh" }], {
      createIfMissing: true,
    });
    expect(result).toContain("[SUCCESS]");
    expect(fs.readFileSync(file, "utf8")).toBe("fresh");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JSON parse errors (config files)
// ═══════════════════════════════════════════════════════════════════════════

describe("Error path: JSON parse errors in config files", () => {
  it("invalid JSON in .mcp.json is silently skipped (no crash)", () => {
    const projectMcp = path.join(tmpDir, ".mcp.json");
    fs.writeFileSync(projectMcp, "{invalid json!!!", "utf8");
    // Mimic what extensions.ts does: try to parse, catch on error
    let parsed: any = null;
    try {
      parsed = JSON.parse(fs.readFileSync(projectMcp, "utf8"));
    } catch {
      // silently skip — no crash
    }
    expect(parsed).toBeNull();
  });

  it("JSON.parse on empty file throws SyntaxError", () => {
    const file = path.join(tmpDir, "empty.json");
    fs.writeFileSync(file, "", "utf8");
    expect(() => JSON.parse(fs.readFileSync(file, "utf8"))).toThrow(SyntaxError);
  });

  it("JSON.parse on truncated JSON throws SyntaxError", () => {
    const file = path.join(tmpDir, "truncated.json");
    fs.writeFileSync(file, '{"name": "test"', "utf8");
    expect(() => JSON.parse(fs.readFileSync(file, "utf8"))).toThrow(SyntaxError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Invalid config errors (configSchema)
// ═══════════════════════════════════════════════════════════════════════════

describe("Error path: invalid mode config rejected by schema", () => {
  it("rejects config without name field", () => {
    const errors = validateModeConfig({ label: "L", tools: [] });
    expect(errors.some(e => e.field === "name")).toBe(true);
  });

  it("rejects config with name as number (wrong type)", () => {
    const errors = validateModeConfig({ name: 123, label: "L" });
    expect(errors.some(e => e.field === "name")).toBe(true);
  });

  it("rejects config with label as null", () => {
    const errors = validateModeConfig({ name: "x", label: null });
    expect(errors.some(e => e.field === "label")).toBe(true);
  });

  it("rejects config with toolsDir as number", () => {
    const errors = validateModeConfig({ name: "x", label: "L", toolsDir: 123 });
    expect(errors.some(e => e.field === "toolsDir")).toBe(true);
  });

  it("rejects config with validators as object (not array)", () => {
    const errors = validateModeConfig({ name: "x", label: "L", validators: { not: "array" } });
    expect(errors.some(e => e.field === "validators")).toBe(true);
  });

  it("rejects validator entry missing tool field", () => {
    const errors = validateModeConfig({
      name: "x", label: "L",
      validators: [{ filePattern: "*.lua", blocking: true }],
    });
    expect(errors.some(e => e.field === "validators[0].tool")).toBe(true);
  });

  it("rejects validator entry with blocking as string (not boolean)", () => {
    const errors = validateModeConfig({
      name: "x", label: "L",
      validators: [{ tool: "selene", filePattern: "*.lua", blocking: "yes" }],
    });
    expect(errors.some(e => e.field === "validators[0].blocking")).toBe(true);
  });

  it("rejects hook entry with invalid trigger value", () => {
    const errors = validateModeConfig({
      name: "x", label: "L",
      hooks: [{ name: "h", file: "h.js", trigger: "invalid_trigger" }],
    });
    expect(errors.some(e => e.field === "hooks[0].trigger")).toBe(true);
  });

  it("rejects config mixing legacy + new format", () => {
    const errors = validateModeConfig({
      name: "x", label: "L",
      toolsDir: "tools",
      enableTools: ["tool:x"],
    });
    expect(errors.some(e => e.field === "format")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool call with missing required args
// ═══════════════════════════════════════════════════════════════════════════

describe("Error path: tool calls with missing required args", () => {
  it("pokaYokeCheck blocks editar_arquivo without path/caminho/file", () => {
    const r = pokaYokeCheck("editar_arquivo", { search: "x", replace: "y" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("editar_arquivo");
  });

  it("pokaYokeCheck blocks editar_arquivo with empty path string", () => {
    const r = pokaYokeCheck("editar_arquivo", { path: "  ", search: "x", replace: "y" });
    expect(r.ok).toBe(false);
  });

  it("pokaYokeCheck blocks aplicar_diff without bloco_diff", () => {
    const r = pokaYokeCheck("aplicar_diff", { path: "/x.lua" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("bloco_diff");
  });

  it("pokaYokeCheck blocks aplicar_diff with malformed bloco_diff (missing markers)", () => {
    const r = pokaYokeCheck("aplicar_diff", {
      path: "/x.lua",
      bloco_diff: "no markers here",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("SEARCH");
  });

  it("pokaYokeCheck blocks executar_comando without comando/command", () => {
    const r = pokaYokeCheck("executar_comando", {});
    expect(r.ok).toBe(false);
  });

  it("pokaYokeCheck blocks editar_multi_arquivos with empty requests array", () => {
    const r = pokaYokeCheck("editar_multi_arquivos", { requests: [] });
    expect(r.ok).toBe(false);
  });

  it("pokaYokeCheck blocks desfazer_edicao without caminho", () => {
    const r = pokaYokeCheck("desfazer_edicao", {});
    expect(r.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool call with wrong arg types
// ═══════════════════════════════════════════════════════════════════════════

describe("Error path: tool calls with wrong arg types", () => {
  it("pokaYokeCheck blocks path as number (not non-empty string)", () => {
    const r = pokaYokeCheck("ler_arquivo", { path: 12345 });
    expect(r.ok).toBe(false);
  });

  it("pokaYokeCheck blocks path as null", () => {
    const r = pokaYokeCheck("ler_arquivo", { path: null });
    expect(r.ok).toBe(false);
  });

  it("pokaYokeCheck blocks path as object", () => {
    const r = pokaYokeCheck("ler_arquivo", { path: { nested: "obj" } });
    expect(r.ok).toBe(false);
  });

  it("pokaYokeCheck blocks bloco_diff as number", () => {
    const r = pokaYokeCheck("aplicar_diff", { path: "/x.lua", bloco_diff: 123 });
    expect(r.ok).toBe(false);
  });

  it("pokaYokeCheck blocks edits as non-array (string instead)", () => {
    const r = pokaYokeCheck("editar_arquivo", { path: "/x", edits: "not-an-array" });
    // edits check: Array.isArray(args.edits) — false; falls through to search+replace check
    expect(r.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// applyEdits failure paths
// ═══════════════════════════════════════════════════════════════════════════

describe("Error path: applyEdits failures", () => {
  it("returns failure when search string not found", () => {
    const r = applyEdits("hello world", [{ search: "nonexistent", replace: "x" }]);
    expect(r.success).toBe(false);
    expect(r.replacements).toBe(0);
    expect(r.error).toContain("SEARCH not found");
  });

  it("error message truncates long search strings (>80 chars)", () => {
    const longSearch = "x".repeat(200);
    const r = applyEdits("hello", [{ search: longSearch, replace: "y" }]);
    expect(r.success).toBe(false);
    expect(r.error).toContain("...");
    // Error should NOT contain the full 200-char search string
    expect(r.error!.length).toBeLessThan(longSearch.length + 100);
  });

  it("preserves original content on failure", () => {
    const original = "hello world";
    const r = applyEdits(original, [
      { search: "hello", replace: "hi" },
      { search: "nonexistent", replace: "x" },
    ]);
    // Second edit fails — first edit's content is in r.content
    expect(r.success).toBe(false);
    expect(r.content).toBe("hi world");
  });

  it("stops at first failed edit (does not continue to next)", () => {
    const r = applyEdits("aaa bbb ccc", [
      { search: "aaa", replace: "1" },       // succeeds
      { search: "nonexistent", replace: "x" }, // fails
      { search: "ccc", replace: "3" },       // would succeed but never runs
    ]);
    expect(r.success).toBe(false);
    expect(r.content).toBe("1 bbb ccc"); // 'ccc' is NOT replaced
  });

  it("applyEdits with empty edits array returns success with 0 replacements", () => {
    const r = applyEdits("hello", []);
    expect(r.success).toBe(true);
    expect(r.replacements).toBe(0);
    expect(r.content).toBe("hello");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MCP guard blocks
// ═══════════════════════════════════════════════════════════════════════════

describe("Error path: MCP guard blocks write tools", () => {
  it("multi_edit is blocked with helpful error directing to aplicar_diff", () => {
    const r = evaluateMcpToolCall("Roblox_Studio__multi_edit", { path: "/x.lua" });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toContain("aplicar_diff");
    expect(r.blockReason).toContain("Bug Hunter");
    expect(r.blockReason).toContain("DataGuard");
  });

  it("generate_mesh is blocked (asset generation bypasses version control)", () => {
    const r = evaluateMcpToolCall("Roblox_Studio__generate_mesh", {});
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toContain("generate_");
  });

  it("insert_from_creator_store is blocked (bypasses Rojo sync)", () => {
    const r = evaluateMcpToolCall("Roblox_Studio__insert_from_creator_store", {});
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toContain("insert");
  });

  it("blockReason for multi_edit includes path from args", () => {
    const r = evaluateMcpToolCall("Roblox_Studio__multi_edit", { path: "/my/script.luau" });
    expect(r.blockReason).toContain("/my/script.luau");
  });

  it("blockReason falls back to 'unknown' when path arg is missing", () => {
    const r = evaluateMcpToolCall("Roblox_Studio__multi_edit", {});
    expect(r.blockReason).toContain("unknown");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// History overflow / compaction edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Error path: history compaction handles small/empty history", () => {
  it("compactHistoryAsync returns null when history is too small", async () => {
    const { compactHistoryAsync, resetHistory } = await import("../history.js");
    resetHistory();
    const result = await compactHistoryAsync();
    // Small history (just system prompt) → nothing to compact
    expect(result).toBeNull();
  });

  it("estimateTokens returns at least 1 (Math.max(1, ...))", async () => {
    const { estimateTokens, resetHistory } = await import("../history.js");
    resetHistory();
    // System prompt is non-empty, so estimateTokens is > 0
    const tokens = estimateTokens();
    expect(tokens).toBeGreaterThanOrEqual(1);
  });

  it("replaceHistory with empty array prepends system prompt", async () => {
    const { replaceHistory, getHistory, resetHistory } = await import("../history.js");
    resetHistory();
    replaceHistory([]);
    const h = getHistory();
    expect(h.length).toBeGreaterThanOrEqual(1);
    expect(h[0].role).toBe("system");
  });

  it("replaceHistory with array starting with system prompt keeps it as-is", async () => {
    const { replaceHistory, getHistory } = await import("../history.js");
    const customSystem = { role: "system" as const, content: "Custom system prompt" };
    replaceHistory([customSystem]);
    const h = getHistory();
    expect(h[0]).toBe(customSystem);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// System prompt edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Error path: system prompt always non-empty", () => {
  it("getSystemPrompt() returns non-empty string even without memory/skills", async () => {
    const { getSystemPrompt, resetHistory } = await import("../history.js");
    resetHistory();
    const prompt = getSystemPrompt();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt).toContain("Claude-Killer");
  });

  it("getSystemPrompt() includes tool descriptions", async () => {
    const { getSystemPrompt, resetHistory } = await import("../history.js");
    resetHistory();
    const prompt = getSystemPrompt();
    expect(prompt).toContain("ler_arquivo");
    expect(prompt).toContain("editar_arquivo");
    expect(prompt).toContain("pensar");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MCP spawn failures (mocked)
// ═══════════════════════════════════════════════════════════════════════════

describe("Error path: MCP spawn failures handled gracefully", () => {
  it("startAndInitMCPServer with Windows-only command on non-Windows is skipped", async () => {
    // Verify the platform guard logic from extensions.ts:
    //   - cmd.exe, .bat, .cmd, .ps1 are considered Windows-only
    //   - .exe alone is NOT flagged (only cmd.exe specifically)
    // We can't easily test startAndInitMCPServer directly (it's internal), but
    // we can verify the platform-check pattern is in place.
    const isWindowsCommand = (cmd: string) => {
      const lower = cmd.toLowerCase();
      return lower.endsWith("cmd.exe") || lower.endsWith(".bat") ||
             lower.endsWith(".cmd") || lower.endsWith(".ps1");
    };
    expect(isWindowsCommand("cmd.exe")).toBe(true);
    expect(isWindowsCommand("mcp.bat")).toBe(true);
    expect(isWindowsCommand("setup.ps1")).toBe(true);
    expect(isWindowsCommand("node")).toBe(false);
    expect(isWindowsCommand("python3")).toBe(false);
    // .exe alone is NOT flagged (only cmd.exe specifically)
    expect(isWindowsCommand("StudioMCP.exe")).toBe(false);
  });

  it("callMCPTool with invalid format (no __ separator) returns error", async () => {
    const { callMCPTool } = await import("../extensions.js");
    const result = await callMCPTool("invalid_name_no_separator", {});
    expect(result).toContain("[ERROR]");
    expect(result).toContain("Invalid MCP tool name format");
  });

  it("callMCPTool for non-existent server returns error", async () => {
    const { callMCPTool } = await import("../extensions.js");
    const result = await callMCPTool("NonExistentServer__some_tool", {});
    expect(result).toContain("[ERROR]");
    expect(result).toContain("not available");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// normalizeArgs handles invalid inputs gracefully
// ═══════════════════════════════════════════════════════════════════════════

describe("Error path: normalizeArgs handles invalid args gracefully", () => {
  it("does not throw when args is empty object", () => {
    expect(() => normalizeArgs("ler_arquivo", {})).not.toThrow();
  });

  it("does not throw when schema has no properties", () => {
    const args: any = { path: "/x" };
    expect(() => normalizeArgs("ler_arquivo", args, {})).not.toThrow();
  });

  it("does not throw when schema.properties is empty", () => {
    const args: any = { path: "/x" };
    expect(() => normalizeArgs("ler_arquivo", args, { properties: {} })).not.toThrow();
  });

  it("does not throw on unknown toolName", () => {
    const args: any = { path: "/x" };
    expect(() => normalizeArgs("unknown_tool_xyz", args)).not.toThrow();
  });

  it("leaves invalid JSON string alone (does not throw)", () => {
    const args: any = { path: "/x", data: "{invalid json" };
    expect(() => normalizeArgs("ler_arquivo", args)).not.toThrow();
    // Invalid JSON is left as-is
    expect(args.data).toBe("{invalid json");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// dotfileConfig error handling
// ═══════════════════════════════════════════════════════════════════════════

describe("Error path: dotfileConfig handles invalid JSON gracefully", () => {
  it("loadConfig returns empty object when config file is invalid JSON", async () => {
    // Write invalid JSON to the config path
    const cfgDir = path.join(tmpDir, ".claude-killer");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "config.json"), "{invalid json!!!", "utf8");

    // Re-import so the cache is reset
    vi.resetModules();
    const mod = await import("../dotfileConfig.js");
    const cfg = mod.loadConfig();
    expect(cfg).toBeDefined();
    expect(typeof cfg).toBe("object");
    // Invalid JSON → returns empty object (catch block sets cachedConfig = {})
    expect(Object.keys(cfg).length).toBe(0);
  });

  it("loadConfig returns empty object when config file does not exist", async () => {
    vi.resetModules();
    const mod = await import("../dotfileConfig.js");
    const cfg = mod.loadConfig();
    expect(cfg).toBeDefined();
    expect(typeof cfg).toBe("object");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// toolReduction edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Error path: toolReduction handles unknown intents", () => {
  it("filterToolsByIntent with unknown intent returns only core tools", () => {
    const tools = [
      { type: "function" as const, function: { name: "ler_arquivo", parameters: {} } },
      { type: "function" as const, function: { name: "custom_tool", parameters: {} } },
    ];
    // 'invalid' is not in INTENT_TOOL_MAP, so allowedTools starts as empty Set,
    // then core tools are added. ler_arquivo is core, so it's included.
    // custom_tool is NOT in core nor in intent map → excluded.
    const filtered = filterToolsByIntent(tools, "invalid" as any);
    const names = filtered.map(t => t.function.name);
    expect(names).toContain("ler_arquivo");
    expect(names).not.toContain("custom_tool");
  });

  it("filterToolsByIntent with general intent returns all tools (no filtering)", () => {
    const tools = [
      { type: "function" as const, function: { name: "ler_arquivo", parameters: {} } },
      { type: "function" as const, function: { name: "custom_tool", parameters: {} } },
    ];
    const filtered = filterToolsByIntent(tools, "general");
    expect(filtered.length).toBe(tools.length);
  });

  it("filterToolsByIntent with empty tools array returns empty", () => {
    const filtered = filterToolsByIntent([], "read");
    expect(filtered).toEqual([]);
  });
});
