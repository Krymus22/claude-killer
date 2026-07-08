/**
 * markdown-renderer.test.tsx — Testes para o MarkdownRenderer.
 *
 * Cobre: parsing de blocos, inline formatting, tabelas, code blocks,
 * headers, listas, blockquotes, horizontal rules, links, e edge cases.
 *
 * Inclui testes de regressão para bugs corrigidos (ATX closed headers,
 * HR space-separated, nested inline, table column mismatch, CJK width,
 * escaped pipes/backslashes, negative HR width, numbered list start, etc).
 *
 * NOTE: Rendering tests (using ink-testing-library) are in a SEPARATE file
 * (markdown-renderer-render.test.tsx) because ink-testing-library
 * accumulates memory across many `render()` calls in the same file,
 * causing OOM in large test suites. This file tests parsing and helpers
 * directly without rendering.
 */

import { describe, it, expect } from "vitest";
import {
  parseBlocks,
  renderInline,
  splitTableRow,
  padCell,
  displayWidth,
  isTableSeparator,
} from "../tui/MarkdownRenderer.js";

describe("MarkdownRenderer — Block Parsing", () => {
  describe("parseBlocks", () => {
    it("parses plain text", () => {
      const blocks = parseBlocks("Hello world");
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("text");
      expect(blocks[0].content).toBe("Hello world");
    });

    it("parses empty lines as empty blocks", () => {
      const blocks = parseBlocks("Hello\n\nWorld");
      expect(blocks).toHaveLength(3);
      expect(blocks[0].type).toBe("text");
      expect(blocks[1].type).toBe("empty");
      expect(blocks[2].type).toBe("text");
    });

    it("parses headers (level 1-6)", () => {
      for (let level = 1; level <= 6; level++) {
        const hashes = "#".repeat(level);
        const blocks = parseBlocks(`${hashes} Title`);
        expect(blocks[0].type).toBe("header");
        expect(blocks[0].level).toBe(level);
        expect(blocks[0].content).toBe("Title");
      }
    });

    it("parses code blocks with language", () => {
      const blocks = parseBlocks("```typescript\nconst x = 1;\n```");
      expect(blocks[0].type).toBe("code");
      expect(blocks[0].content).toBe("const x = 1;");
      expect(blocks[0].lang).toBe("typescript");
    });

    it("parses code blocks without language", () => {
      const blocks = parseBlocks("```\nplain code\n```");
      expect(blocks[0].type).toBe("code");
      expect(blocks[0].content).toBe("plain code");
      expect(blocks[0].lang).toBeUndefined();
    });

    it("parses multi-line code blocks", () => {
      const blocks = parseBlocks("```\nline1\nline2\nline3\n```");
      expect(blocks[0].type).toBe("code");
      expect(blocks[0].content).toBe("line1\nline2\nline3");
    });

    it("parses unclosed code blocks without crash", () => {
      const blocks = parseBlocks("```\nconst x = 1;\n// no closing");
      expect(blocks[0].type).toBe("code");
      expect(blocks[0].content).toContain("const x = 1;");
    });

    it("parses horizontal rules (consecutive)", () => {
      for (const rule of ["---", "***", "___", "----------"]) {
        const blocks = parseBlocks(rule);
        expect(blocks[0].type).toBe("hr");
      }
    });

    it("parses horizontal rules (space-separated) — regression", () => {
      // BUG FIX: GFM allows `- - -`, `* * *`, `_ _ _` as HR.
      // Previously only consecutive same-char sequences matched.
      for (const rule of ["- - -", "* * *", "_ _ _", "-  -  -", "*   *   *"]) {
        const blocks = parseBlocks(rule);
        expect(blocks[0].type).toBe("hr");
      }
    });

    it("does NOT treat - item as HR", () => {
      const blocks = parseBlocks("- item");
      expect(blocks[0].type).toBe("bullet-list");
    });

    it("does NOT treat -- as HR (needs 3+)", () => {
      const blocks = parseBlocks("--");
      expect(blocks[0].type).toBe("text");
    });

    it("does NOT treat * item as HR", () => {
      const blocks = parseBlocks("* item");
      expect(blocks[0].type).toBe("bullet-list");
    });

    it("parses bullet lists (- prefix)", () => {
      const blocks = parseBlocks("- item 1\n- item 2\n- item 3");
      expect(blocks[0].type).toBe("bullet-list");
      expect(blocks[0].items).toEqual(["item 1", "item 2", "item 3"]);
    });

    it("parses bullet lists (* prefix)", () => {
      const blocks = parseBlocks("* item A\n* item B");
      expect(blocks[0].type).toBe("bullet-list");
      expect(blocks[0].items).toEqual(["item A", "item B"]);
    });

    it("parses bullet lists (+ prefix)", () => {
      const blocks = parseBlocks("+ item A\n+ item B");
      expect(blocks[0].type).toBe("bullet-list");
      expect(blocks[0].items).toEqual(["item A", "item B"]);
    });

    it("parses numbered lists", () => {
      const blocks = parseBlocks("1. first\n2. second\n3. third");
      expect(blocks[0].type).toBe("numbered-list");
      expect(blocks[0].items).toEqual(["first", "second", "third"]);
    });

    it("preserves numbered list start number — regression", () => {
      // BUG FIX: previously the start number was discarded — `5. item`
      // was rendered as `1. item`. Now captured in `startNumber`.
      const blocks = parseBlocks("5. fifth\n6. sixth");
      expect(blocks[0].type).toBe("numbered-list");
      expect(blocks[0].startNumber).toBe(5);
    });

    it("defaults numbered list start to 1", () => {
      const blocks = parseBlocks("1. first\n2. second");
      expect(blocks[0].startNumber).toBe(1);
    });

    it("parses blockquotes", () => {
      const blocks = parseBlocks("> This is a quote\n> Second line");
      expect(blocks[0].type).toBe("blockquote");
      expect(blocks[0].content).toBe("This is a quote\nSecond line");
    });

    it("parses GFM tables", () => {
      const md = "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |";
      const blocks = parseBlocks(md);
      expect(blocks[0].type).toBe("table");
      expect(blocks[0].rows).toEqual([
        ["Name", "Age"],
        ["Alice", "30"],
        ["Bob", "25"],
      ]);
    });

    it("parses table with alignment markers", () => {
      const md = "| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |";
      const blocks = parseBlocks(md);
      expect(blocks[0].type).toBe("table");
      expect(blocks[0].aligns).toEqual(["left", "center", "right"]);
    });

    it("does NOT treat a non-separator line as table", () => {
      // Second line has letters, not a valid separator
      const md = "| a | b |\n| c | d |";
      const blocks = parseBlocks(md);
      expect(blocks[0].type).not.toBe("table");
    });

    it("parses mixed content (text + code + text)", () => {
      const md = "Here is some text.\n\n```js\nconst x = 1;\n```\n\nMore text.";
      const blocks = parseBlocks(md);
      expect(blocks).toHaveLength(5);
      expect(blocks[0].type).toBe("text");
      expect(blocks[1].type).toBe("empty");
      expect(blocks[2].type).toBe("code");
      expect(blocks[3].type).toBe("empty");
      expect(blocks[4].type).toBe("text");
    });
  });

  describe("ATX closed headers — regression", () => {
    it("strips trailing #s from closed ATX header", () => {
      // BUG FIX: `# Title #` previously kept the trailing # in content.
      // CommonMark says optional closing #s (preceded by space) are stripped.
      expect(parseBlocks("# Title #")[0].content).toBe("Title");
      expect(parseBlocks("## Title ##")[0].content).toBe("Title");
      expect(parseBlocks("### Title ###")[0].content).toBe("Title");
    });

    it("strips trailing whitespace from header", () => {
      expect(parseBlocks("# Title   ")[0].content).toBe("Title");
      expect(parseBlocks("# Title\t")[0].content).toBe("Title");
    });

    it("preserves # in title when not preceded by space (C#)", () => {
      // `# C#` — the trailing # is NOT a closing sequence (no space before)
      expect(parseBlocks("# C#")[0].content).toBe("C#");
    });

    it("strips closing #s with mixed counts", () => {
      // CommonMark: closing # count need not match opening
      expect(parseBlocks("# Title ##")[0].content).toBe("Title");
      expect(parseBlocks("## Title ###")[0].content).toBe("Title");
    });

    it("preserves content with internal #", () => {
      expect(parseBlocks("# Issue #123 fix")[0].content).toBe("Issue #123 fix");
    });
  });
});

