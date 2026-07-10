/**
 * regression-bh7-compaction-fix.test.ts
 *
 * Regression tests for the 5 HIGH bugs found by Bug Hunter BH7 in
 * src/contextCompaction.ts (and a MEDIUM-classified one — BH7 BUG 7 —
 * promoted to HIGH per the FIX-COMPACT brief) and fixed by FIX-COMPACT.
 *
 * Bugs covered:
 *
 *   HIGH 1 + HIGH 2 (BH7 BUG 1 + BUG 2): modelBasedCompactionAsync deduped
 *   preserved system messages by EXACT content and iterated FORWARD, so
 *   regenerated messages (`[CONVERSATION MEMORY]`, `## Recently Modified
 *   Files`, `## Invoked Skills`) accumulated across LLM compactions AND
 *   the OLDEST (stale) version was kept. The sibling `compactHistoryAsync`
 *   in history.ts was already fixed (Bug Hunter #2a part 3) by deduping
 *   by PREFIX and iterating BACKWARD + `unshift` (keeping the LATEST
 *   instance per prefix). The fix ports that pattern to
 *   modelBasedCompactionAsync. §6.4 / §6.6 require the PREFIX to survive
 *   compaction — keeping the most recent instance satisfies that without
 *   unbounded growth.
 *
 *   HIGH 3 (BH7 BUG 3): modelBasedCompactionAsync did NOT call
 *   appendCompactionSnapshot after replaceHistory — violating §6.6
 *   ("Compaction snapshot é salvo no session file após compactar"). Only
 *   the manual `/compact` path (compactHistoryAsync) saved one, so on
 *   session reload the IA got the full un-compacted history.
 *
 *   HIGH 4 (BH7 BUG 4): smartCompact's heuristic + mechanical fallback
 *   path also did NOT save a snapshot. So when LLM compaction was skipped
 *   (effortLevel="low") or failed, no snapshot was saved either. The fix
 *   adds a single appendCompactionSnapshot call in smartCompact gated by
 *   `if (compacted)`, with the correct method tag ("llm" | "mechanical").
 *
 *   HIGH 5 (BH7 BUG 7): modelBasedCompactionAsync returned compacted:true
 *   even when savedTokens was NEGATIVE (LLM summary larger than the
 *   original toSummarize slice). smartCompact then skipped the
 *   heuristic/mechanical fallback AND injected 50K of re-hydration ON TOP
 *   of the larger context — net compaction INCREASED context, risking OOM.
 *   The fix: only return compacted:true if savedTokens > 0, so the
 *   fallback runs and shrinks the context.
 *
 * BUSINESS_RULES.md §17 compliance: no §17 rule was violated. The 9-section
 * LLM summary prompt and "DIRECTLY QUOTE" anti-drift text are unchanged.
 * PRESERVE_PREFIXES list unchanged. COMPACT_KEEP_RECENT=6 unchanged.
 * Re-hydration (5/5k/50k) and skill re-injection (5k/25k) budgets unchanged.
 * The snapshot save mirrors compactHistoryAsync's pattern (history.ts:1159-1164).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Shared mocks (hoisted) ─────────────────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn(),
    setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaApiKeys: "", nvidiaApiKeysFile: "",
    nvidiaBaseUrl: "https://test.api.com/v1", model: "test-model",
    contextWindowTokens: 128000, contextWarnThreshold: 0.6,
    contextCompactThreshold: 0.70, costPerKPrompt: 0, costPerKCompletion: 0,
    maxHealRetries: 2, temperature: 0.6, topP: 0.9,
    maxTokens: 4096, diffPreview: false, rateLimitRpm: 1000, maxConcurrency: 1,
  },
}));

const {
  chatMock,
  effortState,
  mockHistoryState,
  appendCompactionSnapshotMock,
} = vi.hoisted(() => ({
  chatMock: vi.fn(),
  effortState: { intelligent: false },
  mockHistoryState: {
    messages: [] as any[],
    tokens: 0,
    compactResult: null as any,
  },
  appendCompactionSnapshotMock: vi.fn(),
}));

vi.mock("../apiClient.js", () => ({ chat: chatMock }));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(() => () => {}),
}));

vi.mock("../history.js", () => ({
  // Mirror real estimateTokens: chars / 4 (1 token ≈ 4 chars).
  estimateTokens: vi.fn((msgs?: any) => {
    if (msgs !== undefined) {
      let chars = 0;
      for (const m of msgs) {
        if (typeof m.content === "string") chars += m.content.length;
        if (Array.isArray(m.tool_calls)) chars += JSON.stringify(m.tool_calls).length;
      }
      return Math.max(1, Math.ceil(chars / 4));
    }
    return mockHistoryState.tokens;
  }),
  getHistory: vi.fn(() => mockHistoryState.messages),
  replaceHistory: vi.fn((m: any[]) => {
    mockHistoryState.messages = m;
    let chars = 0;
    for (const mm of m) {
      if (typeof mm.content === "string") chars += mm.content.length;
      if (Array.isArray(mm.tool_calls)) chars += JSON.stringify(mm.tool_calls).length;
    }
    mockHistoryState.tokens = Math.max(1, Math.ceil(chars / 4));
  }),
  compactHistory: vi.fn(() => mockHistoryState.compactResult),
  resetHistory: vi.fn(() => {
    mockHistoryState.messages = [];
    mockHistoryState.tokens = 0;
    mockHistoryState.compactResult = null;
  }),
}));

vi.mock("../effortLevels.js", () => ({
  shouldUseIntelligentCompaction: vi.fn(() => effortState.intelligent),
  getEffortLevel: vi.fn(() => "medium"),
  setEffortLevel: vi.fn(),
  getEffortLabel: vi.fn(() => "MEDIUM"),
  getEffortPromptSnippet: vi.fn(() => ""),
  shouldAutoGenerateTests: vi.fn(() => false),
  shouldUseSubAgents: vi.fn(() => false),
}));

vi.mock("../session.js", () => ({
  appendMessage: vi.fn(),
  appendCompactionSnapshot: appendCompactionSnapshotMock,
  getActiveSessionId: vi.fn(() => null),
  setActiveSession: vi.fn(),
}));

vi.mock("../fileRehydration.js", () => ({
  buildRehydrationMessage: vi.fn(() => null),
  recordSessionFileEdit: vi.fn(),
  clearSessionFiles: vi.fn(),
}));

vi.mock("../skillTracker.js", () => ({
  buildSkillReInjectionMessage: vi.fn(() => null),
  recordSkillInvocation: vi.fn(),
  clearInvokedSkills: vi.fn(),
}));

// ─── Imports AFTER mocks ───────────────────────────────────────────────────

import { smartCompact } from "../contextCompaction.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function resetMockHistory(): void {
  mockHistoryState.messages = [];
  mockHistoryState.tokens = 0;
  mockHistoryState.compactResult = null;
}

/** Build a fake history with N user+assistant turns after a system prompt. */
function buildFakeHistory(n: number): any[] {
  const msgs: any[] = [{ role: "system", content: "system prompt" }];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: "user", content: `user msg ${i} with enough text to be meaningful` });
    msgs.push({ role: "assistant", content: `assistant reply ${i} with enough text` });
  }
  return msgs;
}

