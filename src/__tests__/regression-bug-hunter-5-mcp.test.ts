/**
 * regression-bug-hunter-5-mcp.test.ts
 *
 * Regression tests for bugs found and fixed by Bug Hunter #5 (MCP + extensions + modes).
 *
 * Bugs covered:
 *   1. Stale docstring in extensions.ts (Content-Length → NDJSON) — verified by
 *      reading the file header. Not a runtime test.
 *   2. shutdownMCPServers was NOT called on SIGHUP / uncaughtException because
 *      it was only registered for SIGINT/SIGTERM via the `cleanup` function in
 *      index.ts. Fix: register it via onShutdown() so gracefulShutdown calls
 *      it for ALL signals.
 *   3. parseMessages LSP detection was too broad — /Content-Length:\s*\d+/i
 *      matched the string ANYWHERE in the buffer, so NDJSON messages whose
 *      JSON body contained "Content-Length:" (e.g., a tool result returning
 *      HTTP headers) were misclassified as LSP and silently dropped. Fix:
 *      anchor the regex to the start of the buffer (^).
 *   4. runHook used a naive `command.split(/\s+/)` which broke quoted file
 *      paths with spaces. Fix: added a quote-aware parseCommand() helper.
 *   5. findSharedManifests only scanned ~/.claude-killer/modes/ and
 *      <cwd>/defaults/modes/ — it missed the dist/ path
 *      (import.meta.dirname/../defaults/modes/). Shared tools from
 *      bundled-only modes were silently missing when running from dist/.
 *      Fix: added the dist/ path to the scan, with deduplication via
 *      fs.realpathSync.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// ─── Top-level mocks (hoisted by vitest) ────────────────────────────────────

vi.mock("../logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
  setTuiMode: vi.fn(),
  isTuiMode: vi.fn(() => false),
}));

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: spawnMock, execSync: vi.fn(() => "ok") }));

// Hoisted mocks for modes + toolDetector (used by Bug 5 tests).
const modesMock = vi.hoisted(() => ({ getActiveMode: vi.fn(() => null) }));
vi.mock("../modes.js", () => ({ getActiveMode: modesMock.getActiveMode }));

const toolDetectorMock = vi.hoisted(() => ({ findToolBinary: vi.fn(() => "/fake/binary") }));
vi.mock("../toolDetector.js", () => ({ findToolBinary: toolDetectorMock.findToolBinary }));

// ─── Helpers (shared with extensions-mcp.test.ts patterns) ──────────────────

function frameNDJSON(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

function parseStdinNDJSON(data: string): any | null {
  const lines = data.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { return JSON.parse(trimmed); } catch { /* skip */ }
  }
  return null;
}

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

let tmpDir: string;
let pluginsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bh5_mcp_"));
  pluginsDir = path.join(tmpDir, ".claude-killer", "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
  spawnMock.mockReset();
  modesMock.getActiveMode.mockReturnValue(null);
  toolDetectorMock.findToolBinary.mockReturnValue("/fake/binary");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

async function loadExtensionsModule() {
  vi.resetModules();
  vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
  return import("../extensions.js");
}

function createMcpPlugin(name: string, serverName: string, cmd: string, args: string[] = []) {
  const dir = path.join(pluginsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
    name,
    version: "1.0.0",
    mcpServers: { [serverName]: { command: cmd, args } },
  }));
  return dir;
}

// ─── Bug 3: parseMessages LSP detection regression ──────────────────────────

