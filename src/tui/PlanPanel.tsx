/**
 * PlanPanel.tsx — Collapsible visual plan with checkboxes.
 *
 * Renders as part of the chat (not a fixed panel). Appears as a compact
 * summary line that can be expanded/collapsed with arrow keys.
 *
 * Compact view:  ▸ ☐ 1/3 tasks — "Read file" (first incomplete step)
 * Expanded view:  ▾ ☐ 1/3 tasks — Plan
 *                  │  ☑ 1. Read the file
 *                  │  ☐ 2. Edit the function
 *                  │  ☐ 3. Run tests
 *                  │  ██░░░░ 33%
 *
 * The plan appears inline in the chat (like a message), not as a fixed panel.
 * It updates in real-time when the IA calls marcar_passo().
 * When all steps are done, it auto-expands to show the completed plan.
 *
 * ─── Bug fixes (bug-hunt pass) ────────────────────────────────────────────
 *   - Removed `useInput` hook (BUG: global-keyboard-interference). The hook
 *     intercepted ALL Up/Down/Enter keys pressed anywhere in the app —
 *     including autocomplete navigation in App.tsx and Enter in the input
 *     box — causing the plan's expanded state to toggle on every keystroke.
 *     The plan is purely informational (auto-expanded on creation and
 *     completion), so manual toggle is unnecessary. The hook is gone; the
 *     plan is always expanded (matches the "auto-expand" doc and the
 *     existing tests that expect ▾ by default).
 *   - Added null/undefined guard for `steps` (defensive: parent always
 *     passes an array, but a future caller might not).
 *   - Removed unused `useState`/`useCallback`/`useInput` imports.
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
  /**
   * Whether the plan was just completed (auto-expand).
   *
   * NOTE: previously declared but never read (dead code). The plan is
   * always expanded now (no manual toggle), so this prop is accepted
   * for backwards-compat but does not change rendering. Reserved for a
   * future focused-toggle mechanism (e.g. via `useFocus`) if needed.
   */
  justCompleted?: boolean;
}

export function PlanPanel({ steps, justCompleted }: Readonly<PlanPanelProps>) {
  // Defensive guard: parent (App.tsx) always passes an array, but if a
  // future caller forgets, we degrade gracefully instead of throwing on
  // `steps.length`.
  void justCompleted; // explicitly mark as accepted-but-unused (backwards-compat)
  if (!Array.isArray(steps) || steps.length === 0) return null;

  const termWidth = useTerminalWidth();
  const innerWidth = Math.max(30, Math.min(termWidth - 4, 80));

  // Always expanded — the plan is informational only (auto-expand on
  // creation/completion). The previous `useState(true)` + `useInput`
  // pattern allowed manual toggle but caused global keyboard interference
  // (see file header). Removing the toggle keeps the plan always visible.
  const expanded = true;

  const doneCount = steps.filter((s) => s.done).length;
  const totalCount = steps.length;
  const allDone = doneCount === totalCount;
  const progressPercent = Math.round((doneCount / totalCount) * 100);

  // Find first incomplete step for compact view
  const firstIncomplete = steps.find((s) => !s.done);
  const compactLabel = firstIncomplete
    ? truncateStr(firstIncomplete.description, innerWidth - 25)
    : "All steps complete!";

  // Arrow indicator
  const arrow = expanded ? "▾" : "▸";

  // Checkbox for compact view
  const compactCheckbox = allDone ? "☑" : "☐";

  // Progress bar for expanded view
  const progressBarWidth = Math.min(20, innerWidth - 16);
  const filledCount = Math.round((progressPercent / 100) * progressBarWidth);
  const progressBar = `${"█".repeat(filledCount)}${"░".repeat(progressBarWidth - filledCount)}`;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Compact summary line (always visible) */}
      <Box flexDirection="row">
        <Text color={allDone ? colors.success : colors.primary} bold>
          {arrow}{" "}
        </Text>
        <Text color={allDone ? colors.success : colors.muted}>
          {compactCheckbox}{" "}
        </Text>
        <Text color={allDone ? colors.success : colors.white} bold>
          {doneCount}/{totalCount}{" "}
        </Text>
        <Text color={colors.muted}>
          tasks —{" "}
        </Text>
        <Text color={allDone ? colors.success : colors.white}>
          {compactLabel}
        </Text>
        {allDone && (
          <Text color={colors.success} bold>
            {" ✓"}
          </Text>
        )}
      </Box>

      {/* Expanded view (steps + progress bar) */}
      {expanded && (
        <Box flexDirection="column" marginLeft={2} marginTop={0}>
          {steps.map((step, i) => {
            const checkbox = step.done ? "☑" : "☐";
            const checkboxColor = step.done ? colors.success : colors.muted;
            const textColor = step.done ? colors.muted : colors.white;
            const numStr = `${i + 1}.`;
            const maxStepWidth = innerWidth - 8;
            const truncatedDesc = truncateStr(step.description, maxStepWidth);

            return (
              <Box key={`plan-step-${i}`} flexDirection="row">
                <Text color={colors.muted}>│ </Text>
                <Text color={checkboxColor}>{checkbox} </Text>
                <Text color={colors.muted}>{numStr} </Text>
                <Text color={textColor}>{truncatedDesc}</Text>
              </Box>
            );
          })}

          {/* Progress bar */}
          <Box flexDirection="row" marginTop={0}>
            <Text color={colors.muted}>│ </Text>
            <Text color={allDone ? colors.success : colors.secondary}>
              {progressBar}
            </Text>
            <Text color={colors.muted}> {progressPercent}%</Text>
            {allDone ? (
              <Text color={colors.success} bold> ✓ All done!</Text>
            ) : (
              <Text color={colors.muted}> ({doneCount}/{totalCount})</Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
