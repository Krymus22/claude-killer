/**
 * markdown-renderer-bug-hunt.test.ts — Regression tests for the bug-hunt pass
 * on src/tui/MarkdownRenderer.tsx.
 *
 * These tests run in the default vitest config (the original
 * markdown-renderer.test.ts is excluded because rendering-based tests OOM in
 * CI). This file tests the parser and helpers DIRECTLY — no React rendering,
 * no ink-testing-library — so it stays lightweight.
 *
 * Each test names the bug it pins in its description so future regressions
 * are easy to triage.
 */

import { describe, it, expect } from "vitest";
import {
  parseBlocks,
  splitTableRow,
  isTableSeparator,
  isTableStart,
  isCodeFenceClose,
  displayWidth,
  padCell,
} from "../tui/MarkdownRenderer.js";

// ─── CRITICAL: infinite-loop regressions ──────────────────────────────────
//
// Before the fix, `parseBlocks` could enter an infinite loop on several
// inputs where a line matched a text-block terminator but was NOT consumed
// by the corresponding outer-loop branch. The outer `while` then re-reached
// the same line without advancing `i`, hanging the TUI forever.
//
// These tests use a short vitest timeout — if the parser hangs, the test
// fails fast instead of stalling the suite.

describe("MarkdownRenderer bug-hunt — infinite-loop regressions", () => {
  it("does NOT infinite-loop on pipe-prefixed non-table (no separator)", () => {
    // BUG (infinite-loop-table): `| a | b |\n| c | d |` — second line is not
    // a separator, so the outer table check fails. The text-block loop
    // previously terminated on `startsWith("|")` without consuming the line,
    // so `i` never advanced. Now `isTableStart` only terminates on a REAL
    // table, so the lines are consumed as text.
    const blocks = parseBlocks("| a | b |\n| c | d |");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].content).toBe("| a | b |\n| c | d |");
  });

  it("does NOT infinite-loop on a lone pipe", () => {
    const blocks = parseBlocks("|");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });

  it("does NOT infinite-loop on three pipes", () => {
    const blocks = parseBlocks("|||");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });

  it("does NOT infinite-loop on a pipe-prefixed single line", () => {
    const blocks = parseBlocks("| not a table");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].content).toBe("| not a table");
  });

  it("does NOT infinite-loop on `# ` (hash + space, no content)", () => {
    // BUG (infinite-loop-header): the text-block loop used the weak regex
    // `/^(#{1,6})\s+/` (no content required) while the outer loop required
    // `^(#{1,6})\s+(.+)$` (content required). A line like `# ` matched the
    // weak regex (terminating the text block) but NOT the outer regex (so
    // the header branch didn't consume it). Now both use the content-
    // requiring regex, so `# ` is consumed as text.
    const blocks = parseBlocks("# ");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });

  it("does NOT infinite-loop on `## ` (hashes + space, no content)", () => {
    const blocks = parseBlocks("## ");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });

  it("does NOT infinite-loop on `###### ` (six hashes + space)", () => {
    const blocks = parseBlocks("###### ");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });

  it("parses `####### ` (7 hashes) as text (not a header, not a loop)", () => {
    // 7+ hashes is outside the 1-6 header range — must be plain text.
    const blocks = parseBlocks("####### ");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });

  it("still parses real tables correctly (no regression)", () => {
    const blocks = parseBlocks("| a | b |\n|---|---|\n| c | d |");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("table");
    expect(blocks[0].rows).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("still parses text-then-table correctly (no regression)", () => {
    // The text block must terminate WHEN a real table starts (so the outer
    // loop can parse the table), but not before. This is the dual of the
    // infinite-loop fix.
    const blocks = parseBlocks("intro\n| a | b |\n|---|---|\n| c | d |");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].content).toBe("intro");
    expect(blocks[1].type).toBe("table");
  });

  it("parses pipe-prefixed text followed by a real table", () => {
    // First line is pipe-prefixed but not a table; second pair IS a table.
    // The first line should be text; the table should be parsed.
    const blocks = parseBlocks("| not a table\n| a | b |\n|---|---|\n| c | d |");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].content).toBe("| not a table");
    expect(blocks[1].type).toBe("table");
  });
});

// ─── isTableSeparator: reject `=` and other invalid chars ─────────────────

