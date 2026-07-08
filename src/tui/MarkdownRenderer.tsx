/**
 * MarkdownRenderer.tsx — Renders markdown text as formatted Ink components.
 *
 * Supported markdown features:
 *   - **bold** → <Text bold>
 *   - *italic* → <Text italic>
 *   - ***bold+italic*** → <Text bold italic>
 *   - `inline code` → <Text color="yellow">
 *   - ```code blocks``` → <Box> with colored text
 *   - # Headers → bold + colored (ATX, with optional closing #s)
 *   - - / * / + bullet lists → with • prefix
 *   - 1. numbered lists → with number prefix (preserves start number)
 *   - > blockquotes → indented with │ prefix
 *   - | tables | → aligned with Ink flexbox (handles \| escaped pipes)
 *   - --- / *** / ___ / - - - horizontal rules → ───── line
 *   - [links](url) → colored (handles URLs with balanced parentheses)
 *   - ~~strikethrough~~ → dim text
 *
 * Approach: Custom parser (no `marked` dependency). Parses block elements
 * line-by-line, then inline elements within each line. Uses Ink's flexbox
 * for tables (like Claude Code) instead of ASCII border libraries.
 *
 * Integration: Used by ChatDisplay.tsx for assistant messages only.
 * User messages and tool messages remain plain text.
 *
 * ─── Bug fixes (bug-hunt pass) ────────────────────────────────────────────
 *   - ATX closed headers (`# Title #`) now strip trailing `#`s.
 *   - Header trailing whitespace is trimmed.
 *   - `- - -`, `* * *`, `_ _ _` (space-separated) now recognized as HR.
 *   - Nested inline `**bold *italic* text**` parses as one bold node
 *     (with recursive italic inside).
 *   - `***bold italic***` parses as bold+italic.
 *   - Link URLs with balanced parentheses (e.g. Wikipedia) no longer
 *     truncated at the first `)`.
 *   - `splitTableRow` handles `\\` (escaped backslash) and `\|` (escaped
 *     pipe) correctly.
 *   - Table header renders `colCount` columns (was `rows[0].length`,
 *     missing columns when data rows had more cells than header).
 *   - `padCell` uses Unicode-aware `displayWidth` so CJK / emoji cells
 *     align correctly instead of overflowing.
 *   - `renderHr` guards against negative width (crash when
 *     `process.stdout.columns` is 0 or very small).
 *   - Numbered lists preserve their start number (`5. item` → `5.`, not `1.`).
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { colors } from "./theme.js";

// ─── Types ─────────────────────────────────────────────────────────────────

interface MarkdownBlock {
  type: "text" | "code" | "header" | "table" | "bullet-list" | "numbered-list" | "blockquote" | "hr" | "empty";
  content: string;
  level?: number; // for headers (1-6)
  items?: string[]; // for lists
  rows?: string[][]; // for tables
  aligns?: ("left" | "center" | "right")[]; // for table column alignment
  lang?: string; // for code blocks
  startNumber?: number; // for numbered lists (first item's number)
}

// ─── Unicode display width ─────────────────────────────────────────────────

/**
 * Compute the terminal display width of a string.
 *
 * Unlike `string.length` (which counts UTF-16 code units), this accounts for:
 *   - CJK / fullwidth / emoji characters → width 2
 *   - Combining marks, zero-width chars, variation selectors → width 0
 *   - Control characters → width 0
 *   - Everything else → width 1
 *
 * This is essential for table cell padding — without it, CJK cells like
 * "日本語" (JS length 3, terminal width 6) would be under-padded and
 * break column alignment.
 *
 * This is a minimal implementation covering the common ranges. For full
 * Unicode width compliance, use the `string-width` package (already
 * available as a transitive dependency).
 */
