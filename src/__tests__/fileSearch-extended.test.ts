/**
 * fileSearch-extended.test.ts — Extended tests for the glob file search module.
 *
 * Covers scenarios beyond the basic test file:
 *   - matchesGlob with empty strings, dots, special chars
 *   - globToRegex behavior via matchesGlob public API
 *   - brace expansion edge cases (nested, single, no comma)
 *   - globSearch respects maxDepth, custom ignore, ignore of dotfiles
 *   - findFilesByExtension / findFilesByName helpers
 *   - real-filesystem integration with temp dirs
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
  globSearch,
  matchesGlob,
  findFilesByExtension,
  findFilesByName,
  type GlobOptions,
} from "../fileSearch.js";

const TMP_ROOT = path.join(os.tmpdir(), `__ck_filesearch_ext_${process.pid}_${Date.now()}__`);

beforeAll(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  // Build a small project tree:
  //  TMP_ROOT/
  //    a.ts
  //    a.js
  //    b.ts
  //    README.md
  //    src/
  //      app.ts
  //      utils/
  //        helper.ts
  //    node_modules/
  //      pkg/
  //        index.js
  //    deep/
  //      l1/
  //        l2/
  //          l3/
  //            l4/
  //              deep.ts
  fs.writeFileSync(path.join(TMP_ROOT, "a.ts"), "export {};");
  fs.writeFileSync(path.join(TMP_ROOT, "a.js"), "module.exports={};");
  fs.writeFileSync(path.join(TMP_ROOT, "b.ts"), "export {};");
  fs.writeFileSync(path.join(TMP_ROOT, "README.md"), "# readme");
  fs.mkdirSync(path.join(TMP_ROOT, "src", "utils"), { recursive: true });
  fs.writeFileSync(path.join(TMP_ROOT, "src", "app.ts"), "export {};");
  fs.writeFileSync(path.join(TMP_ROOT, "src", "utils", "helper.ts"), "export {};");
  fs.mkdirSync(path.join(TMP_ROOT, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(TMP_ROOT, "node_modules", "pkg", "index.js"), "module.exports={};");
  fs.mkdirSync(path.join(TMP_ROOT, "deep", "l1", "l2", "l3", "l4"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_ROOT, "deep", "l1", "l2", "l3", "l4", "deep.ts"),
    "export {};",
  );
});

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ─── matchesGlob — pure unit tests ─────────────────────────────────────────
describe("matchesGlob — basic pattern matching", () => {
  it("matches a simple .ts file", () => {
    expect(matchesGlob("foo.ts", "*.ts")).toBe(true);
  });

  it("does not match wrong extension", () => {
    expect(matchesGlob("foo.js", "*.ts")).toBe(false);
  });

  it("matches a literal file name", () => {
    expect(matchesGlob("README.md", "README.md")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchesGlob("FOO.TS", "foo.ts")).toBe(true);
    expect(matchesGlob("foo.ts", "FOO.TS")).toBe(true);
  });

  it("matches * at start of pattern", () => {
    expect(matchesGlob("index.spec.ts", "*.spec.ts")).toBe(true);
    expect(matchesGlob("index.spec.js", "*.spec.ts")).toBe(false);
  });
});

describe("matchesGlob — `**` deep wildcard", () => {
  it("matches nested paths with **/*.ts", () => {
    expect(matchesGlob("src/app.ts", "**/*.ts")).toBe(true);
    expect(matchesGlob("src/utils/helper.ts", "**/*.ts")).toBe(true);
    expect(matchesGlob("a.ts", "**/*.ts")).toBe(true);
  });

  it("matches with prefix + **", () => {
    expect(matchesGlob("src/utils/helper.ts", "src/**/helper.ts")).toBe(true);
    expect(matchesGlob("src/helper.ts", "src/**/helper.ts")).toBe(true);
    expect(matchesGlob("helper.ts", "src/**/helper.ts")).toBe(false);
  });

  it("matches ** at end (trailing path)", () => {
    expect(matchesGlob("src/anything/here", "src/**")).toBe(true);
    expect(matchesGlob("other/x", "src/**")).toBe(false);
  });
});

