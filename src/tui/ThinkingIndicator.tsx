/**
 * ThinkingIndicator.tsx - Animated status indicator with real activity tracking.
 *
 * Bug fixed: the old version showed "PENSANDO..." forever, regardless of what
 * the agent was actually doing (streaming tokens, executing a tool, running
 * the quality gate, etc.). Now it subscribes to the global ActivityTracker
 * and shows the current activity with elapsed time.
 *
 * Falls back to "PENSANDO..." if no activity is pushed (backwards compat).
 */

import React, { useState, useEffect, useRef } from "react";
import { Text } from "ink";
import { colors } from "./theme.js";
import {
  subscribeToActivity,
  getActivitySnapshot,
  type ActivitySnapshot,
} from "../activityTracker.js";

interface ThinkingIndicatorProps {
  active: boolean;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

function spinnerChar(idx: number): string {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  return frames[idx % frames.length] ?? "•";
}

export function ThinkingIndicator({ active }: Readonly<ThinkingIndicatorProps>) {
  const [dots, setDots] = useState("");
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(getActivitySnapshot());
  const spinnerIdx = useRef(0);

  // Subscribe to activity tracker — re-render on every push/pop.
  useEffect(() => {
    if (!active) return;
    const unsub = subscribeToActivity((snap) => setSnapshot(snap));
    return unsub;
  }, [active]);

  // Spinner + elapsed time + dot animation tick (every 200ms).
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      spinnerIdx.current = (spinnerIdx.current + 1) % 10;
      setDots((prev) => (prev.length >= 3 ? "" : prev + "."));
      // Force re-render to update elapsed time even when stack is unchanged
      setSnapshot(getActivitySnapshot());
    }, 200);
    return () => clearInterval(interval);
  }, [active]);

  if (!active) return null;

  const hasActivity = snapshot.current !== null;
  const elapsed = formatElapsed(snapshot.elapsedMs);
  const elapsedStr = elapsed ? ` (${elapsed})` : "";

  if (hasActivity) {
    const spinner = spinnerChar(spinnerIdx.current);
    const label = snapshot.displayLabel;
    return (
      <Text color={colors.muted}> {spinner} {label}{elapsedStr} </Text>
    );
  }

  // Fallback: legacy "PENSANDO..." (when no activity was pushed)
  return (
    <Text color={colors.muted}> • PENSANDO{dots} </Text>
  );
}