function displayWidth(str: string): number {
  let width = 0;
  // Iterate by code point (not UTF-16 unit) so surrogate pairs (emoji)
  // are handled as a single character.
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0) continue;

    // Control characters (C0 + C1) → 0
    if (code < 0x20 || (code >= 0x7F && code < 0xA0)) continue;

    // Zero-width characters
    if (code >= 0x200B && code <= 0x200F) continue; // zero-width space/joiner/non-joiner
    if (code === 0xFEFF) continue; // BOM / zero-width no-break space

    // Variation selectors (VS1-VS16, VS17-VS256) → 0
    if (code >= 0xFE00 && code <= 0xFE0F) continue;
    if (code >= 0xE0100 && code <= 0xE01EF) continue;

    // Combining Diacritical Marks (simplified — common range)
    if (code >= 0x0300 && code <= 0x036F) continue;

    // CJK / fullwidth / emoji → width 2
    if (
      (code >= 0x1100 && code <= 0x115F) || // Hangul Jamo
      (code >= 0x2329 && code <= 0x232A) || // bracket
      (code >= 0x2E80 && code <= 0xA4CF && code !== 0x303F) || // CJK Radicals-Yi
      (code >= 0xAC00 && code <= 0xD7A3) || // Hangul Syllables
      (code >= 0xF900 && code <= 0xFAFF) || // CJK Compatibility Ideographs
      (code >= 0xFE10 && code <= 0xFE19) || // Vertical forms
      (code >= 0xFE30 && code <= 0xFE6F) || // CJK Compatibility Forms
      (code >= 0xFF00 && code <= 0xFF60) || // Fullwidth Forms
      (code >= 0xFFE0 && code <= 0xFFE6) || // Fullwidth Signs
      (code >= 0x1F300 && code <= 0x1FAFF) || // Symbols & Pictographs + Emoji
      (code >= 0x1F900 && code <= 0x1F9FF) || // Supplemental Symbols
      (code >= 0x20000 && code <= 0x3FFFD) // CJK Extension B-F
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

// ─── Block Parser ─────────────────────────────────────────────────────────

/**
 * Check if a line is a valid closing code fence.
 *
 * Per CommonMark, a closing code fence must be a line containing only
 * backticks (at least as many as the opening fence, but we accept 3+)
 * and optional trailing whitespace. Any other content (e.g. ```` ```javascript ````
 * — backticks followed by a word) is NOT a closing fence and should be
 * preserved as code content.
 *
 * BUG FIX (false-close): previously the parser used
 * `lines[i].trim().startsWith("```")` to detect the closing fence, which
 * incorrectly treated ```` ```javascript ```` as a closing fence. This caused
 * code blocks to be prematurely closed when they contained a line starting
 * with backticks (e.g. an example of a code fence inside a code block).
 */
function isCodeFenceClose(line: string): boolean {
  return /^\s*`{3,}\s*$/.test(line);
}

/**
 * Check if the line at index `i` is the start of a valid GFM table.
 *
 * A table starts when:
 *   1. The current line starts with `|` (we require leading pipes).
 *   2. There is a next line.
 *   3. The next line is a valid table separator (dashes/colons only).
 *
 * Used by both the outer `parseBlocks` loop (to decide whether to enter
 * table-parsing mode) and the inner text-block loop (to decide whether to
 * terminate the current text block so the outer loop can handle the table).
 *
 * BUG FIX (infinite-loop-table): the text-block loop previously used the
 * weaker `lines[i].trim().startsWith("|")` check, which terminated the text
 * block on ANY pipe-prefixed line — including lines that were NOT valid
 * table headers. The outer loop then re-reached the same line without
 * advancing, causing an infinite loop on inputs like
 * `| a | b |\n| c | d |`. Using `isTableStart` instead ensures the text
 * block only yields to a genuine table.
 */
function isTableStart(lines: string[], i: number): boolean {
  if (i + 1 >= lines.length) return false;
  return lines[i].trim().startsWith("|") && isTableSeparator(lines[i + 1].trim());
}

/**
 * Parse markdown text into blocks (block-level elements).
 * Each block is a separate render unit.
 */
function parseBlocks(text: string): MarkdownBlock[] {
  const lines = text.split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Empty line
    if (!line || line.trim() === "") {
      blocks.push({ type: "empty", content: "" });
      i++;
      continue;
    }

    // Code block (```)
    // BUG FIX (lang-bloat): previously `line.trim().slice(3).trim()` returned
    // everything after the opening fence as the lang, so ```` ```ts extra info ````
    // produced lang = "ts extra info" instead of just "ts". CommonMark says the
    // info string's first word is the language; the rest is metadata. Now we
    // split on whitespace and take only the first word.
    //
    // BUG FIX (false-close): previously the closing-fence check
    // `!lines[i].trim().startsWith("```")` treated ANY line starting with ``` as
    // a closing fence, even ```` ```javascript ```` (with content after the
    // backticks). Per CommonMark, a closing fence must be ONLY backticks (+ optional
    // trailing whitespace) — no other content. Now `isCodeFenceClose` enforces that,
    // so a line like ```` ```javascript ```` inside a code block is preserved as
    // code content instead of prematurely closing the block.
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim().split(/\s+/)[0] || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !isCodeFenceClose(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ``` (or advance past end if unclosed)
      blocks.push({ type: "code", content: codeLines.join("\n"), lang });
      continue;
    }

    // Header (# ## ### etc) — ATX style, supports optional closing #s
    // BUG FIX: previously `^(#{1,6})\s+(.+)$` kept trailing `#`s and
    // whitespace in the content (e.g. `# Title #` → "Title #", `# Title   `
    // → "Title   "). Now we strip a CommonMark-compliant closing sequence
    // (one or more `#`s preceded by whitespace) and trailing whitespace.
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      let content = headerMatch[2];
      // Strip optional closing #s (must be preceded by whitespace per CommonMark)
      content = content.replace(/\s+#+\s*$/, "");
      // Trim any remaining trailing whitespace
      content = content.replace(/\s+$/, "");
      blocks.push({
        type: "header",
        content,
        level: headerMatch[1].length,
      });
      i++;
      continue;
    }

    // Horizontal rule
    // BUG FIX: previously `^(-{3,}|\*{3,}|_{3,})\s*$` required 3+
    // CONSECUTIVE same chars. GFM also allows space-separated forms like
    // `- - -`, `* * *`, `_ _ _`. New regex uses a backreference to require
    // the SAME character (3+ times, optionally space-separated).
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: "hr", content: "" });
      i++;
      continue;
    }

    // Table (| ... | ... |)
    // Separator must be a row of cells containing only dashes, colons, spaces.
    if (line.trim().startsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1].trim())) {
      const table = parseTable(lines, i);
      blocks.push(table.block);
      i = table.nextIndex;
      continue;
    }

    // Blockquote (> ...)
    if (line.trim().startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", content: quoteLines.join("\n") });
      continue;
    }

    // Bullet list (- or * or +)
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ type: "bullet-list", content: "", items });
      continue;
    }

    // Numbered list (1. 2. etc)
    // BUG FIX: previously the start number was discarded — `5. item` was
    // rendered as `1. item`. Now we capture the first item's number and
    // preserve it in `startNumber`.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      const firstMatch = line.match(/^\s*(\d+)\.\s+/);
      const startNumber = firstMatch ? parseInt(firstMatch[1], 10) : 1;
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ type: "numbered-list", content: "", items, startNumber });
      continue;
    }

    // Regular text (may span multiple lines until empty line or block element)
    //
    // BUG FIX (infinite-loop-table): previously the loop terminated on ANY
    // line starting with `|`, but if that line was NOT a valid table header
    // (no separator on the next line), the outer `while` loop reached this
    // branch again WITHOUT advancing `i`. Result: infinite loop on inputs
    // like `| a | b |\n| c | d |` (pipe-prefixed text that isn't a table).
    // Now we only terminate the text block when a VALID table starts
    // (`isTableStart`), so non-table pipe lines are consumed as text.
    //
    // BUG FIX (infinite-loop-header): previously the loop terminated on the
    // weak regex `/^(#{1,6})\s+/` (no content required), but the outer loop's
    // header check requires `^(#{1,6})\s+(.+)$` (content required). So a line
    // like `# ` (hash + space, no content) terminated the text block but was
    // NOT consumed by the outer header branch — infinite loop. Now the text
    // block condition uses the same content-requiring regex as the outer loop.
    const textLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trim().startsWith("```") &&
      !/^(#{1,6})\s+.+/.test(lines[i]) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]) &&
      !isTableStart(lines, i) &&
      !lines[i].trim().startsWith(">") &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      textLines.push(lines[i]);
      i++;
    }
    // SAFETY: if the text block produced zero lines (i.e. the current line
    // matched a terminator but the outer loop didn't consume it), force
    // advancement to prevent an infinite loop. This is a defensive guard —
    // the fixes above should make it unreachable, but if a future change
    // re-introduces a mismatch, this keeps the parser total.
    if (textLines.length === 0 && i < lines.length) {
      textLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "text", content: textLines.join("\n") });
  }

  return blocks;
}

