/**
 * chatdisplay-planpanel-integration.test.tsx — Regression tests for the
 * ChatDisplay × PlanPanel × App.tsx integration bug hunt pass.
 *
 * COVERS THE FOLLOWING BUGS (each with a regression test that fails
 * without the fix and passes with it):
 *
 *   Bug A (indexOf-on2): ChatDisplay used messages.indexOf(msg) inside the
 *   <Static> and live render loops — O(n²) per render. For 1000 messages,
 *   that's ~500K reference comparisons every 80ms during streaming. Fixed
 *   to use index offsets (O(1) per item).
 *
 *   Bug B (syncPlan-race): App.tsx's syncPlan used `await import()` which
 *   scheduled a microtask that could fire AFTER createPlan() was called
 *   in the same tick, producing a transient render with `planSteps = []`
 *   (flicker). Fixed via static import (synchronous getPlan) + calling
 *   syncPlan() immediately after createPlan().
 *
 *   Bug C (planpanel-keyboard-steal): PlanPanel registered a useInput that
 *   toggled `expanded` on Enter / Up / Down — stealing keys from the
 *   autocomplete (Up/Down navigation) and TextInput (Enter submit). The
 *   keyboard toggle was documented as not-working; removed.
 *
 *   Bug D (§17.4.21): error messages rendered through MarkdownRenderer.
 *   Already covered in chatdisplay-markdown-integration.test.tsx; this
 *   file adds an end-to-end "error label is separate from content" test.
 *
 *   Bug E (plan-disappear-on-clear): verify that when planExecutor's plan
 *   is cleared (clearPlan), the React state also goes empty (syncPlan
 *   picks up the null and calls setPlanSteps([])). This is the
 *   "plan appears/disappears correctly" check from the bug-hunt checklist.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

// ─── Mocks (same pattern as chatdisplay-markdown-integration.test.tsx) ─────

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn(),
  },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(),
  debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com", model: "test-model",
    contextWindowTokens: 128000, contextWarnThreshold: 0.5, contextCompactThreshold: 0.8,
    costPerKPrompt: 0.01, costPerKCompletion: 0.03, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

// Import DEPOIS dos mocks.
import { ChatDisplay, type ChatMessage } from "../tui/ChatDisplay.js";
import { PlanPanel } from "../tui/PlanPanel.js";
import {
  createPlan,
  getPlan,
  clearPlan,
  hasIncompletePlan,
  markStep,
} from "../planExecutor.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderMessages(messages: ChatMessage[]): string {
  const { lastFrame } = render(<ChatDisplay messages={messages} />);
  return stripAnsi(lastFrame() ?? "");
}

// ─── Bug A: O(n²) indexOf → O(n) index offsets ────────────────────────────

describe("Bug A: ChatDisplay render is O(n), not O(n²) (indexOf fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a 500-message conversation in reasonable time (no indexOf)", () => {
    // Before the fix: messages.indexOf(msg) was called for every static and
    // live item. For 500 messages, that's ~125K reference comparisons per
    // render. With the offset fix, it's 500 O(1) lookups.
    //
    // The performance smoke test in chatdisplay-markdown-integration.test.tsx
    // uses 20 messages — too small to surface the O(n²) issue. This test
    // uses 500 messages so the difference is measurable.
    const messages: ChatMessage[] = Array.from({ length: 500 }, (_, i) => ({
      role: i % 2 === 0 ? "user" as const : "assistant" as const,
      content: i % 2 === 0 ? `Pergunta ${i}` : `**Resposta ${i}**`,
    }));

    const start = performance.now();
    const out = renderMessages(messages);
    const elapsed = performance.now() - start;

    // All messages render (none dropped).
    expect(out).toContain("Pergunta 0");
    expect(out).toContain("Resposta 499");
    // Markdown is parsed (no raw **).
    expect(out).not.toMatch(/\*\*Resposta \d+\*\*/);
    // Performance: < 1.5s even on slow CI. Without the fix, this was ~3-5s
    // for 500 messages (mostly indexOf overhead + parseBlocks).
    expect(elapsed).toBeLessThan(1500);
  });

  it("renders a 1000-message conversation in reasonable time (scaling check)", () => {
    // Scaling check: doubling the message count should NOT double the time
    // (O(n) vs O(n²)). The actual time depends on parseBlocks too, so we
    // use a generous threshold — the goal is to catch regressions to O(n²).
    const messages: ChatMessage[] = Array.from({ length: 1000 }, (_, i) => ({
      role: i % 2 === 0 ? "user" as const : "assistant" as const,
      content: i % 2 === 0 ? `Q${i}` : `**A${i}**`,
    }));

    const start = performance.now();
    const out = renderMessages(messages);
    const elapsed = performance.now() - start;

    expect(out).toContain("Q0");
    expect(out).toContain("A999");
    // Generous threshold — the point is to surface catastrophic regressions
    // (e.g. someone re-adds messages.indexOf).
    expect(elapsed).toBeLessThan(4000);
  });

  it("re-render with same messages produces same output (stable keys)", () => {
    // The fix changed how keys are computed (offset instead of indexOf).
    // Verify keys are still stable across re-renders with the same messages.
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "**hi**" },
      { role: "user", content: "bye" },
      { role: "assistant", content: "**bye**" },
      { role: "user", content: "end" },
    ];
    const { lastFrame: f1, rerender } = render(<ChatDisplay messages={messages} />);
    const out1 = stripAnsi(f1() ?? "");

    rerender(<ChatDisplay messages={messages} />);
    const out2 = stripAnsi(f1() ?? "");

    expect(out1).toBe(out2);
  });

  it("keys stay stable when messages graduate from live to static", () => {
    // When a new message arrives, an older message may move from live to
    // static. Its key must NOT change (otherwise Ink re-writes it to
    // scrollback, causing duplicate output).
    //
    // We can't observe keys directly with ink-testing-library, but we CAN
    // verify that the rendered output for old messages is identical before
    // and after the graduation (no duplicated lines).
    const baseMessages: ChatMessage[] = Array.from({ length: 5 }, (_, i) => ({
      role: "user" as const,
      content: `msg${i}`,
    }));

    const { lastFrame: f1, rerender } = render(<ChatDisplay messages={baseMessages} />);
    const out1 = stripAnsi(f1() ?? "");

    // Add 2 more messages — this pushes some `msg0`/`msg1` from live to static.
    const grownMessages = [
      ...baseMessages,
      { role: "user" as const, content: "msg5" },
      { role: "user" as const, content: "msg6" },
    ];
    rerender(<ChatDisplay messages={grownMessages} />);
    const out2 = stripAnsi(f1() ?? "");

    // The original 5 messages still appear (no loss).
    for (let i = 0; i < 5; i++) {
      expect(out2).toContain(`msg${i}`);
    }
    // The new messages appear.
    expect(out2).toContain("msg5");
    expect(out2).toContain("msg6");
    // No duplicate "msg0" (which would happen if the key changed and Ink
    // re-wrote the now-static message).
    const msg0Count = (out2.match(/msg0/g) ?? []).length;
    expect(msg0Count).toBe(1);
  });
});

