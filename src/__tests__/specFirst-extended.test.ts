/**
 * specFirst-extended.test.ts — Casos de borda para spec-first mode.
 *
 * O módulo specFirst.ts expõe `createSpec`, `getSpec`, `hasSpec`, `clearSpec`
 * e `formatSpec`. Conceitos do roteiro (mapeados para a API real):
 *
 *   - parseSpec (2):          createSpec + getSpec (parsear e armazenar spec)
 *   - validateSpec (2):       hasSpec + clearSpec (estado e transições)
 *   - generateBoilerplate (2): formatSpec (gera string formatada do spec)
 *   - extractRequirements (2): getSpec + verifica inputs/outputs/edgeCases
 *
 * Evita duplicar testes do specFirst.test.ts básico.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

describe("specFirst — extended", () => {
  beforeEach(async () => {
    const { clearSpec } = await import("./../specFirst.js");
    clearSpec();
  });

  // === parseSpec — createSpec + getSpec =======================================

  describe("parseSpec (createSpec + getSpec)", () => {
    it("faz parse e armazena spec com múltiplos inputs/outputs preservando ordem", async () => {
      const { createSpec, getSpec } = await import("./../specFirst.js");
      const spec = createSpec({
        name: "MultiInputApi",
        description: "API com vários inputs",
        inputs: [
          { name: "id", type: "number", required: true },
          { name: "name", type: "string", required: true },
          { name: "opts", type: "object", required: false },
        ],
        outputs: [
          { name: "result", type: "object" },
          { name: "status", type: "number" },
        ],
        edgeCases: ["id negativo", "name vazio"],
        constraints: ["Não modifica estado global"],
      });

      // createSpec retorna a spec criada com createdAt
      expect(spec.name).toBe("MultiInputApi");
      expect(typeof spec.createdAt).toBe("number");

      // getSpec recupera a mesma spec
      const stored = getSpec();
      expect(stored).not.toBeNull();
      expect(stored!.inputs).toHaveLength(3);
      expect(stored!.inputs[0]!.name).toBe("id");
      expect(stored!.inputs[2]!.name).toBe("opts");
      expect(stored!.outputs).toHaveLength(2);
    });

    it("substitui spec existente ao chamar createSpec novamente (não acumula)", async () => {
      const { createSpec, getSpec } = await import("./../specFirst.js");

      createSpec({
        name: "FirstSpec",
        description: "primeira",
        inputs: [{ name: "a", type: "string", required: true }],
        outputs: [],
        edgeCases: [],
        constraints: [],
      });

      createSpec({
        name: "SecondSpec",
        description: "segunda",
        inputs: [{ name: "b", type: "number", required: false }],
        outputs: [],
        edgeCases: [],
        constraints: [],
      });

      const stored = getSpec();
      expect(stored!.name).toBe("SecondSpec");
      expect(stored!.inputs).toHaveLength(1);
      expect(stored!.inputs[0]!.name).toBe("b");
      // Não deve ter resquícios da primeira spec
      expect(stored!.description).toBe("segunda");
    });
  });

  // === validateSpec — hasSpec + clearSpec =====================================

  describe("validateSpec (hasSpec + clearSpec)", () => {
    it("hasSpec alterna corretamente entre false -> true -> false após clearSpec", async () => {
      const { createSpec, hasSpec, clearSpec } = await import("./../specFirst.js");

      expect(hasSpec()).toBe(false);

      createSpec({
        name: "Temp",
        description: "",
        inputs: [],
        outputs: [],
        edgeCases: [],
        constraints: [],
      });
      expect(hasSpec()).toBe(true);

      clearSpec();
      expect(hasSpec()).toBe(false);

      // clearSpec chamado de novo não deve quebrar
      expect(() => clearSpec()).not.toThrow();
    });

    it("getSpec retorna null após clearSpec (estado consistente)", async () => {
      const { createSpec, getSpec, clearSpec } = await import("./../specFirst.js");
      createSpec({
        name: "X",
        description: "temp",
        inputs: [{ name: "i", type: "string", required: true }],
        outputs: [],
        edgeCases: [],
        constraints: [],
      });
      expect(getSpec()).not.toBeNull();

      clearSpec();
      expect(getSpec()).toBeNull();
    });
  });

  // === generateBoilerplate — formatSpec =======================================

  describe("generateBoilerplate (formatSpec)", () => {
    it("gera boilerplate incluindo todas as seções quando spec tem dados completos", async () => {
      const { createSpec, formatSpec } = await import("./../specFirst.js");
      createSpec({
        name: "CompleteApi",
        description: "API completa de exemplo",
        inputs: [
          { name: "playerId", type: "number", required: true, description: "ID do jogador" },
          { name: "amount", type: "number", required: true, description: "Quantidade" },
        ],
        outputs: [{ name: "success", type: "boolean", description: "True se ok" }],
        edgeCases: ["playerId negativo", "amount zero", "jogador offline"],
        constraints: ["Tx em <100ms", "Idempotente"],
      });

      const boilerplate = formatSpec();

      // Todas as seções devem estar presentes
      expect(boilerplate).toContain("[SPEC: CompleteApi]");
      expect(boilerplate).toContain("Description: API completa de exemplo");
      expect(boilerplate).toContain("Inputs:");
      expect(boilerplate).toContain("playerId (number, required): ID do jogador");
      expect(boilerplate).toContain("amount (number, required): Quantidade");
      expect(boilerplate).toContain("Outputs:");
      expect(boilerplate).toContain("success (boolean): True se ok");
      expect(boilerplate).toContain("Edge cases to handle:");
      expect(boilerplate).toContain("- playerId negativo");
      expect(boilerplate).toContain("- amount zero");
      expect(boilerplate).toContain("- jogador offline");
      expect(boilerplate).toContain("Constraints:");
      expect(boilerplate).toContain("- Tx em <100ms");
      expect(boilerplate).toContain("- Idempotente");
    });

    it("gera boilerplate mínimo quando spec tem arrays vazios (sem seções Inputs/Outputs/Edge/Constraints)", async () => {
      const { createSpec, formatSpec } = await import("./../specFirst.js");
      createSpec({
        name: "MinimalSpec",
        description: "Apenas descrição",
        inputs: [],
        outputs: [],
        edgeCases: [],
        constraints: [],
      });

      const boilerplate = formatSpec();

      // Sempre tem o header e a descrição
      expect(boilerplate).toContain("[SPEC: MinimalSpec]");
      expect(boilerplate).toContain("Description: Apenas descrição");
      // Não deve ter as seções vazias
      expect(boilerplate).not.toContain("Inputs:");
      expect(boilerplate).not.toContain("Outputs:");
      expect(boilerplate).not.toContain("Edge cases to handle:");
      expect(boilerplate).not.toContain("Constraints:");
    });
  });

  // === extractRequirements — getSpec + verificação de campos ===================

  describe("extractRequirements (getSpec + campos)", () => {
    it("extrai corretamente inputs required vs optional", async () => {
      const { createSpec, getSpec } = await import("./../specFirst.js");
      createSpec({
        name: "MixedSpec",
        description: "Mix de required e optional",
        inputs: [
          { name: "required1", type: "string", required: true },
          { name: "optional1", type: "number", required: false },
          { name: "required2", type: "boolean", required: true },
        ],
        outputs: [],
        edgeCases: [],
        constraints: [],
      });

      const stored = getSpec()!;
      const requiredInputs = stored.inputs.filter((i) => i.required);
      const optionalInputs = stored.inputs.filter((i) => !i.required);

      expect(requiredInputs).toHaveLength(2);
      expect(optionalInputs).toHaveLength(1);
      expect(optionalInputs[0]!.name).toBe("optional1");
    });

    it("extrai edgeCases e constraints preservando ordem e conteúdo", async () => {
      const { createSpec, getSpec } = await import("./../specFirst.js");
      const edgeCases = ["primeiro edge", "segundo edge", "terceiro edge"];
      const constraints = ["constraint A", "constraint B"];

      createSpec({
        name: "EdgeCaseSpec",
        description: "",
        inputs: [],
        outputs: [],
        edgeCases,
        constraints,
      });

      const stored = getSpec()!;
      expect(stored.edgeCases).toEqual(edgeCases);
      expect(stored.constraints).toEqual(constraints);
      // Ordem preservada
      expect(stored.edgeCases[0]).toBe("primeiro edge");
      expect(stored.edgeCases[2]).toBe("terceiro edge");
    });
  });
});
