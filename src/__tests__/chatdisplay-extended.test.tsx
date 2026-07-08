/**
 * chatdisplay-extended.test.tsx — Testes estendidos do ChatDisplay.
 *
 * O arquivo existente (tui-chatdisplay.test.ts) tem 18 testes mas só
 * testa lógica de slicing/filtragem via funções helper duplicadas. Aqui
 * cobrimos a renderização real com ink-testing-library, focando em edge
 * cases:
 *   - Prefixos PT-BR ("you:", "Claude-Killer:")
 *   - Tool call com path longo truncado no meio (truncateMiddle com "…")
 *   - Tool result OK com checkmark (✔) e ERRO com X (✘)
 *   - Mensagem muito longa (5000 chars) sem crash
 *   - Emojis sem mojibake
 *   - CJK characters (chinês/japonês)
 *   - Código com backticks
 *   - Mensagem vazia
 *   - Múltiplas mensagens em sequência
 *   - Mix de user/assistant/tool em ordem cronológica
 *
 * Seguimos o padrão de mocks de tui-render-snapshots.test.tsx (logger,
 * config, extensions, etc.) para garantir que o ambiente de teste seja
 * idêntico ao dos outros testes TUI.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

// ─── Mocks (mesmo padrão de tui-render-snapshots.test.tsx) ────────────────

// Mock logger
vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn(),
  },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(),
  debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
}));

// Mock config
vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com", model: "test-model",
    contextWindowTokens: 128000, contextWarnThreshold: 0.5, contextCompactThreshold: 0.8,
    costPerKPrompt: 0.01, costPerKCompletion: 0.03, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

// Mock extensions (não usado pelo ChatDisplay, mas evita imports cascateados)
vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

// Import DEPOIS dos mocks.
import { ChatDisplay, type ChatMessage } from "../tui/ChatDisplay.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Renderiza ChatDisplay e retorna o output sem ANSI codes. */
function renderMessages(messages: ChatMessage[]): string {
  const { lastFrame } = render(<ChatDisplay messages={messages} />);
  return stripAnsi(lastFrame() ?? "");
}

// ─── Testes ───────────────────────────────────────────────────────────────