describe("matchesGlob — `?` single-char wildcard", () => {
  it("matches single chars", () => {
    expect(matchesGlob("file1.ts", "file?.ts")).toBe(true);
    expect(matchesGlob("fileA.ts", "file?.ts")).toBe(true);
  });

  it("does not match multi-char with single ?", () => {
    expect(matchesGlob("file12.ts", "file?.ts")).toBe(false);
  });

  it("does not match slash with ?", () => {
    expect(matchesGlob("a/b.ts", "a?b.ts")).toBe(false);
  });
});

describe("matchesGlob — brace expansion {a,b}", () => {
  it("expands two alternatives", () => {
    expect(matchesGlob("app.ts", "*.{ts,js}")).toBe(true);
    expect(matchesGlob("app.js", "*.{ts,js}")).toBe(true);
    expect(matchesGlob("app.py", "*.{ts,js}")).toBe(false);
  });

  it("expands three alternatives", () => {
    expect(matchesGlob("x.ts", "*.{ts,js,tsx}")).toBe(true);
    expect(matchesGlob("x.tsx", "*.{ts,js,tsx}")).toBe(true);
    expect(matchesGlob("x.css", "*.{ts,js,tsx}")).toBe(false);
  });

  it("supports a single alternative inside braces", () => {
    expect(matchesGlob("a.ts", "*.{ts}")).toBe(true);
  });

  it("supports prefix and suffix around braces", () => {
    expect(matchesGlob("src/utils.ts", "src/*.{ts,js}")).toBe(true);
    expect(matchesGlob("src/utils.js", "src/*.{ts,js}")).toBe(true);
    expect(matchesGlob("src/utils.py", "src/*.{ts,js}")).toBe(false);
  });
});

describe("matchesGlob — dot handling", () => {
  it("treats `.` in pattern as literal dot", () => {
    expect(matchesGlob("a.b.ts", "a.b.ts")).toBe(true);
    expect(matchesGlob("aXb.ts", "a.b.ts")).toBe(false);
  });

  it("handles extensions with multiple dots", () => {
    expect(matchesGlob("file.spec.ts", "*.spec.ts")).toBe(true);
  });
});

describe("matchesGlob — edge cases", () => {
  it("returns a boolean for empty pattern", () => {
    expect(typeof matchesGlob("foo.ts", "")).toBe("boolean");
  });

  it("returns a boolean for empty path", () => {
    expect(typeof matchesGlob("", "*.ts")).toBe("boolean");
  });

  it("returns false for malformed pattern that produces invalid regex", () => {
    expect(matchesGlob("test.ts", "[invalid")).toBe(false);
  });

  it("handles backslash separators in path", () => {
    // backslash should be normalized to forward slash
    expect(matchesGlob("src\\app.ts", "src/*.ts")).toBe(true);
  });

  it("treats pattern with backslash consistently (normalized)", () => {
    // Backslashes in pattern are also normalized; both sides use forward slash
    expect(matchesGlob("src/app.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/app.ts", "src\\app.ts")).toBe(true);
  });
});

