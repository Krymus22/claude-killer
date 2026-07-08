/**
 * plan-panel-bug-hunt.test.tsx — Regression tests for the bug-hunt pass on
 * src/tui/PlanPanel.tsx.
 *
 * Tests cover:
 *   - useInput removal: the plan no longer intercepts Up/Down/Enter keys
 *     globally (which previously conflicted with autocomplete navigation
 *     and the input box).
 *   - Null/undefined guard for `steps` (defensive).
 *   - `justCompleted` prop is accepted (backwards-compat) but is a no-op.
 *   - Expanded state is always true (no manual toggle).
 *   - Rendering correctness preserved.
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { PlanPanel } from "../tui/PlanPanel.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("PlanPanel bug-hunt — useInput removal (no global keyboard interference)", () => {
  it("does NOT toggle expanded state on Up arrow (was a bug)", () => {
    // BUG (global-keyboard-interference): previously `useInput` intercepted
    // ALL Up/Down/Enter keys pressed anywhere in the app, toggling the
    // plan's expanded state. This conflicted with autocomplete navigation
    // in App.tsx and the Enter key in the input box. Now the hook is gone;
    // the plan is always expanded and ignores key presses.
    const steps = [
      { description: "Step 1", done: false },
      { description: "Step 2", done: false },
    ];
    const { lastFrame, stdin } = render(<PlanPanel steps={steps} />);
    const before = stripAnsi(lastFrame() ?? "");
    // Send Up arrow (ESC [ A).
    stdin.write("\u001B[A");
    const after = stripAnsi(lastFrame() ?? "");
    // The frame should be IDENTICAL — no toggle.
    expect(after).toBe(before);
    // Expanded indicator should still be present (▾).
    expect(after).toContain("▾");
    // Steps should still be visible (expanded).
    expect(after).toContain("Step 1");
    expect(after).toContain("Step 2");
  });

  it("does NOT toggle expanded state on Down arrow", () => {
    const steps = [{ description: "Only step", done: false }];
    const { lastFrame, stdin } = render(<PlanPanel steps={steps} />);
    const before = stripAnsi(lastFrame() ?? "");
    stdin.write("\u001B[B");
    const after = stripAnsi(lastFrame() ?? "");
    expect(after).toBe(before);
    expect(after).toContain("▾");
  });

  it("does NOT toggle expanded state on Enter", () => {
    // Enter in the chat input box should submit a message, not toggle the
    // plan. With useInput removed, the plan ignores Enter.
    const steps = [{ description: "Step A", done: false }];
    const { lastFrame, stdin } = render(<PlanPanel steps={steps} />);
    const before = stripAnsi(lastFrame() ?? "");
    stdin.write("\r");
    const after = stripAnsi(lastFrame() ?? "");
    expect(after).toBe(before);
    expect(after).toContain("▾");
  });

  it("does NOT toggle on rapid Up + Down + Enter sequence", () => {
    const steps = [
      { description: "A", done: false },
      { description: "B", done: true },
      { description: "C", done: false },
    ];
    const { lastFrame, stdin } = render(<PlanPanel steps={steps} />);
    const before = stripAnsi(lastFrame() ?? "");
    stdin.write("\u001B[A\u001B[B\r\u001B[A");
    const after = stripAnsi(lastFrame() ?? "");
    expect(after).toBe(before);
    // Expanded content (steps + progress bar) must still be visible.
    expect(after).toContain("▾");
    expect(after).toContain("A");
    expect(after).toContain("B");
    expect(after).toContain("C");
    expect(after).toContain("│");
  });
});

describe("PlanPanel bug-hunt — null / undefined / empty steps guard", () => {
  it("returns null when steps is undefined (defensive)", () => {
    // BUG: previously `steps.length` would throw if steps was undefined.
    // Now guarded with `!Array.isArray(steps)`.
    // @ts-expect-error — intentionally passing undefined to test the guard.
    const { lastFrame } = render(<PlanPanel steps={undefined} />);
    expect(lastFrame() ?? "").toBe("");
  });

  it("returns null when steps is null (defensive)", () => {
    // @ts-expect-error — intentionally passing null.
    const { lastFrame } = render(<PlanPanel steps={null} />);
    expect(lastFrame() ?? "").toBe("");
  });

  it("returns null when steps is empty array", () => {
    const { lastFrame } = render(<PlanPanel steps={[]} />);
    expect(lastFrame() ?? "").toBe("");
  });

  it("returns null when steps is a non-array object (defensive)", () => {
    // @ts-expect-error — intentionally passing a non-array.
    const { lastFrame } = render(<PlanPanel steps={{ length: 5 }} />);
    expect(lastFrame() ?? "").toBe("");
  });
});

describe("PlanPanel bug-hunt — justCompleted prop is accepted (no-op)", () => {
  it("renders normally when justCompleted=true", () => {
    const steps = [{ description: "Done", done: true }];
    const { lastFrame } = render(<PlanPanel steps={steps} justCompleted={true} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("1/1");
    expect(out).toContain("100%");
    expect(out).toContain("All done");
  });

  it("renders normally when justCompleted=false", () => {
    const steps = [{ description: "Pending", done: false }];
    const { lastFrame } = render(<PlanPanel steps={steps} justCompleted={false} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("0/1");
    expect(out).toContain("Pending");
  });

  it("renders normally when justCompleted is omitted", () => {
    const steps = [{ description: "Task", done: false }];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("0/1");
    expect(out).toContain("Task");
  });

  it("justCompleted does not change expanded state (always expanded)", () => {
    // The prop is accepted for backwards-compat but is a no-op. The plan
    // is always expanded regardless of justCompleted.
    const steps = [{ description: "X", done: false }];
    const a = stripAnsi(render(<PlanPanel steps={steps} justCompleted={true} />).lastFrame() ?? "");
    const b = stripAnsi(render(<PlanPanel steps={steps} justCompleted={false} />).lastFrame() ?? "");
    const c = stripAnsi(render(<PlanPanel steps={steps} />).lastFrame() ?? "");
    // All three should show the expanded indicator.
    expect(a).toContain("▾");
    expect(b).toContain("▾");
    expect(c).toContain("▾");
  });
});

describe("PlanPanel bug-hunt — always-expanded state", () => {
  it("shows expanded view (▾) by default", () => {
    const steps = [{ description: "Step", done: false }];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("▾");
  });

  it("shows expanded view even after key presses (no collapse)", () => {
    // Previously, pressing Up would toggle to collapsed (▸). Now the plan
    // is always expanded and key presses have no effect.
    const steps = [{ description: "Step", done: false }];
    const { lastFrame, stdin } = render(<PlanPanel steps={steps} />);
    stdin.write("\u001B[A");
    stdin.write("\r");
    stdin.write("\u001B[B");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("▾");
    expect(out).not.toContain("▸");
  });

  it("shows step details when expanded", () => {
    const steps = [
      { description: "Read file", done: false },
      { description: "Edit code", done: false },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("1. Read file");
    expect(out).toContain("2. Edit code");
  });

  it("shows progress bar when expanded", () => {
    const steps = [
      { description: "A", done: true },
      { description: "B", done: false },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("50%");
    expect(out).toMatch(/[█░]/); // progress bar chars
  });
});

describe("PlanPanel bug-hunt — rendering correctness (no regressions)", () => {
  it("renders compact summary with task count", () => {
    const steps = [
      { description: "A", done: false },
      { description: "B", done: false },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("0/2");
    expect(out).toContain("tasks");
  });

  it("renders ✓ All done when all complete", () => {
    const steps = [
      { description: "A", done: true },
      { description: "B", done: true },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("2/2");
    expect(out).toContain("All done");
    expect(out).toContain("100%");
  });

  it("shows first incomplete step in compact view", () => {
    const steps = [
      { description: "Done", done: true },
      { description: "In progress", done: false },
      { description: "Later", done: false },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("In progress");
  });

  it("shows All steps complete when all done", () => {
    const steps = [{ description: "Done", done: true }];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("All steps complete");
  });

  it("handles many steps", () => {
    const steps = Array.from({ length: 10 }, (_, i) => ({
      description: `Step ${i + 1}`,
      done: i < 5,
    }));
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("5/10");
    expect(out).toContain("50%");
    expect(out).toContain("Step 1");
    expect(out).toContain("Step 10");
  });

  it("shows ☑ for completed steps and ☐ for pending", () => {
    const steps = [
      { description: "Done task", done: true },
      { description: "Pending task", done: false },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("☑");
    expect(out).toContain("☐");
  });
});
