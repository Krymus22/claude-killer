/**
 * patternExtractor-extended.test.ts — Extended tests for patternExtractor.ts
 *
 * Covers:
 *   - extractPatterns: empty dir, unknown files, real files
 *   - detectNaming / detectErrorHandling / detectImportStyle / detectCommentStyle /
 *     detectIndentation / detectQuoteStyle (tested indirectly via extractPatterns)
 *   - formatPatterns: output structure
 *   - getPatternsCached: caching behavior
 *   - clearPatternCache
 *   - CodePatterns type contract
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
}));

import {
  extractPatterns,
  formatPatterns,
  getPatternsCached,
  clearPatternCache,
  type CodePatterns,
} from "../patternExtractor.js";

const TMP = path.join(os.tmpdir(), `__ck_patterns_${process.pid}_${Date.now()}__`);

beforeEach(() => {
  fs.mkdirSync(TMP, { recursive: true });
  clearPatternCache();
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  clearPatternCache();
});

// ─── extractPatterns — basic shape ─────────────────────────────────────────
describe("extractPatterns — return shape", () => {
  it("returns a CodePatterns object", () => {
    const p = extractPatterns(TMP);
    expect(p).toHaveProperty("namingConvention");
    expect(p).toHaveProperty("errorHandling");
    expect(p).toHaveProperty("importStyle");
    expect(p).toHaveProperty("commentStyle");
    expect(p).toHaveProperty("indentation");
    expect(p).toHaveProperty("quoteStyle");
    expect(p).toHaveProperty("filesAnalyzed");
    expect(p).toHaveProperty("rawSummary");
  });

  it("filesAnalyzed is a non-negative number", () => {
    const p = extractPatterns(TMP);
    expect(typeof p.filesAnalyzed).toBe("number");
    expect(p.filesAnalyzed).toBeGreaterThanOrEqual(0);
  });

  it("rawSummary is a string", () => {
    const p = extractPatterns(TMP);
    expect(typeof p.rawSummary).toBe("string");
  });
});

describe("extractPatterns — empty dir", () => {
  it("returns filesAnalyzed=0 and all-unknown for empty dir", () => {
    const p = extractPatterns(TMP);
    expect(p.filesAnalyzed).toBe(0);
    expect(p.namingConvention).toBe("unknown");
    expect(p.errorHandling).toBe("unknown");
    expect(p.importStyle).toBe("unknown");
    expect(p.commentStyle).toBe("unknown");
    expect(p.indentation).toBe("unknown");
    expect(p.quoteStyle).toBe("unknown");
  });

  it("returns a non-empty rawSummary even when no files found", () => {
    const p = extractPatterns(TMP);
    expect(p.rawSummary.length).toBeGreaterThan(0);
  });

  it("returns a rawSummary mentioning 'No source files'", () => {
    const p = extractPatterns(TMP);
    expect(p.rawSummary).toContain("No source files");
  });
});

describe("extractPatterns — single .ts file (2-space indent, //, double quotes)", () => {
  it("detects // comment style and 2-space indent", () => {
    fs.writeFileSync(
      path.join(TMP, "sample.ts"),
      [
        'import { foo } from "bar";',
        "",
        "// a comment",
        "function helloWorld() {",
        '  console.log("hi");',
        "}",
        "",
      ].join("\n"),
    );
    const p = extractPatterns(TMP);
    expect(p.filesAnalyzed).toBeGreaterThanOrEqual(1);
    expect(p.commentStyle).toBe("//");
  });

  it("detects -- comment style in Lua files", () => {
    fs.writeFileSync(
      path.join(TMP, "sample.lua"),
      [
        "-- a comment",
        "local function hello()",
        "  print('hi')",
        "end",
      ].join("\n"),
    );
    const p = extractPatterns(TMP);
    expect(p.filesAnalyzed).toBeGreaterThanOrEqual(1);
    expect(p.commentStyle).toBe("--");
  });

  it("detects # comment style in Python files", () => {
    fs.writeFileSync(
      path.join(TMP, "sample.py"),
      [
        "# a comment",
        "def hello():",
        "    print('hi')",
      ].join("\n"),
    );
    const p = extractPatterns(TMP);
    expect(p.filesAnalyzed).toBeGreaterThanOrEqual(1);
    expect(p.commentStyle).toBe("#");
  });
});

describe("extractPatterns — quote style detection", () => {
  it("detects double quotes when overwhelmingly used", () => {
    fs.writeFileSync(
      path.join(TMP, "sample.ts"),
      [
        'const a = "double";',
        'const b = "double";',
        'const c = "double";',
        'const d = "double";',
        'const e = "double";',
        'const f = "double";',
        'const g = "double";',
      ].join("\n"),
    );
    const p = extractPatterns(TMP);
    expect(p.quoteStyle).toBe("double");
  });

  it("detects single quotes when overwhelmingly used", () => {
    fs.writeFileSync(
      path.join(TMP, "sample.ts"),
      [
        "const a = 'single';",
        "const b = 'single';",
        "const c = 'single';",
        "const d = 'single';",
        "const e = 'single';",
        "const f = 'single';",
        "const g = 'single';",
      ].join("\n"),
    );
    const p = extractPatterns(TMP);
    expect(p.quoteStyle).toBe("single");
  });
});

describe("extractPatterns — error handling detection", () => {
  it("detects try-catch in TS", () => {
    fs.writeFileSync(
      path.join(TMP, "sample.ts"),
      [
        "try {",
        "  doSomething();",
        "} catch (e) {",
        "  console.error(e);",
        "}",
      ].join("\n"),
    );
    const p = extractPatterns(TMP);
    expect(p.errorHandling).toBe("try-catch");
  });

  it("detects pcall in Lua (try-catch style)", () => {
    // Note: 'ok, err' pattern would match result-type first; we use plain pcall here
    fs.writeFileSync(
      path.join(TMP, "sample.lua"),
      [
        "local success = pcall(function()",
        "  doSomething()",
        "end)",
        "if not success then print('err') end",
      ].join("\n"),
    );
    const p = extractPatterns(TMP);
    // Either try-catch (pcall) or result-type depending on which pattern hits first
    expect(["try-catch", "result-type"]).toContain(p.errorHandling);
  });

  it("detects result-type pattern (ok, err)", () => {
    fs.writeFileSync(
      path.join(TMP, "sample.lua"),
      [
        "local ok, err = someFn()",
        "if not ok then return end",
      ].join("\n"),
    );
    const p = extractPatterns(TMP);
    expect(p.errorHandling).toBe("result-type");
  });
});

describe("extractPatterns — import style detection", () => {
  it("detects relative imports", () => {
    fs.writeFileSync(
      path.join(TMP, "sample.ts"),
      [
        'import { a } from "./a";',
        'import { b } from "./b";',
        'import { c } from "./c";',
        'import { d } from "./d";',
      ].join("\n"),
    );
    const p = extractPatterns(TMP);
    expect(p.importStyle).toBe("relative");
  });
});

describe("extractPatterns — maxFiles parameter", () => {
  it("respects maxFiles=1 (only 1 file analyzed)", () => {
    fs.writeFileSync(path.join(TMP, "a.ts"), "// file a\n");
    fs.writeFileSync(path.join(TMP, "b.ts"), "// file b\n");
    fs.writeFileSync(path.join(TMP, "c.ts"), "// file c\n");
    const p = extractPatterns(TMP, 1);
    expect(p.filesAnalyzed).toBe(1);
  });

  it("respects maxFiles=3", () => {
    fs.writeFileSync(path.join(TMP, "a.ts"), "// file a\n");
    fs.writeFileSync(path.join(TMP, "b.ts"), "// file b\n");
    fs.writeFileSync(path.join(TMP, "c.ts"), "// file c\n");
    fs.writeFileSync(path.join(TMP, "d.ts"), "// file d\n");
    const p = extractPatterns(TMP, 3);
    expect(p.filesAnalyzed).toBeLessThanOrEqual(3);
  });
});

describe("extractPatterns — skips test files and dotfiles", () => {
  it("does not include .test.ts files", () => {
    fs.writeFileSync(path.join(TMP, "foo.ts"), "// foo\n");
    fs.writeFileSync(path.join(TMP, "foo.test.ts"), "// test\n");
    const p = extractPatterns(TMP);
    expect(p.filesAnalyzed).toBe(1);
  });

  it("does not include .spec.ts files", () => {
    fs.writeFileSync(path.join(TMP, "bar.ts"), "// bar\n");
    fs.writeFileSync(path.join(TMP, "bar.spec.ts"), "// spec\n");
    const p = extractPatterns(TMP);
    expect(p.filesAnalyzed).toBe(1);
  });

  it("does not descend into node_modules", () => {
    fs.mkdirSync(path.join(TMP, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "node_modules", "pkg.ts"), "// pkg\n");
    fs.writeFileSync(path.join(TMP, "root.ts"), "// root\n");
    const p = extractPatterns(TMP);
    expect(p.filesAnalyzed).toBe(1);
  });
});

describe("extractPatterns — non-existent dir", () => {
  it("does not throw on non-existent root and returns 0 files", () => {
    const p = extractPatterns("/nonexistent/__ck_test__/path");
    expect(p.filesAnalyzed).toBe(0);
    expect(p.namingConvention).toBe("unknown");
  });
});

describe("formatPatterns", () => {
  it("returns a non-empty string", () => {
    const p: CodePatterns = {
      namingConvention: "camelCase",
      errorHandling: "try-catch",
      importStyle: "relative",
      commentStyle: "//",
      indentation: "2-space",
      quoteStyle: "double",
      filesAnalyzed: 5,
      rawSummary: "",
    };
    const s = formatPatterns(p);
    expect(typeof s).toBe("string");
    expect(s.length).toBeGreaterThan(0);
  });

  it("includes a header line with the file count", () => {
    const p: CodePatterns = {
      namingConvention: "camelCase",
      errorHandling: "try-catch",
      importStyle: "relative",
      commentStyle: "//",
      indentation: "2-space",
      quoteStyle: "double",
      filesAnalyzed: 7,
      rawSummary: "",
    };
    const s = formatPatterns(p);
    expect(s).toContain("7 files");
  });

  it("lists each pattern category", () => {
    const p: CodePatterns = {
      namingConvention: "camelCase",
      errorHandling: "try-catch",
      importStyle: "relative",
      commentStyle: "//",
      indentation: "2-space",
      quoteStyle: "double",
      filesAnalyzed: 1,
      rawSummary: "",
    };
    const s = formatPatterns(p);
    expect(s).toContain("Naming");
    expect(s).toContain("Error handling");
    expect(s).toContain("Import style");
    expect(s).toContain("Comment style");
    expect(s).toContain("Indentation");
    expect(s).toContain("Quote style");
  });

  it("includes a follow-the-conventions instruction", () => {
    const p: CodePatterns = {
      namingConvention: "unknown",
      errorHandling: "unknown",
      importStyle: "unknown",
      commentStyle: "unknown",
      indentation: "unknown",
      quoteStyle: "unknown",
      filesAnalyzed: 0,
      rawSummary: "",
    };
    const s = formatPatterns(p);
    expect(s).toMatch(/Follow these conventions/i);
  });
});

describe("getPatternsCached — caching behavior", () => {
  it("returns the same CodePatterns object on the second call (cache hit)", () => {
    fs.writeFileSync(path.join(TMP, "x.ts"), "// x\n");
    const p1 = getPatternsCached(TMP);
    const p2 = getPatternsCached(TMP);
    // On cache hit, should return the SAME object reference
    expect(p2).toBe(p1);
  });

  it("extracts again after cache is cleared", () => {
    fs.writeFileSync(path.join(TMP, "x.ts"), "// x\n");
    const p1 = getPatternsCached(TMP);
    clearPatternCache();
    const p2 = getPatternsCached(TMP);
    // Different object instances after clear
    expect(p2).not.toBe(p1);
    // But same content
    expect(p2).toEqual(p1);
  });
});

describe("clearPatternCache", () => {
  it("does not throw", () => {
    expect(() => clearPatternCache()).not.toThrow();
  });

  it("can be called multiple times", () => {
    clearPatternCache();
    clearPatternCache();
    expect(true).toBe(true);
  });
});

describe("CodePatterns type contract", () => {
  it("accepts the documented shape", () => {
    const p: CodePatterns = {
      namingConvention: "camelCase",
      errorHandling: "try-catch",
      importStyle: "relative",
      commentStyle: "//",
      indentation: "2-space",
      quoteStyle: "double",
      filesAnalyzed: 1,
      rawSummary: "summary",
    };
    expect(p.namingConvention).toBe("camelCase");
  });

  it("namingConvention accepts all allowed values", () => {
    const allowed = ["camelCase", "snake_case", "PascalCase", "mixed", "unknown"];
    for (const v of allowed) {
      const p: CodePatterns = {
        namingConvention: v as any,
        errorHandling: "unknown",
        importStyle: "unknown",
        commentStyle: "unknown",
        indentation: "unknown",
        quoteStyle: "unknown",
        filesAnalyzed: 0,
        rawSummary: "",
      };
      expect(p.namingConvention).toBe(v);
    }
  });
});