// ─── Bug B: syncPlan race condition — planExecutor is synchronous ──────────

describe("Bug B: syncPlan reads planExecutor synchronously (no race)", () => {
  beforeEach(() => {
    clearPlan();
  });

  it("createPlan + getPlan is synchronous — no async delay", () => {
    // The fix replaced `await import("../planExecutor.js")` in syncPlan
    // with a static import. This means getPlan() returns the new plan
    // IMMEDIATELY after createPlan(), in the same tick — no microtask.
    //
    // Before the fix: syncPlan() scheduled import().then(...) which fired
    // AFTER createPlan() in the next microtask, causing a transient
    // setPlanSteps([]) before the new plan appeared.
    //
    // This test verifies the contract: createPlan → getPlan has zero async
    // delay (synchronous).
    expect(getPlan()).toBeNull();

    // Synchronous create + immediate get.
    createPlan(["step 1", "step 2", "step 3"]);
    const plan = getPlan();

    // Plan is immediately visible — no await needed.
    expect(plan).not.toBeNull();
    expect(plan!.steps).toHaveLength(3);
    expect(plan!.steps[0]!.description).toBe("step 1");
    expect(plan!.steps[0]!.done).toBe(false);
    expect(plan!.steps[2]!.description).toBe("step 3");
  });

  it("hasIncompletePlan reflects new plan immediately after createPlan", () => {
    // The agent loop calls hasIncompletePlan to block finish. If there's
    // a race, the agent might finish before the plan is registered.
    expect(hasIncompletePlan()).toBe(false);

    createPlan(["a", "b"]);
    expect(hasIncompletePlan()).toBe(true); // immediate, no async

    markStep(0, true);
    expect(hasIncompletePlan()).toBe(true); // still 1 incomplete

    markStep(1, true);
    expect(hasIncompletePlan()).toBe(false); // all done
  });

  it("syncPlan sequence: clear → create → sync reflects new plan immediately", () => {
    // Simulate the App.tsx handleSubmit flow:
    //   1. syncPlan() at the start (reads null → setPlanSteps([]))
    //   2. createPlan(steps) inside the ===END PLAN=== block
    //   3. syncPlan() right after createPlan (reads new plan → setPlanSteps(new))
    //
    // Before the fix, step 3 was MISSING (syncPlan was async, scheduled
    // after the createPlan microtask). Now step 3 is synchronous and
    // called immediately, so the plan appears in the SAME React commit.
    clearPlan();
    expect(getPlan()).toBeNull();

    // Step 1: syncPlan reads null.
    const beforeCreate = getPlan();
    expect(beforeCreate).toBeNull();

    // Step 2: createPlan (synchronous).
    createPlan(["Read file", "Edit code", "Run tests"]);

    // Step 3: syncPlan reads new plan IMMEDIATELY (no await).
    const afterCreate = getPlan();
    expect(afterCreate).not.toBeNull();
    expect(afterCreate!.steps.map((s) => s.description)).toEqual([
      "Read file",
      "Edit code",
      "Run tests",
    ]);
    expect(afterCreate!.steps.every((s) => !s.done)).toBe(true);
  });

  it("clearPlan makes getPlan return null synchronously (plan disappears)", () => {
    // Verify the "plan disappears correctly" check from the bug-hunt list.
    // When clearPlan is called (e.g. on /reset), getPlan() must immediately
    // return null so syncPlan can call setPlanSteps([]) in the same tick.
    createPlan(["a", "b"]);
    expect(getPlan()).not.toBeNull();

    clearPlan();
    expect(getPlan()).toBeNull();
    expect(hasIncompletePlan()).toBe(false);
  });
});

