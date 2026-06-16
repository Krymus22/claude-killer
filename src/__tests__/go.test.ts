import { describe, it, expect, vi, beforeEach } from "vitest";
import { GO_TOOLS } from "../tools/go.js";

vi.mock("../externalTools.js", () => ({}));
vi.mock("../logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../tools/index.js", () => ({}));
vi.mock("../guardrail.js", () => ({ checkGuardrails: vi.fn() }));
vi.mock("../diffPreview.js", () => ({ generateDiffPreview: vi.fn() }));
vi.mock("../hooks.js", () => ({ executeHooks: vi.fn() }));
vi.mock("child_process", () => ({ execSync: vi.fn() }));
vi.mock("./fileEdit.js", () => ({}));

describe("GO_TOOLS", () => {
  it("should be an array", () => {
    expect(Array.isArray(GO_TOOLS)).toBe(true);
  });

  it("should have 9 tools", () => {
    expect(GO_TOOLS).toHaveLength(9);
  });

  it("should have unique tool names", () => {
    const names = GO_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all tools should have category 'go'", () => {
    GO_TOOLS.forEach((t) => expect(t.category).toBe("go"));
  });

  it("all tools should have detection with method 'binary'", () => {
    GO_TOOLS.forEach((t) => expect(t.detection.method).toBe("binary"));
  });

  it("all tools should have context with whenToUse array", () => {
    GO_TOOLS.forEach((t) => {
      expect(Array.isArray(t.context.whenToUse)).toBe(true);
      expect(t.context.whenToUse.length).toBeGreaterThan(0);
    });
  });

  it("go_build tool should have correct args", () => {
    const t = GO_TOOLS.find((t) => t.name === "go_build")!;
    expect(t.args).toEqual(["build"]);
    expect(t.command).toBe("go");
  });

  it("go_run tool should have required package flag", () => {
    const t = GO_TOOLS.find((t) => t.name === "go_run")!;
    const pkg = t.flags.find((f) => f.name === "package")!;
    expect(pkg.required).toBe(true);
  });

  it("go_test tool should have multiple flags", () => {
    const t = GO_TOOLS.find((t) => t.name === "go_test")!;
    expect(t.flags.length).toBeGreaterThanOrEqual(4);
  });

  it("go_mod_download should have args ['mod', 'download']", () => {
    const t = GO_TOOLS.find((t) => t.name === "go_mod_download")!;
    expect(t.args).toEqual(["mod", "download"]);
  });

  it("go_mod_tidy should have args ['mod', 'tidy']", () => {
    const t = GO_TOOLS.find((t) => t.name === "go_mod_tidy")!;
    expect(t.args).toEqual(["mod", "tidy"]);
  });

  it("go_get should have required package flag and -u flag", () => {
    const t = GO_TOOLS.find((t) => t.name === "go_get")!;
    expect(t.flags.find((f) => f.name === "package")!.required).toBe(true);
    expect(t.flags.find((f) => f.name === "-u")!.type).toBe("boolean");
  });

  it("golangci_lint should use command 'golangci-lint'", () => {
    const t = GO_TOOLS.find((t) => t.name === "golangci_lint")!;
    expect(t.command).toBe("golangci-lint");
  });

  it("golangci_lint should have --fix and --config flags", () => {
    const t = GO_TOOLS.find((t) => t.name === "golangci_lint")!;
    expect(t.flags.find((f) => f.name === "--fix")).toBeDefined();
    expect(t.flags.find((f) => f.name === "--config")).toBeDefined();
  });

  describe("go_build customParser", () => {
    const t = GO_TOOLS.find((t) => t.name === "go_build")!;
    const parser = t.customParser as (output: string) => any;

    it("should return success true when no errors", () => {
      const result = parser("build successful");
      expect(result.success).toBe(true);
      expect(result.metadata.errorCount).toBe(0);
    });

    it("should return success false when errors present", () => {
      const result = parser("main.go:5: error: undefined variable");
      expect(result.success).toBe(false);
      expect(result.metadata.errorCount).toBe(1);
    });

    it("should count multiple error lines", () => {
      const result = parser("line1: error: x\nline2: error: y\nok line\nline3: error: z");
      expect(result.metadata.errorCount).toBe(3);
    });

    it("should handle empty output", () => {
      const result = parser("");
      expect(result.success).toBe(true);
      expect(result.metadata.errorCount).toBe(0);
    });
  });

  describe("go_test customParser", () => {
    const t = GO_TOOLS.find((t) => t.name === "go_test")!;
    const parser = t.customParser as (output: string) => any;

    it("should return success true when no failures", () => {
      const result = parser("3 passed, 0 failed");
      expect(result.success).toBe(true);
      expect(result.metadata.passed).toBe(3);
      expect(result.metadata.failed).toBe(0);
    });

    it("should return success false when failures present", () => {
      const result = parser("5 passed, 2 failed");
      expect(result.success).toBe(false);
      expect(result.metadata.passed).toBe(5);
      expect(result.metadata.failed).toBe(2);
    });

    it("should handle no passed count", () => {
      const result = parser("0 failed");
      expect(result.metadata.passed).toBe(0);
      expect(result.metadata.failed).toBe(0);
    });

    it("should handle empty output", () => {
      const result = parser("");
      expect(result.success).toBe(true);
      expect(result.metadata.passed).toBe(0);
      expect(result.metadata.failed).toBe(0);
    });

    it("should handle output with no numbers", () => {
      const result = parser("ok");
      expect(result.success).toBe(true);
      expect(result.metadata.passed).toBe(0);
      expect(result.metadata.failed).toBe(0);
    });
  });

  describe("go_vet customParser", () => {
    const t = GO_TOOLS.find((t) => t.name === "go_vet")!;
    const parser = t.customParser as (output: string) => any;

    it("should return success true when empty output", () => {
      const result = parser("");
      expect(result.success).toBe(true);
      expect(result.metadata.issues).toBe(0);
    });

    it("should return success false when issues present", () => {
      const result = parser("main.go:10: x is unused\nmain.go:20: y is shadowed");
      expect(result.success).toBe(false);
      expect(result.metadata.issues).toBe(2);
    });

    it("should filter blank lines from issue count", () => {
      const result = parser("issue1\n\nissue2\n\n");
      expect(result.metadata.issues).toBe(2);
    });
  });

  describe("golangci_lint customParser", () => {
    const t = GO_TOOLS.find((t) => t.name === "golangci_lint")!;
    const parser = t.customParser as (output: string) => any;

    it("should return success true when no colon lines", () => {
      const result = parser("no issues");
      expect(result.success).toBe(true);
      expect(result.metadata.issueCount).toBe(0);
    });

    it("should return success false when colon lines present", () => {
      const result = parser("file.go:10:5: error\nfile.go:20:3: warning");
      expect(result.success).toBe(false);
      expect(result.metadata.issueCount).toBe(2);
    });

    it("should handle empty output", () => {
      const result = parser("");
      expect(result.success).toBe(true);
      expect(result.metadata.issueCount).toBe(0);
    });
  });

  it("go_fmt should have raw outputParser", () => {
    const t = GO_TOOLS.find((t) => t.name === "go_fmt")!;
    expect(t.outputParser).toBe("raw");
  });

  it("go_mod_download should have raw outputParser", () => {
    const t = GO_TOOLS.find((t) => t.name === "go_mod_download")!;
    expect(t.outputParser).toBe("raw");
  });

  it("go_mod_tidy should have raw outputParser", () => {
    const t = GO_TOOLS.find((t) => t.name === "go_mod_tidy")!;
    expect(t.outputParser).toBe("raw");
  });

  it("go_run should have raw outputParser", () => {
    const t = GO_TOOLS.find((t) => t.name === "go_run")!;
    expect(t.outputParser).toBe("raw");
  });
});