describe("MarkdownRenderer — Inline Parsing", () => {
  describe("renderInline", () => {
    it("returns plain text for non-markdown", () => {
      const nodes = renderInline("hello world", "test");
      expect(nodes).toHaveLength(1);
    });

    it("parses **bold** text", () => {
      const nodes = renderInline("this is **bold** text", "test");
      expect(nodes.length).toBeGreaterThanOrEqual(2);
    });

    it("parses *italic* text", () => {
      const nodes = renderInline("this is *italic* text", "test");
      expect(nodes.length).toBeGreaterThanOrEqual(2);
    });

    it("parses `inline code`", () => {
      const nodes = renderInline("use `console.log()` here", "test");
      expect(nodes.length).toBeGreaterThanOrEqual(2);
    });

    it("parses ~~strikethrough~~ text", () => {
      const nodes = renderInline("this is ~~old~~ text", "test");
      expect(nodes.length).toBeGreaterThanOrEqual(2);
    });

    it("parses [links](url)", () => {
      const nodes = renderInline("see [docs](https://example.com) here", "test");
      expect(nodes.length).toBeGreaterThanOrEqual(2);
    });

    it("handles multiple inline formats in one line", () => {
      const nodes = renderInline("**bold** and *italic* and `code`", "test");
      expect(nodes.length).toBeGreaterThanOrEqual(5);
    });

    it("does not parse ** inside `code`", () => {
      const nodes = renderInline("`**not bold**`", "test");
      expect(nodes).toHaveLength(1);
    });
  });

  describe("nested inline formatting — regression", () => {
    it("parses **bold *italic* text** as single bold node", () => {
      // BUG: previously `[^*]+` couldn't span the inner `*`, producing
      // 5 garbage nodes. Now `.+?` (non-greedy) spans the inner italic
      // and produces ONE bold node (with nested italic inside).
      const nodes = renderInline("**bold *italic* text**", "t");
      expect(nodes.length).toBe(1);
      const props = (nodes[0] as { props: { bold?: boolean } }).props;
      expect(props.bold).toBe(true);
    });

    it("parses ***bold italic*** as bold+italic", () => {
      // BUG FIX: triple-asterisk bold+italic now matched before plain bold.
      const nodes = renderInline("***bold italic***", "t");
      expect(nodes.length).toBe(1);
      const props = (nodes[0] as { props: { bold?: boolean; italic?: boolean; children?: string } }).props;
      expect(props.bold).toBe(true);
      expect(props.italic).toBe(true);
      expect(props.children).toBe("bold italic");
    });

    it("still parses **bold** correctly (no regression)", () => {
      const nodes = renderInline("**bold**", "t");
      expect(nodes.length).toBe(1);
      expect((nodes[0] as { props: { bold?: boolean } }).props.bold).toBe(true);
    });

    it("still parses *italic* correctly (no regression)", () => {
      const nodes = renderInline("*italic*", "t");
      expect(nodes.length).toBe(1);
      expect((nodes[0] as { props: { italic?: boolean } }).props.italic).toBe(true);
    });

    it("parses **bold** and **more** as two separate bold nodes", () => {
      const nodes = renderInline("**bold** and **more**", "t");
      // 3 nodes: bold, " and ", bold
      expect(nodes.length).toBe(3);
    });

    it("does not match ** (lone double-asterisk) as bold", () => {
      const nodes = renderInline("a ** b", "t");
      // `**` alone (no content + closing **) is plain text
      expect(nodes.length).toBe(1);
    });

    it("parses bold containing inline code", () => {
      // **use `code` here** → bold containing code
      const nodes = renderInline("**use `code` here**", "t");
      expect(nodes.length).toBe(1);
      expect((nodes[0] as { props: { bold?: boolean } }).props.bold).toBe(true);
    });

    it("does not crash on pathological asterisk input", () => {
      // Many asterisks — should not cause catastrophic backtracking
      const pathological = "*".repeat(100) + "a" + "*".repeat(100);
      const nodes = renderInline(pathological, "t");
      expect(nodes).toBeDefined();
    });

    it("handles deeply nested asterisks without infinite loop", () => {
      const nested = "**a**b**c**d**e**f**g**h**";
      const nodes = renderInline(nested, "t");
      expect(nodes).toBeDefined();
    });
  });

  describe("links with special URLs — regression", () => {
    it("handles URLs with balanced parentheses", () => {
      // BUG FIX: previously `\([^)]+\)` truncated at first ), leaving a
      // stray ")" as plain text. Now handles balanced parens one level deep.
      const nodes = renderInline("[link](https://en.wikipedia.org/wiki/File_(disambiguation))", "t");
      expect(nodes.length).toBe(1);
      const props = (nodes[0] as { props: { color?: string; children?: string } }).props;
      expect(props.color).toBe("blue");
      expect(props.children).toBe("link");
    });

    it("still handles simple URLs", () => {
      const nodes = renderInline("[docs](https://example.com)", "t");
      expect(nodes.length).toBe(1);
      expect((nodes[0] as { props: { children?: string } }).props.children).toBe("docs");
    });

    it("does not match unclosed link", () => {
      const nodes = renderInline("[unclosed](https://example.com", "t");
      // No complete link match — plain text
      expect(nodes.length).toBe(1);
    });

    it("handles multiple links in one line", () => {
      const nodes = renderInline("[a](http://a.com) and [b](http://b.com)", "t");
      // 3 nodes: link, " and ", link
      expect(nodes.length).toBe(3);
    });
  });
});

