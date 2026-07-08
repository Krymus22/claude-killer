/**
 * markdown-renderer-render.test.tsx — Rendering smoke tests for MarkdownRenderer.
 *
 * This file is SEPARATE from markdown-renderer.test.tsx because
 * ink-testing-library accumulates memory across many `render()` calls
 * in the same test file (each call creates a React reconciler + Yoga
 * node tree that isn't promptly GC'd). Putting 30+ render calls in one
 * file causes OOM. This file keeps the render count low (≤15) so the
 * suite runs reliably.
 *
 * The parsing and helper regression tests live in
 * markdown-renderer.test.tsx (no rendering, no memory pressure).
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { MarkdownRenderer } from "../tui/MarkdownRenderer.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("MarkdownRenderer — Rendering (smoke)", () => {
  it("renders plain text without crash", () => {
    const { lastFrame } = render(<MarkdownRenderer text="Hello world" />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Hello");
    expect(out).toContain("world");
  });

  it("renders empty text gracefully", () => {
    const { lastFrame } = render(<MarkdownRenderer text="" />);
    expect(lastFrame()).toBeDefined();
  });

  it("renders null text gracefully (no crash)", () => {
    const { lastFrame } = render(<MarkdownRenderer text={null as unknown as string} />);
    expect(lastFrame()).toBeDefined();
  });

  it("renders header", () => {
    const { lastFrame } = render(<MarkdownRenderer text="# Big Header" />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Big Header");
  });

  it("renders code block", () => {
    const { lastFrame } = render(<MarkdownRenderer text={"```\nconst x = 1;\n```"} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("const x = 1;");
  });

  it("renders bullet list", () => {
    const { lastFrame } = render(<MarkdownRenderer text={"- item 1\n- item 2"} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("item 1");
    expect(out).toContain("item 2");
  });

  it("renders table with all cells", () => {
    const md = "| Name | Age |\n|------|-----|\n| Alice | 30 |";
    const { lastFrame } = render(<MarkdownRenderer text={md} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Name");
    expect(out).toContain("Age");
    expect(out).toContain("Alice");
    expect(out).toContain("30");
  });

  it("renders horizontal rule", () => {
    const { lastFrame } = render(<MarkdownRenderer text="---" />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("─");
  });

  it("renders space-separated HR (regression)", () => {
    const { lastFrame } = render(<MarkdownRenderer text="* * *" />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("─");
  });

  it("renders ATX closed header (regression)", () => {
    const { lastFrame } = render(<MarkdownRenderer text="# Title #" />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Title");
  });

  it("renders numbered list with start number (regression)", () => {
    const { lastFrame } = render(<MarkdownRenderer text={"5. fifth\n6. sixth"} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("5.");
    expect(out).toContain("fifth");
  });

  it("renders CJK content without crash", () => {
    const { lastFrame } = render(<MarkdownRenderer text="日本語 🎉 café" />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("日本語");
    expect(out).toContain("🎉");
  });

  it("renders table with mismatched columns (regression)", () => {
    const md = "| a | b | c |\n|---|---|---|\n| x | y |";
    const { lastFrame } = render(<MarkdownRenderer text={md} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("a");
    expect(out).toContain("x");
  });

  it("renders nested inline bold+italic (regression)", () => {
    const { lastFrame } = render(<MarkdownRenderer text="**bold *italic* text**" />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("bold");
    expect(out).toContain("italic");
  });
});
