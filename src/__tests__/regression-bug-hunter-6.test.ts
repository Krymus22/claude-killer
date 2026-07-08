/**
 * regression-bug-hunter-6.test.ts
 *
 * Regression tests for bugs found and fixed by Bug Hunter #6
 * (focus area: Quality gate + safety + honesty).
 *
 * Bugs covered:
 *   1. strictQualityGate.ts:254 used `require("node:child_process")` in an
 *      ESM module — replaced with a top-level `import { execSync }`.
 *   2. dataGuard.ts:478 set `shouldBlock = findings.length > 0`, which
 *      contradicted the system-prompt VERDICT contract (BLOCK only when
 *      CRITICAL/HIGH found) and produced a "MUST address before finishing"
 *      message even for medium/low-only findings. Fix: shouldBlock =
 *      criticalAndHigh.length > 0; advisory message for medium/low-only.
 *   3. dataGuard.ts:196 had `required: ["pattern"]` on the ler_arquivo tool
 *      definition — a copy-paste from buscar_texto. ler_arquivo has no
 *      `pattern` property, so strict providers would reject every call.
 *      Fix: removed the bogus required field.
 *   4. dataGuard.ts:426 shell-injected the LLM-controlled `pattern` into a
 *      `grep -rn "${pattern}"` string. A malicious pattern like
 *      `"; rm -rf ~ #` would break out and execute arbitrary shell. Fix:
 *      use `spawnSync("grep", ["-rn", "--", pattern, searchPath])` (no
 *      shell, argv-only).
 *   5. honestySystem.ts:148 used `lower.includes("high")` and
 *      `lower.includes("low")` to classify Devil's Advocate severity —
 *      matching substrings like "highlight", "higher", "below", "follow".
 *      Result: benign reviewer comments ("the highlighted section is fine")
 *      were misclassified as severity=high and blocked the finish in
 *      agent.ts:1772-1778. Fix: word-boundary regex `\\bword\\b`.
 *   6. bugHunter.ts:401 computed projectDir as
 *      `nodePath.dirname(filesModified[0]).replace("/src", "")` — fragile
 *      heuristic that mangled paths like `/x/src-project/foo.ts`
 *      (→ `/x/-project/foo.ts`) and broke for files in `tests/` or
 *      nested `src/utils/` dirs. Fix: walk up looking for the nearest
 *      package.json / default.project.json, falling back to process.cwd().
 *
 * Each test below fails BEFORE the corresponding fix and passes AFTER.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Shared mocks ────────────────────────────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
}));

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
  config: {
    model: "test-model", nvidiaApiKey: "test", nvidiaApiKeys: "",
    nvidiaApiKeysFile: "", nvidiaBaseUrl: "https://test",
    maxTokens: 4096, temperature: 0.6, topP: 0.9,
    contextWindowTokens: 128000, contextCompactThreshold: 0.65,
  },
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(() => () => {}),
}));

// `runDevilsAdvocate` calls `runSubAgent` from subAgents.js (not `chat`
// directly), so we must mock that module to control the sub-agent's verdict.
const subAgentMock = vi.hoisted(() => ({ runSubAgent: vi.fn() }));
vi.mock("../subAgents.js", () => ({
  runSubAgent: subAgentMock.runSubAgent,
}));

// Hoisted mock state for extensionCenter so we can toggle honesty features
// without depending on the real hub persisted state.
const featureState = vi.hoisted(() => ({
  enabled: new Set<string>(),
  reset() { this.enabled.clear(); },
  enable(id: string) { this.enabled.add(id); },
  disable(id: string) { this.enabled.delete(id); },
  isEnabled(id: string) { return this.enabled.has(id); },
}));

vi.mock("../extensionCenter.js", () => ({
  getExtension: vi.fn((id: string) => ({
    enabled: featureState.isEnabled(id),
    triggerMode: featureState.isEnabled(id) ? "always" : "disabled",
  })),
  // `dataGuard.ts` and `bugHunter.ts` import `formatBugHuntMessage` from
  // bugHunter — keep that import working by re-using the real module.
  // (vi.mock with factory replaces the whole module, so we have to
  // explicitly re-export everything else that consumers import.)
  syncExtensions: vi.fn(),
  toggleExtension: vi.fn((id: string) => {
    if (featureState.isEnabled(id)) featureState.disable(id);
    else featureState.enable(id);
    return featureState.isEnabled(id);
  }),
  getAllExtensions: vi.fn(() => []),
  getEnabledExtensions: vi.fn(() => []),
  getExtensionsByCategory: vi.fn(() => []),
  getExtensionsForTrigger: vi.fn(() => []),
}));

vi.mock("../bugHunter.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    // Keep formatBugHuntMessage simple and deterministic so dataGuard tests
    // can focus on shouldBlock/message semantics without coupling to the
    // bug-hunter message format.
    formatBugHuntMessage: vi.fn((findings: any[]) =>
      `[BUG_HUNTER MSG] ${findings.length} finding(s)`),
  };
});

// ─── Bug #1: strictQualityGate.ts uses ESM import (not require) ──────────────

describe("Bug Hunter #6 — strictQualityGate: ESM import of execSync", () => {
  it("module exports execSync via static import (not require)", () => {
    // Read the source file and assert it no longer uses require("node:child_process")
    // for execSync. We strip JS/TS comments before matching so the BUG FIX
    // comment (which quotes the old buggy code for context) doesn't trigger
    // a false positive.
    const rawSrc = fs.readFileSync(
      path.join(__dirname, "..", "strictQualityGate.ts"),
      "utf8",
    );
    const src = rawSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // No require() of node:child_process should appear in actual code.
    expect(src).not.toMatch(/require\(\s*["']node:child_process["']\s*\)/);
    // The top-level import should include execSync.
    expect(src).toMatch(/import\s*\{[^}]*\bexecSync\b[^}]*\}\s*from\s*["']node:child_process["']/);
  });
});

// ─── Bug #2: dataGuard shouldBlock respects critical/high only ────────────────

describe("Bug Hunter #6 — dataGuard: shouldBlock only on critical/high", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bh6-dataguard-"));
    vi.clearAllMocks();
    featureState.reset();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("returns shouldBlock=false when only MEDIUM findings exist", async () => {
    const { runDataGuard, resetDataGuardState } = await import("../dataGuard.js");
    const { chat } = await import("../apiClient.js");
    resetDataGuardState();
    (chat as any).mockResolvedValue({
      choices: [{
        message: {
          content:
            "[MEDIUM] file.luau:10 — Missing pcall around DataStore call\n" +
            "Fix: wrap in pcall\n" +
            "VERDICT: PASS",
        },
        finish_reason: "stop",
      }],
    });
    const result = await runDataGuard([path.join(tmpDir, "f.luau")], "req", "resp");
    // Before the fix: shouldBlock was `findings.length > 0` → true (WRONG).
    // After the fix: shouldBlock is `criticalAndHigh.length > 0` → false.
    expect(result.shouldBlock).toBe(false);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0].severity).toBe("medium");
    expect(result.completed).toBe(true);
  });

  it("returns shouldBlock=false when only LOW findings exist", async () => {
    const { runDataGuard, resetDataGuardState } = await import("../dataGuard.js");
    const { chat } = await import("../apiClient.js");
    resetDataGuardState();
    (chat as any).mockResolvedValue({
      choices: [{
        message: {
          content:
            "[LOW] file.luau:5 — Best practice: use UpdateAsync\n" +
            "Fix: switch to UpdateAsync\n" +
            "VERDICT: PASS",
        },
        finish_reason: "stop",
      }],
    });
    const result = await runDataGuard([path.join(tmpDir, "f.luau")], "req", "resp");
    expect(result.shouldBlock).toBe(false);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0].severity).toBe("low");
  });

  it("returns shouldBlock=true when CRITICAL findings exist", async () => {
    const { runDataGuard, resetDataGuardState } = await import("../dataGuard.js");
    const { chat } = await import("../apiClient.js");
    resetDataGuardState();
    (chat as any).mockResolvedValue({
      choices: [{
        message: {
          content:
            "[CRITICAL] file.luau:5 — SetAsync without GetAsync\n" +
            "Fix: call GetAsync first\n" +
            "VERDICT: BLOCK",
        },
        finish_reason: "stop",
      }],
    });
    const result = await runDataGuard([path.join(tmpDir, "f.luau")], "req", "resp");
    expect(result.shouldBlock).toBe(true);
    expect(result.findings[0].severity).toBe("critical");
  });

  it("returns shouldBlock=true when HIGH findings exist", async () => {
    const { runDataGuard, resetDataGuardState } = await import("../dataGuard.js");
    const { chat } = await import("../apiClient.js");
    resetDataGuardState();
    (chat as any).mockResolvedValue({
      choices: [{
        message: {
          content:
            "[HIGH] file.luau:10 — RemoveAsync without backup\n" +
            "Fix: add backup\n" +
            "VERDICT: BLOCK",
        },
        finish_reason: "stop",
      }],
    });
    const result = await runDataGuard([path.join(tmpDir, "f.luau")], "req", "resp");
    expect(result.shouldBlock).toBe(true);
    expect(result.findings[0].severity).toBe("high");
  });

  it("medium/low-only message is advisory, not blocking", async () => {
    const { runDataGuard, resetDataGuardState } = await import("../dataGuard.js");
    const { chat } = await import("../apiClient.js");
    resetDataGuardState();
    (chat as any).mockResolvedValue({
      choices: [{
        message: {
          content:
            "[MEDIUM] file.luau:10 — Missing pcall\n" +
            "Fix: wrap in pcall\n" +
            "VERDICT: PASS",
        },
        finish_reason: "stop",
      }],
    });
    const result = await runDataGuard([path.join(tmpDir, "f.luau")], "req", "resp");
    // Before the fix: message said "you MUST address these before finishing"
    // even though agent.ts only treats medium/low as advisory. After the fix,
    // the message frames itself as advisory (no "MUST ... before finishing").
    expect(result.message).toContain("[DATAGUARD]");
    expect(result.message.toLowerCase()).not.toContain("must address these before finishing");
    expect(result.message).toMatch(/advisory|review recommended/i);
  });

  it("critical/high message still uses blocking framing", async () => {
    const { runDataGuard, resetDataGuardState } = await import("../dataGuard.js");
    const { chat } = await import("../apiClient.js");
    resetDataGuardState();
    (chat as any).mockResolvedValue({
      choices: [{
        message: {
          content:
            "[CRITICAL] file.luau:5 — SetAsync without GetAsync\n" +
            "Fix: call GetAsync first\n" +
            "VERDICT: BLOCK",
        },
        finish_reason: "stop",
      }],
    });
    const result = await runDataGuard([path.join(tmpDir, "f.luau")], "req", "resp");
    expect(result.message).toContain("MUST address these before finishing");
  });
});

// ─── Bug #3: dataGuard ler_arquivo tool has no bogus required field ──────────

describe("Bug Hunter #6 — dataGuard: ler_arquivo tool schema is correct", () => {
  it("ler_arquivo tool does not require 'pattern' (copy-paste bug)", () => {
    // Source-level regression: verify the bogus `required: ["pattern"]` on
    // ler_arquivo has been removed. We strip JS/TS comments before matching
    // so that the BUG FIX comment (which quotes the old buggy line for
    // context) doesn't trigger a false positive.
    const rawSrc = fs.readFileSync(
      path.join(__dirname, "..", "dataGuard.ts"),
      "utf8",
    );
    // Strip /* ... */ and // ... line comments.
    const srcWithoutComments = rawSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // Find the ler_arquivo tool definition block (from `name: "ler_arquivo"`
    // to the next `name:` after it, which is `name: "buscar_texto"`).
    const startIdx = srcWithoutComments.indexOf('name: "ler_arquivo"');
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = srcWithoutComments.indexOf('name: "buscar_texto"', startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    const block = srcWithoutComments.slice(startIdx, endIdx);
    // The ler_arquivo tool must NOT have a `required: ["pattern"]` field
    // (its parameters are path/caminho/offset/limit — pattern belongs to
    // buscar_texto).
    expect(block).not.toMatch(/required:\s*\[\s*"pattern"\s*\]/);
  });
});