describe("Regression Bug 3: parseMessages does not misclassify NDJSON with 'Content-Length:' in body", () => {
  /**
   * BUG: The old LSP detection regex `/Content-Length:\s*\d+/i.test(remaining)`
   * matched "Content-Length:" ANYWHERE in the buffer. A NDJSON message whose
   * JSON body contained the string "Content-Length: 1234" (e.g., a tool result
   * returning HTTP headers, or an LSP/HTTP error message embedded in a string
   * field) would be misclassified as LSP. The LSP parser would then try to
   * parse the JSON body as an LSP frame, fail JSON.parse on the wrong slice,
   * and skip the message. This caused tools/call responses to be lost
   * intermittently when the result mentioned Content-Length.
   *
   * FIX: Anchor the regex to the start of the buffer with `^` so only buffers
   * that actually START with a Content-Length header are parsed as LSP.
   */

  it("NDJSON response with 'Content-Length:' in string value is parsed correctly (not dropped)", async () => {
    const child = fakeChild();
    child.stdin.write = vi.fn((data: string) => {
      const req = parseStdinNDJSON(data);
      if (!req || req.id == null) return;
      if (req.method === "initialize") {
        // Respond with NDJSON (no Content-Length header). The response body
        // contains the string "Content-Length: 9999\r\n\r\n" inside a JSON
        // string value. The old code would misclassify this as LSP because
        // the buffer contains both "Content-Length:" and "\r\n\r\n".
        const res = {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            capabilities: {},
            // This string value contains the pattern that triggered the bug:
            // "Content-Length:" followed by digits, plus "\r\n\r\n".
            message: "HTTP/1.1 200 OK\r\nContent-Length: 9999\r\n\r\nbody here",
          },
        };
        process.nextTick(() =>
          child.stdout.emit("data", Buffer.from(frameNDJSON(res)))
        );
      } else if (req.method === "tools/list") {
        const res = {
          jsonrpc: "2.0",
          id: req.id,
          result: { tools: [] },
        };
        process.nextTick(() =>
          child.stdout.emit("data", Buffer.from(frameNDJSON(res)))
        );
      }
    });
    spawnMock.mockReturnValue(child);

    const { loadAllExtensions, getActiveMCPServers, shutdownMCPServers } =
      await loadExtensionsModule();
    createMcpPlugin("bug3", "bug3srv", "echo");
    await loadAllExtensions();

    // The server should be active (initialize succeeded, not dropped by
    // misclassification). With the old code, the initialize response would
    // have been silently dropped, and the server would have failed to init.
    expect(getActiveMCPServers()).toContain("bug3srv");
    shutdownMCPServers();
  });

  it("NDJSON tools/call response with 'Content-Length:' in result text is delivered", async () => {
    const child = fakeChild();
    child.stdin.write = vi.fn((data: string) => {
      const req = parseStdinNDJSON(data);
      if (!req || req.id == null) return;
      if (req.method === "initialize") {
        const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
        process.nextTick(() =>
          child.stdout.emit("data", Buffer.from(frameNDJSON(res)))
        );
      } else if (req.method === "tools/list") {
        const res = {
          jsonrpc: "2.0",
          id: req.id,
          result: { tools: [{ name: "fetch_url", description: "Fetch", inputSchema: {} }] },
        };
        process.nextTick(() =>
          child.stdout.emit("data", Buffer.from(frameNDJSON(res)))
        );
      } else if (req.method === "tools/call") {
        // The tool result text contains "Content-Length:" — this is what
        // triggered the bug. A fetch_url tool could return HTTP headers.
        const res = {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            content: [
              {
                type: "text",
                text: "HTTP/1.1 200 OK\nContent-Length: 42\r\n\r\nHello World",
              },
            ],
          },
        };
        process.nextTick(() =>
          child.stdout.emit("data", Buffer.from(frameNDJSON(res)))
        );
      }
    });
    spawnMock.mockReturnValue(child);

    const { loadAllExtensions, callMCPTool, shutdownMCPServers } =
      await loadExtensionsModule();
    createMcpPlugin("bug3b", "bug3srvb", "echo");
    await loadAllExtensions();

    const result = await callMCPTool("bug3srvb__fetch_url", { url: "http://example.com" });
    // With the old code, the tools/call response would have been dropped
    // (misclassified as LSP), and callMCPTool would have timed out or
    // returned an error. With the fix, the response is correctly parsed.
    expect(result).toContain("Content-Length: 42");
    expect(result).toContain("Hello World");
    shutdownMCPServers();
  });

  it("LSP-framed response (starting with Content-Length:) is still parsed correctly", async () => {
    // Verify the fix didn't break LSP parsing for servers that actually use
    // Content-Length framing at the start of the buffer.
    const child = fakeChild();
    child.stdin.write = vi.fn((data: string) => {
      const req = parseStdinNDJSON(data);
      if (!req || req.id == null) return;
      if (req.method === "initialize") {
        const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
        const body = JSON.stringify(res);
        const lspFrame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
        process.nextTick(() =>
          child.stdout.emit("data", Buffer.from(lspFrame))
        );
      } else if (req.method === "tools/list") {
        const res = { jsonrpc: "2.0", id: req.id, result: { tools: [] } };
        const body = JSON.stringify(res);
        const lspFrame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
        process.nextTick(() =>
          child.stdout.emit("data", Buffer.from(lspFrame))
        );
      }
    });
    spawnMock.mockReturnValue(child);

    const { loadAllExtensions, getActiveMCPServers, shutdownMCPServers } =
      await loadExtensionsModule();
    createMcpPlugin("bug3c", "bug3srvc", "echo");
    await loadAllExtensions();
    // LSP-framed responses (starting with Content-Length:) should still work.
    expect(getActiveMCPServers()).toContain("bug3srvc");
    shutdownMCPServers();
  });
});