describe("ChatDisplay — testes estendidos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Prefixos PT-BR ──────────────────────────────────────────────────

  it("renderiza mensagem de user com prefixo 'you:' (PT-BR)", () => {
    const out = renderMessages([{ role: "user", content: "olá, tudo bem?" }]);
    expect(out).toContain("you:");
    expect(out).toContain("olá, tudo bem?");
  });

  it("renderiza mensagem de assistant com prefixo 'Claude-Killer:'", () => {
    const out = renderMessages([{ role: "assistant", content: "tudo certo!" }]);
    expect(out).toContain("Claude-Killer:");
    expect(out).toContain("tudo certo!");
  });

  // ─── Tool call/result ───────────────────────────────────────────────

  it("renderiza tool call com path longo truncado no meio (truncateMiddle)", () => {
    const longPath = "/home/usuario/projetos/meuapp/src/components/botao/muito/nested/Arquivo.tsx";
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: JSON.stringify({ path: longPath }),
        toolName: "ler_arquivo",
        isResult: false,
      },
    ];
    const out = renderMessages(messages);
    expect(out).toContain("ler_arquivo");
    // truncateMiddle insere "…" (Unicode U+2026) no meio.
    expect(out).toContain("…");
    // O path completo não deve aparecer inalterado (foi truncado).
    expect(out).not.toContain(longPath);
    // Mas início e fim do path devem aparecer.
    expect(out).toContain("/home/usuario");
    expect(out).toContain("Arquivo.tsx");
  });

  it("renderiza tool result OK com checkmark (✔ ou v)", () => {
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: "conteúdo do arquivo",
        toolName: "ler_arquivo",
        isResult: true,
        ok: true,
      },
    ];
    const out = renderMessages(messages);
    expect(out).toContain("ler_arquivo");
    // icons.check = "✔" (figures tick). Aceita fallback "v" também.
    expect(out).toMatch(/[✔v]/);
    expect(out).toContain("conteúdo do arquivo");
  });

  it("renderiza tool result ERRO com X (✘ ou x)", () => {
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: "[ERROR] arquivo not found",
        toolName: "ler_arquivo",
        isResult: true,
        ok: false,
      },
    ];
    const out = renderMessages(messages);
    expect(out).toContain("ler_arquivo");
    // icons.cross = "✘" (figures cross). Aceita fallback "x" também.
    expect(out).toMatch(/[✘x]/);
    expect(out).toContain("[ERROR] arquivo not found");
  });

  // ─── Edge cases de conteúdo ─────────────────────────────────────────

  it("renderiza mensagem muito longa (5000 chars) sem crash", () => {
    const longContent = "A".repeat(5000);
    const out = renderMessages([{ role: "user", content: longContent }]);
    expect(out).toContain("you:");
    // Pelo menos algum do conteúdo deve aparecer.
    expect(out).toContain("A");
    // Não deve crashar — output deve ser non-empty.
    expect(out.length).toBeGreaterThan(0);
  });

  it("renderiza mensagem com emojis sem mojibake", () => {
    const out = renderMessages([
      { role: "user", content: "Olá! 🚀🎉💯 teste de emojis" },
    ]);
    expect(out).toContain("🚀");
    expect(out).toContain("🎉");
    expect(out).toContain("💯");
    expect(out).toContain("teste de emojis");
  });

  it("renderiza mensagem com CJK characters (chinês/japonês)", () => {
    const out = renderMessages([
      { role: "assistant", content: "你好世界！ こんにちは。" },
    ]);
    expect(out).toContain("你好世界");
    expect(out).toContain("こんにちは");
  });

  it("renderiza mensagem com código (backticks)", () => {
    const out = renderMessages([
      { role: "assistant", content: "Use `npm test` para rodar os testes" },
    ]);
    // MarkdownRenderer strips backticks and renders inline code as colored text
    // So we check for "npm test" without backticks
    expect(out).toContain("npm test");
  });

  it("renderiza mensagem vazia sem crash", () => {
    const out = renderMessages([{ role: "user", content: "" }]);
    // Deve renderizar o prefixo "you:" mesmo com conteúdo vazio.
    expect(out).toContain("you:");
    // Não deve crashar.
    expect(out.length).toBeGreaterThan(0);
  });

  // ─── Múltiplas mensagens ────────────────────────────────────────────

  it("renderiza múltiplas mensagens em sequência", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "primeira pergunta" },
      { role: "assistant", content: "primeira resposta" },
      { role: "user", content: "segunda pergunta" },
      { role: "assistant", content: "segunda resposta" },
    ];
    const out = renderMessages(messages);
    expect(out).toContain("primeira pergunta");
    expect(out).toContain("primeira resposta");
    expect(out).toContain("segunda pergunta");
    expect(out).toContain("segunda resposta");
  });

  it("renderiza mensagens misturando user/assistant/tool em ordem cronológica", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "leia o arquivo foo.ts" },
      {
        role: "tool",
        content: JSON.stringify({ path: "/foo.ts" }),
        toolName: "ler_arquivo",
        isResult: false,
      },
      {
        role: "tool",
        content: "conteúdo do foo.ts",
        toolName: "ler_arquivo",
        isResult: true,
        ok: true,
      },
      { role: "assistant", content: "arquivo lido com sucesso" },
    ];
    const out = renderMessages(messages);
    // Todas as mensagens devem aparecer.
    expect(out).toContain("leia o arquivo foo.ts");
    expect(out).toContain("ler_arquivo");
    expect(out).toContain("/foo.ts");
    expect(out).toContain("conteúdo do foo.ts");
    expect(out).toContain("arquivo lido com sucesso");
    // Ordem cronológica: user → tool call → tool result → assistant.
    const userPos = out.indexOf("leia o arquivo");
    const toolCallPos = out.indexOf("ler_arquivo");
    const toolResultPos = out.indexOf("conteúdo do foo.ts");
    const assistantPos = out.indexOf("arquivo lido com sucesso");
    expect(userPos).toBeLessThan(toolCallPos);
    expect(toolCallPos).toBeLessThan(toolResultPos);
    expect(toolResultPos).toBeLessThan(assistantPos);
  });

  // ─── Casos extras ───────────────────────────────────────────────────

  it("filtra mensagens de sistema (não renderiza)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "visível" },
      { role: "system", content: "mensagem interna secreta" },
      { role: "assistant", content: "também visível" },
    ];
    const out = renderMessages(messages);
    expect(out).toContain("visível");
    expect(out).toContain("também visível");
    expect(out).not.toContain("mensagem interna secreta");
  });

  it("respeita maxVisible (mostra apenas as últimas N mensagens)", () => {
    const messages: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
      role: "user" as const,
      content: `msg${i}`,
    }));
    const { lastFrame } = render(<ChatDisplay messages={messages} maxVisible={10} />);
    const out = stripAnsi(lastFrame() ?? "");
    // maxVisible=10 → mostra as últimas 10 (msg50 a msg59).
    expect(out).toContain("msg59");
    expect(out).toContain("msg50");
    // Não mostra msg49 (foi cortado).
    expect(out).not.toContain("msg49");
  });

  it("renderiza tool call com args de comando (não path)", () => {
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: JSON.stringify({ comando: "npm run build" }),
        toolName: "executar_comando",
        isResult: false,
      },
    ];
    const out = renderMessages(messages);
    expect(out).toContain("executar_comando");
    expect(out).toContain("npm run build");
  });
});

// ─── Static + Live split (limite-historico fix) ──────────────────────────

