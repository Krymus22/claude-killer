/**
 * contract-interfaces.test.ts — Contract tests verifying module interfaces
 * (exports, types, return shapes).
 *
 * These tests ensure that public interfaces don't change shape silently.
 * If someone removes a required field or renames an export, these tests fail.
 *
 * Strategy: import modules and assert that exports exist with the expected
 * types, and that runtime objects conform to the expected shape.
 */

import { describe, it, expect } from "vitest";
import { pokaYokeCheck } from "../pokaYoke.js";
import {
  evaluateMcpToolCall,
  classifyMcpTool,
} from "../robloxMcpGuard.js";
import { getActiveMode } from "../modes.js";
import { getActiveSkills, getActiveMCPServers, getMCPToolDefinitions } from "../extensions.js";
import { getLoadedMemoryFiles } from "../history.js";
import {
  getEffortLevel, setEffortLevel, getEffortLabel,
} from "../effortLevels.js";
import { validateModeConfig, isValidModeConfig } from "../configSchema.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Assert that a module exports the given named functions. */
async function expectFunctions(modulePath: string, names: string[]) {
  const mod = await import(modulePath);
  for (const name of names) {
    expect(mod, `${modulePath} should export "${name}"`).toHaveProperty(name);
    expect(typeof mod[name as keyof typeof mod], `${modulePath}.${name} should be a function`).toBe("function");
  }
}