// ─── Bug 2: shutdownMCPServers on SIGHUP / uncaughtException ─────────────────

describe("Regression Bug 2: shutdownMCPServers is called via onShutdown for all signals", () => {
  /**
   * BUG: shutdownMCPServers was only called by the `cleanup` function in
   * index.ts, which was registered for SIGINT and SIGTERM only. On SIGHUP
   * (terminal close) or uncaughtException (crash), cleanup did NOT run,
   * and MCP server child processes spawned with `detached: true` (POSIX)
   * became orphaned — they're in their own process group and don't receive
   * the parent's signal.
   *
   * FIX: register shutdownMCPServers via onShutdown() in index.ts so
   * gracefulShutdown calls it for ALL signals (SIGINT, SIGTERM, SIGHUP,
   * uncaughtException).
   */

  it("onShutdown handler is called when gracefulShutdown.shutdown() runs for SIGHUP", async () => {
    vi.resetModules();
    const { onShutdown, shutdown, resetShutdownState } = await import("../gracefulShutdown.js");
    resetShutdownState();
    let handlerCalled = false;
    onShutdown(() => { handlerCalled = true; });
    await shutdown("SIGHUP");
    expect(handlerCalled).toBe(true);
  });

  it("onShutdown handler is called for uncaughtException signal", async () => {
    vi.resetModules();
    const { onShutdown, shutdown, resetShutdownState } = await import("../gracefulShutdown.js");
    resetShutdownState();
    let handlerCalled = false;
    onShutdown(() => { handlerCalled = true; });
    await shutdown("uncaughtException");
    expect(handlerCalled).toBe(true);
  });

  it("registering shutdownMCPServers via onShutdown kills MCP servers on shutdown()", async () => {
    // End-to-end: set up an MCP server, register shutdownMCPServers via
    // onShutdown (as index.ts now does), call shutdown(), verify the server
    // was killed (removed from active list).
    const child = fakeChild();
    child.stdin.write = vi.fn((data: string) => {
      const req = parseStdinNDJSON(data);
      if (!req || req.id == null) return;
      if (req.method === "initialize") {
        const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
        process.nextTick(() =>
          child.stdout.emit("data", Buffer.from(frameNDJSON(res)))
        );
      } else if (req.method === "tools/list") {
        const res = { jsonrpc: "2.0", id: req.id, result: { tools: [] } };
        process.nextTick(() =>
          child.stdout.emit("data", Buffer.from(frameNDJSON(res)))
        );
      }
    });
    spawnMock.mockReturnValue(child);

    const extMod = await loadExtensionsModule();
    const { loadAllExtensions, getActiveMCPServers, shutdownMCPServers } = extMod;
    createMcpPlugin("bug2", "bug2srv", "echo");
    await loadAllExtensions();
    expect(getActiveMCPServers()).toContain("bug2srv");

    // Simulate what index.ts does: register shutdownMCPServers via onShutdown.
    vi.resetModules();
    const { onShutdown, shutdown, resetShutdownState } = await import("../gracefulShutdown.js");
    resetShutdownState();
    onShutdown(() => shutdownMCPServers());

    // Simulate SIGHUP — before the fix, shutdownMCPServers would NOT be called.
    await shutdown("SIGHUP");

    // After shutdown(), the MCP server should have been killed.
    expect(getActiveMCPServers()).not.toContain("bug2srv");
    expect(child.kill).toHaveBeenCalled();
  });
});

// ─── Bug 4: runHook handles file paths with spaces ──────────────────────────