/**
 * Check if a line is a valid GFM table separator.
 * A separator row consists of cells containing only dashes, colons, and
 * spaces, with each cell having at least one dash. The line must start
 * and end with `|` (we require leading pipes for table detection).
 *
 * Examples of valid separators:
 *   |---|---|
 *   |:--|:-:|--:|
 *   | --- | :---: |
 *
 * Invalid (not a table):
 *   |abc|def|        (letters in cells)
 *   | | |            (no dashes)
 *   |=-=|=-=|        (equals signs — BUG FIX: previously accepted)
 *
 * BUG FIX (equals-accept): previously the char-class regex was `[ :\-=]+`,
 * which allowed `=` in separator cells. A line like `|=-=|=-=|` was
 * incorrectly detected as a valid separator, so `| a | b |\n|=-=|=-=|`
 * was parsed as a (malformed) table instead of falling back to text.
 * GFM separators must contain only `-`, `:`, and spaces — never `=`.
 * The regex is now `[ :\-]+`.
 *
 * BUG FIX (convoluted-logic): the previous `if (!/^-/.test(trimmed) && ...)`
 * branch was dead-code-heavy and hard to follow. Simplified to a single
 * rule: the trimmed cell must match `^[ :\-]+$` AND contain at least one `-`.
 */
function isTableSeparator(line: string): boolean {
  if (!line.startsWith("|")) return false;
  // Strip leading/trailing pipe, split by unescaped |
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  // Each cell must contain at least one dash and only dashes/colons/spaces
  return cells.every((cell) => {
    const trimmed = cell.trim();
    // Only spaces, colons, dashes are allowed (NOT `=` — GFM spec).
    if (!/^[ :\-]+$/.test(trimmed)) return false;
    // Must contain at least one dash (allow `:-`, `:-:`, `--`, etc.)
    return trimmed.includes("-");
  });
}

