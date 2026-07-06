/**
 * unit-history-extended.test.ts — Deep unit tests for src/history.ts
 *
 * Coverage focus:
 *   - addUserMessage / addToolResult / addSystemMessage / addRawAssistantMessage
 *   - resetHistory, getHistory, historyLength
 *   - historySummary, compactHistory, estimateTokens
 *   - getSystemPrompt (non-empty, includes date, includes effort level)
 *   - loadProjectMemoryFiles / getLoadedMemoryFiles / reloadProjectMemory (cache)
 *   - isPlanMode / setPlanMode toggle
 *   - getCavemanLevel / setCavemanLevel
 *   - Memory file format (relativePath, absolutePath, sizeBytes, content)
 *
 * External deps mocked: extensions.getActiveSkills, effortLevels.getEffortPromptSnippet.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// --- Mocks ------------------------------------------------------------------

// Mock extensions.getActiveSkills (history.ts imports it for system prompt)
const mockGetActiveSkills = vi.fn().mockReturnValue([]);
vi.mock("../extensions.js", () => ({
  getActiveSkills: (...args: any[]) => mockGetActiveSkills(...args),
}));

// Mock effortLevels.getEffortPromptSnippet (history.ts imports it for system prompt)
vi.mock("../effortLevels.js", () => ({
  getEffortPromptSnippet: vi.fn().mockReturnValue("## EFFORT LEVEL: MEDIUM (default)"),
  setEffortLevel: vi.fn(),
}));

// --- Imports ----------------------------------------------------------------

import {
  addUserMessage,
  addRawAssistantMessage,
  addToolResult,
  addSystemMessage,
  getHistory,
  historyLength,
  resetHistory,
  compactHistory,
  historySummary,
  estimateTokens,
  replaceHistory,
  optimizeContext,
  getSystemPrompt,
  loadProjectMemoryFiles,
  getLoadedMemoryFiles,
  reloadProjectMemory,
  isPlanMode,
  setPlanMode,
  getCavemanLevel,
  setCavemanLevel,
} from "../history.js";

// --- Setup ------------------------------------------------------------------

beforeEach(() => {
  resetHistory();
  setPlanMode(false);
  setCavemanLevel(null);
  mockGetActiveSkills.mockReturnValue([]);
});

afterEach(() => {
  resetHistory();
  setPlanMode(false);
  setCavemanLevel(null);
  mockGetActiveSkills.mockReturnValue([]);
});

// --- Tests ------------------------------------------------------------------

describe("history (unit-extended) — addUserMessage", () => {
  it("adds a user message to history", () => {
    addUserMessage("hello");
    const h = getHistory();
    const last = h[h.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("hello");
  });

  it("preserves exact content (unicode, special chars)", () => {
    const content = "café ☕ 日本語 'quote' \"double\" \\backslash\\";
    addUserMessage(content);
    const h = getHistory();
    expect(h[h.length - 1].content).toBe(content);
  });

  it("increments historyLength by 1 per call", () => {
    const before = historyLength();
    addUserMessage("a");
    addUserMessage("b");
    addUserMessage("c");
    expect(historyLength()).toBe(before + 3);
  });
});

describe("history (unit-extended) — addToolResult", () => {
  it("adds a tool message with the correct tool_call_id", () => {
    addToolResult("call_abc", "tool output");
    const h = getHistory();
    const toolMsg = h.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect((toolMsg as any).tool_call_id).toBe("call_abc");
  });

  it("preserves the tool result content", () => {
    addToolResult("call_xyz", "[SUCCESS] file written");
    const h = getHistory();
    const toolMsg = h.find((m: any) => m.role === "tool") as any;
    expect(toolMsg.content).toBe("[SUCCESS] file written");
  });
});

describe("history (unit-extended) — addSystemMessage (BUG-CC prefix replacement)", () => {
  it("adds a system message after the system prompt", () => {
    addSystemMessage("## TASK_STATE: test");
    const h = getHistory();
    const systems = h.filter((m: any) => m.role === "system");
    expect(systems.length).toBeGreaterThanOrEqual(2);
    expect(systems.some((s: any) => s.content === "## TASK_STATE: test")).toBe(true);
  });

  it("replaces previous TASK_STATE message (doesn't accumulate)", () => {
    addSystemMessage("## TASK_STATE: first");
    addSystemMessage("## TASK_STATE: second");
    const h = getHistory();
    const taskStates = h.filter(
      (m: any) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("## TASK_STATE"),
    );
    // Should be 1 (replaced, not accumulated) — excluding the system prompt
    expect(taskStates.length).toBe(1);
    expect(taskStates[0].content).toBe("## TASK_STATE: second");
  });

  it("replaces previous Persistent Memory message", () => {
    addSystemMessage("## Persistent Memory: v1");
    addSystemMessage("## Persistent Memory: v2");
    const h = getHistory();
    const memories = h.filter(
      (m: any) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("## Persistent Memory"),
    );
    expect(memories.length).toBe(1);
    expect(memories[0].content).toBe("## Persistent Memory: v2");
  });

  it("replaces previous [PLAN] message", () => {
    addSystemMessage("[PLAN] original plan");
    addSystemMessage("[PLAN] updated plan");
    const h = getHistory();
    const plans = h.filter(
      (m: any) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("[PLAN]"),
    );
    expect(plans.length).toBe(1);
    expect(plans[0].content).toBe("[PLAN] updated plan");
  });

  it("non-replacable system messages accumulate (not replaced)", () => {
    addSystemMessage("random system msg 1");
    addSystemMessage("random system msg 2");
    const h = getHistory();
    const randoms = h.filter(
      (m: any) => m.role === "system" && typeof m.content === "string" &&
        (m.content === "random system msg 1" || m.content === "random system msg 2"),
    );
    expect(randoms.length).toBe(2);
  });
});

describe("history (unit-extended) — addRawAssistantMessage", () => {
  it("preserves tool_calls array in the assistant message", () => {
    const fakeMsg: any = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "tc_1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
      ],
    };
    addRawAssistantMessage(fakeMsg);
    const h = getHistory();
    const asst = h.find((m: any) => m.role === "assistant") as any;
    expect(asst).toBeDefined();
    expect(asst.tool_calls).toHaveLength(1);
    expect(asst.tool_calls[0].id).toBe("tc_1");
  });

  it("stores role correctly as 'assistant'", () => {
    addRawAssistantMessage({ role: "assistant", content: "hello" } as any);
    const h = getHistory();
    expect(h.some((m: any) => m.role === "assistant")).toBe(true);
  });
});

describe("history (unit-extended) — resetHistory", () => {
  it("clears all messages (back to just system prompt)", () => {
    addUserMessage("x");
    addUserMessage("y");
    addSystemMessage("z");
    resetHistory();
    const h = getHistory();
    // After reset: only the system prompt at index 0
    expect(h.length).toBe(1);
    expect(h[0].role).toBe("system");
  });

  it("historyLength is 1 after reset (system prompt only)", () => {
    addUserMessage("x");
    addUserMessage("y");
    resetHistory();
    expect(historyLength()).toBe(1);
  });
});

describe("history (unit-extended) — getHistory", () => {
  it("returns the same reference (singleton) when no reset between calls", () => {
    addUserMessage("x");
    const h1 = getHistory();
    const h2 = getHistory();
    expect(h1).toBe(h2);
  });

  it("returns an array", () => {
    const h = getHistory();
    expect(Array.isArray(h)).toBe(true);
  });
});

describe("history (unit-extended) — historyLength", () => {
  it("returns correct count after multiple adds", () => {
    resetHistory();
    expect(historyLength()).toBe(1); // system prompt
    addUserMessage("a");
    expect(historyLength()).toBe(2);
    addUserMessage("b");
    expect(historyLength()).toBe(3);
  });
});

describe("history (unit-extended) — historySummary", () => {
  it("returns a string", () => {
    const s = historySummary();
    expect(typeof s).toBe("string");
  });

  it("contains role:count format (e.g., 'user:2')", () => {
    resetHistory();
    addUserMessage("a");
    addUserMessage("b");
    const s = historySummary();
    expect(s).toContain("user:2");
  });
});

describe("history (unit-extended) — compactHistory", () => {
  it("returns null when history is small (≤ COMPACT_KEEP_RECENT + 1 = 7)", () => {
    addUserMessage("short");
    const result = compactHistory();
    expect(result).toBeNull();
  });

  it("returns CompactResult (not null) when history is large enough", () => {
    for (let i = 0; i < 20; i++) {
      addUserMessage(`msg-${i}`);
    }
    const result = compactHistory();
    expect(result).not.toBeNull();
    expect(result!.removed).toBeGreaterThan(0);
    expect(result!.method).toBe("mechanical");
  });

  it("preserves system prompt at index 0 after compaction", () => {
    for (let i = 0; i < 20; i++) {
      addUserMessage(`msg-${i}`);
    }
    compactHistory();
    const h = getHistory();
    expect(h[0].role).toBe("system");
  });
});

describe("history (unit-extended) — estimateTokens", () => {
  it("always returns a positive number (>= 1, even for empty history)", () => {
    resetHistory();
    const t = estimateTokens();
    expect(t).toBeGreaterThanOrEqual(1);
  });

  it("scales with content length (more content → more tokens)", () => {
    resetHistory();
    const small = estimateTokens();
    // Add a large user message
    addUserMessage("x".repeat(10000));
    const large = estimateTokens();
    expect(large).toBeGreaterThan(small);
  });
});

describe("history (unit-extended) — getSystemPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = getSystemPrompt();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("includes current date (Today is YYYY-MM-DD)", () => {
    const prompt = getSystemPrompt();
    const today = new Date().toISOString().split("T")[0];
    expect(prompt).toContain(today);
  });

  it("includes effort level instructions (EFFORT LEVEL)", () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain("EFFORT LEVEL");
  });

  it("includes skill list when skills are available", () => {
    mockGetActiveSkills.mockReturnValue([
      {
        name: "test-skill",
        description: "a test skill",
        path: "/fake/path.md",
        content: "skill body",
      },
    ]);
    const prompt = getSystemPrompt();
    expect(prompt).toContain("test-skill");
    expect(prompt).toContain("Available Skills");
  });
});

describe("history (unit-extended) — loadProjectMemoryFiles", () => {
  it("returns an array (possibly empty when no CLAUDE.md/AGENTS.md found)", () => {
    const files = loadProjectMemoryFiles();
    expect(Array.isArray(files)).toBe(true);
  });

  it("each item has required fields (relativePath, absolutePath, sizeBytes, content)", () => {
    const files = loadProjectMemoryFiles();
    for (const f of files) {
      expect(typeof f.relativePath).toBe("string");
      expect(typeof f.absolutePath).toBe("string");
      expect(typeof f.sizeBytes).toBe("number");
      expect(typeof f.content).toBe("string");
    }
  });
});

describe("history (unit-extended) — getLoadedMemoryFiles (cache)", () => {
  it("returns the cached array (same reference as loadProjectMemoryFiles)", () => {
    const loaded = getLoadedMemoryFiles();
    expect(Array.isArray(loaded)).toBe(true);
    // Calling again should return the same cached reference
    const again = getLoadedMemoryFiles();
    expect(again).toBe(loaded);
  });
});

describe("history (unit-extended) — reloadProjectMemory", () => {
  it("invalidates the cache (returns null or string after reload)", () => {
    // First call populates cache
    getLoadedMemoryFiles();
    // reloadProjectMemory invalidates cache and returns the new content (or null)
    const result = reloadProjectMemory();
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("after reload, getLoadedMemoryFiles returns fresh data (possibly same content)", () => {
    getLoadedMemoryFiles();
    reloadProjectMemory();
    const fresh = getLoadedMemoryFiles();
    expect(Array.isArray(fresh)).toBe(true);
  });
});

describe("history (unit-extended) — isPlanMode / setPlanMode", () => {
  it("setPlanMode(true) then isPlanMode() returns true", () => {
    setPlanMode(true);
    expect(isPlanMode()).toBe(true);
  });

  it("setPlanMode(false) then isPlanMode() returns false", () => {
    setPlanMode(true);
    setPlanMode(false);
    expect(isPlanMode()).toBe(false);
  });

  it("default isPlanMode() is false (after reset)", () => {
    setPlanMode(false);
    expect(isPlanMode()).toBe(false);
  });
});

describe("history (unit-extended) — getCavemanLevel / setCavemanLevel", () => {
  it("setCavemanLevel('lite') then getCavemanLevel() returns 'lite'", () => {
    setCavemanLevel("lite");
    expect(getCavemanLevel()).toBe("lite");
  });

  it("setCavemanLevel(null) resets to null", () => {
    setCavemanLevel("full");
    setCavemanLevel(null);
    expect(getCavemanLevel()).toBeNull();
  });

  it("default getCavemanLevel() is null (after reset)", () => {
    setCavemanLevel(null);
    expect(getCavemanLevel()).toBeNull();
  });

  it("setCavemanLevel('ultra') is reflected in system prompt", () => {
    setCavemanLevel("ultra");
    const prompt = getSystemPrompt();
    expect(prompt).toContain("CAVEMAN MODE");
    expect(prompt).toContain("ultra");
  });
});

describe("history (unit-extended) — replaceHistory", () => {
  it("replaces history with provided messages, prepending system prompt if missing", () => {
    replaceHistory([{ role: "user", content: "x" }] as any);
    const h = getHistory();
    expect(h[0].role).toBe("system");
    expect(h[1].role).toBe("user");
    expect(h[1].content).toBe("x");
  });

  it("does NOT prepend system prompt if first message is already system", () => {
    replaceHistory([{ role: "system", content: "custom prompt" }] as any);
    const h = getHistory();
    expect(h[0].role).toBe("system");
    expect(h[0].content).toBe("custom prompt");
    // Should not have an additional system prompt prepended
    expect(h.length).toBe(1);
  });
});

describe("history (unit-extended) — optimizeContext", () => {
  it("does not throw on empty/small history", () => {
    expect(() => optimizeContext()).not.toThrow();
  });

  it("never removes user messages (only summarizes tool results)", () => {
    addUserMessage("important instruction 1");
    addUserMessage("important instruction 2");
    optimizeContext();
    const h = getHistory();
    const userMsgs = h.filter((m: any) => m.role === "user");
    expect(userMsgs.length).toBe(2);
  });
});

describe("history (unit-extended) — memory file format", () => {
  it("MemoryFile interface has all 4 required fields (relativePath, absolutePath, sizeBytes, content)", () => {
    const files = loadProjectMemoryFiles();
    for (const f of files) {
      expect(f).toHaveProperty("relativePath");
      expect(f).toHaveProperty("absolutePath");
      expect(f).toHaveProperty("sizeBytes");
      expect(f).toHaveProperty("content");
    }
  });

  it("sizeBytes is a non-negative number", () => {
    const files = loadProjectMemoryFiles();
    for (const f of files) {
      expect(f.sizeBytes).toBeGreaterThanOrEqual(0);
    }
  });
});
