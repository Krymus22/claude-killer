import { describe, it, expect, vi } from "vitest";
import { ROBLOX_TOOLS } from "../tools/roblox.js";

vi.mock("../externalTools.js", () => ({}));
vi.mock("../logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../tools/index.js", () => ({}));
vi.mock("../guardrail.js", () => ({ checkGuardrails: vi.fn() }));
vi.mock("../diffPreview.js", () => ({ generateDiffPreview: vi.fn() }));
vi.mock("../hooks.js", () => ({ executeHooks: vi.fn() }));
vi.mock("child_process", () => ({ execSync: vi.fn() }));
vi.mock("./fileEdit.js", () => ({}));

describe("ROBLOX_TOOLS", () => {
  it("should be an array", () => {
    expect(Array.isArray(ROBLOX_TOOLS)).toBe(true);
  });

  it("should have 19 tools", () => {
    expect(ROBLOX_TOOLS).toHaveLength(19);
  });

  it("should have unique tool names", () => {
    const names = ROBLOX_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all tools should have category 'roblox'", () => {
    ROBLOX_TOOLS.forEach((t) => expect(t.category).toBe("roblox"));
  });

  it("all tools should have context.whenToUse non-empty", () => {
    ROBLOX_TOOLS.forEach((t) => {
      expect(Array.isArray(t.context.whenToUse)).toBe(true);
      expect(t.context.whenToUse.length).toBeGreaterThan(0);
    });
  });

  it("all tools should have description", () => {
    ROBLOX_TOOLS.forEach((t) => {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
    });
  });

  describe("rojo_build", () => {
    const t = ROBLOX_TOOLS.find((t) => t.name === "rojo_build")!;
    it("should have command 'rojo'", () => expect(t.command).toBe("rojo"));
    it("should have args ['build']", () => expect(t.args).toEqual(["build"]));
    it("should have --output flag", () =>
      expect(t.flags.find((f) => f.name === "--output")).toBeDefined());
    it("should require .project.json", () =>
      expect(t.context.requiresProject).toContain(".project.json"));
    it("should have detection method 'binary'", () =>
      expect(t.detection.method).toBe("binary"));
  });

  describe("rojo_serve", () => {
    const t = ROBLOX_TOOLS.find((t) => t.name === "rojo_serve")!;
    it("should have command 'rojo'", () => expect(t.command).toBe("rojo"));
    it("should have args ['serve']", () => expect(t.args).toEqual(["serve"]));
    it("should have --port flag", () =>
      expect(t.flags.find((f) => f.name === "--port")).toBeDefined());
  });

  describe("rojo_sourcemap", () => {
    const t = ROBLOX_TOOLS.find((t) => t.name === "rojo_sourcemap")!;
    it("should have command 'rojo'", () => expect(t.command).toBe("rojo"));
    it("should have args ['sourcemap']", () => expect(t.args).toEqual(["sourcemap"]));
    it("should have --watch flag", () =>
      expect(t.flags.find((f) => f.name === "--watch")).toBeDefined());
  });

  describe("wally_install", () => {
    const t = ROBLOX_TOOLS.find((t) => t.name === "wally_install")!;
    it("should have command 'wally'", () => expect(t.command).toBe("wally"));
    it("should have args ['install']", () => expect(t.args).toEqual(["install"]));
    it("should have detection method 'config'", () =>
      expect(t.detection.method).toBe("config"));
    it("should check for wally.toml", () => expect(t.detection.check).toBe("wally.toml"));
    it("should have no flags", () => expect(t.flags).toHaveLength(0));
    it("should have structured outputParser", () =>
      expect(t.outputParser).toBe("structured"));
  });

  describe("wally_search", () => {
    const t = ROBLOX_TOOLS.find((t) => t.name === "wally_search")!;
    it("should have command 'wally'", () => expect(t.command).toBe("wally"));
    it("should have required query flag", () =>
      expect(t.flags.find((f) => f.name === "query")!.required).toBe(true));
  });

  describe("wally_publish", () => {
    const t = ROBLOX_TOOLS.find((t) => t.name === "wally_publish")!;
    it("should have command 'wally'", () => expect(t.command).toBe("wally"));
    it("should have args ['publish']", () => expect(t.args).toEqual(["publish"]));
    it("should require wally.toml", () =>
      expect(t.context.requiresProject).toContain("wally.toml"));
  });

  describe("lune_run", () => {
    const t = ROBLOX_TOOLS.find((t) => t.name === "lune_run")!;
    it("should have command 'lune'", () => expect(t.command).toBe("lune"));
    it("should have args ['run']", () => expect(t.args).toEqual(["run"]));
    it("should have required script flag", () =>
      expect(t.flags.find((f) => f.name === "script")!.required).toBe(true));
  });

  describe("selene_lint", () => {
    const t = ROBLOX_TOOLS.find((t) => t.name === "selene_lint")!;
    it("should have command 'selene'", () => expect(t.command).toBe("selene"));
    it("should have args ['--color', 'never']", () =>
      expect(t.args).toEqual(["--color", "never"]));

    it("should have customParser", () => expect(typeof t.customParser).toBe("function"));

    it("should parse error severity issues", () => {
      const result = t.customParser!(
        "src/main.luau:10:5: error: undefined global 'Foo'"
      );
      expect(result.success).toBe(false);
      expect(result.metadata.errorCount).toBe(1);
      expect(result.metadata.issues[0].severity).toBe("error");
      expect(result.metadata.issues[0].file).toBe("src/main.luau");
      expect(result.metadata.issues[0].line).toBe(10);
      expect(result.metadata.issues[0].column).toBe(5);
      expect(result.metadata.issues[0].message).toBe("undefined global 'Foo'");
    });

    it("should parse warning severity issues", () => {
      const result = t.customParser!(
        "src/util.luau:5:1: warning: unused variable"
      );
      expect(result.success).toBe(true);
      expect(result.metadata.errorCount).toBe(0);
      expect(result.metadata.issues[0].severity).toBe("warning");
    });

    it("should parse info severity issues", () => {
      const result = t.customParser!(
        "src/app.luau:1:1: info: this is a note"
      );
      expect(result.success).toBe(true);
      expect(result.metadata.issues[0].severity).toBe("info");
    });

    it("should return success true with no issues", () => {
      const result = t.customParser!("No warnings found");
      expect(result.success).toBe(true);
      expect(result.metadata.errorCount).toBe(0);
      expect(result.metadata.issues).toEqual([]);
    });

    it("should handle empty output", () => {
      const result = t.customParser!("");
      expect(result.success).toBe(true);
    });
  });

  describe("rokit_install", () => {
    const t = ROBLOX_TOOLS.find((t) => t.name === "rokit_install")!;
    it("should have command 'rokit'", () => expect(t.command).toBe("rokit"));
    it("should have args ['install']", () => expect(t.args).toEqual(["install"]));
    it("should have detection method 'config'", () =>
      expect(t.detection.method).toBe("config"));
    it("should check for rokit.toml", () => expect(t.detection.check).toBe("rokit.toml"));
    it("should require rokit.toml", () =>
      expect(t.context.requiresProject).toContain("rokit.toml"));
  });

  describe("rokit_add", () => {
    const t = ROBLOX_TOOLS.find((t) => t.name === "rokit_add")!;
    it("should have command 'rokit'", () => expect(t.command).toBe("rokit"));
    it("should have args ['add']", () => expect(t.args).toEqual(["add"]));
    it("should have required tool flag", () =>
      expect(t.flags.find((f) => f.name === "tool")!.required).toBe(true));
  });

  describe("generate_types", () => {
    const t = ROBLOX_TOOLS.find((t) => t.name === "generate_types")!;
    it("should have command 'wally-package-types'", () =>
      expect(t.command).toBe("wally-package-types"));
    it("should have required -s flag", () =>
      expect(t.flags.find((f) => f.name === "-s")!.required).toBe(true));
    it("should have required path flag", () =>
      expect(t.flags.find((f) => f.name === "path")!.required).toBe(true));
  });

  describe("pseudo-tools (code patterns)", () => {
    const pseudoNames = [
      "profilestore_pattern",
      "bytenet_pattern",
      "replica_pattern",
      "react_roblox_pattern",
      "trove_pattern",
      "signal_pattern",
      "observers_pattern",
      "cmdr_pattern",
    ];

    pseudoNames.forEach((name) => {
      describe(name, () => {
        const t = ROBLOX_TOOLS.find((t) => t.name === name)!;

        it("should exist", () => expect(t).toBeDefined());
        it("should have command 'echo'", () => expect(t.command).toBe("echo"));
        it("should have detection method 'manual'", () =>
          expect(t.detection.method).toBe("manual"));
        it("should be installed", () => expect(t.detection.installed).toBe(true));
        it("should have outputParser 'custom'", () =>
          expect(t.outputParser).toBe("custom"));

        it("should have customParser function", () =>
          expect(typeof t.customParser).toBe("function"));

        it("should return success true", () => {
          const result = (t.customParser as () => any)();
          expect(result.success).toBe(true);
        });

        it("should return non-empty output string", () => {
          const result = (t.customParser as () => any)();
          expect(typeof result.output).toBe("string");
          expect(result.output.length).toBeGreaterThan(0);
        });

        it("should return metadata with library name", () => {
          const result = (t.customParser as () => any)();
          expect(result.metadata).toBeDefined();
          expect(typeof result.metadata.library).toBe("string");
        });

        it("should return metadata with category", () => {
          const result = (t.customParser as () => any)();
          expect(typeof result.metadata.category).toBe("string");
        });

        it("should return metadata with wallyPackage", () => {
          const result = (t.customParser as () => any)();
          expect(typeof result.metadata.wallyPackage).toBe("string");
        });
      });
    });
  });
});