/**
 * Parse a GFM table starting at line `startIdx`.
 * Returns the parsed table block and the next line index.
 */
function parseTable(lines: string[], startIdx: number): { block: MarkdownBlock; nextIndex: number } {
  const headerLine = lines[startIdx].trim();
  const separatorLine = lines[startIdx + 1].trim();

  // Parse header cells
  const headerCells = splitTableRow(headerLine);

  // Parse alignment from separator
  const aligns = splitTableRow(separatorLine).map((cell) => {
    const trimmed = cell.trim();
    if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center" as const;
    if (trimmed.endsWith(":")) return "right" as const;
    return "left" as const;
  });

  // Parse data rows
  const rows: string[][] = [headerCells];
  let i = startIdx + 2;
  while (i < lines.length && lines[i].trim().startsWith("|")) {
    rows.push(splitTableRow(lines[i].trim()));
    i++;
  }

  return {
    block: { type: "table", content: "", rows, aligns },
    nextIndex: i,
  };
}

/**
 * Split a table row into cells. Handles escaped pipes (`\|`) and escaped
 * backslashes (`\\`).
 *
 * BUG FIX: previously only `\|` was handled — `\\` (escaped backslash)
 * was treated as `\` + `\|` (escaped pipe), producing wrong cell content
 * like `a\|b` instead of `a\` | `b`. Now `\\` is correctly handled as an
 * escaped backslash (→ single `\`), and only a bare `|` (not preceded by
 * a consuming backslash) is a cell separator.
 */
function splitTableRow(line: string): string[] {
  // Remove leading/trailing pipes (only ONE each — a cell may legally
  // be empty, so we don't strip multiple).
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  let j = 0;
  while (j < trimmed.length) {
    if (trimmed[j] === "\\" && j + 1 < trimmed.length) {
      const next = trimmed[j + 1];
      if (next === "|") {
        // Escaped pipe → literal | in cell
        current += "|";
        j += 2;
      } else if (next === "\\") {
        // Escaped backslash → literal \ in cell
        current += "\\";
        j += 2;
      } else {
        // Backslash followed by other char — keep backslash literally
        // (markdown only escapes special chars; \x stays as \x)
        current += trimmed[j];
        j++;
      }
    } else if (trimmed[j] === "|") {
      cells.push(current.trim());
      current = "";
      j++;
    } else {
      current += trimmed[j];
      j++;
    }
  }
  cells.push(current.trim());
  return cells;
}

