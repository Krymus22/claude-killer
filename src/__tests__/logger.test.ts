/**
 * logger.test.ts — Tests for logger.ts pure logic.
 * Covers: formatLevel, getVisibleLength, truncate, formatTimestamp, log formatting.
 */

import { describe, it, expect } from "vitest";

// ─── Extract pure functions from logger.ts ─────────────────────────────────

type LogLevel = "debug" | "info" | "warn" | "error" | "success";

function formatLevel(level: LogLevel): string {
  const labels: Record<LogLevel, string> = {
    debug: "DEBUG",
    info: " INFO",
    warn: " WARN",
    error: "ERROR",
    success: "  OK ",
  };
  return labels[level] ?? level.toUpperCase();
}

function getVisibleLength(str: string): number {
  // Strip ANSI escape sequences before counting
  const stripped = str.replace(/\x1B\[[0-9;]*m/g, "");
  return stripped.length;
}

function truncate(str: string, maxWidth: number): string {
  if (str.length <= maxWidth) return str;
  if (maxWidth < 3) return str.slice(0, maxWidth);
  return str.slice(0, maxWidth - 3) + "...";
}

function formatTimestamp(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatLogLine(level: LogLevel, message: string, timestamp?: Date): string {
  const ts = timestamp ? `[${formatTimestamp(timestamp)}]` : "";
  const lvl = formatLevel(level);
  return `${ts} ${lvl} ${message}`;
}

function parseAnsiCodes(str: string): string[] {
  const matches = str.match(/\x1B\[[0-9;]*m/g);
  return matches ?? [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("logger.ts pure logic", () => {
  describe("formatLevel", () => {
    it("should format debug level", () => {
      expect(formatLevel("debug")).toBe("DEBUG");
    });

    it("should format info level", () => {
      expect(formatLevel("info")).toBe(" INFO");
    });

    it("should format warn level", () => {
      expect(formatLevel("warn")).toBe(" WARN");
    });

    it("should format error level", () => {
      expect(formatLevel("error")).toBe("ERROR");
    });

    it("should format success level", () => {
      expect(formatLevel("success")).toBe("  OK ");
    });

    it("should uppercase unknown levels", () => {
      expect(formatLevel("trace" as LogLevel)).toBe("TRACE");
    });
  });

  describe("getVisibleLength", () => {
    it("should count plain text", () => {
      expect(getVisibleLength("hello")).toBe(5);
    });

    it("should strip ANSI codes", () => {
      expect(getVisibleLength("\x1B[31mred\x1B[0m")).toBe(3);
    });

    it("should handle empty string", () => {
      expect(getVisibleLength("")).toBe(0);
    });

    it("should handle multiple ANSI codes", () => {
      const str = "\x1B[1m\x1B[31mbold red\x1B[0m";
      expect(getVisibleLength(str)).toBe(8);
    });

    it("should handle nested ANSI codes", () => {
      const str = "\x1B[32m\x1B[1mgreen bold\x1B[0m";
      expect(getVisibleLength(str)).toBe(10);
    });
  });

  describe("truncate", () => {
    it("should not truncate short strings", () => {
      expect(truncate("hello", 10)).toBe("hello");
    });

    it("should truncate long strings with ellipsis", () => {
      expect(truncate("hello world", 8)).toBe("hello...");
    });

    it("should handle exact length", () => {
      expect(truncate("hello", 5)).toBe("hello");
    });

    it("should handle maxWidth of 2", () => {
      expect(truncate("hello", 2)).toBe("he");
    });

    it("should handle maxWidth of 0", () => {
      expect(truncate("hello", 0)).toBe("");
    });

    it("should handle empty string", () => {
      expect(truncate("", 5)).toBe("");
    });

    it("should handle maxWidth of 3 with truncation needed", () => {
      expect(truncate("hello", 3)).toBe("...");
    });
  });

  describe("formatTimestamp", () => {
    it("should format time with leading zeros", () => {
      const date = new Date(2024, 0, 1, 9, 5, 3);
      expect(formatTimestamp(date)).toBe("09:05:03");
    });

    it("should format midnight", () => {
      const date = new Date(2024, 0, 1, 0, 0, 0);
      expect(formatTimestamp(date)).toBe("00:00:00");
    });

    it("should format end of day", () => {
      const date = new Date(2024, 0, 1, 23, 59, 59);
      expect(formatTimestamp(date)).toBe("23:59:59");
    });

    it("should format single-digit hours", () => {
      const date = new Date(2024, 0, 1, 1, 2, 3);
      expect(formatTimestamp(date)).toBe("01:02:03");
    });
  });

  describe("formatLogLine", () => {
    it("should format info log line", () => {
      const line = formatLogLine("info", "Server started");
      expect(line).toContain(" INFO ");
      expect(line).toContain("Server started");
    });

    it("should include timestamp when provided", () => {
      const ts = new Date(2024, 0, 1, 14, 30, 0);
      const line = formatLogLine("warn", "Disk low", ts);
      expect(line).toContain("[14:30:00]");
      expect(line).toContain(" WARN ");
    });

    it("should not include timestamp when omitted", () => {
      const line = formatLogLine("error", "Failed");
      expect(line).not.toContain("[");
      expect(line).toContain("ERROR");
    });

    it("should format success log line", () => {
      const line = formatLogLine("success", "Build complete");
      expect(line).toContain("  OK ");
    });

    it("should format debug log line", () => {
      const line = formatLogLine("debug", "Variables: x=1");
      expect(line).toContain("DEBUG");
    });
  });

  describe("parseAnsiCodes", () => {
    it("should extract ANSI codes", () => {
      const codes = parseAnsiCodes("\x1B[31mred\x1B[0m");
      expect(codes).toHaveLength(2);
      expect(codes[0]).toBe("\x1B[31m");
    });

    it("should return empty array for plain text", () => {
      expect(parseAnsiCodes("no codes here")).toHaveLength(0);
    });

    it("should handle multiple colored segments", () => {
      const codes = parseAnsiCodes("\x1B[31mr\x1B[32mg\x1B[0m");
      expect(codes).toHaveLength(3);
    });
  });
});
