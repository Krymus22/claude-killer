/**
 * PlanPanel.tsx — Visual plan display with checkboxes.
 *
 * Shows the current plan from planExecutor.ts with nice formatting:
 *   ┌─ Plan (3 steps) ─────────────────────────┐
 *   │  ☐ 1. Read the file                       │
 *   │  ☑ 2. Edit the function                   │
 *   │  ☐ 3. Run tests                           │
 *   └────────────────────────────────────────────┘
 *
 * Updates in real-time when the IA calls marcar_passo().
 * Called from App.tsx alongside TodoPanel.
 *
 * Inspired by Claude Code's plan visualization which uses
 * task-list checkboxes (☐/☑) with inline progress tracking.
 */

import React from "react";
import { Box, Text } from "ink";
import { colors } from "./theme.js";
import { useTerminalWidth, truncateStr } from "./useTerminal.js";

interface PlanStep {
  description: string;
  done: boolean;
}

interface PlanPanelProps {
  steps: PlanStep[];
}

export function PlanPanel({ steps }: Readonly<PlanPanelProps>) {
  const termWidth = useTerminalWidth();
  const innerWidth = Math.max(30, Math.min(termWidth - 4, 80));

  if (steps.length === 0) return null;

  const doneCount = steps.filter((s) => s.done).length;
  const totalCount = steps.length;
  const allDone = doneCount === totalCount;

  // Box-drawing characters for rounded corners
  const topLeft = "╭";
  const topRight = "╮";
  const bottomLeft = "╰";
  const bottomRight = "╯";
  const horizontal = "─";
  const vertical = "│";

  // Header line: "╭─ Plan (3 steps) ───────────╮"
  const headerText = ` Plan (${totalCount} step${totalCount !== 1 ? "s" : ""}) `;
  const headerPadding = Math.max(0, innerWidth - headerText.length - 2);
  const headerLine = `${topLeft}${horizontal}${headerText}${horizontal.repeat(headerPadding)}${topRight}`;

  // Footer line: "╰─────────────────────────────╯"
  const footerLine = `${bottomLeft}${horizontal.repeat(innerWidth)}${bottomRight}`;

  // Progress bar
  const progressPercent = Math.round((doneCount / totalCount) * 100);
  const progressBarWidth = Math.min(20, innerWidth - 20);
  const filledCount = Math.round((progressPercent / 100) * progressBarWidth);
  const progressBar = `${"█".repeat(filledCount)}${"░".repeat(progressBarWidth - filledCount)}`;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Header */}
      <Text color={allDone ? colors.success : colors.primary}>{headerLine}</Text>

      {/* Steps */}
      {steps.map((step, i) => {
        const checkbox = step.done ? "☑" : "☐";
        const checkboxColor = step.done ? colors.success : colors.muted;
        const textColor = step.done ? colors.muted : colors.white;
        const numStr = `${i + 1}.`;
        const maxStepWidth = innerWidth - 6; // "│ ☑ 1. " = 6 chars
        const truncatedDesc = truncateStr(step.description, maxStepWidth);

        return (
          <Box key={`plan-step-${i}`} flexDirection="row">
            <Text color={allDone ? colors.success : colors.primary}>{vertical}</Text>
            <Text color={checkboxColor}> {checkbox} </Text>
            <Text color={colors.muted}>{numStr} </Text>
            <Text color={textColor}>{truncatedDesc}</Text>
          </Box>
        );
      })}

      {/* Progress bar */}
      <Box flexDirection="row">
        <Text color={allDone ? colors.success : colors.primary}>{vertical}</Text>
        <Text color={colors.muted}> </Text>
        <Text color={allDone ? colors.success : colors.secondary}>
          {progressBar}
        </Text>
        <Text color={colors.muted}> {progressPercent}%</Text>
        <Text color={allDone ? colors.success : colors.muted}>
          {allDone ? " ✓ All done!" : ` (${doneCount}/${totalCount})`}
        </Text>
      </Box>

      {/* Footer */}
      <Text color={allDone ? colors.success : colors.primary}>{footerLine}</Text>
    </Box>
  );
}