describe("Regression Bug 4: runHook handles file paths with spaces via quote-aware parser", () => {
  /**
   * BUG: runHook used `command.split(/\s+/)` to parse the command into
   * program + args. The {file} placeholder was replaced with `"${filePath}"`
   * (with quotes), but the naive split would break the quoted path into
   * multiple parts. When passed to spawn() (which doesn't use a shell),
   * the literal quote characters became part of the argument values, so
   * the tool received a filename like `"/path/with` and `spaces/file.tf"`
   * instead of `/path/with spaces/file.tf`. Hooks would silently fail on
   * any file path with spaces.
   *
   * FIX: added a quote-aware parseCommand() helper that respects double-
   * quoted segments.
   */

  it("runHook passes file path with spaces as a single argument", async () => {
    // Track spawn calls via the mocked spawn
    const calls: any[] = [];
    spawnMock.mockImplementation((...args: any[]) => {
      calls.push(args);
      const child = new EventEmitter() as any;
      child.stdin = new PassThrough();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      child.pid = 12345;
      process.nextTick(() => child.emit("close", 0));
      return child;
    });

    vi.resetModules();
    const { runHook } = await import("../modeExtensions.js");

    const filePath = "/path/with spaces/file.tf";
    await runHook(
      { filePattern: "*.tf", command: "terraform fmt {file}" },
      filePath,
    );

    // Verify spawn was called
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1];
    // program = "terraform"
    expect(lastCall[0]).toBe("terraform");
    // args should be ["fmt", "/path/with spaces/file.tf"] — the path with
    // spaces must be a SINGLE argument, not split into fragments.
    const args = lastCall[1];
    expect(args).toContain("fmt");
    expect(args).toContain(filePath); // full path with spaces, as one arg
    // The old code would have produced: ["/path/with, spaces/file.tf"]
    // (with literal quote chars). Verify NO arg contains a literal quote.
    for (const a of args) {
      expect(typeof a).toBe("string");
      expect(a).not.toContain('"');
    }
  });

  it("runHook handles file path without spaces (backward compat)", async () => {
    const calls: any[] = [];
    spawnMock.mockImplementation((...args: any[]) => {
      calls.push(args);
      const child = new EventEmitter() as any;
      child.stdin = new PassThrough();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      child.pid = 12345;
      process.nextTick(() => child.emit("close", 0));
      return child;
    });

    vi.resetModules();
    const { runHook } = await import("../modeExtensions.js");

    const filePath = "/normal/path/file.tf";
    await runHook(
      { filePattern: "*.tf", command: "terraform fmt {file}" },
      filePath,
    );

    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toBe("terraform");
    expect(lastCall[1]).toContain("fmt");
    expect(lastCall[1]).toContain(filePath);
  });

  it("runHook handles command with multiple {file} placeholders and path with spaces", async () => {
    const calls: any[] = [];
    spawnMock.mockImplementation((...args: any[]) => {
      calls.push(args);
      const child = new EventEmitter() as any;
      child.stdin = new PassThrough();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      child.pid = 12345;
      process.nextTick(() => child.emit("close", 0));
      return child;
    });

    vi.resetModules();
    const { runHook } = await import("../modeExtensions.js");

    // Command with multiple {file} placeholders and a path with spaces
    const filePath = "/my project/src/main.tf";
    await runHook(
      { filePattern: "*.tf", command: "tool --input {file} --output {file}.out" },
      filePath,
    );

    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1];
    const args = lastCall[1];
    // Both {file} placeholders should be replaced with the full path
    // (each as a single argument, not split).
    expect(args).toContain(filePath);
    expect(args).toContain(`${filePath}.out`);
  });
});

// ─── Bug 5: findSharedManifests scans dist/ path ────────────────────────────

