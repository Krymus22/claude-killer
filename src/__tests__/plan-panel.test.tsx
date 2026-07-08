/**
 * plan-panel.test.tsx — Testes para o PlanPanel.
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { PlanPanel } from "../tui/PlanPanel.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("PlanPanel", () => {
  it("returns null when no steps", () => {
    const { lastFrame } = render(<PlanPanel steps={[]} />);
    expect(lastFrame() ?? "").toBe("");
  });

  it("renders plan with pending steps", () => {
    const steps = [
      { description: "Read file", done: false },
      { description: "Edit code", done: false },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Plan");
    expect(out).toContain("2 steps");
    expect(out).toContain("☐");
    expect(out).toContain("Read file");
    expect(out).toContain("Edit code");
  });

  it("renders completed steps with ☑", () => {
    const steps = [
      { description: "Done task", done: true },
      { description: "Pending task", done: false },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("☑");
    expect(out).toContain("☐");
    expect(out).toContain("Done task");
    expect(out).toContain("Pending task");
  });

  it("shows progress bar", () => {
    const steps = [
      { description: "A", done: true },
      { description: "B", done: false },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("50%");
    expect(out).toContain("1/2");
  });

  it("shows all done message when all complete", () => {
    const steps = [
      { description: "A", done: true },
      { description: "B", done: true },
    ];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("100%");
    expect(out).toContain("All done");
  });

  it("renders with rounded box borders", () => {
    const steps = [{ description: "Step", done: false }];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("╭");
    expect(out).toContain("╮");
    expect(out).toContain("╰");
    expect(out).toContain("╯");
  });

  it("handles single step", () => {
    const steps = [{ description: "Only step", done: false }];
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("1 step"); // singular
    expect(out).toContain("Only step");
  });

  it("handles many steps", () => {
    const steps = Array.from({ length: 10 }, (_, i) => ({
      description: `Step ${i + 1}`,
      done: i < 5,
    }));
    const { lastFrame } = render(<PlanPanel steps={steps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("10 steps");
    expect(out).toContain("50%");
    expect(out).toContain("5/10");
  });
});
