/**
 * snapshotTesting-extended.test.ts — Extended tests for snapshotTesting.ts
 *
 * Covers:
 *   - captureBeforeSnapshot: returns SnapshotResult with captured=false for non-JS files
 *   - captureBeforeSnapshot: returns SnapshotResult with captured=true for runnable JS
 *   - captureAfterSnapshot: returns "no before-snapshot" error when called without capture
 *   - captureAfterSnapshot: returns matched=true when output unchanged
 *   - captureAfterSnapshot: returns matched=false when output changed
 *   - getSnapshots / clearSnapshots / hasBeforeSnapshot
 *   - Snapshot / SnapshotResult type contracts
 *   - Edge cases: empty inputs, malformed JSON, non-existent files
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
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
  captureBeforeSnapshot,
  captureAfterSnapshot,
  getSnapshots,
  clearSnapshots,
  hasBeforeSnapshot,
  type Snapshot,
  type SnapshotResult,
} from "../snapshotTesting.js";

const TMP = path.join(os.tmpdir(), `__ck_snapshot_${process.pid}_${Date.now()}__`);

beforeEach(() => {
  fs.mkdirSync(TMP, { recursive: true });
  clearSnapshots();
});

afterEach(() => {
  clearSnapshots();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// Helper: write a JS module exporting a pure function.
// If `params` is provided, uses those; otherwise derives from `x` references in the body.
function writeJsFile(name: string, fnBody: string, params?: string): string {
  const filePath = path.join(TMP, name);
  const paramList = params ?? (fnBody.includes("x") ? "x" : "");
  fs.writeFileSync(
    filePath,
    `export function fn(${paramList}) {\n  ${fnBody}\n}\n`,
    "utf8",
  );
  return filePath;
}

// ─── captureBeforeSnapshot — non-JS files ──────────────────────────────────
describe("captureBeforeSnapshot — non-JS files return captured=false", () => {
  it("returns captured=false for a .luau file (not runnable in node)", async () => {
    const f = path.join(TMP, "f.luau");
    fs.writeFileSync(f, 'local function fn() return 42 end');
    const result = await captureBeforeSnapshot("fn", f, "[]");
    expect(result.captured).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(result.message).toContain("Could not run");
  });

  it("returns captured=false for a .py file", async () => {
    const f = path.join(TMP, "f.py");
    fs.writeFileSync(f, "def fn(): return 42");
    const result = await captureBeforeSnapshot("fn", f, "[]");
    expect(result.captured).toBe(false);
  });

  it("returns captured=false for a .lua file", async () => {
    const f = path.join(TMP, "f.lua");
    fs.writeFileSync(f, 'local function fn() return 42 end');
    const result = await captureBeforeSnapshot("fn", f, "[]");
    expect(result.captured).toBe(false);
  });
});

// ─── captureBeforeSnapshot — JS files ──────────────────────────────────────
describe("captureBeforeSnapshot — runnable JS files", () => {
  it("captures output for a pure function returning a value", async () => {
    const f = writeJsFile("pure.mjs", "return 42;");
    const result = await captureBeforeSnapshot("fn", f, "[]");
    expect(result.captured).toBe(true);
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot!.outputBefore).toBe("42");
    expect(result.snapshot!.outputAfter).toBeNull();
    expect(result.snapshot!.matched).toBeNull();
    expect(typeof result.snapshot!.timestamp).toBe("number");
  });

  it("stores the snapshot in the internal map", async () => {
    const f = writeJsFile("p2.mjs", "return 'hello';");
    await captureBeforeSnapshot("fn", f, "[]");
    expect(hasBeforeSnapshot("fn", f)).toBe(true);
    expect(getSnapshots().length).toBe(1);
  });

  it("stores the inputs as provided", async () => {
    const f = writeJsFile("p3.mjs", "return x * 2;", "x");
    const result = await captureBeforeSnapshot("fn", f, "[21]");
    expect(result.captured).toBe(true);
    expect(result.snapshot!.inputs).toBe("[21]");
  });

  it("handles a function that returns an object (JSON-serialized)", async () => {
    const f = writeJsFile("p4.mjs", "return { a: 1, b: 'x' };");
    const result = await captureBeforeSnapshot("fn", f, "[]");
    expect(result.captured).toBe(true);
    // Output is JSON-serialized
    expect(result.snapshot!.outputBefore).toContain('"a"');
    expect(result.snapshot!.outputBefore).toContain('"b"');
  });
});

// ─── captureBeforeSnapshot — edge cases ────────────────────────────────────
describe("captureBeforeSnapshot — edge cases", () => {
  it("handles a non-existent JS file (returns captured=false)", async () => {
    const result = await captureBeforeSnapshot("fn", "/tmp/__not_here__.mjs", "[]");
    expect(result.captured).toBe(false);
  });

  it("handles malformed JSON inputs (returns captured=false)", async () => {
    const f = writeJsFile("p5.mjs", "return 1;");
    const result = await captureBeforeSnapshot("fn", f, "{not valid json");
    expect(result.captured).toBe(false);
  });

  it("returns a non-empty message string", async () => {
    const f = writeJsFile("p6.mjs", "return 1;");
    const result = await captureBeforeSnapshot("fn", f, "[]");
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("SnapshotResult has the documented shape", async () => {
    const f = writeJsFile("p7.mjs", "return 1;");
    const result = await captureBeforeSnapshot("fn", f, "[]");
    expect(result).toHaveProperty("captured");
    expect(result).toHaveProperty("snapshot");
    expect(result).toHaveProperty("message");
  });
});

// ─── captureAfterSnapshot — without before-snapshot ────────────────────────
describe("captureAfterSnapshot — no before-snapshot", () => {
  it("returns captured=false with a 'no before-snapshot' message", async () => {
    const f = path.join(TMP, "no_before.mjs");
    fs.writeFileSync(f, "export function fn() { return 1; }");
    const result = await captureAfterSnapshot("fn", f);
    expect(result.captured).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(result.message).toContain("No before-snapshot");
  });
});

// ─── captureAfterSnapshot — matched output ─────────────────────────────────
describe("captureAfterSnapshot — matched (unchanged output)", () => {
  it("returns matched=true when function output is identical", async () => {
    const f = writeJsFile("match.mjs", "return 42;");
    await captureBeforeSnapshot("fn", f, "[]");
    const result = await captureAfterSnapshot("fn", f);
    expect(result.captured).toBe(true);
    expect(result.snapshot!.matched).toBe(true);
    expect(result.snapshot!.outputAfter).toBe("42");
    expect(result.message).toContain("unchanged");
  });

  it("updates the snapshot in-place (outputAfter + matched set)", async () => {
    const f = writeJsFile("match2.mjs", "return 'hello';");
    await captureBeforeSnapshot("fn", f, "[]");
    const before = getSnapshots()[0]!;
    expect(before.matched).toBeNull();
    expect(before.outputAfter).toBeNull();

    await captureAfterSnapshot("fn", f);
    const after = getSnapshots()[0]!;
    expect(after.matched).toBe(true);
    expect(after.outputAfter).toBe("hello");
  });
});

// ─── captureAfterSnapshot — changed output ─────────────────────────────────
describe("captureAfterSnapshot — different (changed output)", () => {
  it("returns matched=false when function output differs after edit", async () => {
    const f = writeJsFile("change.mjs", "return 1;");
    await captureBeforeSnapshot("fn", f, "[]");
    // Now rewrite the file to return a different value
    fs.writeFileSync(f, "export function fn() {\n  return 2;\n}\n");
    const result = await captureAfterSnapshot("fn", f);
    expect(result.captured).toBe(true);
    expect(result.snapshot!.matched).toBe(false);
    expect(result.snapshot!.outputBefore).toBe("1");
    expect(result.snapshot!.outputAfter).toBe("2");
    expect(result.message).toContain("changed");
  });

  it("message includes both before and after values when changed", async () => {
    const f = writeJsFile("change2.mjs", "return 'a';");
    await captureBeforeSnapshot("fn", f, "[]");
    fs.writeFileSync(f, "export function fn() {\n  return 'b';\n}\n");
    const result = await captureAfterSnapshot("fn", f);
    expect(result.message).toContain("Before:");
    expect(result.message).toContain("After:");
  });
});

// ─── hasBeforeSnapshot ─────────────────────────────────────────────────────
describe("hasBeforeSnapshot", () => {
  it("returns false before any capture", () => {
    expect(hasBeforeSnapshot("fn", "/tmp/x.mjs")).toBe(false);
  });

  it("returns true after a successful capture", async () => {
    const f = writeJsFile("has.mjs", "return 1;");
    await captureBeforeSnapshot("fn", f, "[]");
    expect(hasBeforeSnapshot("fn", f)).toBe(true);
  });

  it("returns false for a different file path (key includes path)", async () => {
    const f1 = writeJsFile("has1.mjs", "return 1;");
    const f2 = writeJsFile("has2.mjs", "return 1;");
    await captureBeforeSnapshot("fn", f1, "[]");
    expect(hasBeforeSnapshot("fn", f1)).toBe(true);
    expect(hasBeforeSnapshot("fn", f2)).toBe(false);
  });

  it("returns false for a different function name (key includes name)", async () => {
    const f = writeJsFile("has3.mjs", "return 1;");
    await captureBeforeSnapshot("fn", f, "[]");
    expect(hasBeforeSnapshot("fn", f)).toBe(true);
    expect(hasBeforeSnapshot("other", f)).toBe(false);
  });
});

// ─── getSnapshots ──────────────────────────────────────────────────────────
describe("getSnapshots", () => {
  it("returns an array", () => {
    expect(Array.isArray(getSnapshots())).toBe(true);
  });

  it("returns empty array initially", () => {
    expect(getSnapshots()).toEqual([]);
  });

  it("includes captured snapshots", async () => {
    const f = writeJsFile("gs.mjs", "return 1;");
    await captureBeforeSnapshot("fn", f, "[]");
    const snaps = getSnapshots();
    expect(snaps.length).toBe(1);
    expect(snaps[0]!.functionName).toBe("fn");
    expect(snaps[0]!.filePath).toBe(f);
  });
});

// ─── clearSnapshots ────────────────────────────────────────────────────────
describe("clearSnapshots", () => {
  it("does not throw on empty state", () => {
    expect(() => clearSnapshots()).not.toThrow();
  });

  it("removes all snapshots", async () => {
    const f = writeJsFile("clr.mjs", "return 1;");
    await captureBeforeSnapshot("fn", f, "[]");
    expect(getSnapshots().length).toBe(1);
    clearSnapshots();
    expect(getSnapshots().length).toBe(0);
    expect(hasBeforeSnapshot("fn", f)).toBe(false);
  });

  it("can be called multiple times", () => {
    clearSnapshots();
    clearSnapshots();
    expect(getSnapshots().length).toBe(0);
  });
});

// ─── Snapshot / SnapshotResult type contracts ──────────────────────────────
describe("Type contracts", () => {
  it("Snapshot has all required fields", () => {
    const s: Snapshot = {
      functionName: "fn",
      filePath: "/tmp/f.mjs",
      inputs: "[]",
      outputBefore: "1",
      outputAfter: null,
      matched: null,
      timestamp: Date.now(),
    };
    expect(s.functionName).toBe("fn");
    expect(s.outputAfter).toBeNull();
    expect(s.matched).toBeNull();
  });

  it("SnapshotResult has all required fields", () => {
    const r: SnapshotResult = {
      captured: false,
      snapshot: null,
      message: "test",
    };
    expect(r.captured).toBe(false);
    expect(r.snapshot).toBeNull();
    expect(r.message).toBe("test");
  });

  it("Snapshot.matched can be true / false / null", () => {
    const s1: Snapshot = {
      functionName: "f", filePath: "/x", inputs: "[]",
      outputBefore: "1", outputAfter: "1", matched: true, timestamp: 0,
    };
    const s2: Snapshot = {
      functionName: "f", filePath: "/x", inputs: "[]",
      outputBefore: "1", outputAfter: "2", matched: false, timestamp: 0,
    };
    const s3: Snapshot = {
      functionName: "f", filePath: "/x", inputs: "[]",
      outputBefore: "1", outputAfter: null, matched: null, timestamp: 0,
    };
    expect(s1.matched).toBe(true);
    expect(s2.matched).toBe(false);
    expect(s3.matched).toBeNull();
  });
});

// ─── Larger integration: capture → modify → compare ────────────────────────
describe("Integration: capture → modify → compare", () => {
  it("full snapshot lifecycle on a real JS file", async () => {
    const f = writeJsFile("lifecycle.mjs", "return x + 1;", "x");
    // Capture before with input 41 → expected output "42"
    const before = await captureBeforeSnapshot("fn", f, "[41]");
    expect(before.captured).toBe(true);
    expect(before.snapshot!.outputBefore).toBe("42");

    // File unchanged → after should match
    const after = await captureAfterSnapshot("fn", f);
    expect(after.snapshot!.matched).toBe(true);

    // Now change the function
    fs.writeFileSync(f, "export function fn(x) {\n  return x + 100;\n}\n");
    const after2 = await captureAfterSnapshot("fn", f);
    expect(after2.snapshot!.matched).toBe(false);
    expect(after2.snapshot!.outputAfter).toBe("141");
  });
});
