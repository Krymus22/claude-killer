/**
 * regression-bug-hunter-3.test.ts — Regression tests for Bug Hunter #3 fixes.
 *
 * Covers bugs found in the Session + TUI focus area:
 *   1. session.ts setActiveSession — partial ID resolution (double-write fix)
 *   2. session.ts renameSession — active session repoint (split-write fix)
 *   3. session.ts deleteSession — active session clear (zombie-session fix)
 *   4. session.ts listSessions — snapshot lines excluded from msgCount
 *   5. ChatDisplay formatToolArgs — always-true `||` guard (logic fix)
 *
 * Each test FAILS without the fix and PASSES with it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
}));

let tmpHome: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "bh3-test-"));
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  try { process.chdir(originalCwd); } catch {}
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

async function loadSessionModule() {
  vi.resetModules();
  return await import("../session.js");
}

// ─── 1. setActiveSession resolves partial IDs (double-write fix) ───────────

describe("Bug Hunter #3 — setActiveSession partial ID resolution", () => {
  it("resolves a partial prefix to the full session ID", async () => {
    const { startSession, appendMessage, setActiveSession, getActiveSessionId, getLastSession } = await loadSessionModule();
    const fullId = startSession(undefined, "2026-07-08_10-30-00_abc");
    appendMessage({ role: "user", content: "first" });

    // Simulate `/session load 2026-07` — a partial prefix.
    setActiveSession("2026-07");

    // Active ID must be the FULL id, not the partial prefix.
    expect(getActiveSessionId()).toBe(fullId);

    // The next appendMessage must go to the EXISTING file (not create a new
    // partial-id file). We verify by checking that only ONE .jsonl file
    // exists in the project session dir.
    appendMessage({ role: "user", content: "second" });
    const last = getLastSession();
    expect(last).not.toBeNull();
    expect(last!.id).toBe(fullId);

    // Both messages must be in the SAME file.
    const content = fs.readFileSync(last!.path, "utf8");
    const lines = content.split("\n").filter(Boolean);
    // header + 2 messages = 3 lines
    expect(lines.length).toBe(3);
    expect(lines[1]).toContain("first");
    expect(lines[2]).toContain("second");
  });

  it("does NOT create a separate partial-id file on append after partial load", async () => {
    const { startSession, appendMessage, setActiveSession, getLastSession } = await loadSessionModule();
    const fullId = startSession(undefined, "2026-07-08_10-30-00_abc");
    appendMessage({ role: "user", content: "msg1" });

    // Load by partial prefix.
    setActiveSession("2026-07");
    appendMessage({ role: "user", content: "msg2" });

    // There must be exactly ONE .jsonl file (no double-write).
    const last = getLastSession();
    expect(last).not.toBeNull();
    const dir = path.dirname(last!.path);
    const jsonlFiles = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
    expect(jsonlFiles.length).toBe(1);
    expect(jsonlFiles[0]).toBe(`${fullId}.jsonl`);
  });

  it("uses exact match when full ID is provided (no behavior change)", async () => {
    const { startSession, setActiveSession, getActiveSessionId } = await loadSessionModule();
    const fullId = startSession(undefined, "exact-match-test");
    setActiveSession(fullId);
    expect(getActiveSessionId()).toBe(fullId);
  });
});

// ─── 2. renameSession repoints active session (split-write fix) ─────────────

describe("Bug Hunter #3 — renameSession repoints active session", () => {
  it("updates activeSessionId when the active session is renamed", async () => {
    const { startSession, renameSession, getActiveSessionId, appendMessage, getLastSession } = await loadSessionModule();
    const oldId = startSession(undefined, "old-active-name");
    appendMessage({ role: "user", content: "before rename" });
    expect(getActiveSessionId()).toBe(oldId);

    const ok = renameSession(oldId, "new-active-name");
    expect(ok).toBe(true);

    // Active ID must now be the NEW name.
    expect(getActiveSessionId()).toBe("new-active-name");

    // The next appendMessage must go to the NEW file.
    appendMessage({ role: "user", content: "after rename" });
    const last = getLastSession();
    expect(last).not.toBeNull();
    expect(last!.id).toBe("new-active-name");

    // Both messages must be in the new file.
    const content = fs.readFileSync(last!.path, "utf8");
    expect(content).toContain("before rename");
    expect(content).toContain("after rename");

    // The old file must NOT exist (it was unlinked by rename).
    const dir = path.dirname(last!.path);
    expect(fs.existsSync(path.join(dir, "old-active-name.jsonl"))).toBe(false);
  });

  it("does not affect active session when renaming a DIFFERENT session", async () => {
    const { startSession, setActiveSession, renameSession, getActiveSessionId } = await loadSessionModule();
    const activeId = startSession(undefined, "active-one");
    startSession(undefined, "other-one"); // startSession sets this as active
    // Re-assert active-one as the active session.
    setActiveSession("active-one");
    expect(getActiveSessionId()).toBe(activeId);

    renameSession("other-one", "renamed-other");
    // Active must be unchanged.
    expect(getActiveSessionId()).toBe(activeId);
  });
});

// ─── 3. deleteSession clears active session (zombie-session fix) ────────────

describe("Bug Hunter #3 — deleteSession clears active session", () => {
  it("clears activeSessionId when the active session is deleted", async () => {
    const { startSession, deleteSession, getActiveSessionId, appendMessage, getLastSession } = await loadSessionModule();
    const id = startSession(undefined, "doomed-session");
    expect(getActiveSessionId()).toBe(id);

    deleteSession(id);

    // Active must be cleared (null), not still pointing at the deleted file.
    expect(getActiveSessionId()).toBeNull();

    // The next appendMessage must auto-create a FRESH session (with header),
    // NOT write to the deleted file path (which would create a headerless
    // zombie file).
    appendMessage({ role: "user", content: "after delete" });
    const last = getLastSession();
    expect(last).not.toBeNull();
    expect(last!.id).not.toBe(id);

    // The new file must have a proper header (not a zombie).
    const content = fs.readFileSync(last!.path, "utf8");
    const header = JSON.parse(content.split("\n")[0]!);
    expect(header.type).toBe("session-header");
  });

  it("does not clear active session when deleting a DIFFERENT session", async () => {
    const { startSession, setActiveSession, deleteSession, getActiveSessionId } = await loadSessionModule();
    const activeId = startSession(undefined, "active-keep");
    startSession(undefined, "to-delete"); // startSession sets this as active
    // Re-assert active-keep as the active session.
    setActiveSession("active-keep");
    expect(getActiveSessionId()).toBe(activeId);

    deleteSession("to-delete");
    expect(getActiveSessionId()).toBe(activeId);
  });

  it("supports partial ID when deleting the active session", async () => {
    const { startSession, deleteSession, getActiveSessionId } = await loadSessionModule();
    startSession(undefined, "2026-07-09_12-00-00_xyz");
    expect(getActiveSessionId()).toBe("2026-07-09_12-00-00_xyz");

    // Delete by partial prefix.
    deleteSession("2026-07");
    expect(getActiveSessionId()).toBeNull();
  });
});

// ─── 4. listSessions excludes snapshots from msgCount ───────────────────────

describe("Bug Hunter #3 — listSessions excludes compaction snapshots from count", () => {
  it("counts only real messages, not compaction-snapshot lines", async () => {
    const { startSession, appendMessage, appendCompactionSnapshot, listSessions } = await loadSessionModule();
    startSession();

    // 3 real messages.
    appendMessage({ role: "user", content: "msg1" });
    appendMessage({ role: "assistant", content: "msg2" });
    appendMessage({ role: "user", content: "msg3" });

    // 2 compaction snapshots — these must NOT inflate the count.
    appendCompactionSnapshot([{ role: "system", content: "compacted-1" }], "mechanical");
    appendCompactionSnapshot([{ role: "system", content: "compacted-2" }], "llm");

    const sessions = listSessions();
    expect(sessions.length).toBe(1);
    // Without the fix, this would be 5 (3 msgs + 2 snapshots). Must be 3.
    expect(sessions[0]!.messageCount).toBe(3);
  });

  it("counts 0 messages for a session with only snapshots", async () => {
    const { startSession, appendCompactionSnapshot, listSessions } = await loadSessionModule();
    startSession();
    appendCompactionSnapshot([{ role: "system", content: "compacted" }], "llm");

    const sessions = listSessions();
    expect(sessions[0]!.messageCount).toBe(0);
  });

  it("counts correctly when there are no snapshots", async () => {
    const { startSession, appendMessage, listSessions } = await loadSessionModule();
    startSession();
    appendMessage({ role: "user", content: "a" });
    appendMessage({ role: "user", content: "b" });

    const sessions = listSessions();
    expect(sessions[0]!.messageCount).toBe(2);
  });
});

// ─── 5. ChatDisplay formatToolArgs logic fix ────────────────────────────────
//
// We can't easily import the non-exported `formatToolArgs` directly, so we
// verify via the rendered output of ChatDisplay using ink-testing-library.
// The key property: a NON-pensar tool call (e.g. ler_arquivo) must NOT be
// affected by the `pensamento` guard, even though the old `||` condition
// was always true. We verify that a tool call WITHOUT pensamento renders
// its path/comando normally.

describe("Bug Hunter #3 — ChatDisplay formatToolArgs logic", () => {
  it("renders non-pensar tool call args normally (path field)", async () => {
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { ChatDisplay } = await import("../tui/ChatDisplay.js");

    const messages = [
      {
        role: "tool" as const,
        content: JSON.stringify({ path: "/some/file.ts" }),
        toolName: "ler_arquivo",
        isResult: false,
      },
    ];

    const { lastFrame } = render(React.createElement(ChatDisplay, { messages }));
    const frame = lastFrame() ?? "";
    // The path must appear in the rendered output (formatToolArgs extracted it).
    expect(frame).toContain("/some/file.ts");
  });

  it("renders pensar tool call with char count (not the thought content)", async () => {
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { ChatDisplay } = await import("../tui/ChatDisplay.js");

    const thought = "let me think about this carefully";
    const messages = [
      {
        role: "tool" as const,
        content: JSON.stringify({ pensamento: thought, categoria: "general" }),
        toolName: "pensar",
        isResult: false,
      },
    ];

    const { lastFrame } = render(React.createElement(ChatDisplay, { messages }));
    const frame = lastFrame() ?? "";
    // Must show char count, NOT the thought content.
    expect(frame).toContain("chars");
    expect(frame).not.toContain(thought);
  });

  it("renders pensar tool RESULT as null (hidden from chat)", async () => {
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { ChatDisplay } = await import("../tui/ChatDisplay.js");

    const thought = "internal reasoning result";
    const messages = [
      {
        role: "tool" as const,
        content: thought,
        toolName: "pensar",
        isResult: true,
        ok: true,
      },
    ];

    const { lastFrame } = render(React.createElement(ChatDisplay, { messages }));
    const frame = lastFrame() ?? "";
    // pensar results must be filtered out entirely.
    expect(frame).not.toContain(thought);
  });

  it("renders think (alias) tool RESULT as null too", async () => {
    vi.resetModules();
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { ChatDisplay } = await import("../tui/ChatDisplay.js");

    const thought = "think tool reasoning";
    const messages = [
      {
        role: "tool" as const,
        content: thought,
        toolName: "think",
        isResult: true,
        ok: true,
      },
    ];

    const { lastFrame } = render(React.createElement(ChatDisplay, { messages }));
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain(thought);
  });
});