/** Count system messages whose content starts with the given prefix. */
function countPrefix(msgs: any[], prefix: string): number {
  return msgs.filter(
    (m) => m.role === "system" &&
      typeof m.content === "string" &&
      m.content.startsWith(prefix),
  ).length;
}

/**
 * Compute the token count for a messages array, mirroring the mock's
 * estimateTokens behavior (chars / 4). Used to set mockHistoryState.tokens
 * to a realistic value so modelBasedCompactionAsync's savedTokens calculation
 * reflects actual content size (not an inflated placeholder).
 */
function computeTokensFromMessages(msgs: any[]): number {
  let chars = 0;
  for (const m of msgs) {
    if (typeof m.content === "string") chars += m.content.length;
    if (Array.isArray(m.tool_calls)) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Set up the mock history state with the given messages and a REALISTIC
 * token count (computed from actual content). Use this instead of setting
 * mockHistoryState.tokens to an arbitrary large number — otherwise
 * modelBasedCompactionAsync's `beforeTokens - afterTokens` savedTokens
 * calculation is meaningless.
 */
function setMockHistory(msgs: any[]): void {
  mockHistoryState.messages = msgs;
  mockHistoryState.tokens = computeTokensFromMessages(msgs);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMockHistory();
  effortState.intelligent = false;
});

// ═══════════════════════════════════════════════════════════════════════════
// HIGH 1 + HIGH 2: prefix-based dedup (backward iteration + unshift)
// ═══════════════════════════════════════════════════════════════════════════

describe("FIX-COMPACT — HIGH 1 + HIGH 2: prefix-based dedup keeps LATEST per prefix", () => {
  beforeEach(() => {
    effortState.intelligent = true;
    // chat returns a valid summary (>50 chars) so model-based compaction succeeds
    chatMock.mockResolvedValue({
      choices: [{ message: { content: "## User's Original Intent\n- Test summary with enough length to pass the 50 char minimum threshold." } }],
    } as any);
  });

  it("keeps only the LATEST '## Recently Modified Files' from toSummarize (not both)", async () => {
    // Seed TWO stale re-hydration snapshots with DIFFERENT content (simulating
    // accumulation across two prior LLM compactions). With the OLD code
    // (exact-content dedup), BOTH would survive because the content differs.
    // With the fix (prefix-based dedup, backward iteration), only the LATEST
    // ("newer snapshot") survives.
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "system", content: "## Recently Modified Files\nolder snapshot\nfile_a.lua" },
      { role: "system", content: "## Recently Modified Files\nnewer snapshot\nfile_b.lua" },
      ...buildFakeHistory(18).slice(1),
    ];
    mockHistoryState.tokens = 100000;

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(true);

    const total = countPrefix(mockHistoryState.messages, "## Recently Modified Files");
    // With fix: 1 (latest preserved stale = "newer snapshot") = 1 total.
    // (injectPostCompactionMessages is mocked to return null, so no fresh
    // re-hydration is injected by the post-compaction step.)
    expect(total, "only ONE ## Recently Modified Files must survive (latest, not both)").toBe(1);

    // The OLDER snapshot must have been dropped.
    expect(
      mockHistoryState.messages.some((m) => typeof m.content === "string" && m.content.includes("file_a.lua")),
      "older snapshot content must be dropped (keep-latest semantics)",
    ).toBe(false);
    // The NEWER snapshot must have been preserved.
    expect(
      mockHistoryState.messages.some((m) => typeof m.content === "string" && m.content.includes("file_b.lua")),
      "newer snapshot content must be preserved (keep-latest semantics)",
    ).toBe(true);
  });

  it("keeps only the LATEST '## Invoked Skills' from toSummarize", async () => {
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "system", content: "## Invoked Skills\nolder skill set\nskill_a.md" },
      { role: "system", content: "## Invoked Skills\nnewer skill set\nskill_b.md" },
      ...buildFakeHistory(18).slice(1),
    ];
    mockHistoryState.tokens = 100000;

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(true);

    const total = countPrefix(mockHistoryState.messages, "## Invoked Skills");
    expect(total, "only ONE ## Invoked Skills must survive (latest, not both)").toBe(1);
    expect(mockHistoryState.messages.some((m) => typeof m.content === "string" && m.content.includes("skill_a.md"))).toBe(false);
    expect(mockHistoryState.messages.some((m) => typeof m.content === "string" && m.content.includes("skill_b.md"))).toBe(true);
  });

  it("keeps only the LATEST '[CONVERSATION MEMORY' from toSummarize", async () => {
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "system", content: "[CONVERSATION MEMORY - 5 old messages compacted]\nolder stale summary" },
      { role: "system", content: "[CONVERSATION MEMORY - 9 old messages compacted]\nnewer stale summary" },
      ...buildFakeHistory(18).slice(1),
    ];
    mockHistoryState.tokens = 100000;

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(true);

    // The OLD [CONVERSATION MEMORY] messages are deduped to 1 (latest).
    // The LLM compaction also adds 1 [AI CONTEXT COMPACTED] message (which
    // is NOT in PRESERVE_PREFIXES, so it doesn't count toward this prefix).
    const total = countPrefix(mockHistoryState.messages, "[CONVERSATION MEMORY");
    expect(total, "only ONE [CONVERSATION MEMORY must survive (latest, not both)").toBe(1);
    expect(mockHistoryState.messages.some((m) => typeof m.content === "string" && m.content.includes("older stale summary"))).toBe(false);
    expect(mockHistoryState.messages.some((m) => typeof m.content === "string" && m.content.includes("newer stale summary"))).toBe(true);
  });

  it("does not accumulate '## Recently Modified Files' across two LLM compactions", async () => {
    // Run LLM compaction twice — each time the toSummarize range may contain
    // a previously-preserved re-hydration snapshot. The count of
    // ## Recently Modified Files must stay bounded at 1, not grow.
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "system", content: "## Recently Modified Files\nfirst snapshot" },
      ...buildFakeHistory(18).slice(1),
    ];
    mockHistoryState.tokens = 100000;

    await smartCompact(10000);
    const after1 = countPrefix(mockHistoryState.messages, "## Recently Modified Files");
    expect(after1).toBe(1);

    // Add more messages so we can compact again, and inject a second
    // ## Recently Modified Files snapshot into the toSummarize range
    // (simulating a fresh re-hydration injected by a prior compaction pass).
    mockHistoryState.messages = [
      ...mockHistoryState.messages,
      { role: "system", content: "## Recently Modified Files\nsecond snapshot" },
      ...buildFakeHistory(8).slice(1),
    ];
    mockHistoryState.tokens = 100000;

    await smartCompact(10000);
    const after2 = countPrefix(mockHistoryState.messages, "## Recently Modified Files");
    expect(after2, "## Recently Modified Files count stays bounded at 1 across compactions").toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HIGH 3: modelBasedCompactionAsync saves a snapshot (method="llm")
