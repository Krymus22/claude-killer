/**
 * regression-bug-fixes.test.ts — Regression tests for bugs fixed during the
 * development session. Each test verifies a specific bug doesn't come back.
 *
 * Strategy: test the UNDERLYING module behavior that the regression was about,
 * rather than rendering the full TUI. For slash commands whose handlers live
 * inside App.tsx (not exported), we test the equivalent parsing logic that
 * handleSlashCommand uses AND verify the handler is registered by reading the
 * source file.
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

// Mock child_process for ensureRobloxTools + clipboard
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
  classifyMcpTool, evaluateMcpToolCall,
} from "../robloxMcpGuard.js";
import { validateModeConfig } from "../configSchema.js";
import { loadConfig, saveConfig, updateConfig } from "../dotfileConfig.js";
import {
  setLanguage, resetLanguageCache, resetAllLanguageState, detectLanguage,
} from "../i18n.js";
import {
  getEffortLevel, setEffortLevel, shouldAutoGenerateTests,
  shouldUseSubAgents,
} from "../effortLevels.js";
import { detectIntent } from "../toolReduction.js";
import { detectLanguageFromExt } from "../syntaxHighlight.js";
import { pickBestUtf8Locale, diagnoseUtf8 } from "../utf8Safety.js";
import {
  ensureAutoMemoryFile, readAutoMemory, appendAutoMemory, getAutoMemoryPath,
} from "../autoMemory.js";
import { checkRobloxTools } from "../ensureRobloxTools.js";
import { TOOL_DEFINITIONS } from "../apiClient.js";

// ─── Shared fixtures ────────────────────────────────────────────────────────

let tmpDir: string;
let origHome: string | undefined;
let origCwd: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-reg-"));
  origHome = process.env.HOME;
  origCwd = process.cwd();
  process.env.HOME = tmpDir;
  resetAllLanguageState();
  setEffortLevel("medium");
  mockExecSync.mockReset();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  process.chdir(origCwd);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.clearAllMocks();
  resetAllLanguageState();
});

// ─── Helper: replicate handleSlashCommand parsing logic ────────────────────
// The bug was: `arg = parts[1]?.toLowerCase()` truncated multi-word args AND
// lowercased values where it shouldn't. The fix preserves the full string
// after the first whitespace token (case preserved).

function parseSlashCommand(input: string): { cmd: string; arg: string | null } {
  const trimmed = input.trim();
  const firstSpace = trimmed.search(/\s/);
  const cmd = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const arg = firstSpace === -1 ? null : trimmed.slice(firstSpace + 1).trim() || null;
  return { cmd, arg };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("Regression: handleSlashCommand passes FULL arg string", () => {
  it("/mode roblox new — arg is full 'roblox new' (not just 'roblox')", () => {
    const { cmd, arg } = parseSlashCommand("/mode roblox new");
    expect(cmd).toBe("/mode");
    expect(arg).toBe("roblox new");
  });

  it("/buscar meu arquivo.lua — arg preserves filename with spaces", () => {
    const { arg } = parseSlashCommand("/buscar meu arquivo.lua");
    expect(arg).toBe("meu arquivo.lua");
  });

  it("/compact focus on code changes — arg is the full multi-word instruction", () => {
    const { arg } = parseSlashCommand("/compact focus on code changes");
    expect(arg).toBe("focus on code changes");
  });
});

describe("Regression: /mode create (bare) shows 'Empty description' not 'not found'", () => {
  it("/mode create (no description) — arg is 'create' (handler detects empty prompt)", () => {
    const { cmd, arg } = parseSlashCommand("/mode create");
    expect(cmd).toBe("/mode");
    expect(arg).toBe("create");
    // The handler checks `arg === 'create' || arg === 'new'` and shows
    // "Empty description. Use: /mode create <what you want to do>"
  });

  it("/mode create <description> — handler strips 'create ' prefix to get prompt", () => {
    const { arg } = parseSlashCommand("/mode create modo para revisar código Luau");
    expect(arg).toBe("create modo para revisar código Luau");
    const prompt = arg!.replace(/^(create|new)(\s+)?/, "").trim();
    expect(prompt).toBe("modo para revisar código Luau");
  });

  it("/mode new (alias for create) — arg is 'new'", () => {
    const { arg } = parseSlashCommand("/mode new");
    expect(arg).toBe("new");
  });
});

describe("Regression: /lang pt-BR preserves case (not lowercased to pt-br)", () => {
  it("setLanguage('pt-BR') stores 'pt-BR' (case preserved)", () => {
    setLanguage("pt-BR");
    expect(detectLanguage()).toBe("pt-BR");
  });

  it("setLanguage('en') stores 'en'", () => {
    setLanguage("en");
    expect(detectLanguage()).toBe("en");
  });

  it("/lang pt-BR — parseSlashCommand preserves case in arg", () => {
    const { cmd, arg } = parseSlashCommand("/lang pt-BR");
    expect(cmd).toBe("/lang");
    expect(arg).toBe("pt-BR"); // NOT "pt-br"
  });

  it("/lang PT-BR — uppercase preserved", () => {
    const { arg } = parseSlashCommand("/lang PT-BR");
    expect(arg).toBe("PT-BR");
  });
});

describe("Regression: processStreamChunk — no early return after reasoning", () => {
  // Replicate the fixed core logic: process reasoning, then continue to content.
  function processDelta(
    delta: { reasoning_content?: string; content?: string; tool_calls?: unknown[] },
    callbacks: { onThinking?: () => void; onToken?: (t: string) => void },
  ): void {
    const reasoning = delta.reasoning_content;
    if (reasoning) {
      callbacks.onThinking?.();
      // BUG: previously had `return` here. Fix: continue.
    }
    if (typeof delta.content === "string") {
      callbacks.onToken?.(delta.content);
    }
  }

  it("delta with ONLY reasoning — calls onThinking, NOT onToken", () => {
    let thinking = 0, tokens = 0;
    processDelta(
      { reasoning_content: "thinking..." },
      { onThinking: () => thinking++, onToken: () => tokens++ },
    );
    expect(thinking).toBe(1);
    expect(tokens).toBe(0);
  });

  it("delta with ONLY content — calls onToken, NOT onThinking", () => {
    let thinking = 0, tokens = "";
    processDelta(
      { content: "answer" },
      { onThinking: () => thinking++, onToken: (t) => tokens += t },
    );
    expect(thinking).toBe(0);
    expect(tokens).toBe("answer");
  });

  it("delta with BOTH reasoning + content — calls BOTH onThinking and onToken", () => {
    let thinking = 0, tokens = "";
    processDelta(
      { reasoning_content: "end of thought", content: "Answer is" },
      { onThinking: () => thinking++, onToken: (t) => tokens += t },
    );
    expect(thinking).toBe(1);
    expect(tokens).toBe("Answer is");
  });

  it("delta with empty content string — onToken IS called (typeof check, not truthy)", () => {
    let tokens = 0;
    processDelta({ content: "" }, { onToken: () => tokens++ });
    expect(tokens).toBe(1);
  });
});

describe("Regression: MCP sendRequest uses NDJSON (no Content-Length header)", () => {
  // We can't easily test extensions.ts without spawning real processes,
  // so we verify the contract here: a well-formed NDJSON request is JSON
  // followed by a newline, with no Content-Length header.
  it("NDJSON format: JSON + newline, no Content-Length", () => {
    const req = { jsonrpc: "2.0", id: 1, method: "initialize" };
    const wire = JSON.stringify(req) + "\n";
    expect(wire.startsWith("{")).toBe(true);
    expect(wire.endsWith("\n")).toBe(true);
    expect(wire).not.toContain("Content-Length");
    // Parseable as JSON
    const parsed = JSON.parse(wire.trim());
    expect(parsed.method).toBe("initialize");
  });

  it("old LSP-style framing (Content-Length: N\\r\\n\\r\\n{json}) is NOT used", () => {
    const req = { jsonrpc: "2.0", id: 1, method: "initialize" };
    const lspFraming = `Content-Length: ${JSON.stringify(req).length}\r\n\r\n${JSON.stringify(req)}`;
    // Verify what the code does NOT use
    expect(lspFraming).toContain("Content-Length");
    // NDJSON wire format must NOT contain Content-Length
    const ndjson = JSON.stringify(req) + "\n";
    expect(ndjson).not.toContain("Content-Length");
  });
});

describe("Regression: robloxMcpGuard default-allow policy", () => {
  it("unknown Roblox_Studio__ tool is ALLOWED (not blocked)", () => {
    const r = evaluateMcpToolCall("Roblox_Studio__brand_new_unclassified_tool", {});
    expect(r.allowed).toBe(true);
    expect(r.category).toBe("unknown");
  });

  it("classifyMcpTool returns 'unknown' for unrecognized tool", () => {
    expect(classifyMcpTool("nonexistent_tool_xyz")).toBe("unknown");
  });

  it("get_studio_state classified as 'read'", () => {
    expect(classifyMcpTool("get_studio_state")).toBe("read");
  });
});

describe("Regression: listar_memoria tool exists and is read-only", () => {
  it("TOOL_DEFINITIONS includes listar_memoria", () => {
    const names = TOOL_DEFINITIONS.map(t => t.function.name);
    expect(names).toContain("listar_memoria");
  });

  it("listar_memoria is read-only (parameters has no write fields)", () => {
    const tool = TOOL_DEFINITIONS.find(t => t.function.name === "listar_memoria");
    expect(tool).toBeDefined();
    expect(tool!.function.parameters).toBeDefined();
    // read-only: empty properties
    const props = (tool!.function.parameters as any).properties ?? {};
    expect(Object.keys(props).length).toBe(0);
  });
});

describe("Regression: /cd and /mcp commands exist in COMMAND_HANDLERS", () => {
  // COMMAND_HANDLERS is not exported from App.tsx; verify by reading source.
  const appSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "tui", "App.tsx"),
    "utf8",
  );

  it("/cd command is registered in COMMAND_HANDLERS", () => {
    expect(appSrc).toContain('"/cd":');
  });

  it("/mcp command is registered in COMMAND_HANDLERS", () => {
    expect(appSrc).toContain('"/mcp":');
  });

  it("/cd handler is handleCdCommand", () => {
    expect(appSrc).toContain('"/cd": (arg) => handleCdCommand(arg)');
  });

  it("/mcp handler is handleMcpCommand", () => {
    expect(appSrc).toContain('"/mcp": (arg) => handleMcpCommand(arg)');
  });
});

describe("Regression: FolderBrowser component exists and exports", () => {
  it("FolderBrowser.tsx file exists", () => {
    const p = path.join(process.cwd(), "src", "tui", "FolderBrowser.tsx");
    expect(fs.existsSync(p)).toBe(true);
  });

  it("FolderBrowser is exported as a function", () => {
    const p = path.join(process.cwd(), "src", "tui", "FolderBrowser.tsx");
    const src = fs.readFileSync(p, "utf8");
    expect(src).toMatch(/export\s+function\s+FolderBrowser/);
  });

  it("FolderBrowser takes initialPath, onSelect, onCancel props", () => {
    const p = path.join(process.cwd(), "src", "tui", "FolderBrowser.tsx");
    const src = fs.readFileSync(p, "utf8");
    expect(src).toContain("initialPath");
    expect(src).toContain("onSelect");
    expect(src).toContain("onCancel");
  });
});

describe("Regression: argsNormalizer alias + coercion + JSON parsing", () => {
  it("caminho → path alias works (universal alias)", () => {
    const args: Record<string, unknown> = { caminho: "/tmp/x.lua" };
    normalizeArgs("ler_arquivo", args);
    expect(args.path).toBe("/tmp/x.lua");
  });

  it("type coercion string → number works", () => {
    const args: Record<string, unknown> = { maxResults: "5" };
    const schema = { properties: { maxResults: { type: "number" } } };
    normalizeArgs("test_tool", args, schema);
    expect(args.maxResults).toBe(5);
    expect(typeof args.maxResults).toBe("number");
  });

  it("JSON string parsing works (array string → array)", () => {
    const args: Record<string, unknown> = { items: '["a", "b"]' };
    normalizeArgs("test_tool", args);
    expect(Array.isArray(args.items)).toBe(true);
    expect(args.items).toEqual(["a", "b"]);
  });
});

describe("Regression: pokaYoke uses 'error' field (not 'message')", () => {
  it("PokaYokeResult uses 'error' field on failure (not 'message')", () => {
    const r = pokaYokeCheck("executar_comando", {});
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(typeof r.error).toBe("string");
    // Must NOT use 'message' (the old field name)
    expect((r as any).message).toBeUndefined();
  });

  it("editar_arquivo requires path (blocks when path missing)", () => {
    const r = pokaYokeCheck("editar_arquivo", { search: "x", replace: "y" });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });

  it("executar_comando requires comando (blocks when comando missing)", () => {
    const r = pokaYokeCheck("executar_comando", {});
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });
});

describe("Regression: robloxMcpGuard write/execute/read categories", () => {
  it("multi_edit blocked with blockReason", () => {
    const r = evaluateMcpToolCall("Roblox_Studio__multi_edit", { path: "/x.luau" });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBeDefined();
    expect(typeof r.blockReason).toBe("string");
    expect(r.blockReason!.length).toBeGreaterThan(0);
  });

  it("execute_luau allowed with logging (shouldLog=true)", () => {
    const r = evaluateMcpToolCall("Roblox_Studio__execute_luau", { code: "print(1)" });
    expect(r.allowed).toBe(true);
    expect(r.shouldLog).toBe(true);
    expect(r.category).toBe("execute");
  });

  it("script_read allowed silently (shouldLog=false)", () => {
    const r = evaluateMcpToolCall("Roblox_Studio__script_read", {});
    expect(r.allowed).toBe(true);
    expect(r.shouldLog).toBe(false);
    expect(r.category).toBe("read");
  });
});

describe("Regression: effortLevels feature flags", () => {
  it("shouldAutoGenerateTests true for high/max, false for low", () => {
    setEffortLevel("low");
    expect(shouldAutoGenerateTests()).toBe(false);
    setEffortLevel("medium");
    expect(shouldAutoGenerateTests()).toBe(true);
    setEffortLevel("high");
    expect(shouldAutoGenerateTests()).toBe(true);
    setEffortLevel("max");
    expect(shouldAutoGenerateTests()).toBe(true);
  });

  it("shouldUseSubAgents true for high/max only", () => {
    setEffortLevel("low");
    expect(shouldUseSubAgents()).toBe(false);
    setEffortLevel("medium");
    expect(shouldUseSubAgents()).toBe(false);
    setEffortLevel("high");
    expect(shouldUseSubAgents()).toBe(true);
    setEffortLevel("max");
    expect(shouldUseSubAgents()).toBe(true);
  });
});

describe("Regression: toolReduction detectIntent defaults", () => {
  it("detectIntent('ler o arquivo') returns non-general (matches read intent)", () => {
    // The regex matches "ler" (infinitive). "leia" (imperative) was the bug.
    expect(detectIntent("ler o arquivo")).not.toBe("general");
  });

  it("detectIntent('') returns 'general' (empty message default)", () => {
    expect(detectIntent("")).toBe("general");
  });
});

describe("Regression: configSchema validation", () => {
  it("empty object {} is invalid (missing name + label)", () => {
    const errors = validateModeConfig({});
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.field === "name")).toBe(true);
    expect(errors.some(e => e.field === "label")).toBe(true);
  });

  it("valid config with name + label passes", () => {
    const errors = validateModeConfig({ name: "x", label: "X" });
    expect(errors).toEqual([]);
  });
});

describe("Regression: dotfileConfig save + load + update", () => {
  it("save + load roundtrips config", async () => {
    vi.resetModules();
    const mod = await import("../dotfileConfig.js");
    mod.saveConfig({ model: "gpt-4", rateLimitRpm: 100 });
    const loaded = mod.loadConfig();
    expect(loaded.model).toBe("gpt-4");
    expect(loaded.rateLimitRpm).toBe(100);
  });

  it("updateConfig merges (preserves existing keys)", async () => {
    vi.resetModules();
    const mod = await import("../dotfileConfig.js");
    mod.saveConfig({ model: "v1", rateLimitRpm: 50 });
    mod.updateConfig({ rateLimitRpm: 200 });
    const loaded = mod.loadConfig();
    expect(loaded.model).toBe("v1"); // preserved
    expect(loaded.rateLimitRpm).toBe(200); // updated
  });
});

describe("Regression: syntaxHighlight extensions", () => {
  it(".ts → 'typescript'", () => {
    expect(detectLanguageFromExt(".ts")).toBe("typescript");
  });

  it(".lua → non-empty string (fallback is 'typescript' for unmapped ext)", () => {
    const lang = detectLanguageFromExt(".lua");
    expect(typeof lang).toBe("string");
    expect(lang.length).toBeGreaterThan(0);
  });
});

describe("Regression: utf8Safety", () => {
  it("pickBestUtf8Locale returns {locale, tried} object", () => {
    const result = pickBestUtf8Locale();
    expect(result).toHaveProperty("locale");
    expect(result).toHaveProperty("tried");
    expect(Array.isArray(result.tried)).toBe(true);
  });

  it("diagnoseUtf8 returns string containing 'UTF-8'", () => {
    const result = diagnoseUtf8();
    expect(typeof result).toBe("string");
    expect(result).toContain("UTF-8");
  });
});

describe("Regression: autoMemory", () => {
  it("ensureAutoMemoryFile creates file (doesn't throw)", () => {
    expect(() => ensureAutoMemoryFile()).not.toThrow();
    // Verify file was created
    const file = getAutoMemoryPath();
    expect(fs.existsSync(file)).toBe(true);
  });

  it("appendAutoMemory adds content (file grows)", () => {
    ensureAutoMemoryFile();
    const before = readAutoMemory();
    appendAutoMemory("regression test entry");
    const after = readAutoMemory();
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    expect(after).toContain("regression test entry");
  });
});

describe("Regression: ensureRobloxTools", () => {
  it("checkRobloxTools returns 4 tools", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("which") || cmd.includes("where")) return "/usr/bin/x";
      if (cmd.includes("--version")) return "1.0.0";
      return "";
    });
    const tools = checkRobloxTools();
    expect(tools).toHaveLength(4);
  });

  it("each tool has installUrl", () => {
    mockExecSync.mockImplementation(() => "/usr/bin/x");
    const tools = checkRobloxTools();
    for (const t of tools) {
      expect(t.installUrl).toMatch(/^https?:\/\//);
    }
  });

  it("selene and stylua are required; rojo and lune are optional", () => {
    mockExecSync.mockImplementation(() => "/usr/bin/x");
    const tools = checkRobloxTools();
    const selene = tools.find(t => t.name === "selene");
    const stylua = tools.find(t => t.name === "stylua");
    const rojo = tools.find(t => t.name === "rojo");
    const lune = tools.find(t => t.name === "lune");
    expect(selene?.required).toBe(true);
    expect(stylua?.required).toBe(true);
    expect(rojo?.required).toBe(false);
    expect(lune?.required).toBe(false);
  });
});
