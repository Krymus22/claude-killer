/**
 * sidequest.test.tsx — Testes para o sidequest (mensagens durante processamento).
 *
 * Cobertura:
 *   1. ChatDisplay rendering (mensagens com isSidequest=true)
 *   2. ChatMessage interface (isSidequest opcional)
 *   3. App-level regression tests (handleSubmit + finally block injection):
 *      - stale-closure fix (sidequestsRef)
 *      - while-loop para sidequests aninhadas
 *      - ausência de duplicate user message
 *      - typo SIDEPQUEST → SIDEQUEST
 *      - slash command bloqueado com system message
 *      - error handling no sidequest injection
 *      - isProcessing permanece true durante sidequest processing
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ChatDisplay, ChatMessage } from "../tui/ChatDisplay.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── Mocks para App-level tests ────────────────────────────────────────────
// Estes mocks só afetam módulos importados por App.tsx; ChatDisplay (usado
// pelos testes de render acima) não depende deles, então continuam funcionando.

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn() },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com", model: "test-model",
    contextWindowTokens: 256000, contextWarnThreshold: 0.6, contextCompactThreshold: 0.75,
    costPerKPrompt: 0.01, costPerKCompletion: 0.03, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(async () => {}), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

vi.mock("../extensionCenter.js", () => ({
  getAllExtensions: vi.fn(() => []),
  getExtensionsByCategory: vi.fn(() => []),
  getHubSummary: vi.fn(() => ({ total: 0, enabled: 0, byCategory: {} })),
  toggleExtension: vi.fn(),
  getTriggerLabel: vi.fn(() => ""),
  getTriggerModes: vi.fn(() => []),
  cycleTriggerMode: vi.fn(),
  setTriggerMode: vi.fn(),
  getCategoryIcon: vi.fn(() => ""),
  discoverExtensions: vi.fn(),
  executeTrigger: vi.fn(() => Promise.resolve()),
  subscribeToHubChanges: vi.fn((_l: () => void) => () => {}),
  getHubVersion: vi.fn(() => 0),
}));

vi.mock("../modes.js", () => ({
  getAllModes: vi.fn(() => []),
  getActiveModeName: vi.fn(() => null),
  getActiveMode: vi.fn(() => null),
  getMode: vi.fn(() => null),
  applyMode: vi.fn(async () => ({ success: true })),
  deactivateMode: vi.fn(),
  subscribeToModesChanges: vi.fn((_l: () => void) => () => {}),
  getModesVersion: vi.fn(() => 0),
  suggestMode: vi.fn(() => null),
  confirmAndSaveMode: vi.fn(async () => true),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortLevel: vi.fn(() => "medium"),
  setEffortLevel: vi.fn(),
  getEffortLabel: vi.fn(() => "MEDIUM"),
}));

vi.mock("../apiKeyPool.js", () => ({
  getPoolSize: vi.fn(() => 1),
  formatPoolStats: vi.fn(() => ""),
}));

vi.mock("../i18n.js", () => ({
  getLocalizedSlashCommands: vi.fn(() => []),
  getCommandI18n: vi.fn(() => ({})),
  detectLanguage: vi.fn(() => "pt"),
  setLanguage: vi.fn(),
  resetLanguageCache: vi.fn(),
}));

vi.mock("../history.js", () => ({
  isPlanMode: vi.fn(() => false),
  setPlanMode: vi.fn(),
  resetHistory: vi.fn(),
  getHistory: vi.fn(() => []),
  addUserMessage: vi.fn(),
  addRawAssistantMessage: vi.fn(),
  addToolResult: vi.fn(),
  addSystemMessage: vi.fn(),
  historySummary: vi.fn(() => ""),
  historyLength: vi.fn(() => 0),
  compactHistory: vi.fn(() => null),
  getCavemanLevel: vi.fn(() => null),
  setCavemanLevel: vi.fn(),
  reloadProjectMemory: vi.fn(() => null),
}));

vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => ({ getAll: vi.fn(() => []), getByCategory: vi.fn(() => []), isInstalled: vi.fn(() => false), addTool: vi.fn(), get: vi.fn() })),
  getDetector: vi.fn(() => ({ detect: vi.fn(() => ({ intent: null, context: [] })), detectFromContext: vi.fn(() => []) })),
  getExecutor: vi.fn(() => ({ execute: vi.fn() })),
  getSuggester: vi.fn(() => ({ suggest: vi.fn(() => []) })),
  initializeTools: vi.fn(async () => {}),
}));

vi.mock("../agent.js", () => ({
  runAgentLoop: vi.fn(async () => "mocked response"),
}));

vi.mock("../todo.js", () => ({
  resetTodo: vi.fn(),
  renderTodoBar: vi.fn(() => ""),
  getTodos: vi.fn(() => []),
}));

vi.mock("../memory.js", () => ({
  getMemoryConfig: vi.fn(() => ({})),
  runDream: vi.fn(async () => ({ reviewedSessions: 0, extractedSkills: 0, deduplicatedEntries: 0 })),
  runDistill: vi.fn(async () => ({ skillsExtracted: 0 })),
}));

vi.mock("../session.js", () => ({
  startSession: vi.fn(() => "test-session"),
  appendMessage: vi.fn(),
  getLastSession: vi.fn(() => null),
  loadSessionMessages: vi.fn(() => []),
  setActiveSession: vi.fn(),
  getActiveSessionId: vi.fn(() => null),
  listSessions: vi.fn(() => []),
  deleteSession: vi.fn(() => true),
  renameSession: vi.fn(() => true),
}));

vi.mock("../gracefulShutdown.js", () => ({ registerShutdownHandlers: vi.fn() }));
vi.mock("../configSeeder.js", () => ({ seedUserConfig: vi.fn() }));
vi.mock("../toolUpdater.js", () => ({ performUpdateCheck: vi.fn(async () => ({})) }));
vi.mock("../readBeforeWrite.js", () => ({ clearReadPaths: vi.fn() }));

// Imports AFTER mocks — App.tsx carrega todos os módulos acima.
import { runAgentLoop } from "../agent.js";
import { App } from "../tui/App.js";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Sidequest — ChatDisplay rendering", () => {
  it("renders sidequest with ⚡ label and muted color", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "sobe o servidor do rojo", isSidequest: true },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("⚡");
    expect(out).toContain("sidequest");
    expect(out).toContain("sobe o servidor do rojo");
  });

  it("renders normal user message with 'you:' label (not sidequest)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "mensagem normal" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("you:");
    expect(out).toContain("mensagem normal");
    expect(out).not.toContain("sidequest");
  });

  it("renders both normal and sidequest messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "cria um arquivo" },
      { role: "assistant", content: "Criando..." },
      { role: "user", content: "também sobe o servidor", isSidequest: true },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("you:");
    expect(out).toContain("cria um arquivo");
    expect(out).toContain("Criando");
    expect(out).toContain("⚡");
    expect(out).toContain("sobe o servidor");
  });

  it("sidequest with isSidequest=false renders as normal", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "normal", isSidequest: false },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("you:");
    expect(out).not.toContain("sidequest");
  });

  it("multiple sidequests all render with ⚡", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "sq1", isSidequest: true },
      { role: "user", content: "sq2", isSidequest: true },
      { role: "user", content: "sq3", isSidequest: true },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("sq1");
    expect(out).toContain("sq2");
    expect(out).toContain("sq3");
    // Should have 3 ⚡ symbols
    const lightningCount = (out.match(/⚡/g) || []).length;
    expect(lightningCount).toBe(3);
  });
});

describe("Sidequest — ChatMessage interface", () => {
  it("isSidequest is optional (defaults to undefined/false)", () => {
    const msg: ChatMessage = { role: "user", content: "test" };
    expect(msg.isSidequest).toBeUndefined();
  });

  it("isSidequest can be set to true", () => {
    const msg: ChatMessage = { role: "user", content: "test", isSidequest: true };
    expect(msg.isSidequest).toBe(true);
  });

  it("isSidequest can be set to false", () => {
    const msg: ChatMessage = { role: "user", content: "test", isSidequest: false };
    expect(msg.isSidequest).toBe(false);
  });
});

// ─── App-level regression tests ─────────────────────────────────────────────
//
// Estes testes exercitam o handleSubmit + finally block do App.tsx, focando
// nos bugs de sidequest injection. Seguindo §16.4, mockamos runAgentLoop
// (não testamos wiring end-to-end).

describe("Sidequest — App handleSubmit regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runAgentLoop).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sidequest queued during processing IS processed (stale-closure fix)", async () => {
    // BUG FIX (sidequest-stale-closure): previously the finally block read the
    // `sidequests` STATE, which was captured at handleSubmit memoization time
    // (always `[]`), so the injection NEVER fired. With the ref-based fix,
    // the sidequest MUST be processed (runAgentLoop called a second time).
    //
    // Without the fix: runAgentLoop called once (only for "task").
    // With the fix:    runAgentLoop called twice (for "task" + sidequest).
    vi.mocked(runAgentLoop).mockImplementation(
      async (input: string) => {
        // Simulate some processing time so the user can queue a sidequest
        // while the first call is in flight.
        await delay(200);
        return `response-for:${input.slice(0, 20)}`;
      },
    );

    const { stdin, lastFrame } = render(<App />);
    // Submit the original task.
    stdin.write("task A");
    await delay(30);
    stdin.write("\r");
    // While processing, queue a sidequest.
    await delay(60);
    stdin.write("sidequest B");
    await delay(30);
    stdin.write("\r");
    // Wait for both runAgentLoop calls + React re-render.
    await delay(700);

    // runAgentLoop MUST have been called twice.
    expect(runAgentLoop).toHaveBeenCalledTimes(2);
    // First call: the original task.
    expect(vi.mocked(runAgentLoop).mock.calls[0]?.[0]).toBe("task A");
    // Second call: the sidequest batch, containing "sidequest B".
    const secondInput = vi.mocked(runAgentLoop).mock.calls[1]?.[0] ?? "";
    expect(secondInput).toContain("sidequest B");
    // The second call MUST contain the corrected typo "SIDEQUEST" (not "SIDEPQUEST").
    expect(secondInput).toContain("SIDEQUEST");
    expect(secondInput).not.toContain("SIDEPQUEST");

    // The sidequest text MUST appear in the rendered chat (as ⚡ sidequest).
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("sidequest B");
    // The sidequest response MUST be visible too.
    expect(out).toContain("response-for:");
  });

  it("multiple sidequests queued quickly are ALL captured in one batch", async () => {
    // Race-condition regression: two sidequests submitted in quick succession
    // during processing must BOTH be captured. Without the ref fix, neither
    // would be; with a single `if` (no loop), both would be in one batch.
    vi.mocked(runAgentLoop).mockImplementation(
      async (input: string) => {
        await delay(300);
        return `resp:${input.length}`;
      },
    );

    const { stdin } = render(<App />);
    stdin.write("task");
    await delay(30);
    stdin.write("\r");
    await delay(60);
    // Queue two sidequests quickly (both during the 300ms processing window).
    stdin.write("sq1");
    await delay(20);
    stdin.write("\r");
    await delay(20);
    stdin.write("sq2");
    await delay(20);
    stdin.write("\r");
    await delay(700);

    // Two runAgentLoop calls: one for "task", one for the sidequest batch.
    expect(runAgentLoop).toHaveBeenCalledTimes(2);
    const sidequestInput = vi.mocked(runAgentLoop).mock.calls[1]?.[0] ?? "";
    expect(sidequestInput).toContain("sq1");
    expect(sidequestInput).toContain("sq2");
  });

  it("sidequest text is NOT duplicated (no second 'you:' message)", async () => {
    // BUG FIX (duplicate-sidequest-message): previously the finally block
    // re-added the sidequest text to `messages` as a normal user message,
    // so the same text appeared TWICE (once as ⚡ sidequest, once as "you:").
    // Now the finally block only injects into history (addUserMessage), not
    // into the visual messages list.
    vi.mocked(runAgentLoop).mockImplementation(async () => {
      await delay(200);
      return "ok";
    });

    const { stdin, lastFrame } = render(<App />);
    stdin.write("task");
    await delay(30);
    stdin.write("\r");
    await delay(60);
    stdin.write("UNIQUE_SIDEQUEST_TEXT");
    await delay(30);
    stdin.write("\r");
    await delay(600);

    const out = stripAnsi(lastFrame() ?? "");
    // The sidequest text MUST appear exactly ONCE in the output.
    const occurrences = (out.match(/UNIQUE_SIDEQUEST_TEXT/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it("slash command during processing is blocked with a system message", async () => {
    // Bug fix (sidequest-silent-drop): previously slash commands during
    // processing were silently dropped. Now a system message is shown.
    vi.mocked(runAgentLoop).mockImplementation(async () => {
      await delay(200);
      return "done";
    });

    const { stdin, lastFrame } = render(<App />);
    stdin.write("task");
    await delay(30);
    stdin.write("\r");
    await delay(60);
    stdin.write("/help");
    await delay(30);
    stdin.write("\r");
    await delay(500);

    const out = stripAnsi(lastFrame() ?? "");
    // The slash command MUST NOT have been executed (only one runAgentLoop
    // call for the original task).
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    // A system message about the ignored command MUST be visible.
    expect(out).toContain("ignorado");
  });

  it("sidequest error is shown and remaining sidequests are cleared (no cascade)", async () => {
    // Error handling: if runStreaming throws during sidequest injection,
    // the error MUST be shown, the loop MUST break, and isProcessing MUST
    // be reset to false (so the user can submit again).
    let callCount = 0;
    vi.mocked(runAgentLoop).mockImplementation(async () => {
      callCount++;
      await delay(200);
      if (callCount === 1) return "original-response";
      // Second call (sidequest) throws.
      throw new Error("API_FAILED_SIDEQUEST");
    });

    const { stdin, lastFrame } = render(<App />);
    stdin.write("task");
    await delay(30);
    stdin.write("\r");
    await delay(60);
    stdin.write("sq that will fail");
    await delay(30);
    stdin.write("\r");
    await delay(700);

    const out = stripAnsi(lastFrame() ?? "");
    // The original response MUST be visible.
    expect(out).toContain("original-response");
    // The sidequest error MUST be visible (inner catch — "Sidequest error").
    expect(out).toContain("Sidequest error");
    expect(out).toContain("API_FAILED_SIDEQUEST");
    // runAgentLoop called exactly twice (original + failed sidequest), not
    // more — the loop broke on error.
    expect(runAgentLoop).toHaveBeenCalledTimes(2);
  });

  it("sidequest during sidequest processing is also processed (while-loop)", async () => {
    // Race-condition regression: the user can queue a sidequest WHILE the
    // sidequest injection is running (isProcessing stays true throughout
    // the finally block). The while-loop MUST pick up the new sidequest
    // in the next iteration.
    let callCount = 0;
    const secondCallStarted: { current: boolean } = { current: false };
    vi.mocked(runAgentLoop).mockImplementation(async (input: string) => {
      callCount++;
      await delay(200);
      if (callCount === 2) {
        // Signal that the second call (sidequest batch 1) has started.
        secondCallStarted.current = true;
      }
      return `resp-${callCount}:${input.slice(0, 10)}`;
    });

    const { stdin } = render(<App />);
    stdin.write("task");
    await delay(30);
    stdin.write("\r");
    await delay(60);
    // Queue first sidequest.
    stdin.write("sq-alpha");
    await delay(20);
    stdin.write("\r");

    // Wait for the original task to finish and the first sidequest batch to
    // start processing. We poll until the second runAgentLoop call begins.
    for (let i = 0; i < 40 && !secondCallStarted.current; i++) {
      await delay(20);
    }
    // Now queue a second sidequest DURING the first sidequest's processing.
    stdin.write("sq-beta");
    await delay(20);
    stdin.write("\r");
    await delay(700);

    // runAgentLoop MUST have been called 3 times:
    //   1. original "task"
    //   2. sidequest batch 1 (sq-alpha)
    //   3. sidequest batch 2 (sq-beta) — picked up by the while-loop
    expect(runAgentLoop).toHaveBeenCalledTimes(3);
    const thirdInput = vi.mocked(runAgentLoop).mock.calls[2]?.[0] ?? "";
    expect(thirdInput).toContain("sq-beta");
  });
});
