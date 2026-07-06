/**
 * sideBySideDiff-extended.test.ts — Extended tests for sideBySideDiff.ts
 *
 * Covers:
 *   - computeSideBySideDiff: identical, added-only, removed-only, mixed
 *   - DiffLine.type values and numbering (oldNum/newNum nulls)
 *   - renderSideBySide: header, line truncation, ANSI escapes
 *   - generateUnifiedDiff: --- /+++ / +/- prefix lines
 *   - Edge cases: empty strings, single line, large input
 */

import { describe, it, expect } from "vitest";
import {
  computeSideBySideDiff,
  renderSideBySide,
  generateUnifiedDiff,
  type DiffLine,
} from "../sideBySideDiff.js";

describe("computeSideBySideDiff — identical text", () => {
  it("returns all 'same' lines for identical text", () => {
    const text = "a\nb\nc";
    const diff = computeSideBySideDiff(text, text);
    expect(diff.length).toBe(3);
    expect(diff.every((d) => d.type === "same")).toBe(true);
  });

  it("assigns sequential oldNum and newNum for identical text", () => {
    const diff = computeSideBySideDiff("a\nb", "a\nb");
    expect(diff[0]!.oldNum).toBe(1);
    expect(diff[0]!.newNum).toBe(1);
    expect(diff[1]!.oldNum).toBe(2);
    expect(diff[1]!.newNum).toBe(2);
  });

  it("returns one 'same' line for identical single-line text", () => {
    const diff = computeSideBySideDiff("hello", "hello");
    expect(diff.length).toBe(1);
    expect(diff[0]!.type).toBe("same");
  });
});

describe("computeSideBySideDiff — additions", () => {
  it("marks added lines with newNum and oldNum=null", () => {
    const diff = computeSideBySideDiff("a", "a\nb");
    const added = diff.filter((d) => d.type === "added");
    expect(added.length).toBe(1);
    expect(added[0]!.oldNum).toBeNull();
    expect(added[0]!.newNum).not.toBeNull();
    expect(added[0]!.newContent).toBe("b");
    expect(added[0]!.oldContent).toBe("");
  });

  it("handles addition at the start", () => {
    const diff = computeSideBySideDiff("b", "a\nb");
    const added = diff.find((d) => d.type === "added");
    expect(added).toBeDefined();
    expect(added!.newContent).toBe("a");
  });

  it("handles multiple additions", () => {
    const diff = computeSideBySideDiff("a", "x\na\ny\nz");
    const added = diff.filter((d) => d.type === "added");
    expect(added.length).toBe(3);
  });
});

describe("computeSideBySideDiff — removals", () => {
  it("marks removed lines with oldNum and newNum=null", () => {
    const diff = computeSideBySideDiff("a\nb", "a");
    const removed = diff.find((d) => d.type === "removed");
    expect(removed).toBeDefined();
    expect(removed!.newNum).toBeNull();
    expect(removed!.oldNum).not.toBeNull();
    expect(removed!.oldContent).toBe("b");
    expect(removed!.newContent).toBe("");
  });

  it("handles removal at the start", () => {
    const diff = computeSideBySideDiff("x\na", "a");
    const removed = diff.filter((d) => d.type === "removed");
    expect(removed.length).toBe(1);
    expect(removed[0]!.oldContent).toBe("x");
  });
});

describe("computeSideBySideDiff — mixed", () => {
  it("produces a mix of added and removed for replacement", () => {
    const diff = computeSideBySideDiff("a\nb\nc", "a\nB\nc");
    const types = diff.map((d) => d.type).sort();
    expect(types).toContain("removed");
    expect(types).toContain("added");
  });

  it("preserves same lines around changes", () => {
    const diff = computeSideBySideDiff("a\nb\nc\nd", "a\nB\nc\nd");
    expect(diff[0]!.type).toBe("same");
    expect(diff[diff.length - 1]!.type).toBe("same");
  });
});

describe("computeSideBySideDiff — edge cases", () => {
  it("handles both empty strings", () => {
    const diff = computeSideBySideDiff("", "");
    // "".split("\n") returns [""] so we have one entry
    expect(diff.length).toBe(1);
    expect(diff[0]!.type).toBe("same");
  });

  it("handles old empty, new non-empty", () => {
    const diff = computeSideBySideDiff("", "a\nb");
    const added = diff.filter((d) => d.type === "added");
    expect(added.length).toBeGreaterThanOrEqual(2);
  });

  it("handles old non-empty, new empty", () => {
    const diff = computeSideBySideDiff("a\nb", "");
    const removed = diff.filter((d) => d.type === "removed");
    expect(removed.length).toBeGreaterThanOrEqual(2);
  });

  it("does not crash on large input", () => {
    const before = Array.from({ length: 1000 }, (_, i) => `l${i}`).join("\n");
    const after = Array.from({ length: 1000 }, (_, i) => `l${i}`);
    after[500] = "CHANGED";
    const diff = computeSideBySideDiff(before, after.join("\n"));
    expect(diff.length).toBeGreaterThan(0);
  });

  it("all entries are valid DiffLine objects with required fields", () => {
    const diff = computeSideBySideDiff("a\nb", "a\nB");
    for (const d of diff) {
      expect(typeof d.oldContent).toBe("string");
      expect(typeof d.newContent).toBe("string");
      expect(["same", "added", "removed", "changed"]).toContain(d.type);
      // oldNum/newNum are either null or a number
      expect(d.oldNum === null || typeof d.oldNum === "number").toBe(true);
      expect(d.newNum === null || typeof d.newNum === "number").toBe(true);
    }
  });
});

