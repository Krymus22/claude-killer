import { describe, it, expect, vi } from "vitest";
import { PYTHON_TOOLS } from "../tools/python.js";

vi.mock("../externalTools.js", () => ({}));
vi.mock("../logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../tools/index.js", () => ({}));
vi.mock("../guardrail.js", () => ({ checkGuardrails: vi.fn() }));
vi.mock("../diffPreview.js", () => ({ generateDiffPreview: vi.fn() }));
vi.mock("../hooks.js", () => ({ executeHooks: vi.fn() }));
vi.mock("child_process", () => ({ execSync: vi.fn() }));
vi.mock("./fileEdit.js", () => ({}));

describe("PYTHON_TOOLS", () => {
  it("should be an array", () => {
    expect(Array.isArray(PYTHON_TOOLS)).toBe(true);
  });

  it("should have 8 tools", () => {
    expect(PYTHON_TOOLS).toHaveLength(8);
  });

  it("should have unique tool names", () => {
    const names = PYTHON_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all tools should have category 'python'", () => {
    PYTHON_TOOLS.forEach((t) => expect(t.category).toBe("python"));
  });

  it("all tools should have detection.method 'binary'", () => {
    PYTHON_TOOLS.forEach((t) => expect(t.detection.method).toBe("binary"));
  });

  it("all tools should have context.whenToUse non-empty", () => {
    PYTHON_TOOLS.forEach((t) => {
      expect(Array.isArray(t.context.whenToUse)).toBe(true);
      expect(t.context.whenToUse.length).toBeGreaterThan(0);
    });
  });

  describe("pytest_run", () => {
    const t = PYTHON_TOOLS.find((t) => t.name === "pytest_run")!;
    it("should have command 'pytest'", () => expect(t.command).toBe("pytest"));
    it("should have many flags", () => expect(t.flags.length).toBeGreaterThanOrEqual(6));
    it("should require pyproject.toml", () =>
      expect(t.context.requiresProject).toContain("pyproject.toml"));

    it("should have customParser", () => expect(typeof t.customParser).toBe("function"));

    it("should parse passed count", () => {
      const result = t.customParser!("collected 5 items\n===== 5 passed in 1.23s =====\n");
      expect(result.success).toBe(true);
      expect(result.metadata.passed).toBe(5);
      expect(result.metadata.failed).toBe(0);
    });

    it("should parse failed count", () => {
      const result = t.customParser!("collected 5 items\n===== 3 passed, 2 failed in 1.23s =====\n");
      expect(result.success).toBe(false);
      expect(result.metadata.failed).toBe(2);
    });

    it("should parse error count", () => {
      const result = t.customParser!("collected 1 item\n===== 1 error in 0.10s =====\n");
      expect(result.success).toBe(false);
      expect(result.metadata.errors).toBe(1);
    });

    it("should handle empty output", () => {
      const result = t.customParser!("");
      expect(result.success).toBe(true);
      expect(result.metadata.passed).toBe(0);
    });

    it("should handle output with no summary line", () => {
      const result = t.customParser!("collected 10 items\n\n");
      expect(result.success).toBe(true);
    });
  });

  describe("ruff_lint", () => {
    const t = PYTHON_TOOLS.find((t) => t.name === "ruff_lint")!;
    it("should have command 'ruff'", () => expect(t.command).toBe("ruff"));
    it("should have args ['check']", () => expect(t.args).toEqual(["check"]));
    it("should have --fix flag", () =>
      expect(t.flags.find((f) => f.name === "--fix")).toBeDefined());

    it("should parse issues from ruff output", () => {
      const result = t.customParser!("src/main.py:10:5: F841 unused variable 'x'");
      expect(result.success).toBe(false);
      expect(result.metadata.count).toBe(1);
      expect(result.metadata.issues[0].file).toBe("src/main.py");
      expect(result.metadata.issues[0].line).toBe(10);
      expect(result.metadata.issues[0].column).toBe(5);
      expect(result.metadata.issues[0].code).toBe("F841");
      expect(result.metadata.issues[0].message).toBe("unused variable 'x'");
    });

    it("should parse multiple issues", () => {
      const result = t.customParser!(
        "src/a.py:1:1: E302 expected 2 blank lines\nsrc/b.py:5:1: W291 trailing whitespace"
      );
      expect(result.success).toBe(false);
      expect(result.metadata.count).toBe(2);
    });

    it("should return success true with no issues", () => {
      const result = t.customParser!("All checks passed!");
      expect(result.success).toBe(true);
      expect(result.metadata.count).toBe(0);
    });

    it("should handle empty output", () => {
      const result = t.customParser!("");
      expect(result.success).toBe(true);
      expect(result.metadata.issues).toEqual([]);
    });
  });

  describe("ruff_format", () => {
    const t = PYTHON_TOOLS.find((t) => t.name === "ruff_format")!;
    it("should have command 'ruff'", () => expect(t.command).toBe("ruff"));
    it("should have args ['format']", () => expect(t.args).toEqual(["format"]));
    it("should have --check flag", () =>
      expect(t.flags.find((f) => f.name === "--check")).toBeDefined());
    it("should have --diff flag", () =>
      expect(t.flags.find((f) => f.name === "--diff")).toBeDefined());
    it("should have raw outputParser", () => expect(t.outputParser).toBe("raw"));
  });

  describe("mypy_check", () => {
    const t = PYTHON_TOOLS.find((t) => t.name === "mypy_check")!;
    it("should have command 'mypy'", () => expect(t.command).toBe("mypy"));
    it("should have --strict flag", () =>
      expect(t.flags.find((f) => f.name === "--strict")).toBeDefined());
    it("should have --ignore-missing-imports flag", () =>
      expect(t.flags.find((f) => f.name === "--ignore-missing-imports")).toBeDefined());

    it("should parse error lines", () => {
      const result = t.customParser!("src/app.py:10: error: Incompatible types");
      expect(result.success).toBe(false);
      expect(result.metadata.errorCount).toBe(1);
    });

    it("should return success true when no errors", () => {
      const result = t.customParser!("Success: no issues found");
      expect(result.success).toBe(true);
      expect(result.metadata.errorCount).toBe(0);
    });

    it("should handle empty output", () => {
      const result = t.customParser!("");
      expect(result.success).toBe(true);
    });
  });

  describe("pip_install", () => {
    const t = PYTHON_TOOLS.find((t) => t.name === "pip_install")!;
    it("should have command 'pip'", () => expect(t.command).toBe("pip"));
    it("should have required package flag", () =>
      expect(t.flags.find((f) => f.name === "package")!.required).toBe(true));
    it("should have --upgrade flag", () =>
      expect(t.flags.find((f) => f.name === "--upgrade")).toBeDefined());
    it("should have --user flag", () =>
      expect(t.flags.find((f) => f.name === "--user")).toBeDefined());
  });

  describe("uv_install", () => {
    const t = PYTHON_TOOLS.find((t) => t.name === "uv_install")!;
    it("should have command 'uv'", () => expect(t.command).toBe("uv"));
    it("should have args ['pip', 'install']", () =>
      expect(t.args).toEqual(["pip", "install"]));
    it("should have required package flag", () =>
      expect(t.flags.find((f) => f.name === "package")!.required).toBe(true));
  });

  describe("uv_sync", () => {
    const t = PYTHON_TOOLS.find((t) => t.name === "uv_sync")!;
    it("should have command 'uv'", () => expect(t.command).toBe("uv"));
    it("should have args ['sync']", () => expect(t.args).toEqual(["sync"]));
    it("should have no flags", () => expect(t.flags).toHaveLength(0));
    it("should require pyproject.toml", () =>
      expect(t.context.requiresProject).toContain("pyproject.toml"));
  });

  describe("python_venv", () => {
    const t = PYTHON_TOOLS.find((t) => t.name === "python_venv")!;
    it("should have command 'python'", () => expect(t.command).toBe("python"));
    it("should have args ['-m', 'venv']", () => expect(t.args).toEqual(["-m", "venv"]));
    it("should have raw outputParser", () => expect(t.outputParser).toBe("raw"));
  });
});
