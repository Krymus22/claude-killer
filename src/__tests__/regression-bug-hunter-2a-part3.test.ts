/**
 * regression-bug-hunter-2a-part3.test.ts
 *
 * Regression tests for bugs found by Bug Hunter #2a (part 3) in
 * src/history.ts — compactHistoryAsync, compactHistory (sync),
 * PRESERVE_PREFIXES dedup, LLM-compaction effort gate, and the
 * dangling-tool-cleanup `tc.id` guard.
 *
 * Bugs covered:
 *
 *   A. PRESERVE_PREFIXES accumulation (compactHistoryAsync + compactHistory).
 *      The preservedSystem loop deduped by EXACT content match. Messages
 *      whose content CHANGES every compaction — [CONVERSATION MEMORY],
 *      ## Recently Modified Files, ## Invoked Skills — were NOT deduped
 *      because each instance has different content. After N compactions
 *      there were N stale summaries / re-hydration snapshots / skill
 *      snapshots permanently in context (pure bloat + conflicting versions
 *      of "what happened"). Fix: dedup by PREFIX, keep the LATEST instance.
 *      §6.4/§6.6 (the PREFIX must survive) still holds — the most recent
 *      instance is retained.
 *
 *   B. `tc.id` not null-guarded in the dangling-tool-cleanup loop
 *      (compactHistoryAsync + compactHistory). A corrupted/partial session
 *      file could yield null/undefined entries inside an assistant's
 *      tool_calls array. `tc.id` then threw TypeError, crashing compaction
 *      (the surrounding try/catch only wraps the LLM call, NOT this
 *      cleanup). loadHistoryDirect() and replaceHistory() already guarded
 *      with `if (tc?.id)`; the two compaction paths did not. Fix: add the
 *      same guard.
 *
 *   C. effortLevel="low" did NOT disable LLM compaction in
 *      compactHistoryAsync (§6.6 violation). The auto path
 *      (contextCompaction.ts → smartCompact) already gated on
 *      shouldUseIntelligentCompaction() before calling
 *      modelBasedCompactionAsync(); the manual /compact path
 *      (compactHistoryAsync) did NOT — so /compact with effort=low still
 *      fired an LLM summarization round-trip. Fix: gate on
 *      shouldUseIntelligentCompaction() here too.
 *
 * BUSINESS_RULES.md §17 compliance: no §17 rule was violated by the fixes.
 *   - COMPACT_KEEP_RECENT = 6 (unchanged).
 *   - PRESERVE_PREFIXES list unchanged (still all 7 prefixes; only the
 *     dedup STRATEGY changed — keep-latest-per-prefix instead of
 *     exact-content — so every prefix still survives compaction per §6.6).
 *   - contextCompactThreshold unchanged.
 *   - 9-section LLM prompt + "DIRECTLY QUOTE" anti-drift unchanged.
 *   - Re-hydration (5 files / 5k / 50k) and skill re-injection
 *     (5k / 25k) budgets unchanged.
 *   - Continuation message still always injected.
 *   - Dangling tool messages still removed post-compaction.
 *   - Compaction snapshot still saved.
 *   - Uses `import` not `require()` (ESM).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ─── Hoisted mutable mock state ─────────────────────────────────────────────
const {
  llmCompactMock,
  isLlmCompactionAvailableMock,
  intelligentCompactionMock,
  buildRehydrationMock,
  buildSkillReInjectionMock,
} = vi.hoisted(() => ({
  llmCompactMock: vi.fn(),
  isLlmCompactionAvailableMock: vi.fn(),
  intelligentCompactionMock: vi.fn(() => true), // default: medium/high/max
  buildRehydrationMock: vi.fn(() => null),       // default: no rehydration
  buildSkillReInjectionMock: vi.fn(() => null),   // default: no skill re-injection
}));

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../llmCompactor.js", () => ({
  llmCompact: llmCompactMock,
  isLlmCompactionAvailable: isLlmCompactionAvailableMock,
}));

vi.mock("../extensions.js", () => ({
  getActiveSkills: vi.fn(() => []),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortPromptSnippet: vi.fn(() => ""),
  shouldUseIntelligentCompaction: intelligentCompactionMock,
  setEffortLevel: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key",
    nvidiaApiKeys: "",
    model: "test-model",
    contextWindowTokens: 128000,
    contextCompactThreshold: 0.65,
    temperature: 0.6,
    topP: 0.9,
    maxTokens: 4096,
    effortLevel: "medium",
  },
}));

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
  throttle: vi.fn(),
}));

vi.mock("../session.js", () => ({
  appendMessage: vi.fn(),
  appendCompactionSnapshot: vi.fn(),
  getActiveSessionId: vi.fn(() => null),
  setActiveSession: vi.fn(),
}));

// Mock fileRehydration + skillTracker to return null by default so the
// compaction path doesn't inject ## Recently Modified Files / ## Invoked
// Skills (which would themselves match PRESERVE_PREFIXES and muddy the
// [CONVERSATION MEMORY] count assertions in Bug A tests). Individual tests
// override buildRehydrationMock / buildSkillReInjectionMock where needed.
vi.mock("../fileRehydration.js", () => ({
  buildRehydrationMessage: buildRehydrationMock,
  recordSessionFileEdit: vi.fn(),
  clearSessionFiles: vi.fn(),
}));

vi.mock("../skillTracker.js", () => ({
  buildSkillReInjectionMessage: buildSkillReInjectionMock,
  recordSkillInvocation: vi.fn(),
  clearInvokedSkills: vi.fn(),
}));

// ─── Imports AFTER mocks ────────────────────────────────────────────────────

import {
  compactHistoryAsync,
  compactHistory,
  addUserMessage,
  addRawAssistantMessage,
  addSystemMessage,
  resetHistory,
  getHistory,
  replaceHistory,
} from "../history.js";

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetHistory();
  isLlmCompactionAvailableMock.mockResolvedValue(true);
  intelligentCompactionMock.mockReturnValue(true);
  buildRehydrationMock.mockReturnValue(null);
  buildSkillReInjectionMock.mockReturnValue(null);
  // Default: LLM returns a usable summary so method="llm" tests work.
  llmCompactMock.mockResolvedValue(
    "[CONVERSATION MEMORY - LLM-generated summary of 5 messages]\n\n" +
    "## Context\nTest project\n## Decisions\n- Decision 1\n" +
    "## Code Changes\n- File edited — enough content to pass the >100 char gate.",
  );
});

afterEach(() => {
  resetHistory();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Count system messages whose content starts with the given prefix. */
