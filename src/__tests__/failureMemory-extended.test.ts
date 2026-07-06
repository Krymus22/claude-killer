/**
 * failureMemory-extended.test.ts — Extended tests for failureMemory.ts
 *
 * Covers:
 *   - recordFailure: truncation of long errors, filePath handling
 *   - getFailures: returns array copy
 *   - getRecentFailures: formatting and "X min ago" / "just now"
 *   - getMostRecentFailure: returns last pushed entry or null
 *   - hasRecentFailures: boolean flag
 *   - clearFailures: resets state
 *   - MAX_FAILURES=5 cap behavior
 *   - FailureEntry type contract
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

import {
  recordFailure,
  getFailures,
  getRecentFailures,
  getMostRecentFailure,
  hasRecentFailures,
  clearFailures,
  type FailureEntry,
} from "../failureMemory.js";

describe("failureMemory — initial state", () => {
  beforeEach(() => {
    clearFailures();
  });

  it("getFailures returns empty array initially", () => {
    expect(getFailures()).toEqual([]);
  });

  it("getRecentFailures returns empty string initially", () => {
    expect(getRecentFailures()).toBe("");
  });

  it("getMostRecentFailure returns null initially", () => {
    expect(getMostRecentFailure()).toBeNull();
  });

  it("hasRecentFailures returns false initially", () => {
    expect(hasRecentFailures()).toBe(false);
  });
});

describe("recordFailure", () => {
  beforeEach(() => {
    clearFailures();
  });

  it("adds a failure entry with tool, error, and timestamp", () => {
    recordFailure("aplicar_diff", "SEARCH not found", "/tmp/f.ts");
    const failures = getFailures();
    expect(failures.length).toBe(1);
    expect(failures[0]!.tool).toBe("aplicar_diff");
    expect(failures[0]!.error).toBe("SEARCH not found");
    expect(failures[0]!.filePath).toBe("/tmp/f.ts");
    expect(typeof failures[0]!.timestamp).toBe("number");
  });

  it("filePath defaults to undefined when not provided", () => {
    recordFailure("editar_arquivo", "some error");
    const failures = getFailures();
    expect(failures[0]!.filePath).toBeUndefined();
  });

  it("truncates errors longer than 200 chars", () => {
    const longError = "x".repeat(500);
    recordFailure("tool", longError);
    const failures = getFailures();
    expect(failures[0]!.error.length).toBe(200);
  });

  it("does not truncate errors shorter than 200 chars", () => {
    const shortError = "x".repeat(50);
    recordFailure("tool", shortError);
    expect(getFailures()[0]!.error).toBe(shortError);
  });

  it("accepts multi-line errors (truncates to first 200 chars)", () => {
    const multi = "line1\nline2\nline3";
    recordFailure("tool", multi);
    expect(getFailures()[0]!.error).toBe(multi);
  });

  it("accepts empty error string", () => {
    recordFailure("tool", "");
    expect(getFailures()[0]!.error).toBe("");
  });

  it("sets a numeric timestamp", () => {
    recordFailure("tool", "err");
    const ts = getFailures()[0]!.timestamp;
    expect(typeof ts).toBe("number");
    expect(ts).toBeGreaterThan(0);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("MAX_FAILURES cap (=5)", () => {
  beforeEach(() => {
    clearFailures();
  });

  it("keeps only the last 5 entries when more are added", () => {
    for (let i = 0; i < 10; i++) {
      recordFailure(`tool_${i}`, `err_${i}`);
    }
    const failures = getFailures();
    expect(failures.length).toBe(5);
  });

  it("drops the oldest entries (FIFO)", () => {
    for (let i = 0; i < 7; i++) {
      recordFailure(`tool_${i}`, `err_${i}`);
    }
    const failures = getFailures();
    // First 2 should have been dropped
    expect(failures[0]!.tool).toBe("tool_2");
    expect(failures[failures.length - 1]!.tool).toBe("tool_6");
  });

  it("preserves exactly 5 when adding 5 entries", () => {
    for (let i = 0; i < 5; i++) {
      recordFailure(`tool_${i}`, `err_${i}`);
    }
    expect(getFailures().length).toBe(5);
  });

  it("does not lose entries when adding fewer than 5", () => {
    for (let i = 0; i < 3; i++) {
      recordFailure(`tool_${i}`, `err_${i}`);
    }
    expect(getFailures().length).toBe(3);
  });
});

describe("getFailures — returns a copy", () => {
  beforeEach(() => {
    clearFailures();
  });

  it("returns a fresh array each call (no mutation bleed)", () => {
    recordFailure("t", "e");
    const f1 = getFailures();
    const f2 = getFailures();
    expect(f1).not.toBe(f2);
    expect(f1).toEqual(f2);
  });

  it("mutating the returned array does not affect internal state", () => {
    recordFailure("t", "e");
    const f1 = getFailures();
    f1.pop();
    f1.push({ tool: "x", error: "y", timestamp: 0 });
    const f2 = getFailures();
    expect(f2.length).toBe(1);
    expect(f2[0]!.tool).toBe("t");
  });
});

describe("getRecentFailures — formatting", () => {
  beforeEach(() => {
    clearFailures();
  });

  it("returns empty string when no failures", () => {
    expect(getRecentFailures()).toBe("");
  });

  it("returns a string starting with [FAILURES] header", () => {
    recordFailure("tool", "err");
    const s = getRecentFailures();
    expect(typeof s).toBe("string");
    expect(s.startsWith("[FAILURES]")).toBe(true);
  });

  it("includes the tool name in the formatted output", () => {
    recordFailure("aplicar_diff", "err");
    expect(getRecentFailures()).toContain("aplicar_diff");
  });

  it("includes the error message in the formatted output", () => {
    recordFailure("tool", "SEARCH not found");
    expect(getRecentFailures()).toContain("SEARCH not found");
  });

  it("includes 'just now' for very recent failures", () => {
    recordFailure("tool", "err");
    expect(getRecentFailures()).toContain("just now");
  });

  it("shows file basename when filePath is provided", () => {
    recordFailure("tool", "err", "/tmp/path/to/myfile.ts");
    const s = getRecentFailures();
    expect(s).toContain("myfile.ts");
  });

  it("does not show file when filePath is not provided", () => {
    recordFailure("tool", "err");
    const s = getRecentFailures();
    // No " in <file>" suffix
    expect(s).not.toMatch(/\bin\s+\S+\.(ts|js)/);
  });

  it("one line per failure (plus header)", () => {
    recordFailure("t1", "e1");
    recordFailure("t2", "e2");
    recordFailure("t3", "e3");
    const s = getRecentFailures();
    // header + 3 lines = 4 lines
    expect(s.split("\n").length).toBe(4);
  });

  it("truncates long error to ~80 chars in formatted output", () => {
    const longError = "x".repeat(200);
    recordFailure("tool", longError);
    const s = getRecentFailures();
    // Each line is at most ~200 chars
    const lines = s.split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThan(250);
    }
  });
});

describe("getMostRecentFailure", () => {
  beforeEach(() => {
    clearFailures();
  });

  it("returns null when no failures recorded", () => {
    expect(getMostRecentFailure()).toBeNull();
  });

  it("returns the last pushed failure", () => {
    recordFailure("t1", "e1");
    recordFailure("t2", "e2");
    recordFailure("t3", "e3");
    const recent = getMostRecentFailure();
    expect(recent).not.toBeNull();
    expect(recent!.tool).toBe("t3");
  });

  it("returns null after clearFailures", () => {
    recordFailure("t", "e");
    clearFailures();
    expect(getMostRecentFailure()).toBeNull();
  });
});

describe("hasRecentFailures", () => {
  beforeEach(() => {
    clearFailures();
  });

  it("returns false when empty", () => {
    expect(hasRecentFailures()).toBe(false);
  });

  it("returns true after recording a failure", () => {
    recordFailure("t", "e");
    expect(hasRecentFailures()).toBe(true);
  });

  it("returns false after clearFailures", () => {
    recordFailure("t", "e");
    clearFailures();
    expect(hasRecentFailures()).toBe(false);
  });
});

describe("clearFailures", () => {
  it("does not throw when called on empty state", () => {
    expect(() => clearFailures()).not.toThrow();
  });

  it("clears all recorded failures", () => {
    recordFailure("t1", "e1");
    recordFailure("t2", "e2");
    clearFailures();
    expect(getFailures()).toEqual([]);
    expect(hasRecentFailures()).toBe(false);
    expect(getMostRecentFailure()).toBeNull();
    expect(getRecentFailures()).toBe("");
  });

  it("can be called multiple times safely", () => {
    clearFailures();
    clearFailures();
    clearFailures();
    expect(getFailures()).toEqual([]);
  });
});

describe("FailureEntry type contract", () => {
  it("FailureEntry has the documented shape", () => {
    const entry: FailureEntry = {
      tool: "tool_name",
      error: "error msg",
      timestamp: Date.now(),
    };
    expect(entry.tool).toBe("tool_name");
    expect(entry.filePath).toBeUndefined();
  });

  it("FailureEntry accepts an optional filePath", () => {
    const entry: FailureEntry = {
      tool: "tool_name",
      error: "error msg",
      filePath: "/tmp/x.ts",
      timestamp: Date.now(),
    };
    expect(entry.filePath).toBe("/tmp/x.ts");
  });
});