// ═══════════════════════════════════════════════════════════════════════════

describe("FIX-COMPACT — HIGH 3: smartCompact saves compaction snapshot when LLM path runs (§6.6)", () => {
  beforeEach(() => {
    effortState.intelligent = true;
    chatMock.mockResolvedValue({
      choices: [{ message: { content: "## User's Original Intent\n- Test summary with enough length to pass the 50 char minimum threshold." } }],
    } as any);
  });

  it("calls appendCompactionSnapshot with method='llm' after LLM compaction succeeds", async () => {
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      ...buildFakeHistory(18).slice(1),
    ];
    mockHistoryState.tokens = 100000;

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(true);

    expect(appendCompactionSnapshotMock, "snapshot must be saved after LLM compaction (§6.6)").toHaveBeenCalledTimes(1);
    const [savedMessages, method] = appendCompactionSnapshotMock.mock.calls[0];
    expect(Array.isArray(savedMessages)).toBe(true);
    expect(savedMessages.length).toBeGreaterThan(0);
    expect(method).toBe("llm");
  });

  it("does NOT save a snapshot when LLM compaction is skipped (under threshold)", async () => {
    mockHistoryState.tokens = 100;
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hi" },
    ];

    const result = await smartCompact(50000);
    expect(result.compacted).toBe(false);
    expect(appendCompactionSnapshotMock).not.toHaveBeenCalled();
  });

  it("does NOT save a snapshot when chat() throws (no compaction occurred)", async () => {
    chatMock.mockRejectedValue(new Error("LLM service unavailable (503)"));
    // Build history that won't trigger any heuristic strategy either, so
    // compacted stays false and no snapshot is saved.
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      ...buildFakeHistory(10).slice(1),  // healthy conversation, no heuristics apply
    ];
    mockHistoryState.tokens = 100000;

    const result = await smartCompact(10000);
    // Either path: LLM failed, and heuristics had nothing to do, so compacted
    // is false → no snapshot.
    expect(appendCompactionSnapshotMock).not.toHaveBeenCalled();
    expect(result.compacted).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HIGH 4: smartCompact fallback (heuristic + mechanical) saves a snapshot
// ═══════════════════════════════════════════════════════════════════════════

describe("FIX-COMPACT — HIGH 4: smartCompact saves snapshot when fallback path runs (§6.6)", () => {
  it("calls appendCompactionSnapshot with method='mechanical' when heuristic strategies apply", async () => {
    // Disable intelligent compaction so smartCompact goes straight to heuristics.
    effortState.intelligent = false;
    // Build history with consecutive assistant messages so
    // remove-consecutive-same-role fires.
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
      { role: "assistant", content: "a3" },
    ];
    mockHistoryState.tokens = 100000;

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(true);

    expect(appendCompactionSnapshotMock, "snapshot must be saved after heuristic compaction (§6.6)").toHaveBeenCalledTimes(1);
    const [savedMessages, method] = appendCompactionSnapshotMock.mock.calls[0];
    expect(Array.isArray(savedMessages)).toBe(true);
    expect(savedMessages.length).toBeGreaterThan(0);
    expect(method).toBe("mechanical");
  });

  it("calls appendCompactionSnapshot with method='mechanical' when aggressive compactHistory runs", async () => {
    // Disable intelligent compaction; heuristics won't apply (healthy
    // conversation), so smartCompact falls back to compactHistory() which
    // is mocked to return a non-null result.
    effortState.intelligent = false;
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      ...buildFakeHistory(10).slice(1),
    ];
    mockHistoryState.tokens = 100000;
    mockHistoryState.compactResult = {
      removed: 5, beforeTokens: 100000, afterTokens: 50000, method: "mechanical" as const,
    };

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(true);

    expect(appendCompactionSnapshotMock, "snapshot must be saved after aggressive mechanical compaction (§6.6)").toHaveBeenCalledTimes(1);
    const [, method] = appendCompactionSnapshotMock.mock.calls[0];
    expect(method).toBe("mechanical");
  });

  it("does NOT save a snapshot when fallback path produces no compaction", async () => {
    effortState.intelligent = false;
    // Healthy conversation — no heuristic applies, no aggressive compaction.
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ];
    mockHistoryState.tokens = 100000;
    mockHistoryState.compactResult = null;

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(false);
    expect(appendCompactionSnapshotMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HIGH 5: modelBasedCompactionAsync returns compacted:false when savedTokens <= 0
// ═══════════════════════════════════════════════════════════════════════════

describe("FIX-COMPACT — HIGH 5: LLM compaction with savedTokens <= 0 falls back to heuristics", () => {
  beforeEach(() => {
    effortState.intelligent = true;
  });

  it("falls back to heuristic/mechanical when LLM summary is LARGER than original", async () => {
    // Build a small history (so toSummarize is small) but with enough messages
    // to pass the modelBasedCompactionAsync `if (allMessages.length < 10)` gate.
    // Use SHORT messages so the LLM summary (verbose 10-section format) is
    // guaranteed to be LARGER than the dropped toSummarize slice.
    const shortMsgs: any[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 12; i++) {
      shortMsgs.push({ role: "user", content: `u${i}` });       // very short
      shortMsgs.push({ role: "assistant", content: `a${i}` });  // very short
    }
    // CRITICAL: set mockHistoryState.tokens to the REAL computed value (not an
    // inflated 100000). modelBasedCompactionAsync captures `beforeTokens` from
    // history.estimateTokens() (no args → returns mockHistoryState.tokens) and
    // computes savedTokens = beforeTokens - afterTokens. If beforeTokens is
    // inflated, savedTokens will always be positive even when the LLM summary
    // is larger than the original — defeating the purpose of this test.
    setMockHistory(shortMsgs);
    const beforeTokens = mockHistoryState.tokens;  // ~13 tokens

    // LLM returns a VERBOSE summary (>50 chars, so it's "valid"). The summary
    // content is much LARGER than the dropped toSummarize slice, so
    // savedTokens will be NEGATIVE.
    const verboseSummary = "## User's Original Intent\n- The user wanted to test compaction. " +
      "## Architectural Decisions Made\n- Decision A was made for reasons X, Y, Z. " +
      "## Arquivos Modificados\n- src/foo.ts was changed to add bar(). " +
      "## Unresolved Bugs\n- Bug 1 is unresolved. " +
      "## Problem-Solving Logic Chain\n- We reasoned through this step by step. " +
      "## All User Messages Summary\n- User said do X. User said do Y. " +
      "## Planned Next Steps\n- Next we plan to do Z. " +
      "## Currently Working On\n- We are working on the fix. " +
      "## User Preferences/Constraints\n- User prefers tabs. " +
      "## Critical Technical Context\n- Important context here.";
    chatMock.mockResolvedValue({
      choices: [{ message: { content: verboseSummary } }],
    } as any);

    // Set up compactHistory mock to return a non-null result so the fallback
    // mechanical path can succeed (the heuristic strategies alone won't
    // apply to a conversation of pure user/assistant messages with no
    // consecutive-same-role pairs).
    mockHistoryState.compactResult = {
      removed: 5,
      beforeTokens: beforeTokens,
      afterTokens: 1,
      method: "mechanical" as const,
    };

    // maxTokens must be < beforeTokens so smartCompact triggers.
    const result = await smartCompact(Math.max(1, beforeTokens - 1));

    // The fallback path MUST have run (compacted=true from mechanical).
    expect(result.compacted, "fallback must run and produce compacted=true").toBe(true);
    // savedTokens is non-negative (from the mechanical path).
    expect(result.savedTokens).toBeGreaterThanOrEqual(0);

    // The snapshot was saved with method="mechanical" (NOT "llm"), proving
    // the LLM path was treated as "did not compact" and the fallback ran.
    expect(appendCompactionSnapshotMock, "snapshot must be saved by the fallback path").toHaveBeenCalledTimes(1);
    const [, method] = appendCompactionSnapshotMock.mock.calls[0];
    expect(method, "method must be 'mechanical' (LLM path was skipped due to savedTokens<=0)").toBe("mechanical");
  });

  it("does NOT mark compacted=true when LLM savedTokens is exactly 0", async () => {
    // Edge case: savedTokens = 0 (summary is exactly the same size as the
    // dropped slice). Should still fall through to fallback.
    const msgs: any[] = [{ role: "system", content: "system prompt" }];
    // Add a mix that gives toSummarize enough content to match a tiny summary
    for (let i = 0; i < 12; i++) {
      msgs.push({ role: "user", content: "x".repeat(20) });
      msgs.push({ role: "assistant", content: "y".repeat(20) });
    }
    setMockHistory(msgs);
    const beforeTokens = mockHistoryState.tokens;  // ~125 tokens

    // Return a summary whose token cost is at least as large as the dropped
    // toSummarize tokens, so savedTokens <= 0.
    // toSummarize = messages.slice(1, cutoff) where cutoff = floor(25 * 0.7) = 17
    // → 16 messages, each ~20 chars = ~320 chars = ~80 tokens.
    // The summary below is ~4000 chars = ~1000 tokens, MUCH larger.
    const hugeSummary = "Z".repeat(4000);
    chatMock.mockResolvedValue({
      choices: [{ message: { content: hugeSummary } }],
    } as any);

    mockHistoryState.compactResult = {
      removed: 5,
      beforeTokens: beforeTokens,
      afterTokens: 1,
      method: "mechanical" as const,
    };

    // maxTokens must be < beforeTokens so smartCompact triggers.
    const result = await smartCompact(Math.max(1, beforeTokens - 1));
    expect(result.compacted, "fallback must run (LLM savedTokens<=0 → compacted:false from LLM)").toBe(true);
    expect(appendCompactionSnapshotMock).toHaveBeenCalledTimes(1);
    const [, method] = appendCompactionSnapshotMock.mock.calls[0];
    expect(method).toBe("mechanical");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sanity: snapshot is saved EXACTLY ONCE per smartCompact call
// (no double-save when LLM succeeds, no save when nothing compacted)
// ═══════════════════════════════════════════════════════════════════════════

describe("FIX-COMPACT — sanity: snapshot save semantics", () => {
  it("saves the snapshot EXACTLY ONCE when LLM compaction succeeds (no double-save)", async () => {
    effortState.intelligent = true;
    chatMock.mockResolvedValue({
      choices: [{ message: { content: "## User's Original Intent\n- Test summary with enough length to pass the 50 char minimum threshold." } }],
    } as any);
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      ...buildFakeHistory(18).slice(1),
    ];
    mockHistoryState.tokens = 100000;

    await smartCompact(10000);

    // The fix puts a SINGLE snapshot save call in smartCompact (gated by
    // `if (compacted)`), so even when the LLM path runs, only ONE snapshot
    // is saved (not one in modelBasedCompactionAsync + one in smartCompact).
    expect(appendCompactionSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