describe("MarkdownRenderer bug-hunt — isTableSeparator strictness", () => {
  it("rejects `=` in separator cells — regression", () => {
    // BUG (equals-accept): the old char-class `[ :\-=]+` allowed `=`, so
    // `|=-=|=-=|` was incorrectly accepted as a separator. GFM spec only
    // allows `-`, `:`, and spaces.
    expect(isTableSeparator("|=-=|=-=|")).toBe(false);
    expect(isTableSeparator("|=|=|")).toBe(false);
    expect(isTableSeparator("| -= | -= |")).toBe(false);
  });

  it("still accepts valid separators (no regression)", () => {
    expect(isTableSeparator("|---|---|")).toBe(true);
    expect(isTableSeparator("|:--|:-:|--:|")).toBe(true);
    expect(isTableSeparator("| --- | :---: |")).toBe(true);
    expect(isTableSeparator("|-|-|")).toBe(true);
    expect(isTableSeparator("|:-|")).toBe(true);
    expect(isTableSeparator("|-:|")).toBe(true);
  });

  it("still rejects letters, empty cells, and non-pipe lines (no regression)", () => {
    expect(isTableSeparator("|abc|def|")).toBe(false);
    expect(isTableSeparator("| | |")).toBe(false);
    expect(isTableSeparator("not a separator")).toBe(false);
    expect(isTableSeparator("|:|")).toBe(false); // no dash
    expect(isTableSeparator("---|---")).toBe(false); // no leading pipe
  });

  it("does NOT treat `| a | b |\n|=-=|=-=|` as a table (top-level)", () => {
    // The `=` separator is now rejected, so this falls back to text.
    const blocks = parseBlocks("| a | b |\n|=-=|=-=|");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });
});

// ─── isTableStart helper ───────────────────────────────────────────────────

describe("MarkdownRenderer bug-hunt — isTableStart helper", () => {
  it("returns true when next line is a valid separator", () => {
    expect(isTableStart(["| a | b |", "|---|---|"], 0)).toBe(true);
    expect(isTableStart(["| a | b |", "|---|---|", "| c | d |"], 0)).toBe(true);
  });

  it("returns false when next line is NOT a separator", () => {
    expect(isTableStart(["| a | b |", "| c | d |"], 0)).toBe(false);
    expect(isTableStart(["| a | b |", "text"], 0)).toBe(false);
  });

  it("returns false when current line does not start with `|`", () => {
    expect(isTableStart(["text", "|---|---|"], 0)).toBe(false);
  });

  it("returns false at end of array (no next line)", () => {
    expect(isTableStart(["| a | b |"], 0)).toBe(false);
    expect(isTableStart(["| a | b |", "|---|---|"], 1)).toBe(false);
  });

  it("returns false for separator that contains `=` (regression for equals-accept)", () => {
    expect(isTableStart(["| a | b |", "|=-=|=-=|"], 0)).toBe(false);
  });
});

// ─── isCodeFenceClose helper + code-fence lang extraction ─────────────────

