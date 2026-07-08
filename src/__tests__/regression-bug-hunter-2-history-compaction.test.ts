/**
 * regression-bug-hunter-2-history-compaction.test.ts
 *
 * Regression tests for bugs found and fixed by Bug Hunter #2 (History + compaction focus).
 *
 * Bugs covered:
 *   A. history.ts sync compactHistory() missing "## Recently Modified Files" and
 *      "## Invoked Skills" in PRESERVE_PREFIXES (vs async version which had them).
 *      Violated BUSINESS_RULES.md §6.4 — all PRESERVE_PREFIXES must survive compaction.
 *   B. history.ts injectPatterns() used require("./patternExtractor.js") (CommonJS)
 *      in an ESM project. The require would throw "require is not defined" at runtime
 *      and the catch block silently swallowed it, so patterns were NEVER injected.
 *   C. contextCompaction.ts merge-adjacent-tool-results.shouldApply required 4+ tools
 *      (consecutive >= 3) but BUSINESS_RULES.md §6.2 says "3+ tools seguidos → merge".
 *   D. contextCompaction.ts remove-old-error-messages.shouldApply triggered at 6+ errors
 *      (errorCount > 5) but BUSINESS_RULES.md §6.2 says "mantém só primeiros 3 [ERROR]",
 *      so shouldApply must trigger at 4+ errors.
 *   F. checkpointWriter.ts writeCheckpoint() computed contextPercent from
 *      history_msgs.length (message COUNT) / MAX_CONTEXT_TOKENS, which is meaningless
 *      (~0% always). Should use estimateTokens().
 *
 * Bug E (MAX_CONTEXT_TOKENS = 128_000 hardcoded, violating §1.1) was NOT fixed because
 * changing it would break existing tests that assume 128k. Reported as a §1.1 issue.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn() },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com", model: "test-model",
    contextWindowTokens: 128000, contextWarnThreshold: 0.6, contextCompactThreshold: 0.65,
    costPerKPrompt: 0.01, costPerKCompletion: 0.03, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(async () => {}), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortLevel: vi.fn(() => "medium"),
  setEffortLevel: vi.fn(),
  getEffortLabel: vi.fn(() => "MEDIUM"),
  getEffortPromptSnippet: vi.fn(() => ""),
  shouldAutoGenerateTests: vi.fn(() => false),
  shouldUseSubAgents: vi.fn(() => false),
  shouldUseIntelligentCompaction: vi.fn(() => false),
}));

vi.mock("../apiKeyPool.js", () => ({ getPoolSize: vi.fn(() => 1), formatPoolStats: vi.fn(() => "") }));
vi.mock("../i18n.js", () => ({ getLocalizedSlashCommands: vi.fn(() => []), getCommandI18n: vi.fn(() => ({})) }));

// Mock apiClient so checkpointWriter's chat() doesn't hit the network.
vi.mock("../apiClient.js", () => ({ chat: vi.fn() }));

// Mock llmCompactor to avoid real API calls
vi.mock("../llmCompactor.js", () => ({
  llmCompact: vi.fn(async () => null),
  isLlmCompactionAvailable: vi.fn(async () => false),
}));

// Mock session to avoid file I/O during compaction
vi.mock("../session.js", () => ({
  appendMessage: vi.fn(),
  appendCompactionSnapshot: vi.fn(),
  getActiveSessionId: vi.fn(() => null),
  setActiveSession: vi.fn(),
}));

// ─── Imports AFTER mocks ───────────────────────────────────────────────────

import * as history from "../history.js";
import { compactIntelligently, strategies } from "../contextCompaction.js";
import { getPatternsCached } from "../patternExtractor.js";

// ─── Bug A: sync compactHistory() missing PRESERVE_PREFIXES ────────────────

describe("Bug Hunter #2 — Bug A: sync compactHistory() PRESERVE_PREFIXES", () => {
  beforeEach(() => {
    history.resetHistory();
  });

  it("sync compactHistory preserves '## Recently Modified Files' system message", () => {
    // Add a Recently Modified Files message (would be injected by fileRehydration
    // after a previous async compaction).
    history.addSystemMessage("## Recently Modified Files (re-hydrated after compaction)\n/file.ts content");

    // Pad with enough messages to trigger compaction (> COMPACT_KEEP_RECENT + 1).
    for (let i = 0; i < 15; i++) {
      history.addUserMessage(`user msg ${i} with content`);
      history.addRawAssistantMessage({ role: "assistant", content: `resp ${i}` } as any);
    }

    const result = history.compactHistory();
    expect(result).not.toBeNull();

    // The Recently Modified Files message MUST survive compaction (per §6.4).
    const allHistory = history.getHistory();
    const hasRecentlyModified = allHistory.some(
      (m) => typeof m.content === "string" && m.content.startsWith("## Recently Modified Files")
    );
    expect(hasRecentlyModified).toBe(true);
  });

  it("sync compactHistory preserves '## Invoked Skills' system message", () => {
    history.addSystemMessage("## Invoked Skills (re-injected after compaction)\n/skill.md content");

    for (let i = 0; i < 15; i++) {
      history.addUserMessage(`user msg ${i} with content`);
      history.addRawAssistantMessage({ role: "assistant", content: `resp ${i}` } as any);
    }

    const result = history.compactHistory();
    expect(result).not.toBeNull();

    const allHistory = history.getHistory();
    const hasInvokedSkills = allHistory.some(
      (m) => typeof m.content === "string" && m.content.startsWith("## Invoked Skills")
    );
    expect(hasInvokedSkills).toBe(true);
  });

  it("sync compactHistory preserves all 7 PRESERVE_PREFIXES (matches async)", () => {
    // Add one of each preserved prefix
    history.addSystemMessage("## TASK_STATE\nProject: Test");
    history.addSystemMessage("## Persistent Memory\nfoo");
    history.addSystemMessage("[CONVERSATION MEMORY - prev]\nstuff");
    history.addSystemMessage("[PLAN - 3 steps]\nstep1");
    history.addSystemMessage("[SESSION CONTINUATION] continue");
    history.addSystemMessage("## Recently Modified Files\nfile.ts");
    history.addSystemMessage("## Invoked Skills\nskill.md");

    for (let i = 0; i < 20; i++) {
      history.addUserMessage(`user msg ${i} with content`);
      history.addRawAssistantMessage({ role: "assistant", content: `resp ${i}` } as any);
    }

    const result = history.compactHistory();
    expect(result).not.toBeNull();

    const allHistory = history.getHistory();
    // Each prefix should survive
    const prefixes = [
      "## TASK_STATE",
      "## Persistent Memory",
      "[CONVERSATION MEMORY",
      "[PLAN",
      "[SESSION CONTINUATION",
      "## Recently Modified Files",
      "## Invoked Skills",
    ];
    for (const prefix of prefixes) {
      const hasPrefix = allHistory.some(
        (m) => typeof m.content === "string" && m.content.startsWith(prefix)
      );
      expect(hasPrefix, `prefix "${prefix}" should survive sync compaction`).toBe(true);
    }
  });
});

// ─── Bug B: injectPatterns() require() → ESM import ───────────────────────

describe("Bug Hunter #2 — Bug B: injectPatterns uses ESM import (not require)", () => {
  it("getSystemPrompt does not throw and patternExtractor is importable", () => {
    // If injectPatterns used require() in ESM, it would throw "require is not defined"
    // and the catch block would silently swallow it — but the prompt would still work,
    // just without patterns. So we verify getPatternsCached is a real function (proving
    // the static import works).
    expect(typeof getPatternsCached).toBe("function");
  });

  it("getSystemPrompt succeeds (require() would have been swallowed silently)", () => {
    // This test verifies that getSystemPrompt runs without throwing. Previously,
    // require() inside injectPatterns would throw and be caught — getSystemPrompt
    // would still return a prompt, just without patterns. The bug was silent.
    // With the ESM import fix, patterns can now actually be injected (when present).
    expect(() => history.getSystemPrompt()).not.toThrow();
  });

  it("history.ts source no longer calls require() for patternExtractor (ESM import instead)", () => {
    // Read the source file to verify the require was removed.
    // We check that no EXECUTABLE line uses require("./patternExtractor.js") —
    // comments mentioning the bug are OK (they describe the fix).
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "history.ts"),
      "utf8"
    );
    // Strip /* */ and // comments so we only check executable lines.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
      .replace(/\/\/.*$/gm, "");            // line comments
    // No executable require call for patternExtractor.
    expect(stripped).not.toMatch(/require\s*\(\s*["']\.\/patternExtractor\.js["']\s*\)/);
    // The ESM import should be present.
    expect(source).toMatch(/import\s+\{[^}]*getPatternsCached[^}]*\}\s+from\s+["']\.\/patternExtractor\.js["']/);
  });
});