// ─── Bug #4: dataGuard buscar_texto uses spawnSync (no shell injection) ──────

describe("Bug Hunter #6 — dataGuard: buscar_texto uses argv (no shell)", () => {
  it("source uses spawnSync with argv, not execSync with template literal", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "dataGuard.ts"),
      "utf8",
    );
    // The safer spawnSync approach must be present.
    expect(src).toMatch(/spawnSync/);
    // The `--` separator (end-of-options) must be present so a pattern
    // starting with `-` is treated as a pattern, not a flag.
    expect(src).toMatch(/\["-rn",\s*"--",\s*pattern/);
  });

  it("does not execute shell when pattern contains shell metacharacters", async () => {
    // Exercise the buscar_texto branch via the chat() tool-call path.
    // We feed the DataGuard a tool_calls response that calls buscar_texto
    // with a malicious pattern; verify the result is "(no matches)" or
    // "(search failed or no matches)" — NOT the result of `rm` or similar.
    const { runDataGuard, resetDataGuardState } = await import("../dataGuard.js");
    const { chat } = await import("../apiClient.js");
    resetDataGuardState();

    let callCount = 0;
    (chat as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: model wants to use buscar_texto with a shell-injection payload.
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_1",
                function: {
                  name: "buscar_texto",
                  arguments: JSON.stringify({
                    // Before the fix: this would be `grep -rn "; echo INJECTED; #" "/tmp"`
                    // — the `;` would terminate grep and run `echo INJECTED`.
                    // After the fix: spawnSync passes this as a single argv
                    // element to grep, which treats it as a literal pattern
                    // (and finds no matches).
                    pattern: '; echo INJECTED; #',
                    path: "/tmp",
                  }),
                },
              }],
            },
            finish_reason: "tool_calls",
          }],
        };
      }
      // Second call: model returns verdict.
      return {
        choices: [{
          message: { content: "No issues. VERDICT: PASS" },
          finish_reason: "stop",
        }],
      };
    });

    // Even though the pattern contains shell metacharacters, runDataGuard
    // should not throw, not hang, and not produce "INJECTED" in its output.
    const result = await runDataGuard(["/tmp/x.luau"], "req", "resp");
    expect(result.completed).toBe(true);
    // The malicious string "INJECTED" must NOT appear in the agent's message
    // or in the findings — proving the shell was not invoked.
    expect(result.message).not.toContain("INJECTED");
    expect(JSON.stringify(result.findings)).not.toContain("INJECTED");
  });
});

