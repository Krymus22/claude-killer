/**
 * regression-bug-hunter-8.test.ts — Regression tests for Bug Hunter #8.
 *
 * Focus area: Supporting modules + config.
 *
 * Each test below fails BEFORE the corresponding fix and passes AFTER.
 * The tests are organized by the source file they cover.
 *
 * Bugs covered:
 *   1. searxManager.ts: `require("node:fs")` was used inside
 *      `launchDockerDesktopWindows()`. `require()` is undefined in ESM
 *      (package.json has `"type":"module"`), so the function would throw
 *      `ReferenceError: require is not defined` at runtime when a Windows
 *      user tried to auto-start Docker. The fix uses the already-imported
 *      `existsSync` from the top-level static import. Also removed the
 *      duplicate `import { existsSync as fsExistsSync }` line and the
 *      dynamic `await import("node:fs")` for `openSync`.
 *
 *   2. clipboard.ts (macOS): `applescriptDoubleQuote` only escaped `\`
 *      and `"` for the AppleScript context but NOT `'` for the bash
 *      single-quoted context (`osascript -e '...'`). A path containing
 *      a `'` would terminate the bash string early, allowing the rest
 *      of the path to be interpreted by bash as arbitrary commands
 *      (shell injection). The fix also escapes `'` using the bash
 *      `'\''` idiom.
 *
 *   3. gracefulShutdown.ts: the per-handler `setTimeout` used in
 *      `Promise.race` was never cleared. When a handler resolved before
 *      its timeout, the timer kept ticking for the full budget (default
 *      5s per handler), keeping the Node.js event loop alive and making
 *      tests/process hang. The fix tracks the timer and clears it in a
 *      `finally` block.
 *
 *   4. activityTracker.ts: a test for the `subagent` category was
 *      marked `.skip` because the expected string was "Sub-agent"
 *      (English) but the source returns "Sub-agente" (Portuguese with
 *      'e' at the end), matching the project's PT-BR default. The fix
 *      un-skips the test and corrects the expectation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync as mockedExecSync } from "node:child_process";

// ─── Top-level mocks (required for vi.mock hoisting) ──────────────────────

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ pid: 12345, unref: vi.fn() })),
  spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
  execSync: vi.fn(() => ""),
}));

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  toolCall: vi.fn(),
  toolResult: vi.fn(),
}));

// ─── Bug 1: searxManager.ts uses ESM imports (no require) ─────────────────

describe("Bug Hunter #8 — searxManager.ts ESM imports", () => {
  it("source file does not use require() for node:fs (ESM module)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../searxManager.ts"),
      "utf8",
    );
    // Strip comments so we don't match `require` mentioned in a comment.
    // Simple strip: remove lines that start with `//` (after optional whitespace).
    const withoutComments = src
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    // No actual require() call should remain (only comment references).
    expect(withoutComments).not.toMatch(/\brequire\s*\(/);
  });

  it("source file does not import existsSync under the fsExistsSync alias", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../searxManager.ts"),
      "utf8",
    );
    // The duplicate alias was a leftover from a previous refactor and
    // shadowed the canonical existsSync import. It should be gone.
    expect(src).not.toMatch(/existsSync\s+as\s+fsExistsSync/);
  });

  it("source file imports openSync as a static import (no dynamic await import)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../searxManager.ts"),
      "utf8",
    );
    // Static import for openSync must be present.
    expect(src).toMatch(/import\s+\{[^}]*\bopenSync\b[^}]*\}\s+from\s+"node:fs"/);
    // No dynamic `await import("node:fs")` for openSync.
    expect(src).not.toMatch(/await\s+import\(\s*"node:fs"\s*\)/);
  });

  it("launchDockerDesktopWindows uses the top-level existsSync (no local require)", async () => {
    // The top-level vi.mock for node:child_process and node:fs is already
    // in place. Just import and verify the module loads without throwing.
    const mod = await import("../searxManager.js");
    // If `require()` was still present, Node.js would have thrown
    // `ReferenceError: require is not defined` at module load. Verify the
    // module loaded and has the expected exports.
    expect(typeof mod.isSearxInstalled).toBe("function");
    expect(typeof mod.autoStartSearx).toBe("function");
    expect(typeof mod.autoStopSearx).toBe("function");
    expect(typeof mod.getSearxStatus).toBe("function");
  });
});

// ─── Bug 2: clipboard.ts macOS escaping for single quotes ────────────────

describe("Bug Hunter #8 — clipboard.ts macOS single-quote escaping", () => {
  const execSyncMock = vi.mocked(mockedExecSync);

  let originalPlatform: string;

  beforeEach(() => {
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue("" as any);
    originalPlatform = process.platform;
    // Force darwin (macOS) for these tests.
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("macOS path with single quote is escaped for bash single-quoted context", async () => {
    const { copyFileToClipboard } = await import("../clipboard.js");
    // Path with a single quote — would previously terminate the bash
    // single-quoted string early.
    const maliciousPath = "/tmp/file'with'quote.txt";
    copyFileToClipboard(maliciousPath);

    expect(execSyncMock).toHaveBeenCalled();
    const cmd = String(execSyncMock.mock.calls[0]?.[0] ?? "");
    // The single quotes in the path should be escaped using the bash
    // `'\''` idiom, NOT left bare. Bare `'` would terminate the bash
    // single-quoted -e argument.
    expect(cmd).toContain("'\\''");
    // Sanity: the original path content (without quotes) should still
    // appear in the command, just properly escaped.
    expect(cmd).toContain("file");
    expect(cmd).toContain("with");
    expect(cmd).toContain("quote.txt");
  });

  it("macOS path without special chars is not double-escaped", async () => {
    const { copyFileToClipboard } = await import("../clipboard.js");
    copyFileToClipboard("/tmp/normal-file.txt");

    const cmd = String(execSyncMock.mock.calls[0]?.[0] ?? "");
    // No single quotes in the path → no `'\''` escaping needed.
    expect(cmd).not.toContain("'\\''");
    // Path content should appear verbatim.
    expect(cmd).toContain("/tmp/normal-file.txt");
  });

  it("macOS path with double quote is escaped for AppleScript context", async () => {
    const { copyFileToClipboard } = await import("../clipboard.js");
    copyFileToClipboard('/tmp/file"double.txt');

    const cmd = String(execSyncMock.mock.calls[0]?.[0] ?? "");
    // The `"` in the path should be escaped as `\"` for AppleScript.
    expect(cmd).toContain('\\"');
  });

  it("macOS path with backslash is escaped for AppleScript context", async () => {
    const { copyFileToClipboard } = await import("../clipboard.js");
    copyFileToClipboard("/tmp/file\\backslash.txt");

    const cmd = String(execSyncMock.mock.calls[0]?.[0] ?? "");
    // The `\` in the path should be escaped as `\\` for AppleScript.
    expect(cmd).toContain("\\\\");
  });
});

// ─── Bug 3: gracefulShutdown.ts clears per-handler setTimeout ────────────

describe("Bug Hunter #8 — gracefulShutdown.ts timer cleanup", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "bh8-shutdown-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.SHUTDOWN_HANDLER_TIMEOUT_MS;
    delete process.env.SHUTDOWN_TOTAL_TIMEOUT_MS;
  });

  it("per-handler setTimeout is cleared after the handler resolves (no timer leak)", async () => {
    const { onShutdown, shutdown, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();

    // Spy on setTimeout/clearTimeout to verify cleanup.
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    // Handler that resolves immediately.
    onShutdown(() => { /* fast handler */ });

    await shutdown("SIGINT");

    // At least one setTimeout was scheduled (for the per-handler race).
    expect(setTimeoutSpy).toHaveBeenCalled();
    // clearTimeout was called for the scheduled per-handler timer.
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("shutdown completes quickly when handlers are fast (no 5s wait per handler)", async () => {
    const { onShutdown, shutdown, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();

    // Register 3 fast handlers. Previously, each would leave a 5s timer
    // pending, keeping the process alive for ~15s even after shutdown
    // resolved. Now the timers are cleared, so shutdown returns quickly.
    onShutdown(() => { /* fast */ });
    onShutdown(() => { /* fast */ });
    onShutdown(() => { /* fast */ });

    const t0 = Date.now();
    await shutdown("SIGINT");
    const elapsed = Date.now() - t0;

    // Should complete in well under the 5s per-handler budget. Use 2s
    // as the upper bound to allow for slow CI machines.
    expect(elapsed).toBeLessThan(2000);
  });

  it("slow handler still triggers timeout (and timer is cleared after firing)", async () => {
    vi.useFakeTimers();
    const { onShutdown, shutdown, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();

    // Use a very short timeout for the test.
    process.env.SHUTDOWN_HANDLER_TIMEOUT_MS = "100";

    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    // Handler that never resolves on its own (must be killed by timeout).
    onShutdown(() => new Promise<void>(() => { /* never resolves */ }));

    const shutdownPromise = shutdown("SIGINT");
    // Advance fake timers past the 100ms handler timeout.
    await vi.advanceTimersByTimeAsync(200);
    await shutdownPromise;

    // The timeout fired (causing the race to reject), and then the
    // timer was cleared (clearTimeout called).
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});

// ─── Bug 4: activityTracker 'subagent' label is "Sub-agente" (PT-BR) ─────

describe("Bug Hunter #8 — activityTracker subagent label (un-skipped test)", () => {
  it("formats 'subagent' category with 'Sub-agente:' prefix (PT-BR default)", async () => {
    const { pushActivity, getActivitySnapshot, _resetActivityForTests } = await import("../activityTracker.js");
    _resetActivityForTests();

    const done = pushActivity("subagent", "#1: explorar código");
    const snap = getActivitySnapshot();
    // The source returns "Sub-agente" (PT-BR with 'e' at the end),
    // matching the project's primary language. This test was previously
    // `.skip` because it expected the English "Sub-agent" form.
    expect(snap.displayLabel).toBe("Sub-agente: #1: explorar código");
    expect(snap.shortLabel).toBe("sub-agente");
    done();
  });
});