// ─── Bug C: merge-adjacent-tool-results threshold (3+ not 4+) ──────────────

describe("Bug Hunter #2 — Bug C: merge-adjacent-tool-results shouldApply at 3+ tools", () => {
  it("shouldApply returns TRUE for exactly 3 consecutive tool results", () => {
    // Per BUSINESS_RULES.md §6.2: "3+ tools seguidos → merge".
    // Old code required 4+ (consecutive >= 3 means N-1 >= 3, so N >= 4).
    // New code requires 3+ (consecutive >= 2 means N-1 >= 2, so N >= 3).
    const s = strategies.find((x) => x.name === "merge-adjacent-tool-results")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: "a", tool_call_id: "1" },
      { role: "tool", content: "b", tool_call_id: "2" },
      { role: "tool", content: "c", tool_call_id: "3" },
    ];
    expect(s.shouldApply(msgs)).toBe(true);
  });

  it("shouldApply returns FALSE for 2 consecutive tool results", () => {
    const s = strategies.find((x) => x.name === "merge-adjacent-tool-results")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: "a", tool_call_id: "1" },
      { role: "tool", content: "b", tool_call_id: "2" },
    ];
    expect(s.shouldApply(msgs)).toBe(false);
  });

  it("shouldApply returns TRUE for 4+ consecutive tool results (still works)", () => {
    const s = strategies.find((x) => x.name === "merge-adjacent-tool-results")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: "a", tool_call_id: "1" },
      { role: "tool", content: "b", tool_call_id: "2" },
      { role: "tool", content: "c", tool_call_id: "3" },
      { role: "tool", content: "d", tool_call_id: "4" },
    ];
    expect(s.shouldApply(msgs)).toBe(true);
  });

  it("apply merges exactly 3 consecutive tool results into 1 (regression)", () => {
    // Test apply DIRECTLY (not via compactIntelligently) because
    // remove-consecutive-same-role runs first in compactIntelligently and
    // would merge the 3 tools before merge-adjacent-tool-results can fire.
    // This test verifies that apply() itself handles 3 tools correctly.
    const s = strategies.find((x) => x.name === "merge-adjacent-tool-results")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: "alpha", tool_call_id: "1" },
      { role: "tool", content: "beta", tool_call_id: "2" },
      { role: "tool", content: "gamma", tool_call_id: "3" },
    ];
    const result = s.apply(msgs);
    const toolMsgs = result.filter((m: any) => m.role === "tool");
    // 3 tools → merged into 1 (apply uses `toolResults.length > 2`).
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].content).toContain("[1]");
    expect(toolMsgs[0].content).toContain("[3]");
  });
});

