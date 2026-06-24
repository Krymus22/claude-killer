/**
 * integration-askUser-agent.test.ts — E2E do AskUser integrado com agent loop.
 *
 * Estes testes simulam o fluxo completo do agent loop quando a IA chama
 * `perguntar_usuario`:
 *   1. IA chama a tool → handler chama callback → agent pausa (await)
 *   2. Usuário responde via callback → resposta formatada volta pra IA
 *   3. Agent loop continua
 *
 * Não usamos o agent loop REAL (que exigiria mockar dezenas de módulos).
 * Em vez disso, exercitamos o handler `handleAskUser` exatamente como o
 * agent.ts faz: ele é registrado como handler da tool "perguntar_usuario"
 * e chamado quando a IA faz tool_call. O comportamento é idêntico ao
 * production, só não passamos pelo dispatcher completo.
 *
 * Cenários cobertos:
 *   - Pausa/resume via callback (Promise que resolve manualmente)
 *   - Formatação de resposta de alternativa vs texto livre
 *   - Cancelamento
 *   - Permissões (allowUserQuestions=false)
 *   - Re-entrância (múltiplas perguntas em sequência)
 *   - Validação de schema (min/max alternativas, required fields)
 *   - Ausência de callback (sub-agent sem permissão)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// --- Mocks ------------------------------------------------------------------

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// --- Imports ----------------------------------------------------------------

import {
  ASK_USER_TOOL_DEFINITION,
  handleAskUser,
  setAskUserCallback,
  clearAskUserCallback,
  type AskUserCallback,
  type AskUserQuestion,
  type AskUserResponse,
} from "../askUser.js";

// --- Setup ------------------------------------------------------------------

beforeEach(() => {
  // Garante estado limpo antes de cada teste
  clearAskUserCallback();
});

// --- Testes E2E -------------------------------------------------------------

describe("E2E: AskUser no agent loop", () => {
  it("IA chama perguntar_usuario → agent pausa → usuário responde → continua", async () => {
    // Simula o callback do App.tsx: retorna uma Promise que só resolve
    // quando o usuário responde. O agent loop (via handleAskUser) aguarda.
    let resolveUser!: (r: AskUserResponse) => void;
    const userWillRespond = new Promise<AskUserResponse>((resolve) => {
      resolveUser = resolve;
    });
    const mockCb: AskUserCallback = vi.fn(() => userWillRespond);
    setAskUserCallback(mockCb, true);

    // IA faz tool call → handler é chamado → agent pausa no await
    const handlerPromise = handleAskUser({
      pergunta: "Qual framework?",
      alternativas: ["React", "Vue"],
    });

    // Agent está pausado. Simula o usuário respondendo depois de 10ms.
    setTimeout(() => {
      resolveUser({ value: "React", cancelled: false, fromAlternatives: true });
    }, 10);

    const result = await handlerPromise;

    // Callback foi chamado com a pergunta certa
    expect(mockCb).toHaveBeenCalledOnce();
    const question: AskUserQuestion = mockCb.mock.calls[0]![0];
    expect(question.pergunta).toBe("Qual framework?");
    expect(question.alternativas).toEqual(["React", "Vue"]);

    // Resultado voltou formatado pra IA continuar
    expect(result.resultStr).toContain("[USER RESPONSE]");
    expect(result.resultStr).toContain("React");
    expect(result.usedHeal).toBe(false);
  });

  it("resposta de alternativa formatada com [USER RESPONSE]", async () => {
    const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
      value: "Option A",
      cancelled: false,
      fromAlternatives: true,
    });
    setAskUserCallback(mockCb, true);

    const result = await handleAskUser({
      pergunta: "Choose an option",
      alternativas: ["Option A", "Option B"],
    });

    expect(result.resultStr).toContain("[USER RESPONSE]");
    expect(result.resultStr).not.toContain("texto livre");
    expect(result.resultStr).toContain("Option A");
  });

  it("resposta livre formatada com [USER RESPONSE (free text)]", async () => {
    const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
      value: "minha resposta customizada",
      cancelled: false,
      fromAlternatives: false,
    });
    setAskUserCallback(mockCb, true);

    const result = await handleAskUser({
      pergunta: "Qual seu nome?",
      alternativas: ["Não dizer", "Anônimo"],
    });

    expect(result.resultStr).toContain("[USER RESPONSE (free text)]");
    expect(result.resultStr).toContain("minha resposta customizada");
  });

  it("cancellation formatted with [USER CANCELLED QUESTION]", async () => {
    const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
      value: "",
      cancelled: true,
      fromAlternatives: false,
    });
    setAskUserCallback(mockCb, true);

    const result = await handleAskUser({
      pergunta: "Confirma?",
      alternativas: ["Sim", "Não"],
    });

    expect(result.resultStr).toContain("[USER CANCELLED QUESTION]");
    expect(result.resultStr).toMatch(/best judgment|chose not/i);
  });

  it("IA sem permissão (allowUserQuestions=false) recebe erro", async () => {
    // Callback existe, mas allow=false (sub-agent)
    const mockCb: AskUserCallback = vi.fn();
    setAskUserCallback(mockCb, false);

    const result = await handleAskUser({
      pergunta: "Posso?",
      alternativas: ["Sim", "Não"],
    });

    expect(result.resultStr).toMatch(/[ERROR]/);
    expect(result.resultStr).toMatch(/is not available in this context/i);
    // Callback NÃO foi chamado (permissão negada antes)
    expect(mockCb).not.toHaveBeenCalled();
  });

  it("múltiplas perguntas em sequência funcionam", async () => {
    const responses: AskUserResponse[] = [
      { value: "A", cancelled: false, fromAlternatives: true },
      { value: "B", cancelled: false, fromAlternatives: true },
      { value: "texto livre", cancelled: false, fromAlternatives: false },
      { value: "", cancelled: true, fromAlternatives: false },
    ];
    const mockCb: AskUserCallback = vi.fn().mockImplementation(() => {
      const r = responses.shift()!;
      return Promise.resolve(r);
    });
    setAskUserCallback(mockCb, true);

    const r1 = await handleAskUser({ pergunta: "Q1", alternativas: ["A", "B"] });
    const r2 = await handleAskUser({ pergunta: "Q2", alternativas: ["A", "B"] });
    const r3 = await handleAskUser({ pergunta: "Q3", alternativas: ["A", "B"] });
    const r4 = await handleAskUser({ pergunta: "Q4", alternativas: ["A", "B"] });

    expect(mockCb).toHaveBeenCalledTimes(4);
    expect(r1.resultStr).toContain("[USER RESPONSE] A");
    expect(r2.resultStr).toContain("[USER RESPONSE] B");
    expect(r3.resultStr).toContain("[USER RESPONSE (free text)] texto livre");
    expect(r4.resultStr).toContain("[USER CANCELLED QUESTION]");
  });

  it("perguntar_usuario without callback set -> graceful error", async () => {
    // Não chama setAskUserCallback (callback undefined + allow=true default)
    // Simula sub-agent que não setou callback
    clearAskUserCallback();

    const result = await handleAskUser({
      pergunta: "Q?",
      alternativas: ["A", "B"],
    });

    expect(result.resultStr).toMatch(/[ERROR]/);
    expect(result.resultStr).toMatch(/is not available in this context/i);
    // Mensagem orienta a IA a usar seu best judgment
    expect(result.resultStr).toMatch(/best judgment|continue without askntar/i);
    expect(result.usedHeal).toBe(false);
  });

  it("tool definition tem schema correto (pergunta + alternativas required)", () => {
    // Estrutura básica
    expect(ASK_USER_TOOL_DEFINITION.type).toBe("function");
    expect(ASK_USER_TOOL_DEFINITION.function.name).toBe("perguntar_usuario");

    // Schema: required inclui pergunta + alternativas
    const params = ASK_USER_TOOL_DEFINITION.function.parameters as any;
    expect(params.type).toBe("object");
    expect(params.required).toContain("pergunta");
    expect(params.required).toContain("alternativas");
    // contexto NÃO é required
    expect(params.required).not.toContain("contexto");

    // Propriedades estão definidas
    expect(params.properties.pergunta.type).toBe("string");
    expect(params.properties.alternativas.type).toBe("array");
    expect(params.properties.alternativas.items.type).toBe("string");
    // minItems/maxItems validam cardinalidade
    expect(params.properties.alternativas.minItems).toBe(2);
    expect(params.properties.alternativas.maxItems).toBe(6);
  });

  it("alternativas com menos de 2 → erro", async () => {
    // Mesmo com callback setado, validação ocorre ANTES do callback
    const mockCb: AskUserCallback = vi.fn();
    setAskUserCallback(mockCb, true);

    // Array vazio
    const r0 = await handleAskUser({ pergunta: "Q?", alternativas: [] });
    expect(r0.resultStr).toMatch(/[ERROR]/);
    expect(r0.resultStr).toMatch(/at least 2/i);

    // Array com 1 item
    const r1 = await handleAskUser({ pergunta: "Q?", alternativas: ["única"] });
    expect(r1.resultStr).toMatch(/[ERROR]/);
    expect(r1.resultStr).toMatch(/at least 2/i);

    // Callback não foi chamado (validação rejeita antes)
    expect(mockCb).not.toHaveBeenCalled();
  });

  it("alternativas com mais de 6 → erro", async () => {
    const mockCb: AskUserCallback = vi.fn();
    setAskUserCallback(mockCb, true);

    const result = await handleAskUser({
      pergunta: "Q?",
      alternativas: ["1", "2", "3", "4", "5", "6", "7", "8"],
    });

    expect(result.resultStr).toMatch(/[ERROR]/);
    expect(result.resultStr).toMatch(/at most 6/i);
    expect(mockCb).not.toHaveBeenCalled();
  });
});
