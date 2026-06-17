/**
 * parallelSubAgents.test.ts — Tests for parallel sub-agent execution.
 *
 * Verifies that when 2+ explorar_subagente calls arrive in the same response,
 * they actually run in parallel (not sequentially). This depends on:
 *   1. explorar_subagente being in READ_ONLY_TOOLS (so processToolCalls routes
 *      them to executeReadOnlyCallsInParallel instead of executeToolCallsSequentially)
 *   2. executeParallelTools using Promise.all (true parallelism)
 *   3. The multi-key pool allowing concurrent requests on different keys
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
}));

import { executeParallelTools, type ParallelToolCall } from "../parallelTools.js";

describe("parallelSubAgents", () => {
  describe("executeParallelTools — true parallelism", () => {
    it("runs 2 tools concurrently (not sequentially)", async () => {
      // Each tool sleeps 100ms. If sequential, total = 200ms.
      // If parallel, total ≈ 100ms.
      const startTimes: number[] = [];
      const tools: ParallelToolCall[] = [
        {
          id: "1",
          name: "explorar_subagente",
          args: { questao: "auth flow" },
          execute: async () => {
            startTimes.push(Date.now());
            await new Promise((r) => setTimeout(r, 100));
            return "auth summary";
          },
        },
        {
          id: "2",
          name: "explorar_subagente",
          args: { questao: "data layer" },
          execute: async () => {
            startTimes.push(Date.now());
            await new Promise((r) => setTimeout(r, 100));
            return "data summary";
          },
        },
      ];

      const t0 = Date.now();
      const results = await executeParallelTools(tools, 5);
      const elapsed = Date.now() - t0;

      expect(results).toHaveLength(2);
      // If parallel, elapsed should be ~100ms, not ~200ms
      // Use 180ms as threshold (generous — accounts for scheduling overhead)
      expect(elapsed).toBeLessThan(180);
      // Both started within a small window of each other (true parallel start)
      const startDiff = Math.abs(startTimes[0] - startTimes[1]);
      expect(startDiff).toBeLessThan(50);
    });

    it("runs 3 tools concurrently with maxConcurrency=5", async () => {
      const tools: ParallelToolCall[] = Array.from({ length: 3 }, (_, i) => ({
        id: `tc${i}`,
        name: "explorar_subagente",
        args: { questao: `question ${i}` },
        execute: async () => {
          await new Promise((r) => setTimeout(r, 80));
          return `result ${i}`;
        },
      }));

      const t0 = Date.now();
      const results = await executeParallelTools(tools, 5);
      const elapsed = Date.now() - t0;

      expect(results).toHaveLength(3);
      // 3 × 80ms = 240ms if sequential; ~80ms if parallel
      expect(elapsed).toBeLessThan(200);
    });

    it("respects maxConcurrency limit (2 at a time)", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      const tools: ParallelToolCall[] = Array.from({ length: 4 }, (_, i) => ({
        id: `tc${i}`,
        name: "explorar_subagente",
        args: {},
        execute: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 50));
          concurrent--;
          return `result ${i}`;
        },
      }));

      await executeParallelTools(tools, 2);
      // With maxConcurrency=2, at most 2 should run at the same time
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it("handles failures in one tool without affecting others", async () => {
      const tools: ParallelToolCall[] = [
        {
          id: "ok1",
          name: "explorar_subagente",
          args: {},
          execute: async () => "success 1",
        },
        {
          id: "fail",
          name: "explorar_subagente",
          args: {},
          execute: async () => { throw new Error("boom"); },
        },
        {
          id: "ok2",
          name: "explorar_subagente",
          args: {},
          execute: async () => "success 2",
        },
      ];

      const results = await executeParallelTools(tools, 5);
      expect(results).toHaveLength(3);
      const ok1 = results.find((r) => r.id === "ok1");
      const fail = results.find((r) => r.id === "fail");
      const ok2 = results.find((r) => r.id === "ok2");
      expect(ok1?.success).toBe(true);
      expect(ok1?.result).toBe("success 1");
      expect(fail?.success).toBe(false);
      expect(fail?.error).toBe("boom");
      expect(ok2?.success).toBe(true);
      expect(ok2?.result).toBe("success 2");
    });

    it("returns empty array for empty input", async () => {
      const results = await executeParallelTools([], 5);
      expect(results).toEqual([]);
    });

    it("runs single tool correctly", async () => {
      const tools: ParallelToolCall[] = [{
        id: "only",
        name: "explorar_subagente",
        args: {},
        execute: async () => "only result",
      }];
      const results = await executeParallelTools(tools, 5);
      expect(results).toHaveLength(1);
      expect(results[0].result).toBe("only result");
      expect(results[0].success).toBe(true);
    });
  });
});