// ─── Bug #5: honestySystem Devil's Advocate uses word-boundary severity match ──

describe("Bug Hunter #6 — honestySystem: severity detection uses word boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    featureState.reset();
    featureState.enable("feature:devils_advocate");
    // Default: sub-agent returns null (no review) — individual tests override.
    subAgentMock.runSubAgent.mockResolvedValue(null);
  });

  it("does NOT classify 'highlighted' as severity=high", async () => {
    const { runDevilsAdvocate } = await import("../honestySystem.js");

    subAgentMock.runSubAgent.mockResolvedValue(
      // Before the fix: `lower.includes("high")` matched "highlighted"
      // → severity = "high" → agent.ts:1772-1778 blocked the finish.
      // After the fix: word-boundary regex `\bhigh\b` does NOT match
      // "highlighted" → severity falls through to default "medium"
      // (issues found but no explicit severity keyword).
      //
      // NOTE: the response deliberately avoids the words "critical",
      // "grave", "high", "medium", "low" as standalone classifiers so
      // the only way severity could be "high" is via the old substring
      // match on "highlighted".
      "I reviewed the code. The highlighted section is fine.\n" +
      "- minor concern about variable naming\n" +
      "Nothing serious to report.",
    );

    const result = await runDevilsAdvocate(
      [{ path: "test.lua", content: "local x = 1" }],
      "create a variable",
    );
    expect(result.severity).not.toBe("high");
  });

  it("does NOT classify 'follow' or 'below' as severity=low when no real low-severity issue exists", async () => {
    const { runDevilsAdvocate } = await import("../honestySystem.js");

    subAgentMock.runSubAgent.mockResolvedValue(
      // "follow" and "below" both contain "low" as a substring — the
      // old check `lower.includes("low")` would have flagged this as
      // severity=low even though the reviewer didn't actually classify
      // it as low. The new word-boundary regex avoids the false positive.
      // "Nada encontrado" → severity "none" (reviewer found nothing).
      "Please follow the patterns below.\n- style issue\nNada encontrado.",
    );

    const result = await runDevilsAdvocate(
      [{ path: "test.lua", content: "local x = 1" }],
      "refactor",
    );
    // "Nada encontrado" → no real issues → severity should be "none".
    expect(result.severity).toBe("none");
  });

  it("DOES classify standalone 'high' as severity=high", async () => {
    const { runDevilsAdvocate } = await import("../honestySystem.js");

    subAgentMock.runSubAgent.mockResolvedValue(
      // "Severity: high" + an issue line. Should classify as "high".
      "Severity: high\n- critical bug found",
    );

    const result = await runDevilsAdvocate(
      [{ path: "test.lua", content: "x = nil; print(x.foo)" }],
      "find bugs",
    );
    expect(result.severity).toBe("high");
  });

  it("DOES classify 'critical' as severity=high", async () => {
    const { runDevilsAdvocate } = await import("../honestySystem.js");

    subAgentMock.runSubAgent.mockResolvedValue(
      "This is critical — nil access on user.name\n- will crash at runtime",
    );

    const result = await runDevilsAdvocate(
      [{ path: "test.lua", content: "print(user.name)" }],
      "fix crash",
    );
    expect(result.severity).toBe("high");
  });
});