// ─── globSearch — real FS integration ──────────────────────────────────────
describe("globSearch — real filesystem", () => {
  it("returns an array", () => {
    const result = globSearch({ pattern: "**/*.ts", cwd: TMP_ROOT });
    expect(Array.isArray(result)).toBe(true);
  });

  it("finds top-level .ts files", () => {
    const result = globSearch({ pattern: "*.ts", cwd: TMP_ROOT });
    expect(result).toContain("a.ts");
    expect(result).toContain("b.ts");
  });

  it("finds nested .ts files with **/*.ts", () => {
    const result = globSearch({ pattern: "**/*.ts", cwd: TMP_ROOT });
    expect(result).toContain("a.ts");
    expect(result).toContain("src/app.ts");
    expect(result).toContain("src/utils/helper.ts");
  });

  it("ignores node_modules by default", () => {
    const result = globSearch({ pattern: "**/*.js", cwd: TMP_ROOT });
    expect(result.some((r) => r.includes("node_modules"))).toBe(false);
    // a.js is still found because it's at the top level
    expect(result).toContain("a.js");
  });

  it("respects a custom ignore list (ignore src/)", () => {
    const result = globSearch({ pattern: "**/*.ts", cwd: TMP_ROOT, ignore: ["src"] });
    expect(result).toContain("a.ts");
    expect(result).not.toContain("src/app.ts");
    expect(result).not.toContain("src/utils/helper.ts");
  });

  it("respects maxDepth=0 (only top-level files)", () => {
    const result = globSearch({ pattern: "**/*.ts", cwd: TMP_ROOT, maxDepth: 0 });
    expect(result).toContain("a.ts");
    expect(result).toContain("b.ts");
    // src/ contents are at depth 1+, so should NOT appear
    expect(result.some((r) => r.startsWith("src/"))).toBe(false);
  });

  it("returns empty array for non-existent directory", () => {
    const result = globSearch({ pattern: "**/*.ts", cwd: "/nonexistent/__ck_test__" });
    expect(result).toEqual([]);
  });

  it("returns empty array for pattern matching nothing", () => {
    const result = globSearch({ pattern: "**/*.nonexistent-ext", cwd: TMP_ROOT });
    expect(result).toEqual([]);
  });

  it("supports brace-expansion patterns on real FS", () => {
    const result = globSearch({ pattern: "*.{ts,js}", cwd: TMP_ROOT });
    expect(result).toContain("a.ts");
    expect(result).toContain("a.js");
    expect(result).toContain("b.ts");
    expect(result.some((r) => r.endsWith(".md"))).toBe(false);
  });

  it("supports deep `**` pattern", () => {
    const result = globSearch({ pattern: "**/deep.ts", cwd: TMP_ROOT });
    expect(result.some((r) => r.endsWith("deep.ts"))).toBe(true);
  });

  it("honors maxDepth to limit traversal of deep dirs", () => {
    // deep.ts is at depth 5 (deep/l1/l2/l3/l4/deep.ts). With maxDepth=2, not found.
    const result = globSearch({ pattern: "**/deep.ts", cwd: TMP_ROOT, maxDepth: 2 });
    expect(result.some((r) => r.endsWith("deep.ts"))).toBe(false);
    // With maxDepth=10, found
    const result2 = globSearch({ pattern: "**/deep.ts", cwd: TMP_ROOT, maxDepth: 10 });
    expect(result2.some((r) => r.endsWith("deep.ts"))).toBe(true);
  });
});

// ─── findFilesByExtension ──────────────────────────────────────────────────
describe("findFilesByExtension", () => {
  it("finds files by .ts extension", () => {
    const result = findFilesByExtension(".ts", TMP_ROOT);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.endsWith(".ts"))).toBe(true);
  });

  it("finds files by .js extension (excludes node_modules)", () => {
    const result = findFilesByExtension(".js", TMP_ROOT);
    expect(result).toContain("a.js");
    expect(result.some((r) => r.includes("node_modules"))).toBe(false);
  });

  it("returns empty for unknown extension", () => {
    const result = findFilesByExtension(".nonexistent", TMP_ROOT);
    expect(result).toEqual([]);
  });

  it("returns empty array for non-existent directory", () => {
    const result = findFilesByExtension(".ts", "/nonexistent/__ck_test__");
    expect(result).toEqual([]);
  });
});

// ─── findFilesByName ───────────────────────────────────────────────────────
describe("findFilesByName", () => {
  it("finds a file by name across the tree", () => {
    const result = findFilesByName("helper.ts", TMP_ROOT);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((r) => r.endsWith("helper.ts"))).toBe(true);
  });

  it("finds a top-level file by name", () => {
    const result = findFilesByName("a.ts", TMP_ROOT);
    expect(result).toContain("a.ts");
  });

  it("returns empty for non-existent name", () => {
    const result = findFilesByName("__does_not_exist__.ts", TMP_ROOT);
    expect(result).toEqual([]);
  });
});

// ─── GlobOptions interface and types ───────────────────────────────────────
describe("GlobOptions interface", () => {
  it("accepts all optional fields", () => {
    const opts: GlobOptions = {
      pattern: "**/*.ts",
      cwd: TMP_ROOT,
      maxDepth: 5,
      ignore: ["node_modules"],
    };
    const result = globSearch(opts);
    expect(Array.isArray(result)).toBe(true);
  });

  it("uses defaults when optional fields are omitted", () => {
    const opts: GlobOptions = { pattern: "*.ts" };
    const result = globSearch(opts);
    expect(Array.isArray(result)).toBe(true);
  });
});
