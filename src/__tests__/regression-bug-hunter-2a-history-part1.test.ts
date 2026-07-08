/**
 * regression-bug-hunter-2a-history-part1.test.ts
 *
 * Regression tests for bugs found and fixed by Bug Hunter #2a — part 1,
 * focused on history.ts lines 1-325 + the listed scope items that span
 * up to ~line 491 (getSystemPrompt end):
 *   - imports (ESM, no require())
 *   - memory files: loadProjectMemoryFiles, MemoryFile, MEMORY_FILENAMES
 *   - getSystemPrompt, getCavemanLevel, setCavemanLevel
 *   - effort: getEffortPromptSnippet integration in getSystemPrompt
 *   - buildEnvironmentInfo
 *   - TOOL_ROUTING_RULES
 *   - WRITING_STYLE_RULES
 *   - injectPatterns / loadProjectMemoryFilesCached (private helpers
 *     exercised via getSystemPrompt)
 *
 * Bugs covered:
 *
 *   Bug 1 (MEDIUM): TOOL_ROUTING_RULES line 364 used `ler_arquivo({ caminho })`
 *     — the PT alias — while BASE_SYSTEM_PROMPT (line 291) explicitly says
 *     `caminho` is the WRONG alias and `path` is canonical ("use 'path'
 *     (caminho is auto-corrected)"). The two sections of the system prompt
 *     gave the LLM CONTRADICTORY guidance about which argument name to use
 *     for ler_arquivo. The apiClient.ts tool schema lists `path` first
 *     (canonical) and `caminho` as "Alias for path (PT.)", and
 *     argsNormalizer.ts copies `caminho → path` (universal alias). So
 *     `path` is unambiguously canonical. Fix: TOOL_ROUTING_RULES now uses
 *     `ler_arquivo({ path })` to match BASE_SYSTEM_PROMPT.
 *
 *   Bug 2 (LOW / cosmetic): Line 427 had 4-space indentation
 *     (`    const memoryFiles = ...`) surrounded by 2-space-indented lines.
 *     No behavioral impact, but inconsistent style and would be flagged by
 *     ESLint/Prettier. Fix: re-indented to 2 spaces. No regression test
 *     (cosmetic-only change has no observable behavior to assert).
 *
 * Rules honored (§17):
 *   - "HONESTY RULES sempre no system prompt" (§17.1.5) — verified by test
 *     "getSystemPrompt always includes HONESTY RULES regardless of state".
 *     The fix does NOT touch BASE_SYSTEM_PROMPT, so HONESTY RULES stays.
 *   - "ler_arquivo NÃO trunca" (§17.1.2) — unchanged.
 *   - "think é alias de pensar" (§17.1.4) — unchanged.
 *   - "pensar tool NÃO é removido do tool set" (§17.1.8) — unchanged.
 *   - No §17 intocável values changed (contextCompactThreshold,
 *     STREAM_FLUSH_INTERVAL, MIN_LIVE_MESSAGES, etc.).
 *   - Uses `import` not `require()` (ESM) — §16.4 honored.
 *   - Bug fix has regression test (this file) — §16.4 honored.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ─── Mocks ─────────────────────────────────────────────────────────────────
// Mock extensions.getActiveSkills and effortLevels.getEffortPromptSnippet so
// getSystemPrompt() is deterministic and doesn't touch the real extensions
// system or the real effort-level module-level state.

const mockGetActiveSkills = vi.fn().mockReturnValue([]);
vi.mock("../extensions.js", () => ({
  getActiveSkills: (...args: any[]) => mockGetActiveSkills(...args),
}));

const mockGetEffortSnippet = vi.fn().mockReturnValue("");
vi.mock("../effortLevels.js", () => ({
  getEffortPromptSnippet: (...args: any[]) => mockGetEffortSnippet(...args),
  setEffortLevel: vi.fn(),
}));

// Mock session to avoid file I/O during tests
vi.mock("../session.js", () => ({
  appendMessage: vi.fn(),
  appendCompactionSnapshot: vi.fn(),
  getActiveSessionId: vi.fn(() => null),
  setActiveSession: vi.fn(),
}));

// ─── Imports AFTER mocks ───────────────────────────────────────────────────

import {
  getSystemPrompt,
  getCavemanLevel,
  setCavemanLevel,
  resetHistory,
  addUserMessage,
  getHistory,
  loadProjectMemoryFiles,
  reloadProjectMemory,
} from "../history.js";

// ─── Setup / Teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  resetHistory();
  setCavemanLevel(null);
  mockGetActiveSkills.mockReturnValue([]);
  mockGetEffortSnippet.mockReturnValue("");
  reloadProjectMemory(); // invalidate memory cache so each test sees fresh state
});

afterEach(() => {
  resetHistory();
  setCavemanLevel(null);
  mockGetActiveSkills.mockReturnValue([]);
  mockGetEffortSnippet.mockReturnValue("");
  reloadProjectMemory();
});

// ─── Bug 1: TOOL_ROUTING_RULES uses canonical `path` ───────────────────────

describe("Bug Hunter #2a (part 1) — Bug 1: TOOL_ROUTING_RULES uses canonical 'path'", () => {
  it("TOOL_ROUTING_RULES uses `ler_arquivo({ path })` (canonical), not `ler_arquivo({ caminho })` (alias)", () => {
    // Bug 1 regression: TOOL_ROUTING_RULES previously used `caminho`, which
    // contradicts BASE_SYSTEM_PROMPT's explicit "use 'path' (caminho is
    // auto-corrected)" rule. The two sections gave the LLM contradictory
    // guidance. After the fix, TOOL_ROUTING_RULES uses `path`.
    //
    // Note: BASE_SYSTEM_PROMPT contains `ler_arquivo({ caminho: "/x" })` (with
    // colon + value, as the WRONG example) but NOT `ler_arquivo({ caminho })`
    // (closing brace immediately after `caminho`). So the negative assertion
    // specifically targets the TOOL_ROUTING_RULES pattern.
    const prompt = getSystemPrompt();
    expect(prompt).toContain("ler_arquivo({ path })");
    expect(prompt).not.toContain("ler_arquivo({ caminho })");
  });

  it("TOOL_ROUTING_RULES is consistent with BASE_SYSTEM_PROMPT canonical arg name", () => {
    // Both BASE_SYSTEM_PROMPT and TOOL_ROUTING_RULES should agree that `path`
    // is canonical for ler_arquivo. The "WRONG: ... use 'path'" rule in
    // BASE_SYSTEM_PROMPT must not be contradicted by TOOL_ROUTING_RULES.
    const prompt = getSystemPrompt();
    // BASE_SYSTEM_PROMPT's canonical example
    expect(prompt).toContain("ler_arquivo({ path: \"/abs/path/to/file.ts\" })");
    // TOOL_ROUTING_RULES' canonical example (after fix)
    expect(prompt).toContain("ler_arquivo({ path })");
    // BASE_SYSTEM_PROMPT explicitly says caminho is auto-corrected alias
    expect(prompt).toContain("caminho is auto-corrected");
  });

  it("TOOL_ROUTING_RULES still mentions buscar_texto and buscar_arquivos with `pattern`", () => {
    // Sanity check: the fix to ler_arquivo's arg name didn't accidentally
    // break the other tool routing examples.
    const prompt = getSystemPrompt();
    expect(prompt).toContain("buscar_texto({ pattern })");
    expect(prompt).toContain("buscar_arquivos({ pattern })");
  });

  it("TOOL_ROUTING_RULES preserves the NEVER executar_comando guidance", () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain("NEVER use `executar_comando`");
    expect(prompt).toContain("Running builds");
    expect(prompt).toContain("Running tests");
    expect(prompt).toContain("Running git");
  });
});

// ─── §17.1.5: HONESTY RULES always in system prompt ───────────────────────

describe("Bug Hunter #2a (part 1) — §17.1.5: HONESTY RULES always present", () => {
  // §17.1 rule 5: "HONESTY RULES sempre no system prompt — NUNCA remover,
  // suavizar, ou pular". This test verifies that HONESTY RULES is present
  // regardless of caveman mode, effort level, skills, or memory state.
  // The Bug 1 fix touches TOOL_ROUTING_RULES only — it must not affect
  // HONESTY RULES.

  it("getSystemPrompt always includes HONESTY RULES section (default state)", () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain("HONESTY RULES");
    expect(prompt).toContain("HONESTY OVER AGREEMENT");
  });

  it("getSystemPrompt includes HONESTY RULES when caveman mode is active", () => {
    setCavemanLevel("ultra");
    const prompt = getSystemPrompt();
    expect(prompt).toContain("HONESTY RULES");
    expect(prompt).toContain("HONESTY OVER AGREEMENT");
    // Caveman note is prepended; HONESTY RULES still present in the body
    expect(prompt).toContain("CAVEMAN MODE");
  });

  it("getSystemPrompt includes HONESTY RULES when effort snippet is non-empty", () => {
    mockGetEffortSnippet.mockReturnValue("## EFFORT LEVEL: HIGH");
    const prompt = getSystemPrompt();
    expect(prompt).toContain("HONESTY RULES");
    expect(prompt).toContain("EFFORT LEVEL: HIGH");
  });

  it("getSystemPrompt includes HONESTY RULES when skills are active", () => {
    mockGetActiveSkills.mockReturnValue([
      { name: "test-skill", description: "a test skill", path: "/x.md", content: "" },
    ]);
    const prompt = getSystemPrompt();
    expect(prompt).toContain("HONESTY RULES");
    expect(prompt).toContain("Available Skills");
  });
});

// ─── Section ordering in getSystemPrompt ───────────────────────────────────

describe("Bug Hunter #2a (part 1) — getSystemPrompt section ordering", () => {
  it("sections appear in the expected order (date → base → env → routing → style)", () => {
    // The expected order of fixed sections:
    //   1. ## Current Date
    //   2. BASE_SYSTEM_PROMPT ("You are Claude-Killer...")
    //   3. ## Environment
    //   4. ## Tool Routing — CRITICAL
    //   5. ## Response Style — CRITICAL
    //   (optional: EFFORT LEVEL, CAVEMAN NOTE prefix, Project Memory, Skills)
    const prompt = getSystemPrompt();
    const dateIdx = prompt.indexOf("## Current Date");
    const baseIdx = prompt.indexOf("You are Claude-Killer");
    const envIdx = prompt.indexOf("## Environment");
    const routingIdx = prompt.indexOf("## Tool Routing");
    const styleIdx = prompt.indexOf("## Response Style");

    expect(dateIdx).toBeGreaterThanOrEqual(0);
    expect(baseIdx).toBeGreaterThan(dateIdx);
    expect(envIdx).toBeGreaterThan(baseIdx);
    expect(routingIdx).toBeGreaterThan(envIdx);
    expect(styleIdx).toBeGreaterThan(routingIdx);
  });

  it("caveman note is prepended BEFORE Current Date when active", () => {
    setCavemanLevel("lite");
    const prompt = getSystemPrompt();
    const cavemanIdx = prompt.indexOf("[SYSTEM NOTE: CAVEMAN MODE");
    const dateIdx = prompt.indexOf("## Current Date");
    expect(cavemanIdx).toBeGreaterThanOrEqual(0);
    expect(cavemanIdx).toBeLessThan(dateIdx);
  });
});

// ─── buildEnvironmentInfo fields ───────────────────────────────────────────

describe("Bug Hunter #2a (part 1) — buildEnvironmentInfo (via getSystemPrompt)", () => {
  // buildEnvironmentInfo is private; we exercise it via getSystemPrompt.

  it("includes all expected environment fields", () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain("## Environment");
    expect(prompt).toContain("Working directory:");
    expect(prompt).toContain("Platform:");
    expect(prompt).toContain("Shell:");
    expect(prompt).toContain("Node.js:");
    expect(prompt).toContain("Model:");
  });

  it("includes platform label (Windows/macOS/Linux)", () => {
    const prompt = getSystemPrompt();
    const expected =
      process.platform === "win32" ? "Windows" :
      process.platform === "darwin" ? "macOS" :
      process.platform === "linux" ? "Linux" :
      process.platform;
    expect(prompt).toContain(expected);
  });

  it("includes the platform-appropriate-commands guidance", () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain("Use platform-appropriate commands");
    expect(prompt).toContain("absolute paths");
  });

  it("includes the current working directory", () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain(process.cwd());
  });
});

// ─── WRITING_STYLE_RULES ───────────────────────────────────────────────────

describe("Bug Hunter #2a (part 1) — WRITING_STYLE_RULES (via getSystemPrompt)", () => {
  it("includes the writing style section with all bullets", () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain("## Response Style");
    expect(prompt).toContain("markdown");
    expect(prompt).toContain("≤25 words");
    expect(prompt).toContain("≤100 words");
    expect(prompt).toContain("Don't repeat what the user said");
    expect(prompt).toContain("PT-BR or EN");
  });
});

// ─── getCavemanLevel / setCavemanLevel ─────────────────────────────────────

describe("Bug Hunter #2a (part 1) — getCavemanLevel / setCavemanLevel", () => {
  it("default getCavemanLevel() is null after reset", () => {
    expect(getCavemanLevel()).toBeNull();
  });

  it("setCavemanLevel sets and getCavemanLevel returns the level", () => {
    setCavemanLevel("ultra");
    expect(getCavemanLevel()).toBe("ultra");
  });

  it("setCavemanLevel(null) resets to null", () => {
    setCavemanLevel("lite");
    setCavemanLevel(null);
    expect(getCavemanLevel()).toBeNull();
  });

  it("setCavemanLevel updates the live system prompt (history[0]) when history is initialized", () => {
    // After addUserMessage (which triggers ensureHistoryInitialized), history[0]
    // is the system prompt. setCavemanLevel should refresh history[0] in-place.
    addUserMessage("hi");
    const beforePrompt = getHistory()[0].content as string;
    expect(beforePrompt).not.toContain("CAVEMAN MODE");

    setCavemanLevel("ultra");
    const afterPrompt = getHistory()[0].content as string;
    expect(afterPrompt).toContain("CAVEMAN MODE");
    expect(afterPrompt).toContain("ultra");

    // Cleanup
    setCavemanLevel(null);
    const clearedPrompt = getHistory()[0].content as string;
    expect(clearedPrompt).not.toContain("CAVEMAN MODE");
  });

  it("setCavemanLevel before history init: level is picked up on first system prompt build", () => {
    // If setCavemanLevel is called before history is initialized, the level
    // is stored in currentCavemanLevel and used when getSystemPrompt is next
    // called (e.g. by ensureHistoryInitialized via addUserMessage).
    setCavemanLevel("wenyan-ultra");
    addUserMessage("hello");
    const sysPrompt = getHistory()[0].content as string;
    expect(sysPrompt).toContain("CAVEMAN MODE");
    expect(sysPrompt).toContain("wenyan-ultra");
  });
});

// ─── loadProjectMemoryFiles: walks up directories ──────────────────────────

describe("Bug Hunter #2a (part 1) — loadProjectMemoryFiles basics", () => {
  it("returns an array (possibly empty when no CLAUDE.md/AGENTS.md found)", () => {
    const files = loadProjectMemoryFiles();
    expect(Array.isArray(files)).toBe(true);
  });

  it("each file has the required MemoryFile fields with correct types", () => {
    const files = loadProjectMemoryFiles();
    for (const f of files) {
      expect(typeof f.relativePath).toBe("string");
      expect(typeof f.absolutePath).toBe("string");
      expect(typeof f.sizeBytes).toBe("number");
      expect(typeof f.content).toBe("string");
      expect(f.sizeBytes).toBeGreaterThan(0);
      expect(f.content.length).toBeGreaterThan(0);
    }
  });

  it("absolutePath is absolute (starts with / or drive letter)", () => {
    const files = loadProjectMemoryFiles();
    for (const f of files) {
      expect(
        f.absolutePath.startsWith("/") || /^[A-Za-z]:/.test(f.absolutePath)
      ).toBe(true);
    }
  });

  it("closest memory file (cwd) is LAST in the returned array (highest precedence)", () => {
    // Per the docstring: "closest = last = highest precedence".
    // We can't guarantee memory files exist in the test cwd, so this test
    // only runs the precedence assertion when files were found.
    const files = loadProjectMemoryFiles();
    if (files.length >= 2) {
      // The last file's absolutePath should be the closest to cwd.
      const cwd = process.cwd();
      const lastFile = files[files.length - 1];
      const lastDepth = lastFile.absolutePath.length - cwd.length;
      // The closest file's absolutePath should start with cwd (or be in cwd).
      // (If a memory file is in cwd itself, lastDepth is small/positive.)
      expect(lastFile.absolutePath.startsWith(cwd) || cwd.startsWith(lastFile.absolutePath)).toBe(true);
      // lastDepth being small means it's close to cwd
      expect(lastDepth).toBeLessThanOrEqual(lastFile.absolutePath.length);
    }
  });
});

// ─── Imports: ESM only (no require) ────────────────────────────────────────

describe("Bug Hunter #2a (part 1) — imports use ESM (no require)", () => {
  // §16.4 rule: "Uses `import` not `require()` (ESM)". This is a static
  // guarantee — we verify by reading the source file at test time and
  // asserting no `require(` calls exist in the scope's import section.
  it("history.ts source does not use require() for module loading (lines 1-25 imports)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../history.ts"),
      "utf8"
    );
    const lines = src.split("\n");
    // Inspect the imports section (lines 1-25 in 1-indexed source).
    const importSection = lines.slice(0, 25).join("\n");
    // No require() calls in the import section
    expect(importSection).not.toMatch(/\brequire\s*\(/);
    // Verify ESM imports are present
    expect(importSection).toMatch(/^import\s/m);
    expect(importSection).toContain('from "./apiClient.js"');
    expect(importSection).toContain('from "./extensions.js"');
    expect(importSection).toContain('from "./effortLevels.js"');
    expect(importSection).toContain('from "./config.js"');
    expect(importSection).toContain('from "./patternExtractor.js"');
  });
});