describe("MarkdownRenderer bug-hunt — code fence closing", () => {
  it("isCodeFenceClose accepts bare backticks + trailing whitespace", () => {
    expect(isCodeFenceClose("```")).toBe(true);
    expect(isCodeFenceClose("```   ")).toBe(true);
    expect(isCodeFenceClose("   ```")).toBe(true);
    expect(isCodeFenceClose("``````")).toBe(true); // 6 backticks also valid
    expect(isCodeFenceClose("\t```\t")).toBe(true);
  });

  it("isCodeFenceClose rejects backticks followed by content — regression", () => {
    // BUG (false-close): previously the closing-fence check was
    // `lines[i].trim().startsWith("```")`, which treated ```` ```javascript ````
    // as a closing fence. CommonMark says a closing fence must be ONLY
    // backticks (+ optional whitespace).
    expect(isCodeFenceClose("```javascript")).toBe(false);
    expect(isCodeFenceClose("``` ts")).toBe(false);
    expect(isCodeFenceClose("```python ")).toBe(false);
    expect(isCodeFenceClose("```code here")).toBe(false);
  });

  it("code block with ` ```javascript ` line inside is NOT prematurely closed", () => {
    // BUG (false-close): before the fix, the inner ```` ```javascript ````
    // was treated as the closing fence, so the code block content was
    // truncated to "" and "const y = 2;\n" leaked out as text.
    const blocks = parseBlocks("```\n```javascript\nconst y = 2;\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("code");
    expect(blocks[0].content).toBe("```javascript\nconst y = 2;");
  });

  it("code block with ` ```ts extra info ` opening extracts only `ts` as lang — regression", () => {
    // BUG (lang-bloat): previously the lang was everything after the opening
    // fence, so ```` ```ts extra info ```` produced lang = "ts extra info".
    // CommonMark says the first word is the language.
    const blocks = parseBlocks("```ts extra info\nconst x = 1;\n```");
    expect(blocks[0].type).toBe("code");
    expect(blocks[0].lang).toBe("ts");
  });

  it("code block with ` ```typescript ` opening still extracts `typescript`", () => {
    const blocks = parseBlocks("```typescript\nconst x = 1;\n```");
    expect(blocks[0].lang).toBe("typescript");
  });

  it("code block with empty lang still returns undefined", () => {
    const blocks = parseBlocks("```\nplain code\n```");
    expect(blocks[0].lang).toBeUndefined();
  });

  it("code block with only whitespace after fence returns undefined lang", () => {
    const blocks = parseBlocks("```   \nplain code\n```");
    expect(blocks[0].lang).toBeUndefined();
  });

  it("still parses normal code blocks (no regression)", () => {
    const blocks = parseBlocks("```\nline1\nline2\nline3\n```");
    expect(blocks[0].type).toBe("code");
    expect(blocks[0].content).toBe("line1\nline2\nline3");
  });

  it("still parses unclosed code blocks without crash (no regression)", () => {
    const blocks = parseBlocks("```\nconst x = 1;\n// no closing");
    expect(blocks[0].type).toBe("code");
    expect(blocks[0].content).toContain("const x = 1;");
  });

  it("code block containing a line that is just `````` (6 backticks) closes correctly", () => {
    // 6 backticks is a valid closing fence (3+ backticks).
    const blocks = parseBlocks("```\ncode line\n``````");
    expect(blocks[0].type).toBe("code");
    expect(blocks[0].content).toBe("code line");
  });
});

// ─── splitTableRow: additional edge cases ─────────────────────────────────

describe("MarkdownRenderer bug-hunt — splitTableRow edge cases", () => {
  it("handles a single pipe", () => {
    // `|` → no leading pipe to strip (after trim, the string is "|"; strip
    // leading → ""; strip trailing → "" since "" doesn't end with "|").
    // Loop doesn't run. Returns [""].
    const cells = splitTableRow("|");
    expect(cells).toEqual([""]);
  });

  it("handles three pipes (two empty cells)", () => {
    const cells = splitTableRow("|||");
    // Strip leading `|` → `||`; strip trailing `|` → `|`.
    // Loop: char `|` → push "" (current=""), current="". End → push "".
    // Result: ["", ""].
    expect(cells).toEqual(["", ""]);
  });

  it("handles a row with no pipes (single cell)", () => {
    expect(splitTableRow("just text")).toEqual(["just text"]);
  });

  it("handles escaped pipe at end of cell", () => {
    expect(splitTableRow("| a\\| | b |")).toEqual(["a|", "b"]);
  });

  it("handles double-escaped backslash", () => {
    // `a\\\\|b` → `a\\` then `|` separator then `b`.
    expect(splitTableRow("| a\\\\|b |")).toEqual(["a\\", "b"]);
  });

  it("handles multiple consecutive pipes (empty cells)", () => {
    expect(splitTableRow("| a || b |")).toEqual(["a", "", "b"]);
  });

  it("handles trailing pipe with whitespace", () => {
    expect(splitTableRow("| a | b | ")).toEqual(["a", "b"]);
  });
});

// ─── Parser robustness on empty / null / undefined inputs ─────────────────

describe("MarkdownRenderer bug-hunt — empty / null / undefined inputs", () => {
  it("parseBlocks(empty string) returns one empty block", () => {
    const blocks = parseBlocks("");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("empty");
  });

  it("parseBlocks(whitespace-only) returns empty blocks", () => {
    expect(parseBlocks("   ")[0].type).toBe("empty");
    expect(parseBlocks("\t\t")[0].type).toBe("empty");
  });

  it("parseBlocks(newlines) returns N empty blocks", () => {
    const blocks = parseBlocks("\n\n\n");
    expect(blocks).toHaveLength(4); // "","","",""
    expect(blocks.every((b) => b.type === "empty")).toBe(true);
  });

  it("parseBlocks handles a single newline", () => {
    const blocks = parseBlocks("\n");
    expect(blocks).toHaveLength(2); // ["", ""]
    expect(blocks.every((b) => b.type === "empty")).toBe(true);
  });
});

// ─── Performance: no catastrophic backtracking or O(n²) blowups ───────────

describe("MarkdownRenderer bug-hunt — performance", () => {
  it("parses 1000 pipe-prefixed non-table lines in <500ms", () => {
    // Before the fix, this would infinite-loop. After the fix, it should
    // parse linearly.
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) lines.push(`| not a table line ${i}`);
    const text = lines.join("\n");
    const start = Date.now();
    const blocks = parseBlocks(text);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });

  it("parses 1000 hash-no-content lines in <500ms", () => {
    // Before the fix, this would infinite-loop on the first line.
    // After the fix, all 1000 `# ` lines form a single text block
    // (consecutive non-empty non-block lines = one paragraph per CommonMark).
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) lines.push(`# `);
    const text = lines.join("\n");
    const start = Date.now();
    const blocks = parseBlocks(text);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    // All 1000 lines form ONE text paragraph (CommonMark: consecutive
    // non-block lines merge into a single paragraph).
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });

  it("parses 200 real tables (separated by blank lines) in <500ms", () => {
    // Tables must be separated by a blank line so parseTable doesn't
    // consume the next table's header as a data row.
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(`| h${i} | v${i} |`);
      lines.push(`|---|---|`);
      lines.push(`| a${i} | b${i} |`);
      lines.push(``); // blank line separates tables
    }
    const text = lines.join("\n");
    const start = Date.now();
    const blocks = parseBlocks(text);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(blocks.filter((b) => b.type === "table")).toHaveLength(200);
  });
});