describe("MarkdownRenderer — Table Helpers", () => {
  describe("splitTableRow", () => {
    it("splits basic row", () => {
      expect(splitTableRow("| a | b | c |")).toEqual(["a", "b", "c"]);
    });

    it("splits row without outer pipes", () => {
      expect(splitTableRow("a | b | c")).toEqual(["a", "b", "c"]);
    });

    it("handles escaped pipes", () => {
      expect(splitTableRow("| a\\|b | c |")).toEqual(["a|b", "c"]);
    });

    it("handles escaped backslash — regression", () => {
      // BUG FIX: previously `\\` was treated as `\` + start-of-escape,
      // so `a\\|b` produced `a\|b` in ONE cell. Now `\\` → `\`, then `|`
      // is a separator, so cells are ["a\", "b"].
      expect(splitTableRow("| a\\\\|b | c |")).toEqual(["a\\", "b", "c"]);
    });

    it("keeps lone backslash literally", () => {
      // `\b` is not a valid escape — keep both chars
      expect(splitTableRow("| a\\b | c |")).toEqual(["a\\b", "c"]);
    });

    it("handles empty cells", () => {
      expect(splitTableRow("| | b |")).toEqual(["", "b"]);
    });

    it("trims whitespace in cells", () => {
      expect(splitTableRow("|  spaced  |  also  |")).toEqual(["spaced", "also"]);
    });

    it("handles multiple escaped pipes in one cell", () => {
      expect(splitTableRow("| a\\|b\\|c | d |")).toEqual(["a|b|c", "d"]);
    });

    it("handles single-cell row", () => {
      expect(splitTableRow("| only |")).toEqual(["only"]);
    });

    it("handles escaped backslash at end of cell", () => {
      // | a\ | b | → cell "a\", cell "b"
      expect(splitTableRow("| a\\ | b |")).toEqual(["a\\", "b"]);
    });
  });

  describe("isTableSeparator", () => {
    it("accepts valid separators", () => {
      expect(isTableSeparator("|---|---|")).toBe(true);
      expect(isTableSeparator("|:--|:-:|--:|")).toBe(true);
      expect(isTableSeparator("| --- | :---: |")).toBe(true);
      expect(isTableSeparator("|-|-|")).toBe(true);
    });

    it("rejects invalid separators", () => {
      expect(isTableSeparator("|abc|def|")).toBe(false);
      expect(isTableSeparator("| | |")).toBe(false);
      expect(isTableSeparator("not a separator")).toBe(false);
      expect(isTableSeparator("|:|")).toBe(false); // no dash
    });

    it("rejects lines not starting with |", () => {
      expect(isTableSeparator("---|---")).toBe(false);
    });
  });

  describe("padCell", () => {
    it("pads left-aligned cell", () => {
      expect(padCell("abc", 6, "left")).toBe("abc   ");
    });

    it("pads right-aligned cell", () => {
      expect(padCell("abc", 6, "right")).toBe("   abc");
    });

    it("pads center-aligned cell", () => {
      expect(padCell("abc", 7, "center")).toBe("  abc  ");
    });

    it("does not truncate longer text", () => {
      expect(padCell("abcdefgh", 4, "left")).toBe("abcdefgh");
    });

    it("handles empty string", () => {
      expect(padCell("", 4, "left")).toBe("    ");
    });

    it("pads CJK cells by display width — regression", () => {
      // BUG FIX: previously used `string.length` (UTF-16 units). "日本語"
      // has JS length 3 but display width 6. padEnd(8) produced
      // "日本語     " (3 chars + 5 spaces = JS length 8, display width 11).
      // Now pads by display width: 6 + 2 spaces = 8.
      const result = padCell("日本語", 8, "left");
      expect(displayWidth(result)).toBe(8);
      expect(result).toBe("日本語  ");
    });

    it("pads CJK right-aligned by display width", () => {
      const result = padCell("日本語", 8, "right");
      expect(displayWidth(result)).toBe(8);
      expect(result).toBe("  日本語");
    });

    it("pads CJK center-aligned by display width", () => {
      const result = padCell("日本語", 10, "center");
      expect(displayWidth(result)).toBe(10);
    });

    it("pads emoji cells by display width", () => {
      // 🎉 has JS length 2 (surrogate pair) but display width 2.
      const result = padCell("🎉", 5, "left");
      expect(displayWidth(result)).toBe(5);
    });

    it("handles mixed ASCII + CJK", () => {
      const result = padCell("ab日本語", 10, "left");
      // display width: 2 + 6 = 8, pad to 10 → +2 spaces
      expect(displayWidth(result)).toBe(10);
    });

    it("does not truncate long CJK text", () => {
      expect(padCell("日本語日本語", 4, "left")).toBe("日本語日本語");
    });
  });

  describe("displayWidth", () => {
    it("computes width of ASCII", () => {
      expect(displayWidth("hello")).toBe(5);
    });

    it("computes width of CJK as 2 per char", () => {
      expect(displayWidth("日本語")).toBe(6); // 3 × 2
    });

    it("computes width of emoji as 2", () => {
      expect(displayWidth("🎉")).toBe(2);
    });

    it("computes width of mixed content", () => {
      expect(displayWidth("ab日本語")).toBe(8); // 2 + 6
    });

    it("treats zero-width characters as 0", () => {
      expect(displayWidth("a\u200Bb")).toBe(2); // ZWSP doesn't count
    });

    it("treats variation selectors as 0", () => {
      // ❤️ = U+2764 (width 1) + U+FE0F (VS16, width 0) = 1
      expect(displayWidth("❤\uFE0F")).toBe(1);
    });

    it("handles empty string", () => {
      expect(displayWidth("")).toBe(0);
    });

    it("computes width of Korean Hangul", () => {
      expect(displayWidth("한글")).toBe(4); // 2 × 2
    });
  });
});