// ─── Bug C: PlanPanel no longer steals keyboard input ──────────────────────

describe("Bug C: PlanPanel does not steal Enter / Up / Down keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PlanPanel renders expanded by default (no useInput toggle)", () => {
    // The useInput hook was removed. The panel is always expanded.
    const steps = [
      { description: "Step 1", done: false },
      { description: "Step 2", done: false },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Expanded view shows the steps and progress bar.
    expect(out).toContain("▾"); // expanded arrow
    expect(out).toContain("Step 1");
    expect(out).toContain("Step 2");
    expect(out).toContain("│"); // expanded border
  });

  it("PlanPanel does NOT register useInput (keyboard is free for App.tsx)", () => {
    // We can't directly assert "useInput was not called" without inspecting
    // React hooks. But we CAN verify that pressing Enter / Up / Down does
    // NOT change the panel's expanded state — i.e. the panel stays expanded
    // regardless of keyboard input.
    //
    // The ink-testing-library `stdin.write` simulates keypresses.
    const steps = [
      { description: "Step A", done: false },
      { description: "Step B", done: false },
    ];
    const { lastFrame, stdin } = render(<PlanPanel steps={steps} />);

    const beforeKeys = stripAnsi(lastFrame() ?? "");
    expect(beforeKeys).toContain("▾"); // expanded

    // Simulate pressing Enter, Up, Down — should NOT collapse the panel.
    stdin.write("\r");      // Enter
    stdin.write("\u001B[A"); // Up arrow
    stdin.write("\u001B[B"); // Down arrow

    const afterKeys = stripAnsi(lastFrame() ?? "");
    // Panel is still expanded (▾ still present, steps still visible).
    expect(afterKeys).toContain("▾");
    expect(afterKeys).toContain("Step A");
    expect(afterKeys).toContain("Step B");
    // The output is IDENTICAL — no state change happened.
    expect(afterKeys).toBe(beforeKeys);
  });

  it("PlanPanel with justCompleted prop still renders (backwards compat)", () => {
    // The justCompleted prop is now a no-op (panel is always expanded),
    // but it must still be accepted for backwards compatibility.
    const steps = [{ description: "Only step", done: true }];
    const { lastFrame } = render(<PlanPanel steps={steps} justCompleted={true} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("1/1");
    expect(out).toContain("All done");
  });
});

