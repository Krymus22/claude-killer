import { describe, it, expect, vi } from "vitest";
import { RUST_TOOLS } from "../tools/rust.js";

vi.mock("../externalTools.js", () => ({}));
vi.mock("../logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../tools/index.js", () => ({}));
vi.mock("../guardrail.js", () => ({ checkGuardrails: vi.fn() }));
vi.mock("../diffPreview.js", () => ({ generateDiffPreview: vi.fn() }));
vi.mock("../hooks.js", () => ({ executeHooks: vi.fn() }));
vi.mock("child_process", () => ({ execSync: vi.fn() }));
vi.mock("./fileEdit.js", () => ({}));

describe("RUST_TOOLS", () => {
  it("should be an array", () => {
    expect(Array.isArray(RUST_TOOLS)).toBe(true);
  });

  it("should have 8 tools", () => {
    expect(RUST_TOOLS).toHaveLength(8);
  });

  it("should have unique tool names", () => {
    const names = RUST_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all tools should have category 'rust'", () => {
    RUST_TOOLS.forEach((t) => expect(t.category).toBe("rust"));
  });

  it("all tools should have detection.method 'binary'", () => {
    RUST_TOOLS.forEach((t) => expect(t.detection.method).toBe("binary"));
  });

  it("all tools should have context.whenToUse non-empty", () => {
    RUST_TOOLS.forEach((t) => {
      expect(Array.isArray(t.context.whenToUse)).toBe(true);
      expect(t.context.whenToUse.length).toBeGreaterThan(0);
    });
  });

  it("all tools requiring project should require Cargo.toml", () => {
    RUST_TOOLS.filter((t) => t.context.requiresProject).forEach((t) => {
      expect(t.context.requiresProject).toContain("Cargo.toml");
    });
  });

  describe("cargo_build", () => {
    const t = RUST_TOOLS.find((t) => t.name === "cargo_build")!;
    it("should have command 'cargo'", () => expect(t.command).toBe("cargo"));
    it("should have args ['build']", () => expect(t.args).toEqual(["build"]));
    it("should have --release flag", () =>
      expect(t.flags.find((f) => f.name === "--release")).toBeDefined());
    it("should have --target flag", () =>
      expect(t.flags.find((f) => f.name === "--target")).toBeDefined());
    it("should have --workspace flag", () =>
      expect(t.flags.find((f) => f.name === "--workspace")).toBeDefined());

    it("should have customParser", () => expect(typeof t.customParser).toBe("function"));

    it("should return success true when no errors", () => {
      const result = t.customParser!("Compiling myproject\nFinished release");
      expect(result.success).toBe(true);
      expect(result.metadata.errorCount).toBe(0);
    });

    it("should return success false when errors present", () => {
      const result = t.customParser!("error[E0597]: `x` does not live long enough");
      expect(result.success).toBe(false);
      expect(result.metadata.errorCount).toBe(1);
    });

    it("should handle empty output", () => {
      const result = t.customParser!("");
      expect(result.success).toBe(true);
      expect(result.metadata.errorCount).toBe(0);
    });
  });

  describe("cargo_run", () => {
    const t = RUST_TOOLS.find((t) => t.name === "cargo_run")!;
    it("should have command 'cargo'", () => expect(t.command).toBe("cargo"));
    it("should have args ['run']", () => expect(t.args).toEqual(["run"]));
    it("should have --release flag", () =>
      expect(t.flags.find((f) => f.name === "--release")).toBeDefined());
    it("should have --args flag", () =>
      expect(t.flags.find((f) => f.name === "--args")).toBeDefined());
    it("should have raw outputParser", () => expect(t.outputParser).toBe("raw"));
  });

  describe("cargo_test", () => {
    const t = RUST_TOOLS.find((t) => t.name === "cargo_test")!;
    it("should have command 'cargo'", () => expect(t.command).toBe("cargo"));
    it("should have args ['test']", () => expect(t.args).toEqual(["test"]));
    it("should have --lib flag", () =>
      expect(t.flags.find((f) => f.name === "--lib")).toBeDefined());
    it("should have --test flag", () =>
      expect(t.flags.find((f) => f.name === "--test")).toBeDefined());

    it("should parse passed count", () => {
      const result = t.customParser!("test result: 3 passed, 0 failed");
      expect(result.success).toBe(true);
      expect(result.metadata.passed).toBe(3);
      expect(result.metadata.failed).toBe(0);
    });

    it("should parse failed count", () => {
      const result = t.customParser!("test result: 5 passed, 2 failed");
      expect(result.success).toBe(false);
      expect(result.metadata.passed).toBe(5);
      expect(result.metadata.failed).toBe(2);
    });

    it("should handle empty output", () => {
      const result = t.customParser!("");
      expect(result.success).toBe(true);
      expect(result.metadata.passed).toBe(0);
      expect(result.metadata.failed).toBe(0);
    });
  });

  describe("cargo_clippy", () => {
    const t = RUST_TOOLS.find((t) => t.name === "cargo_clippy")!;
    it("should have command 'cargo'", () => expect(t.command).toBe("cargo"));
    it("should have args ['clippy']", () => expect(t.args).toEqual(["clippy"]));
    it("should have --all-targets flag", () =>
      expect(t.flags.find((f) => f.name === "--all-targets")).toBeDefined());
    it("should have --fix flag", () =>
      expect(t.flags.find((f) => f.name === "--fix")).toBeDefined());

    it("should return success true when no errors", () => {
      const result = t.customParser!("Finished clippy");
      expect(result.success).toBe(true);
      expect(result.metadata.warnings).toBe(0);
      expect(result.metadata.errors).toBe(0);
    });

    it("should count warnings and errors", () => {
      const result = t.customParser!("warning: unused import\nerror: unused variable");
      expect(result.success).toBe(false);
      expect(result.metadata.warnings).toBe(1);
      expect(result.metadata.errors).toBe(1);
    });

    it("should handle empty output", () => {
      const result = t.customParser!("");
      expect(result.success).toBe(true);
    });
  });

  describe("cargo_fmt", () => {
    const t = RUST_TOOLS.find((t) => t.name === "cargo_fmt")!;
    it("should have command 'cargo'", () => expect(t.command).toBe("cargo"));
    it("should have args ['fmt']", () => expect(t.args).toEqual(["fmt"]));
    it("should have --check flag", () =>
      expect(t.flags.find((f) => f.name === "--check")).toBeDefined());
    it("should have --all flag", () =>
      expect(t.flags.find((f) => f.name === "--all")).toBeDefined());
    it("should have raw outputParser", () => expect(t.outputParser).toBe("raw"));
  });

  describe("cargo_add", () => {
    const t = RUST_TOOLS.find((t) => t.name === "cargo_add")!;
    it("should have command 'cargo'", () => expect(t.command).toBe("cargo"));
    it("should have args ['add']", () => expect(t.args).toEqual(["add"]));
    it("should have required package flag", () =>
      expect(t.flags.find((f) => f.name === "package")!.required).toBe(true));
    it("should have --dev flag", () =>
      expect(t.flags.find((f) => f.name === "--dev")).toBeDefined());
    it("should have --features flag", () =>
      expect(t.flags.find((f) => f.name === "--features")).toBeDefined());
  });

  describe("cargo_doc", () => {
    const t = RUST_TOOLS.find((t) => t.name === "cargo_doc")!;
    it("should have command 'cargo'", () => expect(t.command).toBe("cargo"));
    it("should have args ['doc']", () => expect(t.args).toEqual(["doc"]));
    it("should have --open flag", () =>
      expect(t.flags.find((f) => f.name === "--open")).toBeDefined());
    it("should have --no-deps flag", () =>
      expect(t.flags.find((f) => f.name === "--no-deps")).toBeDefined());
    it("should have raw outputParser", () => expect(t.outputParser).toBe("raw"));
  });

  describe("rustup_update", () => {
    const t = RUST_TOOLS.find((t) => t.name === "rustup_update")!;
    it("should have command 'rustup'", () => expect(t.command).toBe("rustup"));
    it("should have args ['update']", () => expect(t.args).toEqual(["update"]));
    it("should have no flags", () => expect(t.flags).toHaveLength(0));
    it("should have raw outputParser", () => expect(t.outputParser).toBe("raw"));
  });
});
