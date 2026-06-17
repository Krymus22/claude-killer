import { describe, it, expect, vi } from "vitest";
import { NODE_TOOLS } from "../tools/node.js";

vi.mock("../externalTools.js", () => ({}));
vi.mock("../logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../tools/index.js", () => ({}));
vi.mock("../guardrail.js", () => ({ checkGuardrails: vi.fn() }));
vi.mock("../diffPreview.js", () => ({ generateDiffPreview: vi.fn() }));
vi.mock("../hooks.js", () => ({ executeHooks: vi.fn() }));
vi.mock("child_process", () => ({ execSync: vi.fn() }));
vi.mock("./fileEdit.js", () => ({}));

describe("NODE_TOOLS", () => {
  it("should be an array", () => {
    expect(Array.isArray(NODE_TOOLS)).toBe(true);
  });

  it("should have 11 tools", () => {
    expect(NODE_TOOLS).toHaveLength(11);
  });

  it("should have unique tool names", () => {
    const names = NODE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all tools should have category 'node'", () => {
    NODE_TOOLS.forEach((t) => expect(t.category).toBe("node"));
  });

  it("all tools should have description", () => {
    NODE_TOOLS.forEach((t) => {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
    });
  });

  it("all tools should have context.whenToUse", () => {
    NODE_TOOLS.forEach((t) => {
      expect(Array.isArray(t.context.whenToUse)).toBe(true);
      expect(t.context.whenToUse.length).toBeGreaterThan(0);
    });
  });

  describe("npm_install", () => {
    const t = NODE_TOOLS.find((t) => t.name === "npm_install")!;
    it("should have command 'npm'", () => expect(t.command).toBe("npm"));
    it("should have args ['install']", () => expect(t.args).toEqual(["install"]));
    it("should have --save-dev flag", () =>
      expect(t.flags.find((f) => f.name === "--save-dev")).toBeDefined());
    it("should have --global flag", () =>
      expect(t.flags.find((f) => f.name === "--global")).toBeDefined());
    it("should have --legacy-peer-deps flag", () =>
      expect(t.flags.find((f) => f.name === "--legacy-peer-deps")).toBeDefined());
    it("should require package.json", () =>
      expect(t.context.requiresProject).toContain("package.json"));
  });

  describe("npm_run", () => {
    const t = NODE_TOOLS.find((t) => t.name === "npm_run")!;
    it("should have required script flag", () =>
      expect(t.flags.find((f) => f.name === "script")!.required).toBe(true));
    it("should have raw outputParser", () => expect(t.outputParser).toBe("raw"));
  });

  describe("npm_update", () => {
    const t = NODE_TOOLS.find((t) => t.name === "npm_update")!;
    it("should have command 'npm'", () => expect(t.command).toBe("npm"));
    it("should have args ['update']", () => expect(t.args).toEqual(["update"]));
  });

  describe("yarn_install", () => {
    const t = NODE_TOOLS.find((t) => t.name === "yarn_install")!;
    it("should have command 'yarn'", () => expect(t.command).toBe("yarn"));
    it("should have args ['install']", () => expect(t.args).toEqual(["install"]));
  });

  describe("yarn_run", () => {
    const t = NODE_TOOLS.find((t) => t.name === "yarn_run")!;
    it("should have command 'yarn'", () => expect(t.command).toBe("yarn"));
    it("should have required script flag", () =>
      expect(t.flags.find((f) => f.name === "script")!.required).toBe(true));
  });

  describe("pnpm_install", () => {
    const t = NODE_TOOLS.find((t) => t.name === "pnpm_install")!;
    it("should have command 'pnpm'", () => expect(t.command).toBe("pnpm"));
    it("should have args ['install']", () => expect(t.args).toEqual(["install"]));
  });

  describe("eslint_lint", () => {
    const t = NODE_TOOLS.find((t) => t.name === "eslint_lint")!;
    it("should have command 'eslint'", () => expect(t.command).toBe("eslint"));

    it("should have customParser", () => expect(typeof t.customParser).toBe("function"));

    it("should parse errors and warnings", () => {
      const result = t.customParser!(
        "src/index.ts:1: error: unused var\nsrc/app.ts:2: warning: no use"
      );
      expect(result.success).toBe(false);
      expect(result.metadata.errors).toBe(1);
      expect(result.metadata.warnings).toBe(1);
    });

    it("should return success true with no errors", () => {
      const result = t.customParser!("no issues found");
      expect(result.success).toBe(true);
      expect(result.metadata.errors).toBe(0);
      expect(result.metadata.warnings).toBe(0);
    });

    it("should handle empty output", () => {
      const result = t.customParser!("");
      expect(result.success).toBe(true);
      expect(result.metadata.errors).toBe(0);
      expect(result.metadata.warnings).toBe(0);
    });
  });

  describe("prettier_format", () => {
    const t = NODE_TOOLS.find((t) => t.name === "prettier_format")!;
    it("should have command 'prettier'", () => expect(t.command).toBe("prettier"));
    it("should have args ['--write']", () => expect(t.args).toEqual(["--write"]));
    it("should have --check flag", () =>
      expect(t.flags.find((f) => f.name === "--check")).toBeDefined());
    it("should have --list-different flag", () =>
      expect(t.flags.find((f) => f.name === "--list-different")).toBeDefined());
  });

  describe("tsc_build", () => {
    const t = NODE_TOOLS.find((t) => t.name === "tsc_build")!;
    it("should have command 'tsc'", () => expect(t.command).toBe("tsc"));
    it("should require tsconfig.json", () =>
      expect(t.context.requiresProject).toContain("tsconfig.json"));

    it("should have customParser", () => expect(typeof t.customParser).toBe("function"));

    it("should parse TS errors", () => {
      const result = t.customParser!("error TS2322: Type mismatch");
      expect(result.success).toBe(false);
      expect(result.metadata.errorCount).toBe(1);
    });

    it("should return success true with no errors", () => {
      const result = t.customParser!("no issues");
      expect(result.success).toBe(true);
      expect(result.metadata.errorCount).toBe(0);
    });

    it("should handle empty output", () => {
      const result = t.customParser!("");
      expect(result.success).toBe(true);
      expect(result.metadata.errorCount).toBe(0);
    });
  });

  describe("node_run", () => {
    const t = NODE_TOOLS.find((t) => t.name === "node_run")!;
    it("should have command 'node'", () => expect(t.command).toBe("node"));
    it("should have required script flag", () =>
      expect(t.flags.find((f) => f.name === "script")!.required).toBe(true));
    it("should have --inspect flag", () =>
      expect(t.flags.find((f) => f.name === "--inspect")).toBeDefined());
    it("should not require any project file", () =>
      expect(t.context.requiresProject).toBeUndefined());
  });

  describe("npx_run", () => {
    const t = NODE_TOOLS.find((t) => t.name === "npx_run")!;
    it("should have command 'npx'", () => expect(t.command).toBe("npx"));
    it("should have required command flag", () =>
      expect(t.flags.find((f) => f.name === "command")!.required).toBe(true));
    it("should have --yes flag", () =>
      expect(t.flags.find((f) => f.name === "--yes")).toBeDefined());
  });
});
