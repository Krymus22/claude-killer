/**
 * smallTaskAgent-real.test.ts — Real E2E test for the /small task agent.
 *
 * This test calls the REAL NVIDIA NIM API to verify that:
 * 1. The model (meta/llama-3.1-8b-instruct) supports tool calling
 * 2. The small task agent can execute a command via tool call
 * 3. The agent produces a concise summary
 *
 * Prerequisites:
 * - NVIDIA_API_KEYS env var must be set (at least one key)
 * - Network access to https://integrate.api.nvidia.com
 *
 * Run: npx vitest run src/__tests__/smallTaskAgent-real.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Skip all tests if no API keys available
const envPath = resolve(__dirname, "../../.env");
let hasApiKeys = false;
try {
  const envContent = readFileSync(envPath, "utf8");
  const keysMatch = envContent.match(/^NVIDIA_API_KEYS=(.+)$/m);
  hasApiKeys = !!keysMatch && keysMatch[1].split(",")[0].startsWith("nvapi-");
} catch { /* file may not exist in CI */ }

const describeOrSkip = hasApiKeys ? describe : describe.skip;

describeOrSkip("smallTaskAgent — real NVIDIA API E2E", () => {
  beforeAll(() => {
    // Load env vars from .env if not already set
    try {
      const envContent = readFileSync(envPath, "utf8");
      for (const line of envContent.split("\n")) {
        const match = line.match(/^([A-Z_]+)=(.+)$/);
        if (match && !process.env[match[1]]) {
          process.env[match[1]] = match[2];
        }
      }
    } catch { /* ignore */ }
  }, 60000);

  beforeEach(async () => {
    // Clear pending summaries and anti-recursion env var between tests
    delete process.env.CLAUDE_KILLER_AGENT_ID;
    const { _resetSmallTaskState } = await import("../smallTaskAgent.js");
    _resetSmallTaskState();
  });

  it(
    "executes a simple command task and returns a summary",
    async () => {
      const { runSmallTask } = await import("../smallTaskAgent.js");

      const result = await runSmallTask(
        "Lista os arquivos do diretório atual e me diz quantos arquivos .ts existem na raiz.",
        resolve(__dirname, "../.."),
        {
          onToolCall: (name, args) => console.log(`  [tool_call] ${name}(${JSON.stringify(args)})`),
          onToolResult: (name, result, ok) => console.log(`  [tool_result] ${name}: ${ok ? "OK" : "FAIL"} (${result.length} chars)`),
        },
      );

      console.log(`\n  Result: ok=${result.ok}`);
      console.log(`  Summary: ${result.summary}`);
      console.log(`  Error: ${result.error ?? "none"}`);
      console.log(`  Tool calls: ${result.toolCallsMade}`);
      console.log(`  Elapsed: ${result.elapsedMs}ms`);

      expect(result.ok).toBe(true);
      expect(result.summary).toBeTruthy();
      expect(result.summary.length).toBeGreaterThan(10);
      expect(result.summary.length).toBeLessThan(500); // should be concise
      expect(result.toolCallsMade).toBeGreaterThan(0);
      expect(result.toolCallsMade).toBeLessThanOrEqual(10);
      expect(result.elapsedMs).toBeLessThan(30000); // should be fast (< 30s)
    },
    60000,
  );

  it(
    "handles a read-only task (ler_arquivo)",
    async () => {
      const { runSmallTask } = await import("../smallTaskAgent.js");

      const result = await runSmallTask(
        "Lê o arquivo package.json e me diz qual é o nome do projeto e a versão.",
        resolve(__dirname, "../.."),
      );

      console.log(`\n  Result: ok=${result.ok}`);
      console.log(`  Summary: ${result.summary}`);
      console.log(`  Error: ${result.error ?? "none"}`);
      console.log(`  Tool calls: ${result.toolCallsMade}`);

      expect(result.ok).toBe(true);
      expect(result.summary).toContain("claude-killer"); // project name
    },
    60000,
  );

  it(
    "produces summary that is stored for main AI context injection",
    async () => {
      const { runSmallTask, consumePendingSmallTaskSummaries, hasPendingSmallTaskSummaries } = await import("../smallTaskAgent.js");

      const result = await runSmallTask(
        "Roda 'echo hello' e me diz o resultado.",
        resolve(__dirname, "../.."),
      );

      console.log(`\n  Result: ok=${result.ok}`);
      console.log(`  Summary: ${result.summary}`);
      console.log(`  Error: ${result.error ?? "none"}`);

      expect(result.ok).toBe(true);

      // The summary should be stored in pendingSummaries
      expect(hasPendingSmallTaskSummaries()).toBe(true);

      const summaries = consumePendingSmallTaskSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toBe(result.summary);

      // After consume, should be empty
      expect(hasPendingSmallTaskSummaries()).toBe(false);
    },
    60000,
  );
});
