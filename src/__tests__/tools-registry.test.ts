/**
 * tools-registry.test.ts — Tests for all tool files.
 * Covers: tools/index.ts, roblox.ts, python.ts, node.ts, rust.ts, go.ts, docker.ts
 */

import { describe, it, expect } from "vitest";
import type { Tool } from "../externalTools.js";

// ─── Reimport the tool arrays from index.ts ────────────────────────────────
import { ALL_TOOLS, TOOL_COUNTS, getToolsByCategory, searchTools } from "../tools/index.js";
import { ROBLOX_TOOLS } from "../tools/roblox.js";
import { PYTHON_TOOLS } from "../tools/python.js";
import { NODE_TOOLS } from "../tools/node.js";
import { RUST_TOOLS } from "../tools/rust.js";
import { GO_TOOLS } from "../tools/go.js";
import { DOCKER_TOOLS } from "../tools/docker.js";

// ═══════════════════════════════════════════════════════════════════════════════
// tools/index.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("tools/index.ts", () => {
  describe("ALL_TOOLS", () => {
    it("should export a non-empty array", () => {
      expect(Array.isArray(ALL_TOOLS)).toBe(true);
      expect(ALL_TOOLS.length).toBeGreaterThan(0);
    });

    it("should have unique tool names", () => {
      const names = ALL_TOOLS.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it("every tool should have required fields", () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.category).toBeTruthy();
        expect(["roblox", "python", "node", "rust", "go", "docker"]).toContain(tool.category);
      }
    });
  });

  describe("TOOL_COUNTS", () => {
    it("should have counts for each category", () => {
      expect(TOOL_COUNTS.roblox).toBeGreaterThan(0);
      expect(TOOL_COUNTS.python).toBeGreaterThan(0);
      expect(TOOL_COUNTS.node).toBeGreaterThan(0);
      expect(TOOL_COUNTS.rust).toBeGreaterThan(0);
      expect(TOOL_COUNTS.go).toBeGreaterThan(0);
      expect(TOOL_COUNTS.docker).toBeGreaterThan(0);
    });

    it("total should match ALL_TOOLS length", () => {
      expect(TOOL_COUNTS.total).toBe(ALL_TOOLS.length);
    });
  });

  describe("getToolsByCategory", () => {
    it("should filter by category", () => {
      const roblox = getToolsByCategory("roblox");
      expect(roblox.length).toBeGreaterThan(0);
      for (const t of roblox) expect(t.category).toBe("roblox");
    });

    it("should return empty for non-existent category", () => {
      expect(getToolsByCategory("nonexistent")).toHaveLength(0);
    });
  });

  describe("searchTools", () => {
    it("should find tools by name substring", () => {
      const results = searchTools("rojo");
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) expect(r.name.toLowerCase()).toContain("rojo");
    });

    it("should find tools by description", () => {
      const results = searchTools("docker");
      expect(results.length).toBeGreaterThan(0);
    });

    it("should return empty for no match", () => {
      expect(searchTools("xyznonexistent")).toHaveLength(0);
    });

    it("should be case-insensitive", () => {
      const lower = searchTools("pytest");
      const upper = searchTools("PYTEST");
      expect(lower.length).toBe(upper.length);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// roblox.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("roblox.ts", () => {
  it("should export 19 Roblox tools", () => {
    expect(ROBLOX_TOOLS.length).toBe(19);
  });

  it("should include all 11 CLI tools", () => {
    const cliNames = ["rojo_build", "rojo_serve", "rojo_sourcemap", "wally_install", "wally_search",
      "wally_publish", "lune_run", "selene_lint", "rokit_install", "rokit_add", "generate_types"];
    for (const name of cliNames) {
      expect(ROBLOX_TOOLS.find((t) => t.name === name)).toBeDefined();
    }
  });

  it("should include all 8 pattern tools", () => {
    const patternNames = ["profilestore_pattern", "bytenet_pattern",
      "replica_pattern", "react_roblox_pattern", "trove_pattern", "signal_pattern",
      "observers_pattern", "cmdr_pattern"];
    for (const name of patternNames) {
      expect(ROBLOX_TOOLS.find((t) => t.name === name)).toBeDefined();
    }
  });

  it("pattern tools should have customParser", () => {
    const patternNames = ["profilestore_pattern", "bytenet_pattern",
      "replica_pattern", "react_roblox_pattern", "trove_pattern", "signal_pattern",
      "observers_pattern", "cmdr_pattern"];
    for (const tool of ROBLOX_TOOLS) {
      if (patternNames.includes(tool.name)) {
        expect(tool.customParser).toBeDefined();
      }
    }
  });

  it("all tools should be roblox category", () => {
    for (const tool of ROBLOX_TOOLS) {
      expect(tool.category).toBe("roblox");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// python.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("python.ts", () => {
  it("should export 8 Python tools", () => {
    expect(PYTHON_TOOLS.length).toBe(8);
  });

  it("should include pytest, ruff, mypy, pip, uv, venv", () => {
    const names = PYTHON_TOOLS.map((t) => t.name);
    expect(names).toContain("pytest_run");
    expect(names).toContain("ruff_lint");
    expect(names).toContain("mypy_check");
    expect(names).toContain("pip_install");
    expect(names).toContain("uv_sync");
    expect(names).toContain("python_venv");
  });

  it("at least one tool should have customParser", () => {
    const withParser = PYTHON_TOOLS.filter((t) => t.customParser);
    expect(withParser.length).toBeGreaterThan(0);
  });

  it("all tools should be python category", () => {
    for (const tool of PYTHON_TOOLS) {
      expect(tool.category).toBe("python");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// node.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("node.ts", () => {
  it("should export 11 Node tools", () => {
    expect(NODE_TOOLS.length).toBe(11);
  });

  it("should include npm, yarn, pnpm, eslint, prettier, tsc, node, npx", () => {
    const names = NODE_TOOLS.map((t) => t.name);
    expect(names).toContain("npm_install");
    expect(names).toContain("yarn_install");
    expect(names).toContain("pnpm_install");
    expect(names).toContain("eslint_lint");
    expect(names).toContain("prettier_format");
    expect(names).toContain("tsc_build");
    expect(names).toContain("node_run");
    expect(names).toContain("npx_run");
  });

  it("all tools should be node category", () => {
    for (const tool of NODE_TOOLS) {
      expect(tool.category).toBe("node");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// rust.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("rust.ts", () => {
  it("should export 8 Rust tools", () => {
    expect(RUST_TOOLS.length).toBe(8);
  });

  it("should include cargo_build, cargo_test, cargo_clippy, cargo_fmt", () => {
    const names = RUST_TOOLS.map((t) => t.name);
    expect(names).toContain("cargo_build");
    expect(names).toContain("cargo_test");
    expect(names).toContain("cargo_clippy");
    expect(names).toContain("cargo_fmt");
  });

  it("all tools should be rust category", () => {
    for (const tool of RUST_TOOLS) {
      expect(tool.category).toBe("rust");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// go.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("go.ts", () => {
  it("should export 9 Go tools", () => {
    expect(GO_TOOLS.length).toBe(9);
  });

  it("should include go_build, go_test, go_vet, go_fmt", () => {
    const names = GO_TOOLS.map((t) => t.name);
    expect(names).toContain("go_build");
    expect(names).toContain("go_test");
    expect(names).toContain("go_vet");
    expect(names).toContain("go_fmt");
  });

  it("all tools should be go category", () => {
    for (const tool of GO_TOOLS) {
      expect(tool.category).toBe("go");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// docker.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe("docker.ts", () => {
  it("should export 11 Docker tools", () => {
    expect(DOCKER_TOOLS.length).toBe(11);
  });

  it("should include docker_build, docker_run, docker_compose_up", () => {
    const names = DOCKER_TOOLS.map((t) => t.name);
    expect(names).toContain("docker_build");
    expect(names).toContain("docker_run");
    expect(names).toContain("docker_compose_up");
  });

  it("all tools should be docker category", () => {
    for (const tool of DOCKER_TOOLS) {
      expect(tool.category).toBe("docker");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-module consistency
// ═══════════════════════════════════════════════════════════════════════════════

describe("cross-module tool consistency", () => {
  it("index.ts aggregates all category arrays", () => {
    const expected = ROBLOX_TOOLS.length + PYTHON_TOOLS.length + NODE_TOOLS.length +
      RUST_TOOLS.length + GO_TOOLS.length + DOCKER_TOOLS.length;
    // ALL_TOOLS may include tools from other sources; verify it's at least as large
    expect(ALL_TOOLS.length).toBeGreaterThanOrEqual(expected);
  });

  it("no duplicate tool names across all modules", () => {
    const allNames = [
      ...ROBLOX_TOOLS, ...PYTHON_TOOLS, ...NODE_TOOLS,
      ...RUST_TOOLS, ...GO_TOOLS, ...DOCKER_TOOLS,
    ].map((t) => t.name);
    expect(new Set(allNames).size).toBe(allNames.length);
  });

  it("every tool has at least one whenToUse context", () => {
    const allTools = [...ROBLOX_TOOLS, ...PYTHON_TOOLS, ...NODE_TOOLS,
      ...RUST_TOOLS, ...GO_TOOLS, ...DOCKER_TOOLS];
    for (const tool of allTools) {
      expect(tool.context).toBeDefined();
      expect(tool.context!.whenToUse.length).toBeGreaterThan(0);
    }
  });
});