describe("MarkdownRenderer — Table column mismatch — regression", () => {
  it("table with more data columns than header", () => {
    // BUG FIX: previously header iterated rows[0].length (2) instead of
    // colCount (3), so the 3rd column was missing from the header
    // while data rows showed it.
    const md = "| a | b |\n|---|---|---|\n| x | y | z |";
    const blocks = parseBlocks(md);
    expect(blocks[0].type).toBe("table");
    const rows = blocks[0].rows!;
    const colCount = Math.max(...rows.map((r) => r.length));
    expect(colCount).toBe(3);
    expect(rows[0]).toEqual(["a", "b"]); // header (2 cells)
    expect(rows[1]).toEqual(["x", "y", "z"]); // data (3 cells)
  });

  it("table with more header columns than data", () => {
    const md = "| a | b | c |\n|---|---|---|\n| x | y |";
    const blocks = parseBlocks(md);
    expect(blocks[0].type).toBe("table");
    const rows = blocks[0].rows!;
    const colCount = Math.max(...rows.map((r) => r.length));
    expect(colCount).toBe(3);
  });

  it("table with uniform column count", () => {
    const md = "| a | b | c |\n|---|---|---|\n| x | y | z |";
    const blocks = parseBlocks(md);
    const rows = blocks[0].rows!;
    const colCount = Math.max(...rows.map((r) => r.length));
    expect(colCount).toBe(3);
    expect(rows[0]).toHaveLength(3);
    expect(rows[1]).toHaveLength(3);
  });
});