// ─── Bug #6: bugHunter findProjectDirForVerification walks up ────────────────

describe("Bug Hunter #6 — bugHunter: projectDir computation walks up", () => {
  let tmpRoot: string;
  let origCwd: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bh6-projectdir-"));
    origCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(origCwd);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("findProjectDirForVerification finds package.json by walking up", async () => {
    const { findProjectDirForVerification } = await import("../bugHunter.js");
    // Layout: <tmpRoot>/package.json, <tmpRoot>/src/utils/foo.ts
    fs.writeFileSync(path.join(tmpRoot, "package.json"), '{"name":"test"}');
    fs.mkdirSync(path.join(tmpRoot, "src", "utils"), { recursive: true });
    const filePath = path.join(tmpRoot, "src", "utils", "foo.ts");
    fs.writeFileSync(filePath, "export const x = 1;");

    const result = findProjectDirForVerification(filePath);
    expect(result).toBe(tmpRoot);
  });

  it("findProjectDirForVerification handles files in tests/ (not just src/)", async () => {
    const { findProjectDirForVerification } = await import("../bugHunter.js");
    // Layout: <tmpRoot>/package.json, <tmpRoot>/tests/foo.test.ts
    // The old `dirname(f).replace("/src", "")` heuristic would return
    // <tmpRoot>/tests (because "/src" doesn't appear in the path) — wrong.
    // The fix walks up and finds <tmpRoot>.
    fs.writeFileSync(path.join(tmpRoot, "package.json"), '{"name":"test"}');
    fs.mkdirSync(path.join(tmpRoot, "tests"), { recursive: true });
    const filePath = path.join(tmpRoot, "tests", "foo.test.ts");
    fs.writeFileSync(filePath, "export const x = 1;");

    const result = findProjectDirForVerification(filePath);
    expect(result).toBe(tmpRoot);
  });

  it("findProjectDirForVerification does NOT mangle paths containing 'src-project'", async () => {
    const { findProjectDirForVerification } = await import("../bugHunter.js");
    // Layout: <tmpRoot>/src-project/package.json, file inside src-project/.
    // Old heuristic: dirname(f).replace("/src", "") would turn
    //   /tmp/.../src-project  →  /tmp/.../-project
    // (mangled — stripping "/src" from the directory name even though it
    // was a contiguous "src-project" name, not a "/src/" path segment).
    // The fix walks up looking for package.json and returns the actual
    // project root unchanged.
    const projectRoot = path.join(tmpRoot, "src-project");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "package.json"), '{"name":"test"}');
    const filePath = path.join(projectRoot, "foo.ts");
    fs.writeFileSync(filePath, "export const x = 1;");

    const result = findProjectDirForVerification(filePath);
    // Must return the unmodified projectRoot (containing "src-project"),
    // NOT the mangled form. The old heuristic would have stripped "/src"
    // to produce `<tmpRoot>/-project` — assert that string is NOT the result.
    expect(result).toBe(projectRoot);
    // Specifically: the mangled form would replace the "/src" inside
    // "/src-project" with "" — producing "/-project". Assert that
    // "<tmpRoot>/-project" (the mangled path) is NOT what we got.
    const mangledForm = path.join(tmpRoot, "-project");
    expect(result).not.toBe(mangledForm);
  });

  it("findProjectDirForVerification finds default.project.json for Roblox projects", async () => {
    const { findProjectDirForVerification } = await import("../bugHunter.js");
    // Layout: <tmpRoot>/default.project.json, <tmpRoot>/src/foo.luau
    fs.writeFileSync(path.join(tmpRoot, "default.project.json"), '{"name":"roblox"}');
    fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
    const filePath = path.join(tmpRoot, "src", "foo.luau");
    fs.writeFileSync(filePath, "local x = 1");

    const result = findProjectDirForVerification(filePath);
    expect(result).toBe(tmpRoot);
  });

  it("findProjectDirForVerification falls back to process.cwd() when no marker found", async () => {
    const { findProjectDirForVerification } = await import("../bugHunter.js");
    // Use a deep path with no package.json / default.project.json anywhere
    // up the tree. The function should fall back to process.cwd() rather
    // than crash or return a path containing "undefined".
    const deepRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bh6-nomarker-"));
    const nested = path.join(deepRoot, "deep", "nested");
    fs.mkdirSync(nested, { recursive: true });
    const filePath = path.join(nested, "file.ts");
    fs.writeFileSync(filePath, "export const x = 1;");
    // Move into the deep root so cwd() is something predictable.
    process.chdir(deepRoot);
    try {
      const result = findProjectDirForVerification(filePath);
      // Should fall back to process.cwd() (no marker found within 10 levels).
      expect(result).toBe(process.cwd());
    } finally {
      process.chdir(origCwd);
      try { fs.rmSync(deepRoot, { recursive: true, force: true }); } catch {}
    }
  });
});