// ─── Inline Parser ────────────────────────────────────────────────────────

/**
 * Parse inline markdown and return React nodes.
 * Supports: `code`, `***bold+italic***`, `**bold**`, `*italic*`,
 * `~~strike~~`, `[links](url)`.
 *
 * BUG FIXES:
 *   - Order is now `***` → `**` → `*` so triple-asterisk bold+italic
 *     is matched before plain bold/italic.
 *   - Matchers use non-greedy `.+?` instead of `[^*]+` / `[^~]+` so
 *     nested formatting like `**bold *italic* text**` parses as ONE
 *     bold node (previously the inner `*` broke `[^*]+` and produced
 *     5 garbage nodes).
 *   - Bold content is recursively parsed for nested italic.
 *   - Link regex handles URLs with balanced parentheses (e.g.
 *     `https://en.wikipedia.org/wiki/File_(disambiguation)`).
 */
function renderInline(text: string, keyPrefix: string = ""): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Regex that matches all inline patterns.
  // Order matters: code first (to avoid parsing ** inside `code`),
  // then *** (triple, bold+italic), then ** (bold, before * since **
  // also starts with *), then ~~strike~~, then * italic, then links.
  //
  // `.+?` (non-greedy) is used for bold/italic/strike so that nested
  // formatting tokens don't break the match. For `**bold *italic* text**`,
  // `.+?` spans the inner `*italic*` (which `[^*]+` could not).
  //
  // Link URL allows balanced parens one level deep via
  // `(?:[^()]|\([^()]*\))*`.
  const regex = /(`[^`]+`)|(\*\*\*.+?\*\*\*)|(\*\*.+?\*\*)|(~~.+?~~)|(\*.+?\*)|(\[[^\]]+\]\((?:[^()]|\([^()]*\))*\))/g;
  let lastIndex = 0;
  let match;
  let keyCounter = 0;

  while ((match = regex.exec(text)) !== null) {
    // Add preceding plain text
    if (match.index > lastIndex) {
      nodes.push(
        <Text key={`${keyPrefix}-text-${keyCounter}`}>
          {text.slice(lastIndex, match.index)}
        </Text>
      );
      keyCounter++;
    }

    const token = match[0];

    if (token.startsWith("`")) {
      // Inline code
      nodes.push(
        <Text key={`${keyPrefix}-code-${keyCounter}`} color={colors.warning}>
          {token.slice(1, -1)}
        </Text>
      );
    } else if (token.startsWith("***")) {
      // Bold + italic
      nodes.push(
        <Text key={`${keyPrefix}-bi-${keyCounter}`} bold italic>
          {token.slice(3, -3)}
        </Text>
      );
    } else if (token.startsWith("**")) {
      // Bold — recursively parse content for nested italic / code / links
      nodes.push(
        <Text key={`${keyPrefix}-bold-${keyCounter}`} bold>
          {renderInline(token.slice(2, -2), `${keyPrefix}-bold-${keyCounter}`)}
        </Text>
      );
    } else if (token.startsWith("~~")) {
      // Strikethrough (dim — Ink doesn't have strike, use dim as closest)
      nodes.push(
        <Text key={`${keyPrefix}-strike-${keyCounter}`} color={colors.muted}>
          {token.slice(2, -2)}
        </Text>
      );
    } else if (token.startsWith("*")) {
      // Italic (may not render in all terminals, but Ink supports it)
      nodes.push(
        <Text key={`${keyPrefix}-italic-${keyCounter}`} italic>
          {token.slice(1, -1)}
        </Text>
      );
    } else if (token.startsWith("[")) {
      // Link [text](url) — extract text and url
      const linkMatch = token.match(/\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)/);
      if (linkMatch) {
        nodes.push(
          <Text key={`${keyPrefix}-link-${keyCounter}`} color="blue">
            {linkMatch[1]}
          </Text>
        );
      }
    }

    lastIndex = match.index + token.length;
    keyCounter++;
  }

  // Add remaining plain text
  if (lastIndex < text.length) {
    nodes.push(
      <Text key={`${keyPrefix}-text-${keyCounter}`}>
        {text.slice(lastIndex)}
      </Text>
    );
  }

  // If no inline formatting was found, return the plain text
  if (nodes.length === 0) {
    nodes.push(<Text key={`${keyPrefix}-plain`}>{text}</Text>);
  }

  return nodes;
}