describe("renderSideBySide — basic structure", () => {
  it("returns a string", () => {
    const diff = computeSideBySideDiff("a", "a");
    const out = renderSideBySide(diff);
    expect(typeof out).toBe("string");
  });

  it("includes OLD | NEW header", () => {
    const diff = computeSideBySideDiff("a", "a");
    const out = renderSideBySide(diff);
    expect(out).toContain("OLD");
    expect(out).toContain("NEW");
  });

  it("includes a separator line of dashes", () => {
    const diff = computeSideBySideDiff("a", "a");
    const out = renderSideBySide(diff);
    expect(out).toMatch(/-{3,}/);
  });

  it("contains ANSI escape codes for added lines", () => {
    const diff = computeSideBySideDiff("", "new");
    const out = renderSideBySide(diff);
    expect(out).toMatch(/\x1b\[/);
  });

  it("contains ANSI escape codes for removed lines", () => {
    const diff = computeSideBySideDiff("old", "");
    const out = renderSideBySide(diff);
    expect(out).toMatch(/\x1b\[/);
  });

  it("contains ANSI escape codes for same lines", () => {
    const diff = computeSideBySideDiff("x", "x");
    const out = renderSideBySide(diff);
    expect(out).toMatch(/\x1b\[/);
  });

  it("respects custom maxLineWidth", () => {
    const diff = computeSideBySideDiff("very long line content here", "very long line content here");
    const out80 = renderSideBySide(diff, 80);
    const out40 = renderSideBySide(diff, 40);
    expect(out40).not.toBe(out80);
  });
});

describe("renderSideBySide — line truncation", () => {
  it("truncates very long line content to fit half width", () => {
    const longLine = "x".repeat(200);
    const diff = computeSideBySideDiff(longLine, longLine);
    const out = renderSideBySide(diff, 40);
    // halfWidth = floor((40-5)/2) = 17 chars per side
    // Each line should not contain the full 200-char string
    expect(out).not.toContain("x".repeat(50));
  });
});

describe("generateUnifiedDiff — basic structure", () => {
  it("includes --- a/<file> header", () => {
    const out = generateUnifiedDiff("a\nb", "a\nB", "src/f.ts");
    expect(out).toContain("--- a/src/f.ts");
  });

  it("includes +++ b/<file> header", () => {
    const out = generateUnifiedDiff("a", "a\nb", "f.ts");
    expect(out).toContain("+++ b/f.ts");
  });

  it("emits `- ` prefixed lines for removals", () => {
    const out = generateUnifiedDiff("a\nb", "a", "f.ts");
    expect(out).toContain("- b");
  });

  it("emits `+ ` prefixed lines for additions", () => {
    const out = generateUnifiedDiff("a", "a\nb", "f.ts");
    expect(out).toContain("+ b");
  });

  it("emits `  ` prefixed lines for context (same)", () => {
    const out = generateUnifiedDiff("a\nb", "a\nB", "f.ts");
    expect(out).toContain("  a");
  });

  it("returns a single string joined by \\n", () => {
    const out = generateUnifiedDiff("a", "b", "f.ts");
    expect(typeof out).toBe("string");
    expect(out.split("\n").length).toBeGreaterThan(2);
  });
});

describe("generateUnifiedDiff — edge cases", () => {
  it("handles empty inputs", () => {
    const out = generateUnifiedDiff("", "", "f.ts");
    expect(typeof out).toBe("string");
  });

  it("contains ANSI escape codes", () => {
    const out = generateUnifiedDiff("a", "b", "f.ts");
    expect(out).toMatch(/\x1b\[/);
  });
});

describe("DiffLine type contract", () => {
  it("DiffLine.type is one of the allowed union members", () => {
    const diff = computeSideBySideDiff("a\nb\nc", "x\nb\ny");
    const allowed = ["same", "added", "removed", "changed"];
    for (const d of diff) {
      expect(allowed).toContain(d.type);
    }
  });

  it("for added lines: oldContent is empty string", () => {
    const diff = computeSideBySideDiff("a", "a\nb");
    const added = diff.find((d) => d.type === "added");
    expect(added!.oldContent).toBe("");
  });

  it("for removed lines: newContent is empty string", () => {
    const diff = computeSideBySideDiff("a\nb", "a");
    const removed = diff.find((d) => d.type === "removed");
    expect(removed!.newContent).toBe("");
  });

  it("for same lines: oldContent === newContent", () => {
    const diff = computeSideBySideDiff("a\nb", "a\nb");
    for (const d of diff) {
      if (d.type === "same") {
        expect(d.oldContent).toBe(d.newContent);
      }
    }
  });
});