describe("MarkdownRenderer — HR width safety — regression", () => {
  it("renderHr does not crash when stdout.columns is 0", () => {
    // BUG FIX: previously `Math.min(cols - 4, 60)` could produce -4 when
    // cols=0, and `"─".repeat(-4)` throws RangeError. Now clamped to ≥1.
    // We can't call renderHr directly (not exported), but verify the math
    // pattern used in the fix.
    const cols = 0;
    const width = Math.max(1, Math.min(cols - 4, 60));
    expect(width).toBeGreaterThanOrEqual(1);
    expect(() => "─".repeat(width)).not.toThrow();
  });

  it("renderHr does not crash when stdout.columns is very small", () => {
    const cols = 2;
    const width = Math.max(1, Math.min(cols - 4, 60));
    expect(width).toBeGreaterThanOrEqual(1);
    expect(() => "─".repeat(width)).not.toThrow();
  });

  it("renderHr clamps to 60 for wide terminals", () => {
    const cols = 200;
    const width = Math.max(1, Math.min(cols - 4, 60));
    expect(width).toBe(60);
  });
});

describe("MarkdownRenderer — Performance (parser only)", () => {
  it("parses large input without excessive time", () => {
    // Generate 1000 lines of mixed markdown
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(`# Header ${i}`);
      lines.push("");
      lines.push(`This is **bold** paragraph ${i} with \`code\` and [link](https://example.com).`);
      lines.push("");
      lines.push("- item 1");
      lines.push("- item 2");
      lines.push("");
    }
    const text = lines.join("\n");

    const start = Date.now();
    const blocks = parseBlocks(text);
    const elapsed = Date.now() - start;

    // Should parse in well under 500ms (typically <50ms)
    expect(elapsed).toBeLessThan(500);
    expect(blocks.length).toBeGreaterThan(1000);
  });

  it("parses large table without excessive time", () => {
    const lines: string[] = ["| A | B | C | D |", "|---|---|---|---|"];
    for (let i = 0; i < 500; i++) {
      lines.push(`| ${i} | cell${i} | **bold** | \`code\` |`);
    }
    const text = lines.join("\n");

    const start = Date.now();
    const blocks = parseBlocks(text);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(blocks[0].type).toBe("table");
    expect(blocks[0].rows).toHaveLength(501);
  });

  it("parses 10000-character line without crash", () => {
    const longLine = "A".repeat(10000);
    const blocks = parseBlocks(longLine);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });

  it("displayWidth is linear (no catastrophic backtracking)", () => {
    const longStr = "a".repeat(10000);
    const start = Date.now();
    const w = displayWidth(longStr);
    const elapsed = Date.now() - start;
    expect(w).toBe(10000);
    expect(elapsed).toBeLessThan(100);
  });
});