function countPrefix(history: ReturnType<typeof getHistory>, prefix: string): number {
  return history.filter(
    (m) => m.role === "system" &&
      typeof m.content === "string" &&
      m.content.startsWith(prefix),
  ).length;
}

/** Push N user+assistant turns so compaction has enough to chew on. */
function addTurns(n: number): void {
  for (let i = 0; i < n; i++) {
    addUserMessage(`User message ${i} with sufficient content for testing`);
    addRawAssistantMessage({
      role: "assistant",
      content: `Assistant response ${i} with sufficient content for testing`,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Bug A: PRESERVE_PREFIXES accumulation (async)
// ═══════════════════════════════════════════════════════════════════════════

describe("Bug Hunter #2a (part 3) — Bug A: PRESERVE_PREFIXES does not accumulate (async)", () => {
  it("keeps only the LATEST [CONVERSATION MEMORY] from the middle (not all)", async () => {
    // Seed TWO stale [CONVERSATION MEMORY] messages (simulating accumulation
    // from two prior compactions), then enough turns to trigger a third
    // compaction. Without the fix, BOTH stale memories survive (different
    // content → exact-content dedup keeps both) + the new one = 3 total.
    // With the fix, only the LATEST stale memory survives + the new one = 2.
    addSystemMessage("[CONVERSATION MEMORY - 5 old messages compacted]\nolder stale summary");
    addSystemMessage("[CONVERSATION MEMORY - 9 old messages compacted]\nnewer stale summary");
    addTurns(8); // 16 messages → well past COMPACT_KEEP_RECENT + 1

    // Force mechanical so the new summary is also [CONVERSATION MEMORY] (from
    // buildCompactionSummary), making the count assertion deterministic.
    isLlmCompactionAvailableMock.mockResolvedValue(false);

    const result = await compactHistoryAsync();
    expect(result).not.toBeNull();

    const history = getHistory();
    const total = countPrefix(history, "[CONVERSATION MEMORY");
    // With fix: 1 (latest preserved stale) + 1 (newly generated) = 2.
    // Without fix: 2 (both stale preserved) + 1 (new) = 3.
    expect(total).toBe(2);

    // The surviving stale memory must be the NEWER one (keep-latest semantics).
    const staleMemories = history.filter(
      (m) => m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("newer stale summary"),
    );
    expect(staleMemories.length).toBe(1);
    // The older stale memory must have been dropped.
    const olderMemories = history.filter(
      (m) => m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("older stale summary"),
    );
    expect(olderMemories.length).toBe(0);
  });

  it("does not accumulate [CONVERSATION MEMORY] across two real compactions", async () => {
    // Run compaction twice (with turns in between) and assert the count of
    // [CONVERSATION MEMORY] messages stays bounded at 2, not 3+.
    isLlmCompactionAvailableMock.mockResolvedValue(false);

    addTurns(8); // 16 messages
    await compactHistoryAsync();
    const after1 = countPrefix(getHistory(), "[CONVERSATION MEMORY");
    expect(after1).toBe(1); // first compaction: just the new summary

    addTurns(6); // grow past threshold again
    await compactHistoryAsync();
    const after2 = countPrefix(getHistory(), "[CONVERSATION MEMORY");
    // With fix: previous summary preserved (latest) + new one = 2.
    // Without fix: would also keep growing each compaction.
    expect(after2).toBe(2);

    addTurns(6);
    await compactHistoryAsync();
    const after3 = countPrefix(getHistory(), "[CONVERSATION MEMORY");
    // Stays bounded at 2 — the third compaction replaces the previous
    // preserved summary with the second one (latest), then adds the third.
    expect(after3).toBe(2);
  });

  it("keeps only the LATEST ## Recently Modified Files when re-hydration runs", async () => {
    // Seed two stale rehydration snapshots, then trigger compaction WITH
    // re-hydration enabled (buildRehydrationMock returns content).
    addSystemMessage("## Recently Modified Files\nolder snapshot\nfile_a.lua");
    addSystemMessage("## Recently Modified Files\nnewer snapshot\nfile_b.lua");
    addTurns(8);

    isLlmCompactionAvailableMock.mockResolvedValue(false);
    buildRehydrationMock.mockReturnValue("## Recently Modified Files\nfresh snapshot\nfile_c.lua");

    await compactHistoryAsync();

    const history = getHistory();
    const total = countPrefix(history, "## Recently Modified Files");
    // With fix: 1 (latest preserved stale = newer snapshot) + 1 (fresh) = 2.
    // Without fix: 2 (both stale) + 1 (fresh) = 3.
    expect(total).toBe(2);
    // The older snapshot must be gone.
    expect(history.some((m) => typeof m.content === "string" && m.content.includes("file_a.lua"))).toBe(false);
  });

  it("keeps only the LATEST ## Invoked Skills when skill re-injection runs", async () => {
    addSystemMessage("## Invoked Skills\nolder skill set\nskill_a.md");
    addSystemMessage("## Invoked Skills\nnewer skill set\nskill_b.md");
    addTurns(8);

    isLlmCompactionAvailableMock.mockResolvedValue(false);
    buildSkillReInjectionMock.mockReturnValue("## Invoked Skills\nfresh skill set\nskill_c.md");

    await compactHistoryAsync();

    const history = getHistory();
    const total = countPrefix(history, "## Invoked Skills");
    expect(total).toBe(2); // latest preserved + fresh
    expect(history.some((m) => typeof m.content === "string" && m.content.includes("skill_a.md"))).toBe(false);
  });

  it("still preserves [SESSION CONTINUATION] (identical content, deduped to 1)", async () => {
    // [SESSION CONTINUATION] is a static string. Both old and new code dedup
    // it (exact-content dedup worked for identical content; prefix dedup
    // also works). This test guards against a regression where the new
    // prefix-dedup might accidentally drop it.
    addSystemMessage("[SESSION CONTINUATION] This session was continued from a previous conversation that ran out of context. The summary above covers the earlier portion. Continue working on the last task you were doing — do NOT ask the user what to do next. Pick up where you left off and keep working until the task is complete or you need user input.");
    addTurns(8);
    isLlmCompactionAvailableMock.mockResolvedValue(false);

    await compactHistoryAsync();

    const history = getHistory();
    // FIX-MED-2: compactHistoryAsync now checks hasContinuation and skips
    // injecting a fresh [SESSION CONTINUATION] message if one already
    // exists in preservedSystem (BH6 MEDIUM 1: previously stacked N copies
    // after N compactions). So we expect exactly 1 instance — the carried-
    // over one is preserved, and no duplicate is injected.
    const total = countPrefix(history, "[SESSION CONTINUATION");
    expect(total).toBe(1);
  });

  it("still preserves ## TASK_STATE (single instance, never regenerated)", async () => {
    addSystemMessage("## TASK_STATE\nProject: Test\nGoal: Implement feature");
    addTurns(8);
    isLlmCompactionAvailableMock.mockResolvedValue(false);

    await compactHistoryAsync();

    const history = getHistory();
    expect(countPrefix(history, "## TASK_STATE")).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug A (sync): same accumulation fix in compactHistory
// ═══════════════════════════════════════════════════════════════════════════

describe("Bug Hunter #2a (part 3) — Bug A: PRESERVE_PREFIXES does not accumulate (sync compactHistory)", () => {
  it("keeps only the LATEST [CONVERSATION MEMORY] from the middle", () => {
    addSystemMessage("[CONVERSATION MEMORY - 5 old messages compacted]\nolder stale summary");
    addSystemMessage("[CONVERSATION MEMORY - 9 old messages compacted]\nnewer stale summary");
    addTurns(8);

    const result = compactHistory();
    expect(result).not.toBeNull();

    const history = getHistory();
    // 1 (latest preserved stale) + 1 (newly generated by buildCompactionSummary) = 2.
    expect(countPrefix(history, "[CONVERSATION MEMORY")).toBe(2);
    // Older stale summary dropped.
    expect(history.some((m) => typeof m.content === "string" && m.content.includes("older stale summary"))).toBe(false);
    // Newer stale summary preserved.
    expect(history.some((m) => typeof m.content === "string" && m.content.includes("newer stale summary"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug B: tc.id null-guard in dangling-tool-cleanup (async + sync)
// ═══════════════════════════════════════════════════════════════════════════

describe("Bug Hunter #2a (part 3) — Bug B: tc.id null-guard in dangling tool cleanup", () => {
  it("compactHistoryAsync does NOT crash when tool_calls contains a null entry", async () => {
    // Build a history where an assistant has a null entry in its tool_calls
    // array (simulating a corrupted/partial session file). Without the
    // `if (tc?.id)` guard, `tc.id` throws TypeError mid-compaction.
    addTurns(8); // 16 messages → triggers compaction

    // Append a recent assistant with a malformed tool_calls entry, then a
    // matching tool result so the assistant itself isn't an orphan.
    const history = getHistory();
    history.push({
      role: "assistant",
      content: "calling tool",
      tool_calls: [
        { id: "call_ok", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
        null as any, // ← corrupted entry — would crash without guard
        undefined as any, // ← another corrupted shape
      ],
    } as any);
    history.push({ role: "tool", tool_call_id: "call_ok", content: "result" } as any);

    isLlmCompactionAvailableMock.mockResolvedValue(false);

    // Must not throw.
    const result = await compactHistoryAsync();
    expect(result).not.toBeNull();
    expect(result?.method).toBe("mechanical");
  });

  it("compactHistory (sync) does NOT crash when tool_calls contains a null entry", () => {
    addTurns(8);

    const history = getHistory();
    history.push({
      role: "assistant",
      content: "calling tool",
      tool_calls: [
        { id: "call_ok", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
        null as any,
      ],
    } as any);
    history.push({ role: "tool", tool_call_id: "call_ok", content: "result" } as any);

    // Must not throw.
    const result = compactHistory();
    expect(result).not.toBeNull();
  });

  it("compactHistoryAsync still removes genuinely dangling tool results (guard doesn't break cleanup)", async () => {
    // A tool result whose tool_call_id matches NO assistant tool_call must
    // still be removed by the cleanup (the guard must not disable cleanup).
    addTurns(8);
    const history = getHistory();
    // Add a dangling tool result with an id that no assistant has.
    history.push({ role: "tool", tool_call_id: "ghost_id", content: "dangling" } as any);

    isLlmCompactionAvailableMock.mockResolvedValue(false);
    await compactHistoryAsync();

    const after = getHistory();
    expect(after.some((m) => (m as any).tool_call_id === "ghost_id")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug C: effortLevel="low" disables LLM compaction (§6.6)
// ═══════════════════════════════════════════════════════════════════════════

describe("Bug Hunter #2a (part 3) — Bug C: effortLevel=low disables LLM compaction (§6.6)", () => {
  it("uses mechanical (not LLM) when shouldUseIntelligentCompaction() returns false", async () => {
    addTurns(8);
    isLlmCompactionAvailableMock.mockResolvedValue(true); // API key present
    intelligentCompactionMock.mockReturnValue(false);     // effortLevel = "low"

    const result = await compactHistoryAsync();
    expect(result).not.toBeNull();
    expect(result?.method).toBe("mechanical");
    // LLM must NOT be called — the whole point of §6.6 is to skip the
    // summarization round-trip when the user opted into low effort.
    expect(llmCompactMock).not.toHaveBeenCalled();
  });

  it("does not even query isLlmCompactionAvailable when effort is low (short-circuit)", async () => {
    addTurns(8);
    intelligentCompactionMock.mockReturnValue(false);

    await compactHistoryAsync();

    // Short-circuit: when effort=low, we must not bother checking API key
    // availability (and certainly not call llmCompact).
    expect(isLlmCompactionAvailableMock).not.toHaveBeenCalled();
    expect(llmCompactMock).not.toHaveBeenCalled();
  });

  it("uses LLM when shouldUseIntelligentCompaction() returns true (medium/high/max)", async () => {
    addTurns(8);
    isLlmCompactionAvailableMock.mockResolvedValue(true);
    intelligentCompactionMock.mockReturnValue(true); // not "low"

    const result = await compactHistoryAsync();
    expect(result?.method).toBe("llm");
    expect(llmCompactMock).toHaveBeenCalledTimes(1);
  });

  it("effort=low still produces a valid compacted history (mechanical summary present)", async () => {
    addTurns(8);
    intelligentCompactionMock.mockReturnValue(false);

    const result = await compactHistoryAsync();
    expect(result).not.toBeNull();

    const history = getHistory();
    // Mechanical summary from buildCompactionSummary starts with [CONVERSATION MEMORY.
    expect(countPrefix(history, "[CONVERSATION MEMORY")).toBe(1);
    // Continuation message still injected (§6.6: always injected).
    expect(countPrefix(history, "[SESSION CONTINUATION")).toBe(1);
    // System prompt at index 0 preserved.
    expect(history[0].role).toBe("system");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sanity: the fix doesn't break the basic "too short to compact" path
// ═══════════════════════════════════════════════════════════════════════════

describe("Bug Hunter #2a (part 3) — sanity: basic compactHistoryAsync behavior preserved", () => {
  it("returns null when history is too short", async () => {
    addTurns(2); // 4 messages < COMPACT_KEEP_RECENT + 1 (7)
    const result = await compactHistoryAsync();
    expect(result).toBeNull();
  });

  it("returns null when history has only system + recent (nothing to drop)", async () => {
    addTurns(3); // 6 messages → 6 <= 6 + 1
    const result = await compactHistoryAsync();
    expect(result).toBeNull();
  });

  it("compaction snapshot is saved after compaction (§6.6)", async () => {
    const { appendCompactionSnapshot } = await import("../session.js");
    addTurns(8);
    isLlmCompactionAvailableMock.mockResolvedValue(false);

    await compactHistoryAsync();

    expect(appendCompactionSnapshot).toHaveBeenCalledTimes(1);
    const [savedMessages, method] = (appendCompactionSnapshot as any).mock.calls[0];
    expect(Array.isArray(savedMessages)).toBe(true);
    expect(savedMessages.length).toBeGreaterThan(0);
    expect(method).toBe("mechanical");
  });
});