/** Assert that a value is a non-null object. */
function expectObject(v: unknown, label: string) {
  expect(v, `${label} should be a non-null object`).toBeDefined();
  expect(typeof v, `${label} should be an object`).toBe("object");
  expect(v, `${label} should not be null`).not.toBeNull();
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool handlers return { resultStr, usedHeal } shape
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract: ToolResult shape { resultStr, usedHeal }", () => {
  it("agent exports dispatchToolCallPublic returning ToolResult", async () => {
    const mod = await import("../agent.js");
    expect(typeof mod.dispatchToolCallPublic).toBe("function");
  });

  it("dispatchToolCallPublic returns a Promise<ToolResult> with resultStr+usedHeal", async () => {
    const { dispatchToolCallPublic } = await import("../agent.js");
    // Call with an unknown tool — the dispatcher returns { resultStr, usedHeal }
    const result = await dispatchToolCallPublic({
      id: "call_contract_1",
      type: "function",
      function: { name: "__unknown_tool__contract__", arguments: "{}" },
    } as any, 0);
    expectObject(result, "ToolResult");
    expect(result).toHaveProperty("resultStr");
    expect(result).toHaveProperty("usedHeal");
    expect(typeof (result as any).resultStr).toBe("string");
    expect(typeof (result as any).usedHeal).toBe("boolean");
  });

  it("dispatchToolCallPublic with missing required args returns error in resultStr", async () => {
    const { dispatchToolCallPublic } = await import("../agent.js");
    // buscar_web without 'query' should return an ERROR-tagged resultStr.
    const result = await dispatchToolCallPublic({
      id: "call_c2",
      type: "function",
      function: { name: "buscar_web", arguments: JSON.stringify({}) },
    } as any, 0);
    // Schema validation error starts with [ERROR: SCHEMA VALIDATION].
    expect((result as any).resultStr).toMatch(/\[ERROR/);
    expect((result as any).usedHeal).toBe(false);
  });

  it("dispatchToolCallPublic for unknown tool returns '[ERROR] Unknown tool'", async () => {
    const { dispatchToolCallPublic } = await import("../agent.js");
    const result = await dispatchToolCallPublic({
      id: "call_c3",
      type: "function",
      function: { name: "non_existent_tool_xyz", arguments: "{}" },
    } as any, 0);
    expect((result as any).resultStr).toContain("[ERROR]");
    expect((result as any).resultStr).toContain("Unknown tool");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PokaYokeResult shape { ok, error?, resolvedPath? }
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract: PokaYokeResult shape", () => {
  it("pokaYoke exports pokaYokeCheck returning PokaYokeResult", async () => {
    const mod = await import("../pokaYoke.js");
    expect(typeof mod.pokaYokeCheck).toBe("function");
  });

  it("pokaYokeCheck success result has { ok: true, resolvedPath? }", () => {
    const r = pokaYokeCheck("ler_arquivo", { path: "/tmp/x" });
    expect(r).toHaveProperty("ok");
    expect(r.ok).toBe(true);
    expect(r).toHaveProperty("resolvedPath");
    expect(typeof r.resolvedPath).toBe("string");
  });

  it("pokaYokeCheck failure result has { ok: false, error: string }", () => {
    const r = pokaYokeCheck("editar_arquivo", { path: "/tmp/x" });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
  });

  it("pokaYokeCheck on non-path tool returns { ok: true } without resolvedPath", () => {
    const r = pokaYokeCheck("executar_comando", { comando: "ls" });
    expect(r.ok).toBe(true);
    expect(r.resolvedPath).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GuardResult shape { allowed, category, shouldLog, blockReason? }
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract: GuardResult shape", () => {
  it("robloxMcpGuard exports evaluateMcpToolCall returning GuardResult", async () => {
    const mod = await import("../robloxMcpGuard.js");
    expect(typeof mod.evaluateMcpToolCall).toBe("function");
  });

  it("GuardResult on allowed read tool has { allowed: true, category, shouldLog }", () => {
    const r = evaluateMcpToolCall("Roblox_Studio__script_read", {});
    expect(r).toHaveProperty("allowed");
    expect(r).toHaveProperty("category");
    expect(r).toHaveProperty("shouldLog");
    expect(r.allowed).toBe(true);
    expect(r.category).toBe("read");
    expect(r.shouldLog).toBe(false);
    expect(r.blockReason).toBeUndefined();
  });

  it("GuardResult on blocked write tool has { allowed: false, blockReason: string }", () => {
    const r = evaluateMcpToolCall("Roblox_Studio__multi_edit", { path: "/x" });
    expect(r.allowed).toBe(false);
    expect(r.category).toBe("write");
    expect(r.shouldLog).toBe(true);
    expect(typeof r.blockReason).toBe("string");
    expect(r.blockReason.length).toBeGreaterThan(0);
  });

  it("GuardResult on execute tool has { allowed: true, shouldLog: true }", () => {
    const r = evaluateMcpToolCall("Roblox_Studio__execute_luau", {});
    expect(r.allowed).toBe(true);
    expect(r.category).toBe("execute");
    expect(r.shouldLog).toBe(true);
  });

  it("GuardResult on non-Roblox MCP tool has { allowed: true, category: 'unknown', shouldLog: false }", () => {
    const r = evaluateMcpToolCall("GitHub__create_issue", {});
    expect(r.allowed).toBe(true);
    expect(r.category).toBe("unknown");
    expect(r.shouldLog).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// McpToolCategory includes all 6 categories
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract: McpToolCategory — all 6 categories covered", () => {
  it("classifies a known tool for each of the 6 categories", () => {
    expect(classifyMcpTool("script_read")).toBe("read");
    expect(classifyMcpTool("multi_edit")).toBe("write");
    expect(classifyMcpTool("execute_luau")).toBe("execute");
    expect(classifyMcpTool("start_stop_play")).toBe("playtest");
    expect(classifyMcpTool("set_active_studio")).toBe("session");
    expect(classifyMcpTool("nonexistent_random_tool")).toBe("unknown");
  });

  it("the 6 categories are: read | write | execute | playtest | session | unknown", () => {
    const seen = new Set<string>();
    [
      "script_read", "multi_edit", "execute_luau",
      "start_stop_play", "set_active_studio", "never_seen_tool",
    ].forEach(t => seen.add(classifyMcpTool(t)));
    expect(seen.has("read")).toBe(true);
    expect(seen.has("write")).toBe(true);
    expect(seen.has("execute")).toBe(true);
    expect(seen.has("playtest")).toBe(true);
    expect(seen.has("session")).toBe(true);
    expect(seen.has("unknown")).toBe(true);
    expect(seen.size).toBe(6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MCPConfig interface has required fields
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract: MCPConfig interface", () => {
  it("extensions exports MCPConfig-typed values via plugin manifests", async () => {
    const mod = await import("../extensions.js");
    // No direct MCPConfig export, but PluginManifest/MCPConfig types are used.
    expect(typeof mod.loadAllExtensions).toBe("function");
  });

  it("MCPConfig requires `command` field (string); args/env are optional", () => {
    // Type-only check via runtime: a valid MCPConfig object.
    const cfg: import("../extensions.js").MCPConfig = {
      command: "node",
      args: ["server.js"],
      env: { FOO: "bar" },
      autoStart: true,
    };
    expect(typeof cfg.command).toBe("string");
    expect(Array.isArray(cfg.args)).toBe(true);
    expect(typeof cfg.env).toBe("object");
    expect(cfg.autoStart).toBe(true);
  });

  it("MCPConfig with platformOverrides preserves structure", () => {
    const cfg: import("../extensions.js").MCPConfig = {
      command: "studio-mcp.exe",
      platformOverrides: {
        win32: { command: "cmd.exe", args: ["/c"] },
        darwin: { command: "open" },
        linux: { command: "wine" },
      },
    };
    expect(cfg.platformOverrides!.win32!.command).toBe("cmd.exe");
    expect(cfg.platformOverrides!.darwin!.command).toBe("open");
    expect(cfg.platformOverrides!.linux!.command).toBe("wine");
  });

  it("MCPConfig can have command only (minimal)", () => {
    const cfg: import("../extensions.js").MCPConfig = { command: "echo" };
    expect(cfg.command).toBe("echo");
    expect(cfg.args).toBeUndefined();
    expect(cfg.env).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ModeDefinition has required fields
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract: ModeDefinition interface", () => {
  it("modes exports getActiveMode returning ModeDefinition | null", async () => {
    const mod = await import("../modes.js");
    expect(typeof mod.getActiveMode).toBe("function");
  });

  it("ModeDefinition requires: name, label, description, builtIn, enableTools, enableSkills, enableFeatures", () => {
    const mode: import("../modes.js").ModeDefinition = {
      name: "test",
      label: "Test",
      description: "Test mode",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    };
    expect(typeof mode.name).toBe("string");
    expect(typeof mode.label).toBe("string");
    expect(typeof mode.description).toBe("string");
    expect(typeof mode.builtIn).toBe("boolean");
    expect(Array.isArray(mode.enableTools)).toBe(true);
    expect(Array.isArray(mode.enableSkills)).toBe(true);
    expect(Array.isArray(mode.enableFeatures)).toBe(true);
  });

  it("ModeDefinition optional fields: effortLevel, strictMode, readBeforeWrite", () => {
    const mode: import("../modes.js").ModeDefinition = {
      name: "full",
      label: "Full",
      description: "Full mode",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
      effortLevel: "high",
      strictMode: true,
      readBeforeWrite: true,
    };
    expect(mode.effortLevel).toBe("high");
    expect(mode.strictMode).toBe(true);
    expect(mode.readBeforeWrite).toBe(true);
  });

  it("getActiveMode() never returns null (falls back to 'normal' base mode)", () => {
    const m = getActiveMode();
    expect(m).not.toBeNull();
    expect(m).toHaveProperty("name");
    expect(m).toHaveProperty("label");
    // ModeDefinition supports both new format (tools/skills) and legacy
    // (enableTools/enableSkills). At least one of each pair should be present.
    expect(
      "enableTools" in m || "tools" in m,
    ).toBe(true);
    expect(
      "enableSkills" in m || "skills" in m,
    ).toBe(true);
    expect(m).toHaveProperty("enableFeatures");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Skill has { name, description, path, content }
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract: Skill interface { name, description, path, content }", () => {
  it("extensions exports getActiveSkills returning Skill[]", async () => {
    const mod = await import("../extensions.js");
    expect(typeof mod.getActiveSkills).toBe("function");
  });

  it("getActiveSkills returns an array (may be empty in test env)", () => {
    const skills = getActiveSkills();
    expect(Array.isArray(skills)).toBe(true);
  });

  it("Skill object has the 4 required fields", () => {
    // Build a typed Skill object and verify shape.
    const skill: import("../extensions.js").Skill = {
      name: "test-skill",
      description: "A test skill",
      path: "/tmp/skill.md",
      content: "Skill body content",
    };
    expect(typeof skill.name).toBe("string");
    expect(typeof skill.description).toBe("string");
    expect(typeof skill.path).toBe("string");
    expect(typeof skill.content).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MemoryFile has { relativePath, absolutePath, sizeBytes, content }
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract: MemoryFile interface", () => {
  it("history exports getLoadedMemoryFiles returning MemoryFile[]", async () => {
    const mod = await import("../history.js");
    expect(typeof mod.getLoadedMemoryFiles).toBe("function");
  });

  it("MemoryFile has the 4 required fields", () => {
    // Build a typed MemoryFile and verify shape.
    const f: import("../history.js").MemoryFile = {
      relativePath: "CLAUDE.md",
      absolutePath: "/tmp/CLAUDE.md",
      sizeBytes: 100,
      content: "# Rules",
    };
    expect(typeof f.relativePath).toBe("string");
    expect(typeof f.absolutePath).toBe("string");
    expect(typeof f.sizeBytes).toBe("number");
    expect(typeof f.content).toBe("string");
  });

  it("getLoadedMemoryFiles returns an array", () => {
    const files = getLoadedMemoryFiles();
    expect(Array.isArray(files)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ActiveMCPServer has { name, process, tools, buffer, initialized, stderrBuffer }
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract: ActiveMCPServer interface", () => {
  it("ActiveMCPServer has the required fields per the type definition", () => {
    // Build a partial ActiveMCPServer object that mimics the shape produced
    // by startAndInitMCPServer. We can't easily spawn one here, but we verify
    // the interface contract by constructing a typed value.
    const server: import("../extensions.js").ActiveMCPServer = {
      name: "test-server",
      process: { pid: 12345 } as any,
      tools: [],
      nextRequestId: 1,
      pendingRequests: new Map(),
      buffer: "",
      initialized: false,
      stderrBuffer: "",
    };
    expect(typeof server.name).toBe("string");
    expect(server.process).toBeDefined();
    expect(Array.isArray(server.tools)).toBe(true);
    expect(typeof server.buffer).toBe("string");
    expect(typeof server.initialized).toBe("boolean");
    expect(typeof server.stderrBuffer).toBe("string");
  });

  it("extensions exports getActiveMCPServers returning string[]", async () => {
    const mod = await import("../extensions.js");
    expect(typeof mod.getActiveMCPServers).toBe("function");
    const names = mod.getActiveMCPServers();
    expect(Array.isArray(names)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EffortLevel type is "low" | "medium" | "high" | "max"
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract: EffortLevel type", () => {
  it("effortLevels exports getEffortLevel returning EffortLevel", async () => {
    const mod = await import("../effortLevels.js");
    expect(typeof mod.getEffortLevel).toBe("function");
    const level = mod.getEffortLevel();
    expect(["low", "medium", "high", "max"]).toContain(level);
  });

  it("setEffortLevel accepts all 4 valid levels and rejects invalid ones", () => {
    expect(setEffortLevel("low")).toBe(true);
    expect(getEffortLevel()).toBe("low");
    expect(setEffortLevel("medium")).toBe(true);
    expect(getEffortLevel()).toBe("medium");
    expect(setEffortLevel("high")).toBe(true);
    expect(getEffortLevel()).toBe("high");
    expect(setEffortLevel("max")).toBe(true);
    expect(getEffortLevel()).toBe("max");
    // Invalid levels return false
    expect(setEffortLevel("extreme" as any)).toBe(false);
    expect(setEffortLevel("OFF" as any)).toBe(false);
    expect(setEffortLevel("" as any)).toBe(false);
  });

  it("getEffortLabel returns a string for the current level", () => {
    const label = getEffortLabel();
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Other module exports — basic contract checks
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract: Other module interfaces", () => {
  it("argsNormalizer exports normalizeArgs(toolName, args, schema?)", async () => {
    const mod = await import("../argsNormalizer.js");
    expect(typeof mod.normalizeArgs).toBe("function");
    const args = { caminho: "/x" };
    mod.normalizeArgs("ler_arquivo", args);
    expect(args).toHaveProperty("path");
  });

  it("fileEdit exports applyEdits + editFile", async () => {
    await expectFunctions("../fileEdit.js", ["applyEdits", "editFile"]);
  });

  it("applyEdits returns EditResult { success, replacements, content, error? }", async () => {
    const { applyEdits } = await import("../fileEdit.js");
    const r = applyEdits("hello", [{ search: "hello", replace: "hi" }]);
    expect(r).toHaveProperty("success");
    expect(r).toHaveProperty("replacements");
    expect(r).toHaveProperty("content");
    expect(typeof r.success).toBe("boolean");
    expect(typeof r.replacements).toBe("number");
    expect(typeof r.content).toBe("string");
  });

  it("contextInjector exports getContextInjection + resetContextInjection", async () => {
    await expectFunctions("../contextInjector.js", ["getContextInjection", "resetContextInjection"]);
  });

  it("toolReduction exports detectIntent + filterToolsByIntent + getFilterSummary", async () => {
    await expectFunctions("../toolReduction.js", ["detectIntent", "filterToolsByIntent", "getFilterSummary"]);
  });

  it("configSchema exports validateModeConfig + isValidModeConfig", async () => {
    await expectFunctions("../configSchema.js", ["validateModeConfig", "isValidModeConfig"]);
  });

  it("dotfileConfig exports loadConfig + saveConfig + updateConfig", async () => {
    await expectFunctions("../dotfileConfig.js", ["loadConfig", "saveConfig", "updateConfig"]);
  });

  it("streaming exports TokenCounter + BufferedStreamProcessor + StreamThrottle + StreamingMetrics", async () => {
    const mod = await import("../streaming.js");
    expect(typeof mod.TokenCounter).toBe("function");
    expect(typeof mod.BufferedStreamProcessor).toBe("function");
    expect(typeof mod.StreamThrottle).toBe("function");
    expect(typeof mod.StreamingMetrics).toBe("function");
  });

  it("TokenCounter getStats returns { prompt, completion, total }", async () => {
    const { TokenCounter } = await import("../streaming.js");
    const tc = new TokenCounter();
    tc.addPrompt(10);
    tc.addCompletion(5);
    const stats = tc.getStats();
    expect(stats).toHaveProperty("prompt");
    expect(stats).toHaveProperty("completion");
    expect(stats).toHaveProperty("total");
    expect(stats.prompt).toBe(10);
    expect(stats.completion).toBe(5);
    expect(stats.total).toBe(15);
  });

  it("i18n exports detectLanguage + setLanguage + resetLanguageCache + t", async () => {
    await expectFunctions("../i18n.js", ["detectLanguage", "setLanguage", "resetLanguageCache", "t"]);
  });

  it("history exports getSystemPrompt + addUserMessage + getHistory + resetHistory", async () => {
    await expectFunctions("../history.js", [
      "getSystemPrompt", "addUserMessage", "getHistory", "resetHistory",
    ]);
  });

  it("modes exports getAllModes + getActiveMode + applyMode + suggestMode", async () => {
    await expectFunctions("../modes.js", [
      "getAllModes", "getActiveMode", "applyMode", "suggestMode",
    ]);
  });

  it("extensions exports loadAllExtensions + getActiveSkills + getMCPToolDefinitions", async () => {
    await expectFunctions("../extensions.js", [
      "loadAllExtensions", "getActiveSkills", "getMCPToolDefinitions",
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ConfigValidationError shape returned by configSchema
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract: ConfigValidationError shape", () => {
  it("validateModeConfig returns ConfigValidationError[] (each has field + message)", () => {
    const errors = validateModeConfig(null);
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    const e = errors[0];
    expect(e).toHaveProperty("field");
    expect(e).toHaveProperty("message");
    expect(typeof e.field).toBe("string");
    expect(typeof e.message).toBe("string");
  });

  it("isValidModeConfig returns boolean", () => {
    const r = isValidModeConfig({ name: "x", label: "X" });
    expect(typeof r).toBe("boolean");
  });

  it("validateModeConfig returns [] for a valid config", () => {
    const errors = validateModeConfig({
      name: "valid",
      label: "Valid",
      enableTools: ["tool:x"],
      enableSkills: [],
      enableFeatures: [],
    });
    expect(errors).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PluginManifest shape (used by extensions.loadPluginsFromDir)
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract: PluginManifest interface", () => {
  it("PluginManifest requires name + version; skills/mcpServers are optional", () => {
    const manifest: import("../extensions.js").PluginManifest = {
      name: "my-plugin",
      version: "1.0.0",
    };
    expect(typeof manifest.name).toBe("string");
    expect(typeof manifest.version).toBe("string");
    expect(manifest.skills).toBeUndefined();
    expect(manifest.mcpServers).toBeUndefined();
  });

  it("PluginManifest with mcpServers field carries MCPConfig entries", () => {
    const manifest: import("../extensions.js").PluginManifest = {
      name: "with-mcp",
      version: "2.0.0",
      mcpServers: {
        "my-server": { command: "node", args: ["s.js"] },
      },
    };
    expect(manifest.mcpServers).toBeDefined();
    expect(manifest.mcpServers!["my-server"].command).toBe("node");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MCPToolDef shape
// ═══════════════════════════════════════════════════════════════════════════

describe("Contract: MCPToolDef interface", () => {
  it("MCPToolDef has name + inputSchema; description is optional", () => {
    const def: import("../extensions.js").MCPToolDef = {
      name: "tool_name",
      inputSchema: { type: "object", properties: {} },
    };
    expect(typeof def.name).toBe("string");
    expect(typeof def.inputSchema).toBe("object");
    expect(def.description).toBeUndefined();
  });

  it("getMCPToolDefinitions returns array of { type, function: { name, description, parameters } }", async () => {
    const { getMCPToolDefinitions } = await import("../extensions.js");
    const tools = getMCPToolDefinitions();
    expect(Array.isArray(tools)).toBe(true);
    // If any tools exist, verify shape
    for (const t of tools) {
      expect(t).toHaveProperty("type");
      expect(t).toHaveProperty("function");
      expect(t.function).toHaveProperty("name");
      expect(t.function).toHaveProperty("description");
      expect(t.function).toHaveProperty("parameters");
    }
  });
});