// ─── Sanity: tests still pass with the bug hunter round limits unchanged ─────

describe("Bug Hunter #6 — §17 rule limits unchanged", () => {
  it("MAX_BUG_HUNTER_ROUNDS = 10 in agent.ts source", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "agent.ts"),
      "utf8",
    );
    expect(src).toMatch(/MAX_BUG_HUNTER_ROUNDS\s*=\s*10/);
  });

  it("MAX_MEDIUM_LOW_ROUNDS = 3 in agent.ts source", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "agent.ts"),
      "utf8",
    );
    expect(src).toMatch(/MAX_MEDIUM_LOW_ROUNDS\s*=\s*3/);
  });

  it("MAX_GOAL_BLOCKS_PER_TURN = 2 in agent.ts source", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "agent.ts"),
      "utf8",
    );
    expect(src).toMatch(/MAX_GOAL_BLOCKS_PER_TURN\s*=\s*2/);
  });

  it("STRICT_GATE_MAX_BLOCKS default = 8 (max 8 blocks rule)", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "strictQualityGate.ts"),
      "utf8",
    );
    // §17.7 rule 29: Max 8 blocks.
    expect(src).toMatch(/STRICT_GATE_MAX_BLOCKS["']?,?\s*8/);
  });

  it("findProjectRoot in strictQualityGate is cwd-only (no walk up)", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "strictQualityGate.ts"),
      "utf8",
    );
    // §17.7 rule 28: findProjectRoot só olha cwd — não caminha pra cima.
    // Extract the function body and assert no `dirname` walk-up loop.
    const fnMatch = src.match(/function\s+findProjectRoot\(\)\s*:\s*string\s*\{([\s\S]*?)\n\}/);
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![1];
    // Must reference process.cwd() (the cwd-only starting point).
    expect(body).toMatch(/process\.cwd\(\)/);
    // Must NOT contain a walk-up loop (dirname-based climbing).
    expect(body).not.toMatch(/path\.dirname\(/);
  });
});
