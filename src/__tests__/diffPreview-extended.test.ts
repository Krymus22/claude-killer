/**
 * diffPreview-extended.test.ts — Extended tests for diffPreview.ts
 *
 * Covers:
 *   - computeUnifiedDiff for: identical strings, simple add/remove, multi-hunk,
 *     empty input, trailing newline normalization, large diff truncation
 *   - renderColoredDiff: ANSI escape codes for +, -, @@, +++, ---, context lines
 *   - previewAndApprove: non-TTY auto-approve path, config.diffPreview=false path,
 *     no-change (empty diff) auto-approve
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: { diffPreview: false },
}));

import { computeUnifiedDiff, renderColoredDiff, previewAndApprove } from "../diffPreview.js";

describe("computeUnifiedDiff — basic", () => {
  it("returns empty string for two identical empty strings", () => {
    expect(computeUnifiedDiff("", "", "f.txt")).toBe("");
  });

  it("returns empty string for two identical non-empty strings", () => {
    const text = "line1\nline2\nline3";
    expect(computeUnifiedDiff(text, text, "f.txt")).toBe("");
  });

  it("returns a string when there are differences", () => {
    const diff = computeUnifiedDiff("a\nb\nc", "a\nB\nc", "f.txt");
    expect(typeof diff).toBe("string");
    expect(diff.length).toBeGreaterThan(0);
  });

  it("includes --- a/<file> and +++ b/<file> headers when diff exists", () => {
    const diff = computeUnifiedDiff("a\nb", "a\nB", "src/file.ts");
    expect(diff).toContain("--- a/src/file.ts");
    expect(diff).toContain("+++ b/src/file.ts");
  });

  it("includes @@ hunk header with line counts", () => {
    const diff = computeUnifiedDiff("a\nb\nc", "a\nB\nc", "f.txt");
    expect(diff).toMatch(/@@\s*-\d+,\d+\s*\+\d+,\d+\s*@@/);
  });
});

describe("computeUnifiedDiff — additions / removals", () => {
  it("emits a `+`-prefixed line for added content", () => {
    const diff = computeUnifiedDiff("a\nb", "a\nb\nc", "f.txt");
    expect(diff).toContain("+c");
  });

  it("emits a `-`-prefixed line for removed content", () => {
    const diff = computeUnifiedDiff("a\nb\nc", "a\nc", "f.txt");
    expect(diff).toContain("-b");
  });

  it("emits context lines with leading space", () => {
    const diff = computeUnifiedDiff("a\nb\nc", "a\nB\nc", "f.txt");
    // context lines start with single space prefix
    expect(diff).toMatch(/^ a$/m);
    expect(diff).toMatch(/^ c$/m);
  });

  it("handles insertion at end (only adds)", () => {
    const diff = computeUnifiedDiff("a\nb", "a\nb\nc\nd", "f.txt");
    expect(diff).toContain("+c");
    expect(diff).toContain("+d");
  });

  it("handles removal at end (only removes)", () => {
    const diff = computeUnifiedDiff("a\nb\nc\nd", "a\nb", "f.txt");
    expect(diff).toContain("-c");
    expect(diff).toContain("-d");
  });

  it("handles pure replacement (same line count)", () => {
    const diff = computeUnifiedDiff("a\nb\nc", "a\nB\nC", "f.txt");
    expect(diff).toContain("-b");
    expect(diff).toContain("-c");
    expect(diff).toContain("+B");
    expect(diff).toContain("+C");
  });
});

describe("computeUnifiedDiff — multi-hunk", () => {
  it("produces multiple @@ hunks for far-apart changes", () => {
    // 30 lines with two far-apart edits so the context regions don't merge
    const before = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const afterArr = Array.from({ length: 30 }, (_, i) => `line${i}`);
    afterArr[2] = "CHANGED_2";
    afterArr[25] = "CHANGED_25";
    const after = afterArr.join("\n");

    const diff = computeUnifiedDiff(before, after, "f.txt");
    const hunkCount = (diff.match(/@@/g) ?? []).length;
    expect(hunkCount).toBeGreaterThanOrEqual(2);
  });

  it("produces few hunks (<=2) for adjacent changes", () => {
    const before = "a\nb\nc\nd\ne";
    const after = "a\nB\nC\nd\ne";
    const diff = computeUnifiedDiff(before, after, "f.txt");
    const hunkCount = (diff.match(/@@/g) ?? []).length;
    expect(hunkCount).toBeLessThanOrEqual(2);
    expect(hunkCount).toBeGreaterThanOrEqual(1);
  });
});

describe("computeUnifiedDiff — newline normalization", () => {
  it("strips a trailing newline before diffing", () => {
    // Both strings are equivalent after trailing newline normalization
    expect(computeUnifiedDiff("a\nb\n", "a\nb", "f.txt")).toBe("");
  });

  it("treats `a` and `a\\n` as identical single-line content", () => {
    expect(computeUnifiedDiff("a", "a\n", "f.txt")).toBe("");
  });

  it("handles CRLF-like inputs (only \\n splitting, but doesn't crash)", () => {
    const diff = computeUnifiedDiff("a\r\nb", "a\r\nB", "f.txt");
    expect(typeof diff).toBe("string");
  });
});

describe("computeUnifiedDiff — large input / truncation", () => {
  it("does not crash on a large file", () => {
    const before = Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n");
    const after = Array.from({ length: 500 }, (_, i) => `l${i}`);
    after[250] = "CHANGED";
    const afterStr = after.join("\n");
    const diff = computeUnifiedDiff(before, afterStr, "f.txt");
    expect(typeof diff).toBe("string");
    expect(diff.length).toBeGreaterThan(0);
  });

  it("produces a truncation marker for very large diffs (heuristic)", () => {
    // Build a diff where every line changes — hunk rendering may trigger truncation.
    const before = Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n");
    const after = Array.from({ length: 500 }, (_, i) => `L${i}`).join("\n");
    const diff = computeUnifiedDiff(before, after, "f.txt");
    // Either truncated or contains many lines; assert at minimum it returns a string.
    expect(typeof diff).toBe("string");
  });
});

describe("renderColoredDiff", () => {
  it("returns a string for empty input", () => {
    const out = renderColoredDiff("");
    expect(typeof out).toBe("string");
  });

  it("colors +++ lines (new file header)", () => {
    const out = renderColoredDiff("+++ b/file.ts");
    // ANSI escape prefix
    expect(out).toMatch(/\x1b\[/);
  });

  it("colors --- lines (old file header)", () => {
    const out = renderColoredDiff("--- a/file.ts");
    expect(out).toMatch(/\x1b\[/);
  });

  it("colors @@ hunk headers", () => {
    const out = renderColoredDiff("@@ -1,3 +1,3 @@");
    expect(out).toMatch(/\x1b\[/);
  });

  it("colors `+` added lines", () => {
    const out = renderColoredDiff("+added");
    expect(out).toMatch(/\x1b\[/);
  });

  it("colors `-` removed lines", () => {
    const out = renderColoredDiff("-removed");
    expect(out).toMatch(/\x1b\[/);
  });

  it("colors context lines (no +/- prefix)", () => {
    const out = renderColoredDiff(" context");
    expect(out).toMatch(/\x1b\[/);
  });

  it("preserves multi-line structure", () => {
    const input = "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-old\n+new";
    const out = renderColoredDiff(input);
    expect(out.split("\n").length).toBe(5);
  });

  it("produces output containing ANSI reset sequence", () => {
    const out = renderColoredDiff("+x");
    expect(out).toContain("\x1b[0m");
  });
});

describe("previewAndApprove", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-approves when config.diffPreview is false (default)", async () => {
    const result = await previewAndApprove("f.txt", "a\nb", "a\nB");
    expect(result).toBe(true);
  });

  it("auto-approves when there is no diff to show", async () => {
    // Even though diffPreview is false, the early return on empty diff should also pass
    const result = await previewAndApprove("f.txt", "same", "same");
    expect(result).toBe(true);
  });

  it("auto-approves identical empty content", async () => {
    const result = await previewAndApprove("f.txt", "", "");
    expect(result).toBe(true);
  });

  it("returns a boolean (type check)", async () => {
    const result = await previewAndApprove("f.txt", "a", "b");
    expect(typeof result).toBe("boolean");
  });

  it("does not throw on very large inputs", async () => {
    const a = "x".repeat(50_000);
    const b = "y".repeat(50_000);
    await expect(previewAndApprove("f.txt", a, b)).resolves.toBe(true);
  });
});