// ─── Bug D: remove-old-error-messages threshold (>3 not >5) ───────────────

describe("Bug Hunter #2 — Bug D: remove-old-error-messages shouldApply at 4+ errors", () => {
  it("shouldApply returns TRUE for exactly 4 errors (was false before fix)", () => {
    // Per BUSINESS_RULES.md §6.2: "mantém só primeiros 3 [ERROR]".
    // apply() keeps first 3, drops 4+. shouldApply must trigger at 4+ so apply has work.
    // Old code: errorCount > 5 → triggers at 6+ (4-5 errors left unpruned — bug).
    // New code: errorCount > 3 → triggers at 4+ (correct).
    const s = strategies.find((x) => x.name === "remove-old-error-messages")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: "[ERROR] a", tool_call_id: "1" },
      { role: "tool", content: "[ERROR] b", tool_call_id: "2" },
      { role: "tool", content: "[ERROR] c", tool_call_id: "3" },
      { role: "tool", content: "[ERROR] d", tool_call_id: "4" },
    ];
    expect(s.shouldApply(msgs)).toBe(true);
  });

  it("shouldApply returns TRUE for 5 errors (was false before fix)", () => {
    const s = strategies.find((x) => x.name === "remove-old-error-messages")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: "[ERROR] a", tool_call_id: "1" },
      { role: "tool", content: "[ERROR] b", tool_call_id: "2" },
      { role: "tool", content: "[ERROR] c", tool_call_id: "3" },
      { role: "tool", content: "[ERROR] d", tool_call_id: "4" },
      { role: "tool", content: "[ERROR] e", tool_call_id: "5" },
    ];
    expect(s.shouldApply(msgs)).toBe(true);
  });

  it("shouldApply returns FALSE for 3 errors (still kept)", () => {
    const s = strategies.find((x) => x.name === "remove-old-error-messages")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: "[ERROR] a", tool_call_id: "1" },
      { role: "tool", content: "[ERROR] b", tool_call_id: "2" },
      { role: "tool", content: "[ERROR] c", tool_call_id: "3" },
    ];
    expect(s.shouldApply(msgs)).toBe(false);
  });

  it("compactIntelligently prunes 4 errors down to 3 (regression, interleaved)", () => {
    // End-to-end: with 4 errors, strategy should fire and keep only first 3.
    // We interleave with assistant messages so remove-consecutive-same-role
    // doesn't merge the tool messages first (which would prevent
    // remove-old-error-messages from seeing 4 separate errors).
    const msgs = [
      { role: "system", content: "p" },
      { role: "assistant", content: "a0" },
      { role: "tool", content: "[ERROR] a", tool_call_id: "1" },
      { role: "assistant", content: "a1" },
      { role: "tool", content: "[ERROR] b", tool_call_id: "2" },
      { role: "assistant", content: "a2" },
      { role: "tool", content: "[ERROR] c", tool_call_id: "3" },
      { role: "assistant", content: "a3" },
      { role: "tool", content: "[ERROR] d", tool_call_id: "4" },
    ];
    const { appliedStrategies, messages } = compactIntelligently(msgs);
    expect(appliedStrategies).toContain("remove-old-error-messages");
    const errors = messages.filter(
      (m: any) => typeof m.content === "string" && m.content.includes("[ERROR]")
    );
    expect(errors.length).toBe(3);
  });
});

// ─── Bug F: regression tests live in checkpointWriter-extended.test.ts ─────
//
// Bug F (checkpointWriter.writeCheckpoint using message count instead of
// estimateTokens for contextPercent) is tested in
// `checkpointWriter-extended.test.ts` under the describe block
// "Bug Hunter #2 — Bug F: writeCheckpoint contextPercent uses tokens".
// That file already mocks history.js with controllable estimateTokens/getHistory,
// which is required because ESM module exports cannot be mutated at runtime
// (the Bug A tests in THIS file need the real history module, so we cannot
// mock it here).
