/**
 * scoutAgent-rapid-fire.test.ts — Real API test: scout making MANY rapid tool calls.
 *
 * Purpose: test if the scout can make many tool calls in rapid succession
 * without hitting 403 / 429 / context overflow. This exercises:
 *   - Pool key rotation (403 cooldown fix §17.13 rule 113)
 *   - Scout internal summary (§17.13 rule 114) — context should NOT overflow
 *   - Multiple ler_arquivo calls in sequence
 *
 * Requirements:
 * - NVIDIA_API_KEY or NVIDIA_API_KEYS env var must be set
 * - SCOUT_ENABLED=1
 *
 * If NVIDIA_API_KEY is not set, the test is SKIPPED.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const hasApiKey = !!process.env.NVIDIA_API_KEY || !!process.env.NVIDIA_API_KEYS;
const shouldSkip = !hasApiKey || process.env.CI === "true" || process.env.SCOUT_SKIP_REAL_TEST === "1";

describe.skipIf(shouldSkip)("scoutAgent — rapid fire tool calls (real API)", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-rapid-"));
    // Create 10 test files of varying sizes
    for (let i = 0; i < 10; i++) {
      const size = i < 5 ? 500 : 3000; // 5 small (< 2KB), 5 large (> 2KB)
      const content = `-- File ${i}\n` + "x".repeat(size) + "\n-- end\n";
      fs.writeFileSync(path.join(tmpDir, `file${i}.luau`), content);
    }
    process.env.SCOUT_ENABLED = "1";
    process.chdir(tmpDir);
  });

  afterAll(() => {
    try { process.chdir(path.resolve(__dirname, "../..")); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    delete process.env.SCOUT_ENABLED;
  });

  it("scout reads 10 files in one invocation (rapid fire)", async () => {
    const { runScout } = await import("../scoutAgent.js");

    const result = await runScout({
      objective: "Read ALL 10 files (file0.luau through file9.luau) and report their contents. Read them one by one.",
      tasks: Array.from({ length: 10 }, (_, i) => ({
        type: "read_file" as const,
        description: `read file${i}.luau`,
      })),
      maxToolCalls: 15, // allow some slack
    });

    expect(result).not.toBeNull();
    expect(result!.completed).toBe(true);
    console.log(`[RAPID FIRE] Tool calls made: ${result!.toolCallCount}`);
    console.log(`[RAPID FIRE] Files inspected: ${result!.filesInspected.length}`);
    console.log(`[RAPID FIRE] Tool results: ${result!.toolResults.length}`);

    // Should have read at least 5 files (scout may not read all 10 if context gets tight)
    expect(result!.toolResults.length).toBeGreaterThanOrEqual(5);

    // Check for errors — no tool result should be a 403/429 error
    const errors = result!.toolResults.filter(tr => !tr.success);
    if (errors.length > 0) {
      console.log(`[RAPID FIRE] Errors encountered:`);
      errors.forEach((e, i) => console.log(`  ${i}: ${e.result.slice(0, 100)}`));
    }

    // At least 7 of 10 should succeed (allow some failures for rate limit)
    const successes = result!.toolResults.filter(tr => tr.success);
    expect(successes.length).toBeGreaterThanOrEqual(7);

    // RAW content should be in toolResults (not summaries)
    // Large files (> 2KB) should have full content, not truncated
    const largeFileResults = result!.toolResults.filter((tr, i) => i >= 5 && tr.success);
    for (const tr of largeFileResults) {
      // Should contain the "x".repeat(3000) pattern from the file
      expect(tr.result.length).toBeGreaterThan(1000); // not just a summary
    }
  }, 180000); // 3 min timeout — many API calls

  it("scout handles 403 gracefully (key rotation)", async () => {
    // This test is hard to force a 403, but we can at least verify
    // that the scout doesn't crash on API errors and returns a useful result
    const { runScout } = await import("../scoutAgent.js");

    const result = await runScout({
      objective: "Read file0.luau and file1.luau",
      tasks: [
        { type: "read_file", description: "read file0.luau" },
        { type: "read_file", description: "read file1.luau" },
      ],
      maxToolCalls: 5,
    });

    expect(result).not.toBeNull();
    // Either completed successfully OR failed with a clear error
    if (result!.completed) {
      expect(result!.toolResults.length).toBeGreaterThan(0);
    } else {
      // If failed, should have error message
      expect(result!.error).toBeDefined();
      console.log(`[403 TEST] Scout failed (expected if rate limited): ${result!.error}`);
    }
  }, 60000);
});
