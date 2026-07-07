/**
 * session-visual-conversion.test.tsx — Tests for convertSessionToVisualMessages.
 *
 * BUG FIX (thinking-vazando): Regression test for the session-reload thinking
 * leak. Previously, tool results loaded from the session file used the literal
 * string "tool" as toolName (because the session file only stores tool_call_id,
 * not the name). This meant the ChatDisplay filter that hides `pensar` tool
 * results never matched during session reload, causing thinking content to
 * leak into the visible chat.
 *
 * The fix builds a tool_call_id → toolName lookup from assistant tool_calls
 * and resolves the real tool name for each tool result. These tests verify:
 *   - toolName is correctly resolved from tool_call_id
 *   - pensar tool results get toolName="pensar" (so the filter catches them)
 *   - other tools are unaffected
 */

import { describe, it, expect } from "vitest";
import { convertSessionToVisualMessages } from "../tui/App.js";
import type { ChatMessage } from "../tui/ChatDisplay.js";

describe("convertSessionToVisualMessages — toolName resolution (thinking-vazando fix)", () => {
  it("resolve toolName do tool_call_id para tool results", () => {
    // Session file format: assistant has tool_calls with id+name,
    // tool result only has tool_call_id (no name).
    const sessionMsgs = [
      { role: "user", content: "lê o arquivo" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc123",
            type: "function",
            function: { name: "ler_arquivo", arguments: '{"path":"/tmp/test.txt"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_abc123", content: "conteúdo do arquivo" },
    ];

    const visual = convertSessionToVisualMessages(sessionMsgs);
    // Find the tool result (isResult=true)
    const toolResult = visual.find((m) => m.role === "tool" && m.isResult);
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolName).toBe("ler_arquivo"); // not "tool"!
  });

  it("pensar tool results ficam com toolName=pensar (filtro do ChatDisplay pega)", () => {
    // This is the CORE regression test for the thinking leak.
    // Before the fix, toolName was "tool" → filter `msg.toolName === "pensar"`
    // never matched → thinking content leaked into visible chat on session reload.
    const sessionMsgs = [
      { role: "user", content: "pensa nisso" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_think_1",
            type: "function",
            function: { name: "pensar", arguments: '{"pensamento":"preciso analisar..."}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_think_1", content: "[THINK] ✓ Pensamento registrado" },
    ];

    const visual = convertSessionToVisualMessages(sessionMsgs);
    const toolResult = visual.find((m) => m.role === "tool" && m.isResult);
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolName).toBe("pensar"); // NOW the filter will catch it
  });

  it("think alias também é resolvido corretamente", () => {
    // If the model called "think" instead of "pensar", the session file
    // stores function.name="think". The converter should preserve it
    // so the ChatDisplay filter (which now checks both "pensar" and "think")
    // catches it.
    const sessionMsgs = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_think_alias",
            type: "function",
            function: { name: "think", arguments: '{"pensamento":"..."}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_think_alias", content: "[THINK] ✓" },
    ];

    const visual = convertSessionToVisualMessages(sessionMsgs);
    const toolResult = visual.find((m) => m.role === "tool" && m.isResult);
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolName).toBe("think");
  });

  it("múltiplas tools com IDs diferentes — cada uma resolve seu próprio nome", () => {
    const sessionMsgs = [
      { role: "user", content: "faz várias coisas" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "pensar", arguments: "{}" } },
          { id: "c3", type: "function", function: { name: "executar_comando", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "arquivo..." },
      { role: "tool", tool_call_id: "c2", content: "[THINK]" },
      { role: "tool", tool_call_id: "c3", content: "output..." },
    ];

    const visual = convertSessionToVisualMessages(sessionMsgs);
    const results = visual.filter((m) => m.role === "tool" && m.isResult);
    expect(results).toHaveLength(3);
    expect(results[0]!.toolName).toBe("ler_arquivo");
    expect(results[1]!.toolName).toBe("pensar");
    expect(results[2]!.toolName).toBe("executar_comando");
  });

  it("tool result sem tool_call_id correspondente usa fallback 'tool'", () => {
    // Edge case: orphan tool result (shouldn't happen normally, but defensive)
    const sessionMsgs = [
      { role: "tool", tool_call_id: "orphan_id", content: "no matching call" },
    ];
    const visual = convertSessionToVisualMessages(sessionMsgs);
    const toolResult = visual.find((m) => m.role === "tool" && m.isResult);
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolName).toBe("tool"); // fallback
  });

  it("explode tool_calls do assistant em visual tool call messages", () => {
    const sessionMsgs = [
      {
        role: "assistant",
        content: "Vou ler o arquivo",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "ler_arquivo", arguments: '{"path":"x"}' } },
        ],
      },
    ];
    const visual = convertSessionToVisualMessages(sessionMsgs);
    // Should have: [assistant text] + [tool call (not result)]
    expect(visual).toHaveLength(2);
    expect(visual[0]).toMatchObject({ role: "assistant", content: "Vou ler o arquivo" });
    expect(visual[1]).toMatchObject({
      role: "tool",
      toolName: "ler_arquivo",
      isResult: false,
    });
  });
});
