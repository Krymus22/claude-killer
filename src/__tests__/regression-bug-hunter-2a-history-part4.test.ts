/**
 * regression-bug-hunter-2a-history-part4.test.ts
 *
 * Regression tests for bugs found and fixed by Bug Hunter #2a (part 4),
 * focused on history.ts lines 951-end:
 *   - buildCompactionSummary()
 *   - optimizeContext() / optimizeToolMessage() / getToolName()
 *   - historySummary()
 *   - tryAppendToSession() (session persistence — no behavioral bug found,
 *     but a smoke test is included for coverage)
 *
 * Bugs covered:
 *
 *   A. getToolName() line 1277 (HIGH): `call.function.name` accessed without
 *      optional chaining. If a tool_call in an assistant message is malformed
 *      (missing `function` field — can happen with corrupted session files or
 *      buggy API responses), this throws TypeError. getToolName is NOT wrapped
 *      in try/catch anywhere up the call chain — optimizeToolMessage() and
 *      hasErrorBeenOvercomeAfterIndex() both call it directly. A throw
 *      propagates up to optimizeContext() → agent loop, CRASHING THE AGENT.
 *      Fix: `return call?.function?.name ?? "";` (consistent with the
 *      "not found" return path).
 *
 *   B. buildCompactionSummary() lines 1156/1160/1164 (LOW): used
 *      `tc.function.name` (unsafe) instead of the already-captured `name`
 *      variable (safe via `tc?.function?.name`). If `tc.function` is
 *      undefined/null, throws TypeError. The per-iteration try/catch swallows
 *      it, silently dropping file/command tracking for that tool_call. With
 *      the fix, the captured `name` is used everywhere — no throw, no silent
 *      drop, and the try/catch only catches the intended JSON.parse errors.
 *
 *   C. optimizeToolMessage() line 1370 (LOW): the prefix guard checked
 *      `!content.startsWith("[ERRO ANTERIOR")` but the replacement content is
 *      `"[PREVIOUS ERROR OVERCOME..."`. Mismatched prefix. The bug was masked
 *      because isErrorMessage() returns false on the replacement (no
 *      "[ERROR]" / "Error:" match), making the guard dead code. But the guard
 *      was incorrect and misleading. Fix: guard now checks
 *      `"[PREVIOUS ERROR OVERCOME"` to match the replacement.
 *
 *   D. historySummary() line 1260 (LOW-MEDIUM): didn't call
 *      ensureHistoryInitialized(), unlike getHistory() and historyLength().
 *      If historySummary() was the first history function called (history === []),
 *      it returned "" instead of "system:1". Fix: call ensureHistoryInitialized()
 *      for consistency.
 *
 * Rules honored (§17 — Regras Intocáveis):
 *   - §17.1.2: "ler_arquivo NÃO trunca" — NOT changed (read-tool optimization
 *     remains disabled per the comment in optimizeToolMessage).
 *   - §17.3.12: "Orphan tool_calls são reparados" — NOT changed (loadHistoryDirect
 *     and replaceHistory repair logic untouched).
 *   - §6.4 PRESERVE_PREFIXES — NOT changed.
 *   - §6.6 COMPACT_KEEP_RECENT = 6 — NOT changed.
 *   - §7.4 "loadHistoryDirect NÃO persiste" — NOT changed (tryAppendToSession
 *     behavior unchanged).
 *   - Uses `import` not `require()` (ESM).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ─── Mocks ─────────────────────────────────────────────────────────────────
// Mock extensions.getActiveSkills and effortLevels.getEffortPromptSnippet so
// getSystemPrompt() is deterministic and doesn't touch the real extensions system.

const mockGetActiveSkills = vi.fn().mockReturnValue([]);
vi.mock("../extensions.js", () => ({
  getActiveSkills: (...args: any[]) => mockGetActiveSkills(...args),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortPromptSnippet: vi.fn().mockReturnValue(""),
  setEffortLevel: vi.fn(),
}));

// Mock session to avoid file I/O during tests. Capture appendMessage calls so
// we can assert tryAppendToSession behavior (Bug Hunter #2a part 4 smoke test).
const mockAppendMessage = vi.fn();
vi.mock("../session.js", () => ({
  appendMessage: (...args: any[]) => mockAppendMessage(...args),
  appendCompactionSnapshot: vi.fn(),
  getActiveSessionId: vi.fn(() => null),
  setActiveSession: vi.fn(),
}));

// ─── Imports AFTER mocks ───────────────────────────────────────────────────

import {
  addUserMessage,
  addRawAssistantMessage,
  addToolResult,
  addSystemMessage,
  getHistory,
  resetHistory,
  historySummary,
  optimizeContext,
  compactHistory,
  compactHistoryAsync,
} from "../history.js";

// ─── Setup / Teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  resetHistory();
  mockGetActiveSkills.mockReturnValue([]);
  mockAppendMessage.mockClear();
});

afterEach(() => {
  resetHistory();
  mockGetActiveSkills.mockReturnValue([]);
});

// ─── Bug A: getToolName throws on malformed tool_call (HIGH) ────────────────

describe("Bug Hunter #2a (part 4) — Bug A: getToolName handles malformed tool_calls", () => {
  it("optimizeContext does NOT throw when tool_call is missing `function` field", () => {
    // Malformed assistant tool_call: has id+type but NO `function` field.
    // This can happen with corrupted session files or buggy API responses.
    // With the OLD code, getToolName() did `call.function.name` which throws
    // TypeError (Cannot read properties of undefined). The throw propagated
    // up through optimizeToolMessage → optimizeContext → agent loop, crashing
    // the agent. With the fix, getToolName returns "" (optional chaining).
    addUserMessage("do task");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "malformed_tc", type: "function" } as any],
    } as any);
    addToolResult("malformed_tc", "some result content");

    // With OLD code: throws TypeError. With fix: no throw.
    expect(() => optimizeContext()).not.toThrow();
  });

  it("optimizeContext does NOT throw when tool_call.function is null", () => {
    // Another malformed variant: `function` is explicitly null.
    addUserMessage("do task");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "null_fn_tc", type: "function", function: null } as any],
    } as any);
    addToolResult("null_fn_tc", "result content");

    expect(() => optimizeContext()).not.toThrow();
  });

  it("optimizeContext does NOT throw when tool_call itself is null", () => {
    // Edge case: a null entry in the tool_calls array.
    addUserMessage("do task");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [null as any],
    } as any);
    // A tool result whose id won't match anything — getToolName returns "".
    addToolResult("orphan_id", "result");

    expect(() => optimizeContext()).not.toThrow();
  });

  it("hasErrorBeenOvercomeAfterIndex path: malformed tool_call + error + later success", () => {
    // This exercises the hasErrorBeenOvercomeAfterIndex → getToolName path.
    // The malformed tool_call has an error result; a later tool call advances
    // the flow. With OLD code, getToolName throws when checking the future
    // tool's name (if that future tool is also malformed). With the fix, no
    // throw.
    addUserMessage("run cmd");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "tc_err", type: "function", function: { name: "executar_comando", arguments: "{}" } },
      ],
    } as any);
    addToolResult("tc_err", "[ERROR] command failed");
    // Later tool call with malformed function (missing `function` field).
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_future_malformed", type: "function" } as any],
    } as any);
    addToolResult("tc_future_malformed", "some output");

    // With OLD code: getToolName("tc_future_malformed", k) throws TypeError
    // inside hasErrorBeenOvercomeAfterIndex. With fix: returns "", no throw.
    expect(() => optimizeContext()).not.toThrow();
  });

  it("malformed tool_call does not break optimization of OTHER valid tool messages", () => {
    // Mix one malformed tool_call with valid ones. optimizeContext should
    // process the valid ones (e.g., overcome an error) without crashing on
    // the malformed one.
    addUserMessage("task");
    // Valid error tool call
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "tc_valid_err", type: "function", function: { name: "executar_comando", arguments: "{}" } },
      ],
    } as any);
    addToolResult("tc_valid_err", "[ERROR] failed");
    // Malformed tool call
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_malformed", type: "function" } as any],
    } as any);
    addToolResult("tc_malformed", "malformed result");
    // Valid success tool call (same tool as the error → overcomes it)
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "tc_valid_ok", type: "function", function: { name: "executar_comando", arguments: "{}" } },
      ],
    } as any);
    addToolResult("tc_valid_ok", "success output");

    expect(() => optimizeContext()).not.toThrow();

    // The valid error should have been optimized (overcome by later success).
    const h = getHistory();
    const errTool = h.find((m) => m.role === "tool" && (m as any).tool_call_id === "tc_valid_err");
    expect(errTool).toBeDefined();
    expect((errTool as any).content).toContain("PREVIOUS ERROR OVERCOME");
  });
});

// ─── Bug B: buildCompactionSummary handles malformed tool_calls ────────────

describe("Bug Hunter #2a (part 4) — Bug B: buildCompactionSummary handles malformed tool_calls", () => {
  it("compactHistory does NOT crash with malformed tool_calls in compacted portion", () => {
    // Build history long enough to trigger compaction (need > COMPACT_KEEP_RECENT + 1 = 8 msgs).
    // Include a malformed tool_call in the portion that gets compacted.
    addUserMessage("start task");
    addRawAssistantMessage({
      role: "assistant",
      content: "working",
      // Mix: valid tool_call + malformed (missing function) + malformed (null function)
      tool_calls: [
        { id: "valid_tc", type: "function", function: { name: "ler_arquivo", arguments: '{"path":"/foo.ts"}' } },
        { id: "bad_tc_1", type: "function" } as any,
        { id: "bad_tc_2", type: "function", function: null } as any,
      ],
    } as any);
    addToolResult("valid_tc", "file content");
    addToolResult("bad_tc_1", "result 1");
    addToolResult("bad_tc_2", "result 2");
    // Add enough messages to push the above into the compacted portion.
    for (let i = 0; i < 8; i++) {
      addUserMessage(`msg ${i}`);
    }

    // compactHistory calls buildCompactionSummary on the compacted portion.
    // With OLD code: the malformed tool_calls trigger tc.function.name → throw,
    // caught by try/catch (no crash, but silent drop). With fix: no throw.
    // Either way, this should not crash.
    const result = compactHistory();
    expect(result).not.toBeNull();
    expect(result?.method).toBe("mechanical");

    // The summary system message should be present and contain the header.
    const h = getHistory();
    const summaryMsg = h.find(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("[CONVERSATION MEMORY")
    );
    expect(summaryMsg).toBeDefined();
  });

  it("buildCompactionSummary tracks valid tool_calls even when siblings are malformed", () => {
    // The valid tool_call (ler_arquivo with path) should be tracked in the
    // "Files Read" section of the summary, even though its sibling tool_calls
    // are malformed. This works both before and after the fix (try/catch is
    // per-iteration), but we assert it as a regression guard.
    addUserMessage("start");
    addRawAssistantMessage({
      role: "assistant",
      content: "reading files",
      tool_calls: [
        { id: "valid_read", type: "function", function: { name: "ler_arquivo", arguments: '{"path":"/abs/file.ts"}' } },
        { id: "bad_tc", type: "function" } as any,
      ],
    } as any);
    addToolResult("valid_read", "content");
    addToolResult("bad_tc", "bad result");
    for (let i = 0; i < 8; i++) {
      addUserMessage(`msg ${i}`);
    }

    compactHistory();

    const h = getHistory();
    const summaryMsg = h.find(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("[CONVERSATION MEMORY")
    ) as any;
    expect(summaryMsg).toBeDefined();
    const summaryContent: string = summaryMsg.content;
    // The valid read should be tracked.
    expect(summaryContent).toContain("## Files Read");
    expect(summaryContent).toContain("/abs/file.ts");
    // The valid tool name should be tracked.
    expect(summaryContent).toContain("ler_arquivo");
  });

  it("compactHistoryAsync mechanical fallback handles malformed tool_calls", async () => {
    // Same as above but via the async path with LLM unavailable → mechanical.
    addUserMessage("start");
    addRawAssistantMessage({
      role: "assistant",
      content: "working",
      tool_calls: [
        { id: "valid_edit", type: "function", function: { name: "editar_arquivo", arguments: '{"path":"/x.ts"}' } },
        { id: "bad_tc", type: "function", function: null } as any,
      ],
    } as any);
    addToolResult("valid_edit", "[SUCCESS] edited");
    addToolResult("bad_tc", "result");
    for (let i = 0; i < 8; i++) {
      addUserMessage(`msg ${i}`);
    }

    // LLM compaction not available → mechanical fallback → buildCompactionSummary.
    const result = await compactHistoryAsync();
    expect(result).not.toBeNull();
    expect(result?.method).toBe("mechanical");

    const h = getHistory();
    const summaryMsg = h.find(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("[CONVERSATION MEMORY")
    ) as any;
    expect(summaryMsg).toBeDefined();
    // The valid edit should be tracked in "Files Modified".
    expect(summaryMsg.content).toContain("## Files Modified");
    expect(summaryMsg.content).toContain("/x.ts");
  });
});

// ─── Bug C: optimizeToolMessage error-prefix guard matches replacement ─────

describe("Bug Hunter #2a (part 4) — Bug C: error optimization is idempotent", () => {
  it("calling optimizeContext twice on an overcome error does not reprocess", () => {
    // Set up an error that gets overcome by a later same-tool success.
    addUserMessage("run cmd");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "tc_fail", type: "function", function: { name: "executar_comando", arguments: "{}" } },
      ],
    } as any);
    addToolResult("tc_fail", "[ERROR] command failed");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "tc_ok", type: "function", function: { name: "executar_comando", arguments: "{}" } },
      ],
    } as any);
    addToolResult("tc_ok", "success output");

    // First optimization — replaces the error with "[PREVIOUS ERROR OVERCOME...".
    optimizeContext();
    const h1 = getHistory();
    const errTool1 = h1.find((m) => m.role === "tool" && (m as any).tool_call_id === "tc_fail");
    expect(errTool1).toBeDefined();
    const content1 = (errTool1 as any).content as string;
    expect(content1).toContain("PREVIOUS ERROR OVERCOME");

    // Second optimization — should be idempotent (no change).
    // The guard `!content.startsWith("[PREVIOUS ERROR OVERCOME")` ensures
    // we skip already-optimized messages. (With the OLD code, the guard
    // checked "[ERRO ANTERIOR" which didn't match — but isErrorMessage()
    // returned false on the replacement, so it was dead code. The fix makes
    // the guard correct AND keeps the idempotency robust.)
    optimizeContext();
    const h2 = getHistory();
    const errTool2 = h2.find((m) => m.role === "tool" && (m as any).tool_call_id === "tc_fail");
    const content2 = (errTool2 as any).content as string;
    expect(content2).toBe(content1);
  });

  it("the replacement content starts with the prefix that the guard checks", () => {
    // Meta-test: verify the guard prefix and the replacement prefix match.
    // This is a regression guard against reintroducing the "[ERRO ANTERIOR"
    // typo. If someone changes the replacement string, this test forces them
    // to also update the guard.
    addUserMessage("run");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "tc_e", type: "function", function: { name: "executar_comando", arguments: "{}" } },
      ],
    } as any);
    addToolResult("tc_e", "[ERROR] failed");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "tc_ok", type: "function", function: { name: "executar_comando", arguments: "{}" } },
      ],
    } as any);
    addToolResult("tc_ok", "ok");

    optimizeContext();
    const h = getHistory();
    const errTool = h.find((m) => m.role === "tool" && (m as any).tool_call_id === "tc_e");
    const content = (errTool as any).content as string;
    // The replacement must start with the prefix the guard checks.
    expect(content.startsWith("[PREVIOUS ERROR OVERCOME")).toBe(true);
  });
});

// ─── Bug D: historySummary initializes history ─────────────────────────────

describe("Bug Hunter #2a (part 4) — Bug D: historySummary initializes history", () => {
  it("historySummary returns 'system:1' on a fresh module (not empty string)", async () => {
    // Reset modules to get a truly fresh history state (history === []).
    vi.resetModules();
    const freshHistory = await import("../history.js");

    // With OLD code: historySummary() does NOT call ensureHistoryInitialized(),
    // so history stays [] and it returns "". With the fix, it calls
    // ensureHistoryInitialized() (consistent with getHistory/historyLength),
    // pushing the system prompt, and returns "system:1".
    const summary = freshHistory.historySummary();
    expect(summary).toContain("system:1");
    expect(summary).not.toBe("");
  });

  it("historySummary is consistent with historyLength on fresh module", async () => {
    vi.resetModules();
    const freshHistory = await import("../history.js");

    const summary = freshHistory.historySummary();
    const len = freshHistory.historyLength();

    // Both should reflect the initialized state (system prompt present).
    expect(len).toBe(1);
    expect(summary).toContain("system:1");
  });

  it("historySummary reflects added messages after initialization", () => {
    // On an already-initialized history (resetHistory was called in beforeEach),
    // historySummary should work as before.
    addUserMessage("hello");
    addUserMessage("world");
    const summary = historySummary();
    expect(summary).toContain("system:1");
    expect(summary).toContain("user:2");
  });

  it("historySummary called before getHistory still returns system:1", async () => {
    // The key regression: historySummary() is the FIRST history function
    // called on a fresh module. OLD code returns "". FIX returns "system:1".
    vi.resetModules();
    const freshHistory = await import("../history.js");

    // Call historySummary FIRST — no other history function called yet.
    const summaryBefore = freshHistory.historySummary();
    expect(summaryBefore).toBe("system:1");

    // Now call getHistory — should be consistent.
    const h = freshHistory.getHistory();
    expect(h.length).toBe(1);
    expect(h[0].role).toBe("system");
  });
});

// ─── Smoke test: tryAppendToSession / session persistence ──────────────────
// No behavioral bug found in tryAppendToSession (lines 1405-1412), but we
// include a smoke test to lock in the behavior: it should call
// session.appendMessage and NOT throw on session failure.

describe("Bug Hunter #2a (part 4) — Smoke: tryAppendToSession persists messages", () => {
  it("addUserMessage triggers session.appendMessage (auto-persist)", () => {
    mockAppendMessage.mockClear();
    addUserMessage("persist me");
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    const arg = mockAppendMessage.mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg.role).toBe("user");
    expect(arg.content).toBe("persist me");
  });

  it("addToolResult triggers session.appendMessage with tool_call_id", () => {
    mockAppendMessage.mockClear();
    addToolResult("tc_persist", "tool output");
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    const arg = mockAppendMessage.mock.calls[0]?.[0];
    expect(arg.role).toBe("tool");
    expect(arg.tool_call_id).toBe("tc_persist");
    expect(arg.content).toBe("tool output");
  });

  it("addRawAssistantMessage triggers session.appendMessage", () => {
    mockAppendMessage.mockClear();
    addRawAssistantMessage({
      role: "assistant",
      content: "reply",
      tool_calls: [{ id: "tc_a", type: "function", function: { name: "ler_arquivo", arguments: "{}" } }],
    } as any);
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    const arg = mockAppendMessage.mock.calls[0]?.[0];
    expect(arg.role).toBe("assistant");
  });

  it("tryAppendToSession does NOT throw when session.appendMessage throws", () => {
    // If session persistence fails (e.g., disk full, permissions), the agent
    // should continue (not crash). tryAppendToSession wraps in try/catch and
    // logs an error. This is the intended behavior — we lock it in.
    mockAppendMessage.mockImplementation(() => {
      throw new Error("disk full");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => addUserMessage("this should not crash")).not.toThrow();
    expect(mockAppendMessage).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[SESSION] Failed to persist message"));
    errSpy.mockRestore();
    mockAppendMessage.mockReset();
  });
});

// ─── Regression: ensure existing behavior still works ──────────────────────

describe("Bug Hunter #2a (part 4) — Regression: existing behavior preserved", () => {
  it("optimizeContext still optimizes [IMPACT] hints for edit tools", () => {
    // Ensure the fix to getToolName didn't break the [IMPACT] optimization path.
    addUserMessage("edit file");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "tc_edit", type: "function", function: { name: "editar_arquivo", arguments: "{}" } },
      ],
    } as any);
    addToolResult("tc_edit", "[SUCCESS] edited\n\n[IMPACT] [ANÁLISE DE IMPACTO]\n19 uso(s) encontrado(s)");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "tc_next", type: "function", function: { name: "executar_comando", arguments: "{}" } },
      ],
    } as any);
    addToolResult("tc_next", "output");

    optimizeContext();

    const h = getHistory();
    const editResult = h.find((m) => m.role === "tool" && (m as any).tool_call_id === "tc_edit");
    const content = (editResult as any).content as string;
    expect(content).toContain("EDIT COMPLETED - IMPACT HINT OMITTED");
    expect(content).not.toContain("[ANÁLISE DE IMPACTO]");
  });

  it("optimizeContext still overcomes errors when same tool later succeeds", () => {
    // Ensure the prefix guard fix didn't break the error-overcome path.
    addUserMessage("run");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "tc_fail", type: "function", function: { name: "executar_comando", arguments: "{}" } },
      ],
    } as any);
    addToolResult("tc_fail", "[ERROR] failed");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "tc_ok", type: "function", function: { name: "executar_comando", arguments: "{}" } },
      ],
    } as any);
    addToolResult("tc_ok", "success");

    optimizeContext();

    const h = getHistory();
    const errTool = h.find((m) => m.role === "tool" && (m as any).tool_call_id === "tc_fail");
    expect((errTool as any).content).toContain("PREVIOUS ERROR OVERCOME");
  });

  it("compactHistory still preserves PRESERVE_PREFIXES system messages", () => {
    // Ensure compaction still preserves TASK_STATE etc. (§6.4, §17).
    addSystemMessage("## TASK_STATE\nProject: Test\nGoal: Fix bugs");
    for (let i = 0; i < 10; i++) {
      addUserMessage(`msg ${i}`);
    }

    const result = compactHistory();
    expect(result).not.toBeNull();

    const h = getHistory();
    const hasTaskState = h.some(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("## TASK_STATE")
    );
    expect(hasTaskState).toBe(true);
  });
});
