/**
 * impactHint-cleanup.test.ts — Testes de regressão para limpeza do [IMPACT] hint.
 *
 * O impactAnalyzer anexa um hint ao resultado de editar_arquivo mostrando quais
 * arquivos do projeto referenciam os símbolos do arquivo editado. Esse hint é
 * útil ANTES da edição, mas inútil DEPOIS — fica poluindo o contexto para sempre.
 *
 * A correção em history.ts (optimizeToolMessage) agora substitui o conteúdo do
 * tool result por "[EDIT COMPLETED - IMPACT HINT OMITTED]" quando o fluxo avançou.
 *
 * Estes testes garantem que:
 *   1. Hint é removido quando fluxo avançou (outra tool call depois)
 *   2. Hint é preservado quando fluxo NÃO avançou (ainda na mesma edição)
 *   3. Funciona para todas as edit tools (editar_arquivo, editar_multi_arquivos,
 *      escrever_arquivo, aplicar_diff)
 *   4. Não remove hints de non-edit tools
 *   5. Não processa hints já omitidos (idempotente)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  },
  toolCall: vi.fn(), toolResult: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
  success: vi.fn(), throttle: vi.fn(),
}));

import {
  addRawAssistantMessage,
  addToolResult,
  addUserMessage,
  getHistory,
  resetHistory,
  optimizeContext,
} from "../history.js";

// Helper: cria uma sequência de mensagens simulando um editar_arquivo com IMPACT
function setupEditWithImpact(toolName: string = "editar_arquivo", impactHint: string = "") {
  resetHistory();
  addUserMessage("edite o arquivo");

  const impactContent = impactHint || `
[IMPACT] [ANÁLISE DE IMPACTO] Antes de editar worker.ts:
Encontrei 1 símbolo(s) definido(s) neste arquivo.
19 uso(s) encontrado(s) em 6 arquivo(s) do projeto:

  src/agent.ts (2 usages):
    L1411: // --- Sprint 8: on_task hooks (Worker-Thread sandbox) ---
    L1412: // Runs user-provided JS snippets in isolated Worker Threads after the

  src/fileEdit.ts (3 usages):
    L277: // --- Sprint 8: before_write hooks (Worker-Thread sandbox) ---

Se você for RENOMEAR ou REMOVER algum desses símbolos, precisa editar todos os arquivos acima também.`;

  addRawAssistantMessage({
    role: "assistant",
    content: "",
    tool_calls: [{ id: "tc_edit", type: "function", function: { name: toolName, arguments: "{}" } }],
  } as any);
  addToolResult("tc_edit", `[SUCCESS] 1 substituição aplicada em worker.ts\n\n${impactContent}`);
}

// ─── Testes de remoção quando fluxo avançou ───────────────────────────────

describe("optimizeContext: remove [IMPACT] hint when flow advanced", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("remove [IMPACT] hint de editar_arquivo quando próxima tool call acontece", () => {
    setupEditWithImpact("editar_arquivo");
    // Avança o fluxo: outra tool call depois
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_next", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc_next", "command output");

    optimizeContext();

    const h = getHistory();
    const editResult = h.find(m => m.role === "tool" && (m as any).tool_call_id === "tc_edit");
    expect(editResult).toBeDefined();
    const content = (editResult as any).content as string;
    expect(content).toContain("EDIT COMPLETED - IMPACT HINT OMITTED");
    // Mantém a primeira linha (success message)
    expect(content).toContain("[SUCCESS] 1 substituição aplicada");
    // Remove o hint de IMPACT
    expect(content).not.toContain("[ANÁLISE DE IMPACTO]");
    expect(content).not.toContain("19 uso(s) encontrado(s)");
  });

  it("remove [IMPACT] hint quando usuário envia nova mensagem", () => {
    setupEditWithImpact("editar_arquivo");
    // Avança o fluxo: nova mensagem do usuário
    addUserMessage("agora faça outra coisa");

    optimizeContext();

    const h = getHistory();
    const editResult = h.find(m => m.role === "tool" && (m as any).tool_call_id === "tc_edit");
    const content = (editResult as any).content as string;
    expect(content).toContain("EDIT COMPLETED - IMPACT HINT OMITTED");
    expect(content).not.toContain("[ANÁLISE DE IMPACTO]");
  });

  it("funciona para editar_multi_arquivos", () => {
    setupEditWithImpact("editar_multi_arquivos");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_next", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc_next", "output");

    optimizeContext();

    const h = getHistory();
    const editResult = h.find(m => m.role === "tool" && (m as any).tool_call_id === "tc_edit");
    const content = (editResult as any).content as string;
    expect(content).toContain("EDIT COMPLETED - IMPACT HINT OMITTED");
  });

  it("funciona para escrever_arquivo", () => {
    setupEditWithImpact("escrever_arquivo");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_next", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc_next", "output");

    optimizeContext();

    const h = getHistory();
    const editResult = h.find(m => m.role === "tool" && (m as any).tool_call_id === "tc_edit");
    const content = (editResult as any).content as string;
    expect(content).toContain("EDIT COMPLETED - IMPACT HINT OMITTED");
  });

  it("funciona para aplicar_diff", () => {
    setupEditWithImpact("aplicar_diff");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_next", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc_next", "output");

    optimizeContext();

    const h = getHistory();
    const editResult = h.find(m => m.role === "tool" && (m as any).tool_call_id === "tc_edit");
    const content = (editResult as any).content as string;
    expect(content).toContain("EDIT COMPLETED - IMPACT HINT OMITTED");
  });
});

// ─── Testes de preservação quando fluxo NÃO avançou ───────────────────────

describe("optimizeContext: preserve [IMPACT] hint when flow NOT advanced", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("preserva [IMPACT] hint quando é a última tool call (sem próxima)", () => {
    setupEditWithImpact("editar_arquivo");
    // NÃO adiciona próxima tool call ou user message

    optimizeContext();

    const h = getHistory();
    const editResult = h.find(m => m.role === "tool" && (m as any).tool_call_id === "tc_edit");
    const content = (editResult as any).content as string;
    // Hint ainda está lá — a IA pode precisar dele
    expect(content).toContain("[ANÁLISE DE IMPACTO]");
    expect(content).not.toContain("EDIT COMPLETED - IMPACT HINT OMITTED");
  });

  it("preserva [IMPACT] hint quando próxima é só assistant message (sem tool call)", () => {
    setupEditWithImpact("editar_arquivo");
    // Adiciona assistant message sem tool_calls (texto puro)
    addRawAssistantMessage({
      role: "assistant",
      content: "Vou continuar trabalhando",
    } as any);

    optimizeContext();

    const h = getHistory();
    const editResult = h.find(m => m.role === "tool" && (m as any).tool_call_id === "tc_edit");
    const content = (editResult as any).content as string;
    // Hint preservado — fluxo não avançou de verdade
    expect(content).toContain("[ANÁLISE DE IMPACTO]");
  });
});

// ─── Testes de idempotência ───────────────────────────────────────────────

describe("optimizeContext: idempotente (não reprocessa já omitido)", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("não reprocessa tool result já marcado como EDIT COMPLETED", () => {
    setupEditWithImpact("editar_arquivo");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_next", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc_next", "output");

    // Primeira otimização — substitui conteúdo
    optimizeContext();

    const h1 = getHistory();
    const editResult = h1.find(m => m.role === "tool" && (m as any).tool_call_id === "tc_edit");
    const content1 = (editResult as any).content as string;
    expect(content1).toContain("EDIT COMPLETED - IMPACT HINT OMITTED");

    // Segunda otimização — não deve alterar nada
    optimizeContext();

    const h2 = getHistory();
    const editResult2 = h2.find(m => m.role === "tool" && (m as any).tool_call_id === "tc_edit");
    const content2 = (editResult2 as any).content as string;
    expect(content2).toBe(content1); // exatamente igual
  });
});

// ─── Testes: não afeta non-edit tools ─────────────────────────────────────

describe("optimizeContext: não remove [IMPACT] de non-edit tools", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("não tenta remover hint de executar_comando (mesmo se contiver [IMPACT])", () => {
    resetHistory();
    addUserMessage("execute algo");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_cmd", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc_cmd", "command output with [IMPACT] word in it");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_next", type: "function", function: { name: "ler_arquivo", arguments: "{}" } }],
    } as any);
    addToolResult("tc_next", "file content");

    optimizeContext();

    const h = getHistory();
    const cmdResult = h.find(m => m.role === "tool" && (m as any).tool_call_id === "tc_cmd");
    const content = (cmdResult as any).content as string;
    // executar_comando não é edit tool — hint preservado
    expect(content).toContain("[IMPACT]");
    expect(content).not.toContain("EDIT COMPLETED - IMPACT HINT OMITTED");
  });
});

// ─── Teste: economia real de tokens ───────────────────────────────────────

describe("optimizeContext: economia real de tokens com [IMPACT] hint", () => {
  it("remover hint economiza significant chars após múltiplas edições", () => {
    resetHistory();
    addUserMessage("faça 5 edições");

    // Simula 5 editar_arquivo calls, cada uma com IMPACT hint de ~2K chars
    for (let i = 0; i < 5; i++) {
      const impactHint = `
[IMPACT] [ANÁLISE DE IMPACTO] Antes de editar file${i}.ts:
Encontrei 1 símbolo(s) definido(s) neste arquivo.
19 uso(s) encontrado(s) em 6 arquivo(s) do projeto:
  src/agent.ts (2 usages): L1411, L1412
  src/fileEdit.ts (3 usages): L277, L278, L318
${"x".repeat(500)}`;
      addRawAssistantMessage({
        role: "assistant",
        content: "",
        tool_calls: [{ id: `tc_edit_${i}`, type: "function", function: { name: "editar_arquivo", arguments: "{}" } }],
      } as any);
      addToolResult(`tc_edit_${i}`, `[SUCCESS] edit ${i}\n\n${impactHint}`);
    }

    // Avança o fluxo com uma próxima tool call
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_next", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc_next", "done");

    // Antes da otimização
    const beforeHistory = getHistory();
    const editResults = beforeHistory.filter(m => m.role === "tool" && (m as any).tool_call_id?.startsWith("tc_edit_"));
    const totalBefore = editResults.reduce((sum, m) => sum + ((m as any).content as string).length, 0);

    optimizeContext();

    // Depois da otimização
    const afterHistory = getHistory();
    const editResultsAfter = afterHistory.filter(m => m.role === "tool" && (m as any).tool_call_id?.startsWith("tc_edit_"));
    const totalAfter = editResultsAfter.reduce((sum, m) => sum + ((m as any).content as string).length, 0);

    // Deve ter economizado pelo menos 3K chars (cada hint removido economiza ~600+ chars)
    expect(totalAfter).toBeLessThan(totalBefore);
    expect(totalBefore - totalAfter).toBeGreaterThan(3000);
  });
});
