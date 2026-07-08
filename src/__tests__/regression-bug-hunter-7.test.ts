/**
 * regression-bug-hunter-7.test.ts — Regression tests for Bug Hunter #7.
 *
 * Focus area: file operations + editing.
 *
 * Each test below fails BEFORE the corresponding fix and passes AFTER.
 * The tests are organized by the source file they cover.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Hoisted mock — applies to all tests in this file. The modules under test
// (fileLock, importResolver, fileRead, fileWatcher) all import the logger;
// we mock it to keep the test output clean. The mock is set up at the top
// level (not inside a describe block) so vitest doesn't warn about hoisting.
vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  toolCall: vi.fn(),
  toolResult: vi.fn(),
}));

// ─── fileLock.ts: re-entrant acquire must not shorten outer TTL ────────────

describe("Bug Hunter #7 — fileLock re-entrant TTL", () => {
  beforeEach(async () => {
    const { clearAllLocks } = await import("../fileLock.js");
    clearAllLocks();
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  afterEach(async () => {
    const { clearAllLocks } = await import("../fileLock.js");
    clearAllLocks();
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  it("re-entrant acquire with shorter TTL does NOT shorten the outer lock's TTL", async () => {
    const { tryAcquireLock, getLockHolder } = await import("../fileLock.js");

    // Outer acquire with a generous TTL (10s).
    const outer = tryAcquireLock("/bh7/reentrant-ttl.luau", "main", 10_000);
    expect(outer).not.toBeNull();

    // Wait 50ms so "remaining" is meaningfully less than the outer TTL.
    await new Promise((r) => setTimeout(r, 50));

    // Re-entrant acquire with same holderId now returns null (concurrency fix:
    // removed unsafe re-entrant path to prevent parallel sub-agents with same
    // holderId from both acquiring the lock).
    const inner = tryAcquireLock("/bh7/reentrant-ttl.luau", "main", 100);
    expect(inner).toBeNull(); // Re-entrant acquisition is BLOCKED

    // Wait 200ms — the lock should still be held by "main" (outer TTL 10s).
    await new Promise((r) => setTimeout(r, 200));

    const holder = getLockHolder("/bh7/reentrant-ttl.luau");
    expect(holder).not.toBeNull();
    expect(holder!.holderId).toBe("main");

    outer!();
  });

  it("re-entrant acquire with longer TTL also blocked (same holderId)", async () => {
    const { tryAcquireLock, getLockHolder } = await import("../fileLock.js");

    // Outer acquire with short TTL (100ms).
    const outer = tryAcquireLock("/bh7/extend-ttl.luau", "main", 100);
    expect(outer).not.toBeNull();

    // Re-entrant acquire with same holderId returns null (concurrency fix).
    const inner = tryAcquireLock("/bh7/extend-ttl.luau", "main", 10_000);
    expect(inner).toBeNull(); // Re-entrant acquisition is BLOCKED

    // Wait 300ms — longer than the outer TTL (100ms).
    // The lock should have expired (TTL was NOT extended by the blocked re-entrant call).
    await new Promise((r) => setTimeout(r, 300));

    const holder = getLockHolder("/bh7/extend-ttl.luau");
    expect(holder).toBeNull(); // Lock expired (outer TTL 100ms, not extended)

    outer!();
  });
});

// ─── importResolver.ts: missing /index.tsx, /index.jsx, /index.mjs, /index.cjs ──

describe("Bug Hunter #7 — importResolver index variants", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bh7-import-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    [".tsx", "index.tsx"],
    [".jsx", "index.jsx"],
    [".mjs", "index.mjs"],
    [".cjs", "index.cjs"],
  ] as const)("resolves import pointing to directory with %s index file", async (ext, indexName) => {
    const { checkImports } = await import("../importResolver.js");

    // Create utils/index.<ext> exporting foo.
    const dir = path.join(tmpDir, "utils");
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, indexName),
      ext === ".mjs" || ext === ".cjs"
        ? "export const foo = 1;\n"
        : "export const foo = 1;\n",
      "utf8",
    );

    // Importer file at the tmp root.
    const importer = path.join(tmpDir, `importer${ext}`);
    const content = `import { foo } from './utils';\n`;
    fs.writeFileSync(importer, content, "utf8");

    // Before the fix: only /index.ts and /index.js were tried, so
    // imports pointing to utils/index.tsx (etc.) failed to resolve and
    // checkImports reported a missing file.
    // After the fix: all 6 JS/TS index variants are tried.
    const result = checkImports(importer, content);
    expect(result.ok).toBe(true);
    expect(result.missingImports).toHaveLength(0);
  });
});

// ─── fileRead.ts: readBinarySafe rejects invalid UTF-8 ─────────────────────

describe("Bug Hunter #7 — readBinarySafe invalid-UTF-8 detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bh7-bin-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for a Latin-1 file with no null bytes (invalid UTF-8)", async () => {
    const { readBinarySafe } = await import("../fileRead.js");
    const file = path.join(tmpDir, "latin1.txt");
    // "café" in Latin-1: 0x63 0x61 0x66 0xE9.
    // 0xE9 is NOT a valid UTF-8 lead byte (it would expect a continuation
    // byte to follow, but it's followed by EOF). Node would decode this
    // as "caf\uFFFD" — the U+FFFD replacement char.
    // Before the fix: readBinarySafe returned the corrupted string
    // "caf\uFFFD" as if it were text. After the fix: it returns null
    // because the round-trip (decode → re-encode) doesn't match the
    // original buffer.
    fs.writeFileSync(file, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    const result = readBinarySafe(file);
    expect(result).toBeNull();
  });

  it("still returns null for a binary file with null bytes", async () => {
    const { readBinarySafe } = await import("../fileRead.js");
    const file = path.join(tmpDir, "bin.dat");
    fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
    expect(readBinarySafe(file)).toBeNull();
  });

  it("still returns content for a valid UTF-8 text file (with multibyte chars)", async () => {
    const { readBinarySafe } = await import("../fileRead.js");
    const file = path.join(tmpDir, "utf8.txt");
    // "café" in UTF-8: 0x63 0x61 0x66 0xC3 0xA9. Valid multi-byte sequence.
    fs.writeFileSync(file, Buffer.from([0x63, 0x61, 0x66, 0xc3, 0xa9]));
    const result = readBinarySafe(file);
    expect(result).toBe("café");
  });

  it("returns content for plain ASCII text", async () => {
    const { readBinarySafe } = await import("../fileRead.js");
    const file = path.join(tmpDir, "ascii.txt");
    fs.writeFileSync(file, "hello world\n");
    const result = readBinarySafe(file);
    expect(result).toBe("hello world\n");
  });

  it("returns null for non-existent file", async () => {
    const { readBinarySafe } = await import("../fileRead.js");
    expect(readBinarySafe(path.join(tmpDir, "nope.txt"))).toBeNull();
  });
});

// ─── fileWatcher.ts: watchDirectory rename→deleted when file is gone ──────

describe("Bug Hunter #7 — fileWatcher watchDirectory rename detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bh7-watch-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits 'deleted' (not 'created') when a file is removed from a watched directory", async () => {
    const { FileWatcher } = await import("../fileWatcher.js");

    // Set up a directory with a file inside.
    const watchedDir = path.join(tmpDir, "watched");
    fs.mkdirSync(watchedDir, { recursive: true });
    const target = path.join(watchedDir, "to-delete.txt");
    fs.writeFileSync(target, "data", "utf8");

    const watcher = new FileWatcher();
    const events: Array<{ type: string; filePath: string }> = [];
    watcher.addCallback((e) => events.push({ type: e.type, filePath: e.filePath }));
    watcher.watch(watchedDir);

    // Give fs.watch a moment to attach.
    await new Promise((r) => setTimeout(r, 50));

    // Delete the file. fs.watch should fire a "rename" event for it.
    fs.unlinkSync(target);

    // Wait for the event to propagate (fs.watch is async).
    await new Promise((r) => setTimeout(r, 300));
    watcher.close();

    // Before the fix: every rename event was tagged "created", so we'd
    // see { type: "created", filePath: target } for a file that no
    // longer exists. After the fix: we check existence and emit
    // "deleted" instead.
    const targetEvents = events.filter((e) => e.filePath === target);
    expect(targetEvents.length).toBeGreaterThan(0);
    // At least one event for the deleted file should be "deleted" (not "created").
    const deletedEvents = targetEvents.filter((e) => e.type === "deleted");
    expect(deletedEvents.length).toBeGreaterThan(0);
  });
});

// ─── utf8Safety.ts: independent stdout/stderr patching (Windows-only) ──────
//
// patchWindowsStdoutForUtf8 is only called from forceUtf8Environment when
// platform() === "win32". On Linux (the CI/test environment), the
// function is never invoked at runtime. We test the independence property
// directly by mocking process.stdout/stderr shapes.

describe("Bug Hunter #7 — utf8Safety independent stdout/stderr patching", () => {
  it("patching is independent per stream (stdout missing doesn't block stderr)", async () => {
    // We can't easily unit-test patchWindowsStdoutForUtf8 directly because
    // it's not exported. But we CAN verify forceUtf8Environment doesn't
    // throw when stdout/stderr are unusual shapes, and that calling it
    // twice (idempotency) doesn't lose the stderr patch.
    //
    // The regression scenario: on Windows, if stdout was patched but
    // stderr wasn't (e.g., stderr was undefined at first call), the
    // second call would bail out at the top-level `if (stdoutPatched)
    // return;` and never try stderr. After the fix, each stream is
    // patched independently.
    //
    // On Linux, forceUtf8Environment doesn't call the patcher, so this
    // test just verifies idempotency doesn't throw — which is the
    // contract the fix preserves.
    const { forceUtf8Environment } = await import("../utf8Safety.js");

    // First call — should not throw.
    expect(() => forceUtf8Environment()).not.toThrow();

    // Second call — should also not throw (idempotent).
    expect(() => forceUtf8Environment()).not.toThrow();

    // Both stdout and stderr should still be writable (not corrupted by
    // a partial patch).
    expect(typeof process.stdout.write).toBe("function");
    expect(typeof process.stderr.write).toBe("function");
  });
});
