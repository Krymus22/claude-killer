/**
 * sidequest.test.tsx — Testes para o sidequest (mensagens durante processamento).
 */

import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { ChatDisplay, ChatMessage } from "../tui/ChatDisplay.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
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
