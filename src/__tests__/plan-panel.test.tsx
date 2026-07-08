/**
 * plan-panel.test.tsx — Testes para o PlanPanel (collapsible).
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { PlanPanel } from "../tui/PlanPanel.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("PlanPanel — Collapsible", () => {
  it("returns null when no steps", () => {
    const { lastFrame } = render(<PlanPanel steps={[]} />);
    expect(lastFrame() ?? "").toBe("");
  });

  it("renders compact view with arrow and task count", () => {
    const steps = [
      { description: "Read file", done: false },
      { description: "Edit code", done: false },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("0/2");
    expect(out).toContain("tasks");
    expect(out).toContain("Read file");
    expect(out).toContain("▾"); // expanded by default
  });

  it("shows ☑ for completed steps", () => {
    const steps = [
      { description: "Done task", done: true },
      { description: "Pending task", done: false },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("☑");
    expect(out).toContain("☐");
    expect(out).toContain("1/2");
  });

  it("shows ✓ All done when all complete", () => {
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

  it("shows progress bar in expanded view", () => {
    const steps = [
      { description: "A", done: true },
      { description: "B", done: false },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("50%");
    expect(out).toContain("1/2");
    expect(out).toContain("│");
  });

  it("handles single step (singular)", () => {
    const steps = [{ description: "Only step", done: false }];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("0/1");
    expect(out).toContain("Only step");
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

  it("compact view shows first incomplete step", () => {
    const steps = [
      { description: "Done", done: true },
      { description: "In progress", done: false },
      { description: "Later", done: false },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("In progress");
  });

  it("compact view shows 'All steps complete' when done", () => {
    const steps = [{ description: "Done", done: true }];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("All steps complete");
  });
});
