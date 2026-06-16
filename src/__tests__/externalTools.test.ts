/**
 * externalTools.test.ts — Tests for the external tools framework
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ToolRegistry,
  ToolDetector,
  ToolExecutor,
  ToolSuggester,
  type Tool,
  type ToolInvocation,
} from "../externalTools.js";

// ─── Mock Tools ─────────────────────────────────────────────────────────────

const mockTool: Tool = {
  name: "test_tool",
  description: "A test tool",
  category: "custom",
  command: "test-cmd",
  args: ["run"],
  flags: [
    { name: "--verbose", type: "boolean" },
    { name: "--output", type: "string", default: "output.txt" }
  ],
  detection: {
    method: "binary",
    check: "test-cmd --version"
  },
  context: {
    whenToUse: ["run tests", "execute test"],
    examples: ["test-cmd run --verbose"]
  },
  outputParser: "raw"
};

const mockConfigTool: Tool = {
  name: "config_tool",
  description: "A tool detected by config file",
  category: "python",
  command: "pytest",
  args: [],
  flags: [],
  detection: {
    method: "config",
    check: "pyproject.toml"
  },
  context: {
    whenToUse: ["run pytest", "python tests"],
    requiresProject: ["pyproject.toml"],
    examples: ["pytest"]
  },
  outputParser: "structured"
};

// ─── Tool Registry Tests ────────────────────────────────────────────────────

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("should register a tool", () => {
    registry.register(mockTool);
    expect(registry.get("test_tool")).toBeDefined();
    expect(registry.get("test_tool")?.name).toBe("test_tool");
  });

  it("should register multiple tools", () => {
    registry.registerAll([mockTool, mockConfigTool]);
    expect(registry.getAll().length).toBe(2);
  });

  it("should get tools by category", () => {
    registry.registerAll([mockTool, mockConfigTool]);
    const pythonTools = registry.getByCategory("python");
    expect(pythonTools.length).toBe(1);
    expect(pythonTools[0].name).toBe("config_tool");
  });

  it("should search tools by intent", () => {
    registry.registerAll([mockTool, mockConfigTool]);
    const results = registry.searchByIntent("run tests");
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("test_tool");
  });

  it("should check if tool is installed (binary)", () => {
    registry.register(mockTool);
    // This will fail because test-cmd doesn't exist
    expect(registry.isInstalled("test_tool")).toBe(false);
  });

  it("should check if tool is installed (config)", () => {
    registry.register(mockConfigTool);
    // This will depend on whether pyproject.toml exists
    const result = registry.isInstalled("config_tool");
    expect(typeof result).toBe("boolean");
  });

  it("should add tool dynamically", () => {
    const result = registry.addTool({
      ...mockTool,
      name: "dynamic_tool"
    });
    expect(result.success).toBe(true);
    expect(registry.get("dynamic_tool")).toBeDefined();
  });

  it("should fail to add tool without name", () => {
    const result = registry.addTool({
      ...mockTool,
      name: ""
    });
    expect(result.success).toBe(false);
  });
});

// ─── Tool Detector Tests ────────────────────────────────────────────────────

describe("ToolDetector", () => {
  let registry: ToolRegistry;
  let detector: ToolDetector;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.registerAll([mockTool, mockConfigTool]);
    detector = new ToolDetector(registry);
  });

  it("should detect tool from intent", () => {
    const result = detector.detectFromIntent("run tests please");
    expect(result).not.toBeNull();
    expect(result?.tool).toBe("test_tool");
  });

  it("should return null for no match", () => {
    const result = detector.detectFromIntent("hello world");
    expect(result).toBeNull();
  });

  it("should detect tools from context", () => {
    // This depends on whether pyproject.toml exists in cwd
    const results = detector.detectFromContext();
    expect(Array.isArray(results)).toBe(true);
  });

  it("should detect both intent and context", () => {
    const result = detector.detect("run tests", ".");
    expect(result.intent).not.toBeNull();
    expect(Array.isArray(result.context)).toBe(true);
  });
});

// ─── Tool Executor Tests ────────────────────────────────────────────────────

describe("ToolExecutor", () => {
  let registry: ToolRegistry;
  let executor: ToolExecutor;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(mockTool);
    executor = new ToolExecutor(registry);
  });

  it("should fail for unknown tool", async () => {
    const result = await executor.execute("unknown_tool");
    expect(result.success).toBe(false);
    expect(result.errors).toContain('Tool "unknown_tool" not found');
  });

  it("should fail for uninstalled tool", async () => {
    const result = await executor.execute("test_tool");
    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain("not installed");
  });

  it("should execute installed tool", async () => {
    // Mark tool as installed
    registry.register({
      ...mockTool,
      name: "echo_tool",
      command: "echo",
      args: ["hello"],
      detection: { method: "binary", check: "echo --version" }
    });
    
    const result = await executor.execute("echo_tool");
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("should handle command timeout", async () => {
    registry.register({
      ...mockTool,
      name: "sleep_tool",
      command: "sleep",
      args: ["10"],
      detection: { method: "binary", check: "sleep --version" }
    });
    
    const result = await executor.execute("sleep_tool", {}, { timeout: 100 });
    expect(result.success).toBe(false);
  });
});

// ─── Tool Suggester Tests ───────────────────────────────────────────────────

describe("ToolSuggester", () => {
  let registry: ToolRegistry;
  let suggester: ToolSuggester;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.registerAll([mockTool, mockConfigTool]);
    suggester = new ToolSuggester(registry);
  });

  it("should suggest tools based on intent", () => {
    const suggestions = suggester.suggest("run tests");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].tool.name).toBe("test_tool");
  });

  it("should rank suggestions by confidence", () => {
    const suggestions = suggester.suggest("run tests");
    expect(suggestions[0].confidence).toBeGreaterThan(0);
    if (suggestions.length > 1) {
      expect(suggestions[0].confidence).toBeGreaterThanOrEqual(suggestions[1].confidence);
    }
  });

  it("should return empty for no match", () => {
    const suggestions = suggester.suggest("hello world");
    expect(suggestions.length).toBe(0);
  });

  it("should get best suggestion", () => {
    const best = suggester.getBest("run tests");
    expect(best).not.toBeNull();
    expect(best?.name).toBe("test_tool");
  });

  it("should return null for no best", () => {
    const best = suggester.getBest("hello world");
    expect(best).toBeNull();
  });
});

// ─── Tool Interface Tests ───────────────────────────────────────────────────

describe("Tool Interface", () => {
  it("should have required fields", () => {
    const tool: Tool = {
      name: "test",
      description: "Test",
      category: "custom",
      command: "test",
      args: [],
      flags: [],
      detection: { method: "binary", check: "test --version" },
      context: { whenToUse: [], examples: [] },
      outputParser: "raw"
    };

    expect(tool.name).toBe("test");
    expect(tool.description).toBe("Test");
    expect(tool.category).toBe("custom");
    expect(tool.command).toBe("test");
    expect(tool.detection.method).toBe("binary");
    expect(tool.outputParser).toBe("raw");
  });

  it("should support all categories", () => {
    const categories = ["roblox", "python", "node", "rust", "go", "docker", "system", "custom"];
    categories.forEach(cat => {
      const tool: Tool = {
        name: `test_${cat}`,
        description: "Test",
        category: cat as any,
        command: "test",
        args: [],
        flags: [],
        detection: { method: "binary", check: "test --version" },
        context: { whenToUse: [], examples: [] },
        outputParser: "raw"
      };
      expect(tool.category).toBe(cat);
    });
  });

  it("should support all flag types", () => {
    const flags = [
      { name: "--string", type: "string" as const },
      { name: "--number", type: "number" as const },
      { name: "--boolean", type: "boolean" as const }
    ];

    flags.forEach(flag => {
      expect(["string", "number", "boolean"]).toContain(flag.type);
    });
  });
});

// ─── Tool Invocation Tests ──────────────────────────────────────────────────

describe("ToolInvocation", () => {
  it("should have tool name", () => {
    const invocation: ToolInvocation = {
      tool: "test_tool",
      args: {}
    };
    expect(invocation.tool).toBe("test_tool");
  });

  it("should support args", () => {
    const invocation: ToolInvocation = {
      tool: "test_tool",
      args: { verbose: true, output: "file.txt" }
    };
    expect(invocation.args.verbose).toBe(true);
    expect(invocation.args.output).toBe("file.txt");
  });

  it("should support context", () => {
    const invocation: ToolInvocation = {
      tool: "test_tool",
      args: {},
      context: "Running tests for the project"
    };
    expect(invocation.context).toBe("Running tests for the project");
  });
});