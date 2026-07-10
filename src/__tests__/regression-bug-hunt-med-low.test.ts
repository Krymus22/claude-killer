/**
 * regression-bug-hunt-med-low.test.ts
 *
 * Regression tests for the MEDIUM and LOW bug fixes discovered during the
 * bug hunt. Each test references the bug ID and the specific fix pattern.
 *
 * Most tests are source-pattern checks (read the source file and assert
 * the fix is present), which are fast, deterministic, and don't require
 * heavy module loading. Behavioral tests (importing the function and
 * testing it directly) are used where the fix is observable through a
 * public API.
 *
 * Bug ID convention: "BH<n> <SEVERITY> <index>" — e.g. "BH3 MED 2" refers
 * to bug #2 in the BH3 MEDIUM report.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── helpers ──────────────────────────────────────────────────────────────

/** Read a source file from the project (under src/) as a UTF-8 string. */
function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), "src", relPath), "utf8");
}

// ──────────────────────────────────────────────────────────────────────────
// MEDIUM bug regression tests
// ──────────────────────────────────────────────────────────────────────────

describe("MEDIUM bug regressions", () => {
  // 1. apiClient: empty reasoning resets hang timer
  it("BH1 MED 1: apiClient uses `if (reasoning != null)` (empty reasoning resets hang timer)", () => {
    const src = readSrc("apiClient.ts");
    // The fix replaced a falsy check (which skipped empty-string reasoning)
    // with an explicit null/undefined check so empty-string deltas still
    // reset the hang timer.
    expect(src).toContain("if (reasoning != null)");
  });

  // 2. heartbeat: stopHeartbeat resets lastModelState
  it("BH3 MED 2: stopHeartbeat resets lastModelState to 'unknown' (behavioral + source)", async () => {
    const src = readSrc("heartbeat.ts");
    // Source: stopHeartbeat must assign lastModelState = "unknown" so that
    // the next first_success event re-fires after a restart.
    expect(src).toMatch(/lastModelState\s*=\s*["']unknown["']/);

    // Behavioral: after stopHeartbeat (via resetHeartbeat which calls it),
    // getHeartbeatStats().modelState === "unknown".
    const { resetHeartbeat, stopHeartbeat, getHeartbeatStats } = await import("../heartbeat.js");
    resetHeartbeat();
    stopHeartbeat();
    const stats = getHeartbeatStats();
    expect(stats.modelState).toBe("unknown");
  });

  // 3. agent: MAX_CONCURRENT_SUB_AGENTS NaN guard
  it("BH4 MED 10: agent.ts MAX_CONCURRENT_SUB_AGENTS uses Math.max(1, parseInt || default) NaN guard", () => {
    const src = readSrc("agent.ts");
    // Must use Math.max(1, ...) so NaN/0/negative values can't deadlock
    // sub-agent acquisition.
    expect(src).toMatch(/MAX_CONCURRENT_SUB_AGENTS\s*=\s*Math\.max\(/);
    expect(src).toContain("parseInt(");
    expect(src).toMatch(/\|\|\s*getProviderMaxSubAgents\(\)/);
  });

  // 4. history: compactHistoryAsync [SESSION CONTINUATION] dedup
  it("BH MED 4: history.ts has hasContinuation check to dedup [SESSION CONTINUATION] messages", () => {
    const src = readSrc("history.ts");
    expect(src).toContain("hasContinuation");
    // Must check the prefix and gate the injection on it.
    expect(src).toContain("[SESSION CONTINUATION");
    expect(src).toMatch(/hasContinuation\s*\?/);
  });

  // 5. llmCompactor: prefix is [AI CONTEXT COMPACTED
  it("BH MED 5: llmCompactor uses the '[AI CONTEXT COMPACTED' prefix", () => {
    const src = readSrc("llmCompactor.ts");
    // The exact prefix mandated by §6.5 so heuristic & LLM compaction
    // messages dedupe correctly.
    expect(src).toContain("[AI CONTEXT COMPACTED");
    expect(src).toMatch(/\[AI CONTEXT COMPACTED -/);
  });

  // 6. contextCompaction: isLlmCompactionAvailable guard
  it("BH7 MED 8: contextCompaction.modelBasedCompactionAsync guards on isLlmCompactionAvailable", () => {
    const src = readSrc("contextCompaction.ts");
    expect(src).toContain("isLlmCompactionAvailable");
    // Must early-return when the guard is false (skip doomed API call).
    expect(src).toMatch(/if\s*\(\s*!\(\s*await\s+isLlmCompactionAvailable\(\)\s*\)\s*\)/);
  });

  // 7. scoutAgent: clearModelOverride in finally
  it("BH9 MED 1: scoutAgent clears modelOverride in a finally block", () => {
    const src = readSrc("scoutAgent.ts");
    expect(src).toContain("clearModelOverride");
    // The clear must be inside a finally block (safety net even on throw).
    expect(src).toMatch(/finally\s*\{[\s\S]*?clearModelOverride/);
  });

  // 8. robloxMcpGuard: normalized server name matching (behavioral)
  it("BH11 MED 1: robloxMcpGuard.isRobloxStudioMcpTool handles spaces/hyphens (normalized)", async () => {
    const { isRobloxStudioMcpTool } = await import("../robloxMcpGuard.js");
    // Exact-match fast paths.
    expect(isRobloxStudioMcpTool("Roblox_Studio__multi_edit")).toBe(true);
    expect(isRobloxStudioMcpTool("roblox_studio__multi_edit")).toBe(true);
    // Slow path: spaces, hyphens, mixed casing must all normalize to true.
    expect(isRobloxStudioMcpTool("Roblox Studio__multi_edit")).toBe(true);
    expect(isRobloxStudioMcpTool("roblox-studio__multi_edit")).toBe(true);
    expect(isRobloxStudioMcpTool("ROBLOX STUDIO__multi_edit")).toBe(true);
    expect(isRobloxStudioMcpTool("Roblox.Studio__multi_edit")).toBe(true);
    // Non-Roblox servers are still rejected.
    expect(isRobloxStudioMcpTool("other_server__multi_edit")).toBe(false);
    expect(isRobloxStudioMcpTool("multi_edit")).toBe(false);
  });

  // 9. App.tsx: /small case-insensitive
  it("BH MED 9: App.tsx uses toLowerCase for /small matching (case-insensitive)", () => {
    const src = readSrc("tui/App.tsx");
    // The /small handler must lowercase the trimmed input before comparing
    // to "/small" so /SMALL, /Small, /small all work.
    expect(src).toMatch(/trimmed\.toLowerCase\(\)/);
    expect(src).toMatch(/startsWith\(["']\/small ["']\)/);
    expect(src).toMatch(/=== ["']\/small["']/);
  });

  // 10. ChatDisplay: system messages don't suppress header
  it("BH MED 10: ChatDisplay.showAssistantHeader treats system like user (prevMsg.role === 'system')", () => {
    const src = readSrc("tui/ChatDisplay.tsx");
    // showAssistantHeader must include the system role so a
    // [user, system, assistant] flow still shows the Claude-Killer header.
    expect(src).toContain('prevMsg.role === "system"');
  });

  // 11. ConfiguratorChat: finished flag reset
  it("BH25 MED 1: ConfiguratorChat resets `finished` when starting a new configuration", () => {
    const src = readSrc("tui/ConfiguratorChat.tsx");
    expect(src).toContain("setFinished(false)");
  });

  // 12. ConfiguratorChat: mountedRef guard
  it("BH25 MED 2: ConfiguratorChat guards setState with mountedRef", () => {
    const src = readSrc("tui/ConfiguratorChat.tsx");
    expect(src).toContain("mountedRef");
    expect(src).toMatch(/mountedRef\s*=\s*useRef\(true\)/);
    // setState callbacks must check mountedRef.current before updating.
    expect(src).toMatch(/if\s*\(\s*!mountedRef\.current\s*\)\s*return/);
  });

  // 13. FolderBrowser: Tab quick-select
  it("BH25 MED 3: FolderBrowser Tab handler calls onSelect(currentPath)", () => {
    const src = readSrc("tui/FolderBrowser.tsx");
    expect(src).toContain("key.tab");
    expect(src).toMatch(/key\.tab[\s\S]*?onSelect\(currentPath\)/);
  });

  // 14. ExtensionHub: install guard via installingRef
  it("BH MED 14: ExtensionHub guards concurrent installs with installingRef", () => {
    const src = readSrc("tui/ExtensionHub.tsx");
    expect(src).toContain("installingRef");
    expect(src).toMatch(/installingRef\s*=\s*useRef\(false\)/);
    // Must guard with installingRef.current before starting an install.
    expect(src).toMatch(/if\s*\(\s*installingRef\.current\s*\)\s*return/);
    expect(src).toMatch(/installingRef\.current\s*=\s*true/);
  });

  // 15. toolUpdater: chmodSync after write
  it("BH MED 15: toolUpdater calls chmodSync after writeFileSync (mode enforcement)", () => {
    const src = readSrc("toolUpdater.ts");
    expect(src).toContain("chmodSync");
    expect(src).toContain("0o600");
  });

  // 16. dotfileConfig: deep merge
  it("BH28 MED 15: dotfileConfig has deepMergeConfig for nested objects", () => {
    const src = readSrc("dotfileConfig.ts");
    expect(src).toMatch(/function\s+deepMergeConfig/);
    // Must merge nested objects key-by-key (mcpServers, theme, etc.).
    expect(src).toContain("mcpServers");
    expect(src).toContain("theme");
  });

  // 17. dotfileConfig: saveConfig mode 0o600
  it("BH28 MED 16: dotfileConfig.saveConfig writes with mode 0o600", () => {
    const src = readSrc("dotfileConfig.ts");
    expect(src).toContain("mode: 0o600");
    expect(src).toContain("chmodSync");
    expect(src).toMatch(/chmodSync\([^,]+,\s*0o600\)/);
  });

  // 18. searxManager: waitForSearxHealthy
  it("BH28 MED 17: searxManager has waitForSearxHealthy health check", () => {
    const src = readSrc("searxManager.ts");
    expect(src).toMatch(/function\s+waitForSearxHealthy/);
    expect(src).toMatch(/waitForSearxHealthy\(\)/);
  });

  // 19. impactAnalyzer: cache key includes cwd
  it("BH28 MED 18: impactAnalyzer cache key includes process.cwd()", () => {
    const src = readSrc("impactAnalyzer.ts");
    // The cache key must include process.cwd() so two projects with the
    // same relative file path don't share a cache slot.
    expect(src).toMatch(/process\.cwd\(\).*::.*targetFile|cacheKey\s*=.*process\.cwd\(\)/);
    expect(src).toContain("process.cwd()");
  });

  // 20. testRunner: parseVitestText regex anchored
  it("BH28 MED 19: testRunner.parseVitestText uses anchored ^FAIL regex (not unanchored X)", () => {
    const src = readSrc("testRunner.ts");
    // The fix anchored the split regex with ^FAIL (multiline) and removed
    // the unanchored single-char `X` alternative that false-split on any
    // "X " in the output.
    expect(src).toMatch(/\^\(\?:FAIL\|✕\|×\)/);
    expect(src).toContain("/m"); // multiline flag
    // The buggy unanchored `X|X` alternative must NOT be present.
    expect(src).not.toMatch(/split\(\s*\/\(\?:FAIL\|X\|X\)\s+/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// LOW bug regression tests
// ──────────────────────────────────────────────────────────────────────────

describe("LOW bug regressions", () => {
  // 21. config: MODEL="" fallback
  it("BH8 LOW 1 (config): config.model uses process.env.MODEL?.trim() || default", () => {
    const src = readSrc("config.ts");
    // Empty/whitespace MODEL must fall back to the default — `?.trim() ||`
    // does that (vs `??` which would keep the empty string).
    expect(src).toMatch(/process\.env\.MODEL\?\.trim\(\)\s*\|\|\s*["']moonshotai\/kimi-k2\.6["']/);
  });

  // 22. logger: 10 segments (not 40)
  it("BH24 LOW 1: logger.statusBar uses 10 segments (not 40)", () => {
    const src = readSrc("logger.ts");
    // The 10-segment bar uses Math.round(pct * 10) and Math.min(10, ...).
    expect(src).toMatch(/Math\.round\(pct\s*\*\s*10\)/);
    expect(src).toMatch(/Math\.min\(\s*10,/);
    // The buggy 40-segment code must NOT be present.
    expect(src).not.toMatch(/Math\.round\(pct\s*\*\s*40\)/);
  });

  // 23. activityTracker: || fallback (not ??)
  it("BH LOW 23: activityTracker.formatShortLabel uses || (not ??) for tool label fallback", () => {
    const src = readSrc("activityTracker.ts");
    // For tool labels, an empty string from split(" ")[0] must fall back to
    // "tool" — `||` handles that; `??` would keep the empty string.
    expect(src).toMatch(/entry\.label\.split\(["'] ["']\)\[0\]\s*\|\|\s*["']tool["']/);
  });

  // 24. logger: inline code precedence
  it("BH24 LOW 3: logger.applyInlineFormatting processes inline code BEFORE bold/italic", () => {
    const src = readSrc("logger.ts");
    expect(src).toMatch(/function\s+applyInlineFormatting/);
    // Inline code replaceAll must appear BEFORE bold/italic replaceAll in
    // the function body so backticked content takes precedence.
    const fnStart = src.indexOf("function applyInlineFormatting");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const fnSlice = src.slice(fnStart);
    const codeIdx = fnSlice.indexOf(".replaceAll(/`");
    const boldIdx = fnSlice.indexOf(".replaceAll(/\\*\\*");
    expect(codeIdx).toBeGreaterThanOrEqual(0);
    expect(boldIdx).toBeGreaterThanOrEqual(0);
    expect(codeIdx).toBeLessThan(boldIdx);
  });

  // 25. tools: Buffer.byteLength for MAX_OUTPUT_BYTES
  it("BH8 LOW 1 (tools): tools.ts tracks byte counts via Buffer chunk length (MAX_OUTPUT_BYTES byte cap)", () => {
    const src = readSrc("tools.ts");
    expect(src).toContain("MAX_OUTPUT_BYTES");
    // The fix tracks actual bytes via the Buffer chunk's length (always in
    // bytes) instead of relying on string .length (UTF-16 code units).
    expect(src).toMatch(/chunk\.subarray/);
    expect(src).toMatch(/slice\.toString\(["']utf8["']\)/);
  });

  // 26. i18n: LANGUAGE priority order
  it("BH20 LOW 4: i18n.detectLanguage splits LANGUAGE by ':' and iterates parts in priority order", () => {
    const src = readSrc("i18n.ts");
    expect(src).toMatch(/LANGUAGE\.split\(["']:["']\)/);
    // Must push each part as its own candidate (in order) — not use
    // String.includes on the whole var.
    expect(src).toMatch(/for\s*\(\s*const\s+part\s+of\s+process\.env\.LANGUAGE\.split\(["']:["']\)\s*\)/);
    expect(src).toMatch(/candidates\.push\(part\)/);
  });

  // 27. taskState: markTaskItemDone no empty file
  it("BH15 LOW 1: taskState.markTaskItemDone guards against creating an empty state file", () => {
    const src = readSrc("taskState.ts");
    expect(src).toContain("markTaskItemDone");
    // The guard: if readTaskState() returns null (no file), return a
    // default in-memory state WITHOUT calling updateTaskState.
    expect(src).toMatch(/if\s*\(\s*!current\s*\)/);
    expect(src).toMatch(/return\s*\{[\s\S]*?title:\s*DEFAULT_TASK_TITLE/);
  });

  // 28. autoMemory: mode 0o600
  it("BH27 LOW 2: autoMemory writes with mode 0o600", () => {
    const src = readSrc("autoMemory.ts");
    expect(src).toContain("mode: 0o600");
    expect(src).toContain("0o700"); // dir mode
  });

  // 29. skillTracker: total budget check
  it("BH27 LOW 3: skillTracker checks total > MAX_TOTAL_TOKENS BEFORE pushing", () => {
    const src = readSrc("skillTracker.ts");
    expect(src).toContain("MAX_TOTAL_TOKENS");
    // The fix: project total BEFORE adding so we never exceed the budget.
    expect(src).toMatch(/if\s*\(\s*totalTokens\s*\+\s*tokens\s*>\s*MAX_TOTAL_TOKENS\s*\)\s*break/);
  });

  // 30. parallelTools: sequential for same-file (behavioral)
  it("BH20 LOW 5: parallelTools.groupIndependentTools puts same-name+same-file in separate groups", async () => {
    const { groupIndependentTools } = await import("../parallelTools.js");
    const groups = groupIndependentTools([
      { name: "editar_arquivo", args: { caminho: "/a.ts" } },
      { name: "editar_arquivo", args: { caminho: "/a.ts" } },
      { name: "editar_arquivo", args: { caminho: "/a.ts" } },
    ]);
    // Each dependent write must land in its OWN group (sequential).
    expect(groups.length).toBe(3);
    for (const g of groups) {
      expect(g.length).toBe(1);
    }
  });

  it("BH20 LOW 5: parallelTools.groupIndependentTools keeps independent calls in their own groups too", async () => {
    const { groupIndependentTools } = await import("../parallelTools.js");
    const groups = groupIndependentTools([
      { name: "ler_arquivo", args: { caminho: "/a.ts" } },
      { name: "ler_arquivo", args: { caminho: "/b.ts" } },
    ]);
    expect(groups.length).toBe(2);
  });

  // 31. dotfileConfig: deep copy returned
  it("BH28 LOW 1: dotfileConfig.loadConfig returns a deep copy (JSON.parse(JSON.stringify(...)))", () => {
    const src = readSrc("dotfileConfig.ts");
    expect(src).toMatch(/JSON\.parse\(\s*JSON\.stringify\(/);
  });

  // 32. lspClient: pathToFileURL
  it("BH19 LOW 3: lspClient uses url.pathToFileURL for didOpen URIs", () => {
    const src = readSrc("lspClient.ts");
    expect(src).toContain("pathToFileURL");
    expect(src).toMatch(/url\.pathToFileURL\(absPath\)/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Cross-cutting sanity: ensure each file referenced exists.
// ──────────────────────────────────────────────────────────────────────────

describe("MEDIUM/LOW regression test file presence", () => {
  const files = [
    "apiClient.ts",
    "heartbeat.ts",
    "agent.ts",
    "history.ts",
    "llmCompactor.ts",
    "contextCompaction.ts",
    "scoutAgent.ts",
    "robloxMcpGuard.ts",
    "tui/App.tsx",
    "tui/ChatDisplay.tsx",
    "tui/ConfiguratorChat.tsx",
    "tui/FolderBrowser.tsx",
    "tui/ExtensionHub.tsx",
    "toolUpdater.ts",
    "dotfileConfig.ts",
    "searxManager.ts",
    "impactAnalyzer.ts",
    "testRunner.ts",
    "config.ts",
    "logger.ts",
    "activityTracker.ts",
    "tools.ts",
    "i18n.ts",
    "taskState.ts",
    "autoMemory.ts",
    "skillTracker.ts",
    "parallelTools.ts",
    "lspClient.ts",
  ];

  beforeEach(() => {
    // no-op, exists to keep vitest happy with the looped `it` calls below
  });

  for (const f of files) {
    it(`source file exists: src/${f}`, () => {
      const full = path.join(process.cwd(), "src", f);
      expect(fs.existsSync(full)).toBe(true);
    });
  }
});