// ─── Block Renderers ──────────────────────────────────────────────────────

function renderHeader(block: MarkdownBlock, key: string): React.ReactNode {
  const level = block.level ?? 1;
  const headerColors = [
    colors.primary,    // # (largest)
    colors.primary,    // ##
    colors.secondary,  // ###
    colors.secondary,  // ####
    colors.muted,      // #####
    colors.muted,      // ######
  ];
  const color = headerColors[Math.min(level - 1, 5)];

  return (
    <Box key={key} flexDirection="column" marginTop={block.level === 1 ? 1 : 0} marginBottom={0}>
      <Text bold color={color}>
        {block.content}
      </Text>
    </Box>
  );
}

function renderCodeBlock(block: MarkdownBlock, key: string): React.ReactNode {
  return (
    <Box key={key} flexDirection="column" marginY={0} marginLeft={2}>
      {block.content.split("\n").map((line, i) => (
        <Text key={`${key}-line-${i}`} color={colors.muted}>
          {line || " "}
        </Text>
      ))}
    </Box>
  );
}

function renderTable(block: MarkdownBlock, key: string): React.ReactNode {
  const rows = block.rows ?? [];
  const aligns = block.aligns ?? [];
  if (rows.length === 0) return null;

  // Calculate column count (max of all rows)
  const colCount = Math.max(...rows.map((r) => r.length));
  // Calculate max display width per column (Unicode-aware)
  // BUG FIX: previously used `cell.length` (UTF-16 units) which
  // under-counted CJK / emoji cells, causing column misalignment.
  const colWidths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let maxWidth = 0;
    for (const row of rows) {
      const cell = row[c] ?? "";
      const w = displayWidth(cell);
      if (w > maxWidth) maxWidth = w;
    }
    colWidths.push(Math.max(maxWidth, 3)); // min width 3
  }

  return (
    <Box key={key} flexDirection="column" marginY={0}>
      {/* Header row — iterates colCount columns (not rows[0].length)
          so columns missing from the header are still rendered as
          empty cells, matching the data row column count. */}
      <Box flexDirection="row">
        {Array.from({ length: colCount }).map((_, c) => (
          <Box key={`${key}-h-${c}`} width={colWidths[c] + 1}>
            <Text bold color={colors.primary}>
              {padCell(rows[0][c] ?? "", colWidths[c], aligns[c] ?? "left")}
            </Text>
          </Box>
        ))}
      </Box>
      {/* Separator (visual only — not a data row) */}
      <Box flexDirection="row">
        {colWidths.map((w, c) => (
          <Box key={`${key}-sep-${c}`} width={w + 1}>
            <Text color={colors.muted}>{"─".repeat(w)}</Text>
          </Box>
        ))}
      </Box>
      {/* Data rows */}
      {rows.slice(1).map((row, r) => (
        <Box key={`${key}-r-${r}`} flexDirection="row">
          {Array.from({ length: colCount }).map((_, c) => (
            <Box key={`${key}-r-${r}-c-${c}`} width={colWidths[c] + 1}>
              <Text>
                {padCell(row[c] ?? "", colWidths[c], aligns[c] ?? "left")}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

/** Pad a cell string to fit the column width with proper alignment.
 *  Uses `displayWidth` so CJK / emoji cells align correctly. */
function padCell(text: string, width: number, align: "left" | "center" | "right"): string {
  const textWidth = displayWidth(text);
  const padCount = Math.max(0, width - textWidth);
  if (align === "right") {
    return " ".repeat(padCount) + text;
  }
  if (align === "center") {
    if (padCount <= 0) return text;
    const leftSpaces = Math.floor(padCount / 2);
    return " ".repeat(leftSpaces) + text + " ".repeat(padCount - leftSpaces);
  }
  // left (default)
  return text + " ".repeat(padCount);
}

function renderBulletList(block: MarkdownBlock, key: string): React.ReactNode {
  const items = block.items ?? [];
  return (
    <Box key={key} flexDirection="column">
      {items.map((item, i) => (
        <Box key={`${key}-item-${i}`} flexDirection="row">
          <Text color={colors.muted}>  • </Text>
          <Box flexDirection="column">
            {renderInline(item, `${key}-item-${i}`)}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function renderNumberedList(block: MarkdownBlock, key: string): React.ReactNode {
  const items = block.items ?? [];
  // BUG FIX: use startNumber so `5. item` renders as `5.` not `1.`
  const start = block.startNumber ?? 1;
  return (
    <Box key={key} flexDirection="column">
      {items.map((item, i) => (
        <Box key={`${key}-item-${i}`} flexDirection="row">
          <Text color={colors.muted}>  {start + i}. </Text>
          <Box flexDirection="column">
            {renderInline(item, `${key}-item-${i}`)}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function renderBlockquote(block: MarkdownBlock, key: string): React.ReactNode {
  const lines = block.content.split("\n");
  return (
    <Box key={key} flexDirection="column" marginY={0}>
      {lines.map((line, i) => (
        <Box key={`${key}-line-${i}`} flexDirection="row">
          <Text color={colors.muted}>  │ </Text>
          <Box flexDirection="column">
            {renderInline(line, `${key}-line-${i}`)}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function renderText(block: MarkdownBlock, key: string): React.ReactNode {
  const lines = block.content.split("\n");
  return (
    <Box key={key} flexDirection="column">
      {lines.map((line, i) => (
        <Box key={`${key}-line-${i}`}>
          <Text>{renderInline(line, `${key}-line-${i}`)}</Text>
        </Box>
      ))}
    </Box>
  );
}

function renderHr(key: string): React.ReactNode {
  // BUG FIX: guard against negative width. When `process.stdout.columns`
  // is 0 or very small (e.g. in some test/non-TTY environments), the
  // old `Math.min(cols - 4, 60)` could produce a negative number, and
  // `"─".repeat(-4)` throws RangeError. Now clamped to at least 1.
  const cols = process.stdout.columns ?? 80;
  const width = Math.max(1, Math.min(cols - 4, 60));
  return (
    <Box key={key} marginY={0}>
      <Text color={colors.muted}>{"─".repeat(width)}</Text>
    </Box>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────

/**
 * Render markdown text as formatted Ink components.
 *
 * Usage:
 *   <MarkdownRenderer text={"## Hello\n\n**bold** and *italic*"} />
 *
 * PERFORMANCE: Wrapped in React.memo so that re-renders with the SAME `text`
 * prop are short-circuited (React skips rendering entirely). This matters
 * for the Static/Live split in ChatDisplay: when a streaming token arrives,
 * the parent ChatDisplay re-renders, which would normally re-render every
 * MarkdownRenderer in the live view (the 3 most-recent non-streaming
 * messages). With React.memo, those non-streaming messages (whose `text`
 * prop is unchanged) skip re-rendering AND re-parsing — only the streaming
 * message (whose `text` changes on every token) actually does work.
 *
 * The internal `useMemo(parseBlocks, [text])` is a second layer of caching:
 * even when the component does re-render (e.g. parent re-rendered for an
 * unrelated reason but `text` is the same string value, not the same
 * reference), parseBlocks is not re-run.
 */
export const MarkdownRenderer = React.memo(function MarkdownRenderer({ text }: { text: string }): React.ReactNode {
  // parseBlocks is the expensive step (line-by-line regex matching). Memoize
  // on `text` so we only re-parse when the content actually changes.
  const blocks = useMemo(() => {
    if (!text || text.trim() === "") return null;
    return parseBlocks(text);
  }, [text]);

  if (blocks === null) {
    return <Text> </Text>;
  }

  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => {
        const key = `md-block-${i}`;

        switch (block.type) {
          case "header":
            return renderHeader(block, key);
          case "code":
            return renderCodeBlock(block, key);
          case "table":
            return renderTable(block, key);
          case "bullet-list":
            return renderBulletList(block, key);
          case "numbered-list":
            return renderNumberedList(block, key);
          case "blockquote":
            return renderBlockquote(block, key);
          case "hr":
            return renderHr(key);
          case "empty":
            return <Text key={key}> </Text>;
          case "text":
          default:
            return renderText(block, key);
        }
      })}
    </Box>
  );
});

// ─── Exports for testing ──────────────────────────────────────────────────

export { parseBlocks, renderInline, splitTableRow, padCell, displayWidth, isTableSeparator, isTableStart, isCodeFenceClose };