// ─── Unicode / emoji handling (displayWidth, padCell) ──────────────────────

describe("MarkdownRenderer bug-hunt — Unicode / emoji", () => {
  it("displayWidth handles emoji modifier sequences (VS16)", () => {
    // ❤ (U+2764, width 1) + VS16 (U+FE0F, width 0) → display width 1.
    // (Limitation: doesn't upgrade to width-2 emoji presentation. Pinned
    // here so a future change is intentional.)
    expect(displayWidth("❤\uFE0F")).toBe(1);
  });

  it("displayWidth handles CJK + emoji mix", () => {
    // "日本語🎉" → 6 (CJK) + 2 (emoji) = 8
    expect(displayWidth("日本語🎉")).toBe(8);
  });

  it("displayWidth handles ZWJ (zero-width joiner) as 0", () => {
    // ZWJ (U+200D) is in the zero-width range → 0.
    expect(displayWidth("a\u200Db")).toBe(2);
  });

  it("displayWidth handles flags (regional indicator pairs)", () => {
    // 🇧🇷 = U+1F1E7 + U+1F1F7. Regional indicators live in 0x1F1E6-0x1F1FF,
    // which is NOT covered by the function's emoji ranges (0x1F300+), so
    // each regional indicator is counted as width 1. Total = 2.
    // (Accidentally matches the real flag display width of 2, but for the
    // wrong reason — the function doesn't handle grapheme clusters. Pinned
    // here so a future change to the emoji ranges is intentional.)
    expect(displayWidth("🇧🇷")).toBe(2);
  });

  it("padCell does not crash on width 0", () => {
    expect(padCell("abc", 0, "left")).toBe("abc");
    expect(padCell("", 0, "left")).toBe("");
  });

  it("padCell does not crash on negative width", () => {
    expect(padCell("abc", -5, "left")).toBe("abc");
    expect(padCell("abc", -5, "right")).toBe("abc");
    expect(padCell("abc", -5, "center")).toBe("abc");
  });

  it("padCell handles emoji in center alignment", () => {
    const result = padCell("🎉", 6, "center");
    expect(displayWidth(result)).toBe(6);
  });

  it("padCell handles CJK in right alignment", () => {
    const result = padCell("日本語", 10, "right");
    expect(displayWidth(result)).toBe(10);
  });
});

// ─── Mixed-content integration smoke tests ────────────────────────────────

describe("MarkdownRenderer bug-hunt — mixed content", () => {
  it("parses a realistic assistant message with table + code + list", () => {
    const md = [
      "## Summary",
      "",
      "Here's the plan:",
      "",
      "| Step | Status |",
      "|------|--------|",
      "| Read | ✅ |",
      "| Edit | ⏳ |",
      "",
      "```ts",
      "const x: number = 1;",
      "```",
      "",
      "- item 1",
      "- item 2",
    ].join("\n");
    const blocks = parseBlocks(md);
    const types = blocks.map((b) => b.type);
    expect(types).toContain("header");
    expect(types).toContain("text");
    expect(types).toContain("table");
    expect(types).toContain("code");
    expect(types).toContain("bullet-list");
    // No empty-handed termination or infinite loop.
    expect(blocks.length).toBeGreaterThan(5);
  });

  it("parses a table immediately after text with no blank line", () => {
    // CommonMark requires a blank line before a table in some flavors, but
    // GFM allows tight transition. The parser should handle both.
    const md = "intro text\n| a | b |\n|---|---|\n| c | d |";
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("text");
    expect(blocks[1].type).toBe("table");
  });
});
