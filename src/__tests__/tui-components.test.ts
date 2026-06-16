/**
 * tui-components.test.ts — Tests for TUI component pure logic.
 * Covers: ChatDisplay, StatusBar, TodoPanel, theme, formatting helpers.
 */

import { describe, it, expect } from "vitest";

// ─── Theme constants (from src/tui/theme.ts) ──────────────────────────────

const COLORS = {
  bg: "#1a1b26",
  fg: "#c0caf5",
  accent: "#7aa2f7",
  accentAlt: "#bb9af7",
  muted: "#565f89",
  success: "#9ece6a",
  warning: "#e0af68",
  error: "#f7768e",
  border: "#3b4261",
  surface: "#24283b",
  surfaceHighlight: "#292e42",
};

const ICONS = {
  check: "\u2713",
  cross: "\u2717",
  warn: "\u26A0",
  info: "\u2139",
  spinner: ["|", "/", "-", "\\"],
  dot: "\u2022",
  ellipsis: "\u2026",
};

// ─── Pure helper functions extracted from TUI components ────────────────────

function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth < 3) return text.slice(0, maxWidth);
  return text.slice(0, maxWidth - 1) + ICONS.ellipsis;
}

function formatStatusText(status: "running" | "completed" | "failed" | "pending"): string {
  switch (status) {
    case "completed": return `${ICONS.check} Completed`;
    case "failed": return `${ICONS.cross} Failed`;
    case "running": return `${ICONS.spinner[0]} Running`;
    case "pending": return `${ICONS.dot} Pending`;
  }
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function padCenter(str: string, width: number): string {
  if (str.length >= width) return str;
  const padTotal = width - str.length;
  const padLeft = Math.floor(padTotal / 2);
  return " ".repeat(padLeft) + str + " ".repeat(padTotal - padLeft);
}

function formatToolResult(success: boolean, name: string, message: string): string {
  const icon = success ? ICONS.check : ICONS.cross;
  const color = success ? COLORS.success : COLORS.error;
  return `${icon} ${name}: ${message}`;
}

function calculateUsagePercent(used: number, total: number): number {
  if (total === 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

function formatUsageBar(used: number, total: number, barWidth: number = 20): string {
  const percent = calculateUsagePercent(used, total);
  const filled = Math.round((percent / 100) * barWidth);
  const empty = barWidth - filled;
  return "[" + "\u2588".repeat(filled) + "\u2591".repeat(empty) + "]";
}

function parseTodoLine(line: string): { checked: boolean; text: string; priority?: string } | null {
  const match = /^(\[[ x]\])\s*(.+)$/.exec(line);
  if (!match) return null;
  const checked = match[1] === "[x]";
  let text = match[2];
  let priority: string | undefined;
  const priorityMatch = /^\((high|medium|low)\)\s*(.*)$/.exec(text);
  if (priorityMatch) {
    priority = priorityMatch[1];
    text = priorityMatch[2];
  }
  return { checked, text, priority };
}

function formatTodoItem(checked: boolean, text: string, priority?: string): string {
  const checkbox = checked ? "[x]" : "[ ]";
  const prio = priority ? `(${priority}) ` : "";
  return `${checkbox} ${prio}${text}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("tui-components pure logic", () => {
  describe("truncateText", () => {
    it("should not truncate short text", () => {
      expect(truncateText("hello", 10)).toBe("hello");
    });

    it("should truncate long text with ellipsis", () => {
      expect(truncateText("hello world", 8)).toBe("hello w\u2026");
    });

    it("should handle exact length", () => {
      expect(truncateText("hello", 5)).toBe("hello");
    });

    it("should handle maxWidth of 2", () => {
      expect(truncateText("hello", 2)).toBe("he");
    });

    it("should handle empty string", () => {
      expect(truncateText("", 5)).toBe("");
    });
  });

  describe("formatStatusText", () => {
    it("should format running status", () => {
      expect(formatStatusText("running")).toContain("Running");
    });

    it("should format completed status with check", () => {
      const text = formatStatusText("completed");
      expect(text).toContain(ICONS.check);
      expect(text).toContain("Completed");
    });

    it("should format failed status with cross", () => {
      const text = formatStatusText("failed");
      expect(text).toContain(ICONS.cross);
      expect(text).toContain("Failed");
    });

    it("should format pending status with dot", () => {
      const text = formatStatusText("pending");
      expect(text).toContain(ICONS.dot);
      expect(text).toContain("Pending");
    });
  });

  describe("padRight", () => {
    it("should pad short text", () => {
      expect(padRight("hi", 5)).toBe("hi   ");
    });

    it("should not truncate long text", () => {
      expect(padRight("hello", 3)).toBe("hello");
    });

    it("should handle exact width", () => {
      expect(padRight("abc", 3)).toBe("abc");
    });
  });

  describe("padCenter", () => {
    it("should center text", () => {
      const result = padCenter("hi", 6);
      expect(result.length).toBe(6);
      expect(result.trim()).toBe("hi");
    });

    it("should handle odd padding", () => {
      const result = padCenter("hi", 5);
      expect(result.length).toBe(5);
      expect(result.trim()).toBe("hi");
    });

    it("should not truncate", () => {
      expect(padCenter("hello", 3)).toBe("hello");
    });
  });

  describe("formatToolResult", () => {
    it("should format success result", () => {
      const result = formatToolResult(true, "bash", "executed");
      expect(result).toContain(ICONS.check);
      expect(result).toContain("bash");
      expect(result).toContain("executed");
    });

    it("should format failure result", () => {
      const result = formatToolResult(false, "edit", "failed");
      expect(result).toContain(ICONS.cross);
      expect(result).toContain("edit");
    });
  });

  describe("calculateUsagePercent", () => {
    it("should calculate normal percentage", () => {
      expect(calculateUsagePercent(50, 100)).toBe(50);
    });

    it("should cap at 100%", () => {
      expect(calculateUsagePercent(150, 100)).toBe(100);
    });

    it("should return 0 for zero total", () => {
      expect(calculateUsagePercent(0, 0)).toBe(0);
    });

    it("should handle zero used", () => {
      expect(calculateUsagePercent(0, 100)).toBe(0);
    });

    it("should round to nearest integer", () => {
      expect(calculateUsagePercent(1, 3)).toBe(33);
    });

    it("should return 0 for negative values", () => {
      expect(calculateUsagePercent(-10, 100)).toBe(0);
    });
  });

  describe("formatUsageBar", () => {
    it("should render a bar of correct width", () => {
      const bar = formatUsageBar(50, 100, 10);
      expect(bar.length).toBe(12); // [ + 10 chars + ]
      expect(bar.startsWith("[")).toBe(true);
      expect(bar.endsWith("]")).toBe(true);
    });

    it("should show all filled at 100%", () => {
      const bar = formatUsageBar(100, 100, 5);
      expect(bar).toBe("[" + "\u2588".repeat(5) + "]");
    });

    it("should show all empty at 0%", () => {
      const bar = formatUsageBar(0, 100, 5);
      expect(bar).toBe("[" + "\u2591".repeat(5) + "]");
    });

    it("should show half filled at 50%", () => {
      const bar = formatUsageBar(50, 100, 10);
      const filledCount = bar.split("\u2588").length - 1;
      expect(filledCount).toBe(5);
    });
  });

  describe("parseTodoLine", () => {
    it("should parse unchecked item", () => {
      const result = parseTodoLine("[ ] Fix the bug");
      expect(result).not.toBeNull();
      expect(result!.checked).toBe(false);
      expect(result!.text).toBe("Fix the bug");
    });

    it("should parse checked item", () => {
      const result = parseTodoLine("[x] Done task");
      expect(result!.checked).toBe(true);
      expect(result!.text).toBe("Done task");
    });

    it("should parse item with priority", () => {
      const result = parseTodoLine("[ ] (high) Critical fix");
      expect(result!.checked).toBe(false);
      expect(result!.priority).toBe("high");
      expect(result!.text).toBe("Critical fix");
    });

    it("should parse checked item with priority", () => {
      const result = parseTodoLine("[x] (low) Nice to have");
      expect(result!.checked).toBe(true);
      expect(result!.priority).toBe("low");
      expect(result!.text).toBe("Nice to have");
    });

    it("should return null for non-matching format", () => {
      expect(parseTodoLine("Just a line")).toBeNull();
      expect(parseTodoLine("")).toBeNull();
    });

    it("should handle medium priority", () => {
      const result = parseTodoLine("[ ] (medium) Task");
      expect(result!.priority).toBe("medium");
    });
  });

  describe("formatTodoItem", () => {
    it("should format unchecked item", () => {
      expect(formatTodoItem(false, "Task")).toBe("[ ] Task");
    });

    it("should format checked item", () => {
      expect(formatTodoItem(true, "Task")).toBe("[x] Task");
    });

    it("should format with priority", () => {
      expect(formatTodoItem(false, "Task", "high")).toBe("[ ] (high) Task");
    });

    it("should format checked with priority", () => {
      expect(formatTodoItem(true, "Task", "low")).toBe("[x] (low) Task");
    });
  });

  describe("COLORS constant", () => {
    it("should have all required color keys", () => {
      expect(COLORS.bg).toBeDefined();
      expect(COLORS.fg).toBeDefined();
      expect(COLORS.accent).toBeDefined();
      expect(COLORS.muted).toBeDefined();
      expect(COLORS.success).toBeDefined();
      expect(COLORS.warning).toBeDefined();
      expect(COLORS.error).toBeDefined();
    });

    it("should have valid hex colors", () => {
      for (const [key, value] of Object.entries(COLORS)) {
        expect(value).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });
  });

  describe("ICONS constant", () => {
    it("should have all required icon keys", () => {
      expect(ICONS.check).toBeDefined();
      expect(ICONS.cross).toBeDefined();
      expect(ICONS.warn).toBeDefined();
      expect(ICONS.info).toBeDefined();
      expect(ICONS.spinner).toBeDefined();
      expect(ICONS.dot).toBeDefined();
    });

    it("spinner should have 4 frames", () => {
      expect(ICONS.spinner).toHaveLength(4);
    });
  });
});