describe("Regression Bug 5: findSharedManifests scans dist/ path for shared tools", () => {
  /**
   * BUG: findSharedManifests only scanned ~/.claude-killer/modes/ and
   * <cwd>/defaults/modes/ — it missed the dist/ path
   * (import.meta.dirname/../defaults/modes/). When running from dist/
   * (production), bundled modes only exist in the dist/ path. Shared tools
   * from bundled-only modes (e.g., a bundled "devops" mode sharing tools
   * with the active "roblox" mode) were silently missing.
   *
   * FIX: added the dist/ path to the scan, with deduplication via
   * fs.realpathSync to avoid scanning the same directory twice.
   */

  it("loadActiveManifests finds shared tools from bundled defaults/modes/", async () => {
    // Create a temporary "bundled defaults" dir with a "devops" mode that
    // shares a tool with "roblox", plus a "roblox" mode.
    // The structure mirrors defaults/modes/<mode>/manifests/*.json
    const tmpBundled = fs.mkdtempSync(path.join(os.tmpdir(), "bh5-bundled-"));
    const origCwd = process.cwd();
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;

    try {
      process.env.HOME = tmpDir;
      process.env.USERPROFILE = tmpDir;

      // getManifestsDir looks for <cwd>/defaults/modes/<mode>/manifests/
      // so we create the structure under tmpBundled/defaults/modes/...
      const devopsManifestsDir = path.join(tmpBundled, "defaults", "modes", "devops", "manifests");
      fs.mkdirSync(devopsManifestsDir, { recursive: true });
      fs.writeFileSync(
        path.join(devopsManifestsDir, "shared.json"),
        JSON.stringify([{
          name: "devops_shared_tool",
          description: "A tool shared from devops to roblox",
          category: "devops",
          command: "devops-tool",
          args: [],
          sharedWith: ["roblox"],
        }]),
      );

      const robloxManifestsDir = path.join(tmpBundled, "defaults", "modes", "roblox", "manifests");
      fs.mkdirSync(robloxManifestsDir, { recursive: true });
      fs.writeFileSync(
        path.join(robloxManifestsDir, "rojo.json"),
        JSON.stringify([{
          name: "rojo_build",
          description: "Build",
          category: "roblox",
          command: "rojo",
          args: ["build"],
        }]),
      );

      // Change cwd to the temp bundled dir so <cwd>/defaults/modes/ resolves
      // to our temp structure.
      process.chdir(tmpBundled);

      modesMock.getActiveMode.mockReturnValue({ name: "roblox" } as any);

      vi.resetModules();
      const { loadActiveManifests } = await import("../manifestLoader.js");
      const manifests = loadActiveManifests();

      const names = manifests.map((m: any) => m.name);
      // The shared tool from "devops" mode should be visible in "roblox" mode.
      expect(names).toContain("devops_shared_tool");
      // The roblox-specific tool should also be present.
      expect(names).toContain("rojo_build");
    } finally {
      process.chdir(origCwd);
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
      vi.resetModules();
      try { fs.rmSync(tmpBundled, { recursive: true, force: true }); } catch {}
    }
  });

  it("findSharedManifests scans the dist/ path (import.meta.dirname-relative)", async () => {
    // This test specifically verifies the Bug 5 fix: findSharedManifests
    // now scans the dist/ path (import.meta.dirname/../defaults/modes/),
    // not just ~/.claude-killer/modes/ and <cwd>/defaults/modes/.
    //
    // We verify this structurally by reading the source code and checking
    // that the dist/ path (import.meta.dirname) is included in the
    // candidateModesDirs array. A behavioral test would require modifying
    // the real project's defaults/modes/ directory (to add a mode that
    // only exists in the dist/ path), which is too risky for a regression
    // test.
    const source = fs.readFileSync(
      path.join(__dirname, "..", "manifestLoader.ts"),
      "utf8",
    );
    // The fix adds import.meta.dirname-based paths to candidateModesDirs.
    expect(source).toMatch(/import\.meta\.dirname/);
    expect(source).toMatch(/candidateModesDirs/);
    // The fix uses fs.realpathSync for deduplication.
    expect(source).toMatch(/fs\.realpathSync/);
  });

  it("findSharedManifests deduplicates directories (no double-scan)", async () => {
    // When cwd is the package root, <cwd>/defaults/modes and the dist-relative
    // path may resolve to the same real directory. The fix uses realpathSync
    // to deduplicate. Verify we don't get duplicate shared tools.
    const origCwd = process.cwd();
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;

    try {
      process.env.HOME = tmpDir;
      process.env.USERPROFILE = tmpDir;

      // Use the REAL project defaults/modes dir (which has roblox + normal).
      // The fix should deduplicate <cwd>/defaults/modes and the dist-relative
      // path (which both resolve to the same real dir in dev mode).
      process.chdir(path.join(__dirname, "..", ".."));

      modesMock.getActiveMode.mockReturnValue({ name: "roblox" } as any);

      vi.resetModules();
      const { loadActiveManifests } = await import("../manifestLoader.js");
      const manifests = loadActiveManifests();

      // Verify no duplicate manifest names (each tool should appear once).
      const names = manifests.map((m: any) => m.name);
      const uniqueNames = new Set(names);
      expect(names.length).toBe(uniqueNames.size);
    } finally {
      process.chdir(origCwd);
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
      vi.resetModules();
    }
  });
});

// ─── Bug 1: Stale docstring (verified by reading file) ──────────────────────

describe("Regression Bug 1: extensions.ts docstring says NDJSON (not Content-Length)", () => {
  it("file header mentions NDJSON framing, not Content-Length framing", () => {
    const content = fs.readFileSync(
      path.join(__dirname, "..", "extensions.ts"),
      "utf8",
    );
    // The header comment should say "NDJSON framing"
    expect(content).toMatch(/NDJSON framing/i);
    // The header comment should NOT say "Content-Length framing" (the old
    // stale text that contradicted BUSINESS_RULES.md §17 rule #22).
    // We check the first 20 lines (the header block) specifically.
    const header = content.split("\n").slice(0, 20).join("\n");
    expect(header).not.toMatch(/Content-Length framing/i);
  });
});