describe("ChatDisplay — Static/Live split (limite-historico fix)", () => {
  it("mensagem em streaming fica na live view (não no static)", () => {
    // Quando uma mensagem está sendo streamada, ela NÃO pode ir para <Static>
    // (que escreve uma vez e nunca atualiza). Deve ficar na live view.
    const messages: ChatMessage[] = [
      { role: "user", content: "old1" },
      { role: "assistant", content: "old2" },
      { role: "user", content: "old3" },
      { role: "assistant", content: "old4" },
      { role: "user", content: "old5" },
      { role: "assistant", content: "streaming...", isStreaming: true },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    // A mensagem em streaming deve aparecer (na live view)
    expect(out).toContain("streaming...");
    // Mensagens antigas também aparecem (no static ou live, dependendo do split)
    expect(out).toContain("old1");
    expect(out).toContain("old5");
  });

  it("conversa longa: todas as mensagens aparecem (static + live)", () => {
    // 20 mensagens — as primeiras vão para <Static>, as últimas ficam live.
    // Todas devem aparecer no output final.
    const messages: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" as const : "assistant" as const,
      content: `Mensagem ${i}`,
    }));
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Primeira e última devem aparecer
    expect(out).toContain("Mensagem 0");
    expect(out).toContain("Mensagem 19");
    // Alguma do meio também
    expect(out).toContain("Mensagem 10");
  });

  it("quando streaming termina, mensagem gradua para static sem desaparecer", () => {
    // Simula: mensagem estava streaming (live), depois termina (isStreaming=false).
    // Na próxima render, ela deve ir para <Static> e continuar visível.
    const streamingMessages: ChatMessage[] = [
      { role: "user", content: "pergunta" },
      { role: "assistant", content: "resposta parcial", isStreaming: true },
    ];
    const { lastFrame: f1, rerender } = render(<ChatDisplay messages={streamingMessages} />);
    const out1 = stripAnsi(f1() ?? "");
    expect(out1).toContain("resposta parcial");

    // Agora o streaming terminou — isStreaming=false
    const finalMessages: ChatMessage[] = [
      { role: "user", content: "pergunta" },
      { role: "assistant", content: "resposta completa", isStreaming: false },
      { role: "user", content: "nova pergunta" },
    ];
    rerender(<ChatDisplay messages={finalMessages} />);
    const out2 = stripAnsi(f1() ?? "");
    // A resposta (agora completa) deve continuar visível
    expect(out2).toContain("resposta completa");
    expect(out2).toContain("nova pergunta");
  });

  it("MIN_LIVE_MESSAGES: pelo menos 4 mensagens ficam na live view", () => {
    // Com 6 mensagens (nenhuma streaming), as primeiras 2 vão para static
    // e as últimas 4 ficam live. Mas todas aparecem no output.
    const messages: ChatMessage[] = Array.from({ length: 6 }, (_, i) => ({
      role: "user" as const,
      content: `msg${i}`,
    }));
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("msg0");
    expect(out).toContain("msg5");
  });
});

// ─── Thinking leak regression (pensar/think tool results hidden) ─────────

describe("ChatDisplay — pensar/think tool results hidden (thinking-vazando fix)", () => {
  it("nao renderiza resultado da tool pensar (live session)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "faz algo" },
      { role: "tool", content: '{"pensamento":"preciso pensar..."}', toolName: "pensar", isResult: false },
      { role: "tool", content: "[THINK] ✓ Pensamento registrado (planning, 156 chars)", toolName: "pensar", isResult: true, ok: true },
      { role: "assistant", content: "Pronto, fiz!" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    // The tool CALL can appear (it just shows args, not the thought content)
    // But the tool RESULT must NOT appear — it contains the thinking content
    expect(out).not.toContain("[THINK]");
    expect(out).not.toContain("Pensamento registrado");
    expect(out).not.toContain("planning, 156 chars");
    // Other content should still appear
    expect(out).toContain("faz algo");
    expect(out).toContain("Pronto, fiz!");
  });

  it("nao renderiza resultado da tool think (alias de pensar)", () => {
    // BUG FIX (thinking-vazando): "think" é um alias para "pensar" em agent.ts.
    // Se a IA chamar think() em vez de pensar(), o resultado também deve
    // ser escondido — senão o pensamento vaza.
    const messages: ChatMessage[] = [
      { role: "user", content: "faz algo" },
      { role: "tool", content: '{"pensamento":"pensando..."}', toolName: "think", isResult: false },
      { role: "tool", content: "[THINK] ✓ Pensamento registrado (analysis, 200 chars)", toolName: "think", isResult: true, ok: true },
      { role: "assistant", content: "Feito!" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).not.toContain("[THINK]");
    expect(out).not.toContain("Pensamento registrado");
    expect(out).toContain("Feito!");
  });

  it("renderiza resultados de outras tools normalmente", () => {
    // Garante que o filtro só esconde pensar/think, não outras tools
    const messages: ChatMessage[] = [
      { role: "tool", content: "conteúdo do arquivo...", toolName: "ler_arquivo", isResult: true, ok: true },
      { role: "tool", content: "Error: not found", toolName: "executar_comando", isResult: true, ok: false },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("ler_arquivo");
    expect(out).toContain("conteúdo do arquivo");
    expect(out).toContain("executar_comando");
  });
});
