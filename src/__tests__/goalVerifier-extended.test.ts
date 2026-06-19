/**
 * goalVerifier-extended.test.ts — Casos de borda para o verificador de conclusão.
 *
 * O módulo goalVerifier.ts expõe `verifyGoalCompletion` (verifica se a tarefa
 * foi concluída) e `formatGoalVerification` (formata o resultado para o agente).
 *
 * Conceitos solicitados:
 *   - verifyGoal (3): alcançado, parcial, falhou
 *   - extractGoals (2): parsing de JSON vs fallback por keywords
 *   - checkCompletion (2): cenários extremos (empty content, JSON inválido)
 *   - edge cases (1): respostas muito grandes, truncamento
 *
 * Evita duplicar testes do goalVerifier.test.ts básico.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock("./../apiClient.js", () => ({
  chat: vi.fn(),
}));

describe("goalVerifier — extended", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  // === verifyGoal — alcançado / parcial / falhou ===============================

  describe("verifyGoalCompletion — estados da verificação", () => {
    it("retorna done=true (ALCANÇADO) quando LLM confirma com reasoning", async () => {
      const { verifyGoalCompletion } = await import("./../goalVerifier.js");
      const { chat } = await import("./../apiClient.js");
      (chat as any).mockResolvedValue({
        choices: [
          {
            message: {
              content:
                '{"done": true, "missing": [], "reasoning": "Todos os requisitos foram implementados e testados."}',
            },
          },
        ],
      });

      const result = await verifyGoalCompletion(
        "implementar feature X com testes",
        ["src/feature.ts", "src/feature.test.ts"],
        "Implementei a feature X e adicionei testes que passam."
      );

      expect(result.done).toBe(true);
      expect(result.missingItems).toEqual([]);
      expect(result.verified).toBe(true);
      expect(result.reasoning).toContain("requisitos");
    });

    it("retorna done=false (PARCIAL) com lista de itens faltantes", async () => {
      const { verifyGoalCompletion } = await import("./../goalVerifier.js");
      const { chat } = await import("./../apiClient.js");
      (chat as any).mockResolvedValue({
        choices: [
          {
            message: {
              content:
                '{"done": false, "missing": ["rodar lint", "adicionar docstring", "atualizar README"], "reasoning": "Faltam 3 itens."}',
            },
          },
        ],
      });

      const result = await verifyGoalCompletion(
        "implementar feature + docs",
        ["src/feature.ts"],
        "Implementei a feature."
      );

      expect(result.done).toBe(false);
      expect(result.verified).toBe(true);
      expect(result.missingItems).toHaveLength(3);
      expect(result.missingItems).toContain("rodar lint");
      expect(result.missingItems).toContain("adicionar docstring");
      expect(result.missingItems).toContain("atualizar README");
    });

    it("retorna done=true + verified=false (FALHOU) quando API lança erro", async () => {
      const { verifyGoalCompletion } = await import("./../goalVerifier.js");
      const { chat } = await import("./../apiClient.js");
      (chat as any).mockRejectedValue(new Error("API timeout 504"));

      const result = await verifyGoalCompletion("task", ["f.ts"], "done");

      // Em caso de falha do verificador, NÃO bloqueia o agente (done=true)
      expect(result.done).toBe(true);
      expect(result.verified).toBe(false);
      expect(result.reasoning).toContain("VERIFIER UNAVAILABLE");
      expect(result.reasoning).toContain("API timeout 504");
    });
  });

  // === extractGoals — parsing de JSON vs fallback ==============================

  describe("verifyGoalCompletion — extração (parsing) de resposta", () => {
    it("extrai JSON mesmo quando cercado por texto explicativo do LLM", async () => {
      const { verifyGoalCompletion } = await import("./../goalVerifier.js");
      const { chat } = await import("./../apiClient.js");
      (chat as any).mockResolvedValue({
        choices: [
          {
            message: {
              content:
                "Analisei a tarefa. Aqui está meu veredito:\n" +
                '```json\n{"done": true, "missing": [], "reasoning": "Tudo ok"}\n```\n' +
                "Espero que isso ajude.",
            },
          },
        ],
      });

      const result = await verifyGoalCompletion("task", ["f.ts"], "done");
      expect(result.done).toBe(true);
      expect(result.verified).toBe(true);
    });

    it("usa fallback de keywords quando resposta não tem JSON válido", async () => {
      const { verifyGoalCompletion } = await import("./../goalVerifier.js");
      const { chat } = await import("./../apiClient.js");
      (chat as any).mockResolvedValue({
        choices: [
          {
            message: {
              content:
                "Após análise, concluo que a tarefa está NOT_COMPLETE porque faltam testes.",
            },
          },
        ],
      });

      const result = await verifyGoalCompletion("task", ["f.ts"], "done");
      // Fallback: "not_complete" no conteúdo -> done=false
      expect(result.done).toBe(false);
      expect(result.verified).toBe(true);
      // reasoning deve conter o conteúdo original (truncado)
      expect(result.reasoning).toContain("NOT_COMPLETE");
    });
  });

  // === checkCompletion — cenários extremos ====================================

  describe("verifyGoalCompletion — cenários extremos", () => {
    it("lida com content vazio do LLM sem quebrar (fallback done=true)", async () => {
      const { verifyGoalCompletion } = await import("./../goalVerifier.js");
      const { chat } = await import("./../apiClient.js");
      (chat as any).mockResolvedValue({
        choices: [{ message: { content: "" } }],
      });

      const result = await verifyGoalCompletion("task", ["f.ts"], "done");
      // Conteúdo vazio: indexOf("{") retorna -1, vai pro fallback.
      // lower não contém "not done" / "not_complete" / "missing" -> done=true
      expect(result.done).toBe(true);
      expect(result.verified).toBe(true);
    });

    it("lida com choices ausente na resposta (content undefined)", async () => {
      const { verifyGoalCompletion } = await import("./../goalVerifier.js");
      const { chat } = await import("./../apiClient.js");
      (chat as any).mockResolvedValue({}); // sem choices

      const result = await verifyGoalCompletion("task", ["f.ts"], "done");
      // content = "" -> fallback -> done=true (sem keywords negativas)
      expect(result.done).toBe(true);
      expect(result.verified).toBe(true);
    });
  });

  // === Edge cases — truncamento de input ======================================

  describe("verifyGoalCompletion — truncamento de input", () => {
    it("trunca userRequest para 500 chars e agentResponse para 2000 chars no prompt", async () => {
      const { verifyGoalCompletion } = await import("./../goalVerifier.js");
      const { chat } = await import("./../apiClient.js");
      (chat as any).mockResolvedValue({
        choices: [{ message: { content: '{"done": true, "missing": [], "reasoning": "ok"}' } }],
      });

      const longRequest = "R".repeat(2000);
      const longResponse = "A".repeat(5000);

      await verifyGoalCompletion(longRequest, ["f.ts"], longResponse);

      // Verifica que o chat foi chamado e o segundo message (user) contém o request truncado
      expect(chat).toHaveBeenCalledTimes(1);
      const callArgs = (chat as any).mock.calls[0][0];
      const userMessage = callArgs[1].content;
      // O prompt deve conter "USER REQUEST:" seguido do request truncado em 500 chars
      expect(userMessage).toContain("USER REQUEST:");
      // O request original (2000 R's) não deve aparecer completo — deve ser truncado
      expect(userMessage).not.toContain("R".repeat(600));
    });
  });

  // === formatGoalVerification — edge cases ====================================

  describe("formatGoalVerification — edge cases", () => {
    it("formata done=false SEM missing items (apenas reasoning)", async () => {
      const { formatGoalVerification } = await import("./../goalVerifier.js");
      const msg = formatGoalVerification({
        done: false,
        missingItems: [],
        reasoning: "Tarefa incompleta por motivos técnicos.",
        verified: true,
      });
      expect(msg).toContain("GOAL NOT VERIFIED");
      expect(msg).toContain("Tarefa incompleta por motivos técnicos");
      // Não deve ter a seção "Itens faltantes" quando array está vazio
      expect(msg).not.toContain("Itens faltantes");
      expect(msg).toContain("NÃO finalize");
    });

    it("formata done=true SEMPRE com a mensagem de verificado, independente de missingItems", async () => {
      const { formatGoalVerification } = await import("./../goalVerifier.js");
      // Mesmo se houver missingItems (inconsistência), done=true tem mensagem fixa
      const msg = formatGoalVerification({
        done: true,
        missingItems: ["item fantasma"],
        reasoning: "tudo ok",
        verified: true,
      });
      expect(msg).toContain("GOAL VERIFIED");
      expect(msg).not.toContain("item fantasma");
    });
  });
});