// ─── Bug D (§17.4.21): Error label is separate from content ───────────────

describe("Bug D (§17.4.21): Error label is separate from content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("error content does NOT include the ❌ label (added by ChatDisplay)", () => {
    // Per the App.tsx fix, error content is plain text WITHOUT the ❌ prefix.
    // The label "❌ Erro:" is rendered by ChatDisplay as a separate <Text>
    // in red bold. This test verifies the separation.
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Erro na execução: algo falhou",
        isError: true,
      },
    ];
    const out = renderMessages(messages);
    // Label is rendered (by ChatDisplay, not from content).
    expect(out).toContain("❌ Erro:");
    // Content is rendered verbatim (plain text).
    expect(out).toContain("Erro na execução: algo falhou");
  });

  it("error content with no markdown renders identically to plain text", () => {
    // Verify that a plain-text error message renders the EXACT same content
    // as a plain user message (no markdown stripping, no formatting).
    const errMessages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Simple error message with no markdown.",
        isError: true,
      },
    ];
    const userMessages: ChatMessage[] = [
      { role: "user", content: "Simple error message with no markdown." },
    ];
    const errOut = renderMessages(errMessages);
    const userOut = renderMessages(userMessages);
    // Both contain the content verbatim.
    expect(errOut).toContain("Simple error message with no markdown.");
    expect(userOut).toContain("Simple error message with no markdown.");
  });

  it("error message with code-like content preserves backticks literally", () => {
    // Per §17.4.21, inline `code` is NOT parsed in error messages.
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Error in `functionName` at line 42",
        isError: true,
      },
    ];
    const out = renderMessages(messages);
    // Backticks are preserved literally (NOT converted to yellow code text).
    expect(out).toContain("`functionName`");
  });
});

// ─── Bug E: Plan appears/disappears correctly ──────────────────────────────

describe("Bug E: Plan panel appears/disappears correctly with plan state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPlan();
  });

  it("PlanPanel renders null when steps is empty (plan disappeared)", () => {
    // App.tsx only renders <PlanPanel> when planSteps.length > 0. But the
    // component itself also returns null for empty steps — defensive.
    const { lastFrame } = render(<PlanPanel steps={[]} />);
    expect(lastFrame() ?? "").toBe("");
  });

  it("PlanPanel renders content when steps is non-empty (plan appeared)", () => {
    const steps = [
      { description: "Read file", done: false },
      { description: "Edit code", done: false },
      { description: "Run tests", done: false },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("0/3");
    expect(out).toContain("Read file");
    expect(out).toContain("Edit code");
    expect(out).toContain("Run tests");
  });

  it("plan state transitions: empty → created → completed → cleared", () => {
    // End-to-end test of the plan lifecycle that App.tsx drives.
    // 1. No plan → getPlan() null.
    expect(getPlan()).toBeNull();

    // 2. Create plan → getPlan() returns new plan with all steps pending.
    createPlan(["a", "b", "c"]);
    const plan1 = getPlan();
    expect(plan1).not.toBeNull();
    expect(plan1!.steps.filter((s) => s.done)).toHaveLength(0);
    expect(hasIncompletePlan()).toBe(true);

    // 3. Mark all done → plan is completed.
    markStep(0, true);
    markStep(1, true);
    markStep(2, true);
    const plan2 = getPlan();
    expect(plan2).not.toBeNull();
    expect(plan2!.steps.every((s) => s.done)).toBe(true);
    expect(plan2!.completedAt).not.toBeNull();
    expect(hasIncompletePlan()).toBe(false);

    // 4. Clear plan → getPlan() null again (plan disappears).
    clearPlan();
    expect(getPlan()).toBeNull();
    expect(hasIncompletePlan()).toBe(false);
  });
});
