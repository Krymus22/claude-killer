/**
 * argsNormalizer-extended.test.ts — Mais testes para argsNormalizer.ts.
 *
 * normalizeArgs(toolName, args, schema) modifica args IN-PLACE.
 * Aliases: caminho→path (universal), command→comando (executar_comando), etc.
 */
import { describe, it, expect } from "vitest";
import { normalizeArgs } from "../argsNormalizer.js";

describe("argsNormalizer — extended", () => {
  describe("normalizeArgs - universal aliases", () => {
    it("caminho → path (universal)", () => {
      const args: any = { caminho: "/test.ts" };
      normalizeArgs("editar_arquivo", args);
      expect(args.path).toBe("/test.ts");
    });

    it("filePath → path (universal)", () => {
      const args: any = { filePath: "/test.ts" };
      normalizeArgs("ler_arquivo", args);
      expect(args.path).toBe("/test.ts");
    });

    it("file → path (universal)", () => {
      const args: any = { file: "/test.ts" };
      normalizeArgs("ler_arquivo", args);
      expect(args.path).toBe("/test.ts");
    });

    it("filename → path (universal)", () => {
      const args: any = { filename: "/test.ts" };
      normalizeArgs("ler_arquivo", args);
      expect(args.path).toBe("/test.ts");
    });

    it("preserva alias original após normalização", () => {
      const args: any = { caminho: "/test.ts" };
      normalizeArgs("editar_arquivo", args);
      expect(args.caminho).toBe("/test.ts");
      expect(args.path).toBe("/test.ts");
    });

    it("não sobrescreve path existente com alias", () => {
      const args: any = { path: "/original.ts", caminho: "/alias.ts" };
      normalizeArgs("editar_arquivo", args);
      expect(args.path).toBe("/original.ts");
    });
  });

  describe("normalizeArgs - tool-specific aliases", () => {
    it("command → comando (executar_comando)", () => {
      const args: any = { command: "ls -la" };
      normalizeArgs("executar_comando", args);
      expect(args.comando).toBe("ls -la");
    });

    it("question → questao (explorar_subagente)", () => {
      const args: any = { question: "como funciona?" };
      normalizeArgs("explorar_subagente", args);
      expect(args.questao).toBe("como funciona?");
    });

    it("thought → pensamento (pensar)", () => {
      const args: any = { thought: "raciocínio" };
      normalizeArgs("pensar", args);
      expect(args.pensamento).toBe("raciocínio");
    });

    it("task → item (marcar_feito)", () => {
      const args: any = { task: "fazer X" };
      normalizeArgs("marcar_feito", args);
      expect(args.item).toBe("fazer X");
    });
  });

  describe("normalizeArgs - type coercion com schema", () => {
    it("converte string para number quando schema pede number", () => {
      const args: any = { maxResults: "10" };
      const schema = { properties: { maxResults: { type: "number" } } };
      normalizeArgs("ler_arquivo", args, schema);
      expect(args.maxResults).toBe(10);
      expect(typeof args.maxResults).toBe("number");
    });

    it("converte string 'true' para boolean true", () => {
      const args: any = { createIfMissing: "true" };
      const schema = { properties: { createIfMissing: { type: "boolean" } } };
      normalizeArgs("editar_arquivo", args, schema);
      expect(args.createIfMissing).toBe(true);
    });

    it("converte string 'false' para boolean false", () => {
      const args: any = { createIfMissing: "false" };
      const schema = { properties: { createIfMissing: { type: "boolean" } } };
      normalizeArgs("editar_arquivo", args, schema);
      expect(args.createIfMissing).toBe(false);
    });

    it("converte string '1' para boolean true", () => {
      const args: any = { flag: "1" };
      const schema = { properties: { flag: { type: "boolean" } } };
      normalizeArgs("tool", args, schema);
      expect(args.flag).toBe(true);
    });

    it("não converte string não-numérica para number", () => {
      const args: any = { maxResults: "abc" };
      const schema = { properties: { maxResults: { type: "number" } } };
      normalizeArgs("tool", args, schema);
      expect(args.maxResults).toBe("abc");
    });
  });

  describe("normalizeArgs - JSON string parsing", () => {
    it("parseia string JSON de array", () => {
      const args: any = { edits: '[{"search":"a","replace":"b"}]' };
      normalizeArgs("editar_arquivo", args);
      expect(Array.isArray(args.edits)).toBe(true);
      expect(args.edits[0].search).toBe("a");
    });

    it("parseia string JSON de objeto", () => {
      const args: any = { config: '{"key":"value"}' };
      normalizeArgs("tool", args);
      expect(typeof args.config).toBe("object");
      expect(args.config.key).toBe("value");
    });

    it("não parseia string que não é JSON", () => {
      const args: any = { text: "hello world" };
      normalizeArgs("tool", args);
      expect(args.text).toBe("hello world");
    });
  });

  describe("normalizeArgs - defaults", () => {
    it("preenche default do schema quando ausente", () => {
      const args: any = {};
      const schema = { properties: { maxResults: { type: "number", default: 50 } } };
      normalizeArgs("tool", args, schema);
      expect(args.maxResults).toBe(50);
    });

    it("não preenche default se já está presente", () => {
      const args: any = { maxResults: 10 };
      const schema = { properties: { maxResults: { type: "number", default: 50 } } };
      normalizeArgs("tool", args, schema);
      expect(args.maxResults).toBe(10);
    });
  });

  describe("normalizeArgs - edge cases", () => {
    it("lida com args vazios", () => {
      const args: any = {};
      expect(() => normalizeArgs("tool", args)).not.toThrow();
    });

    it("lida com schema undefined", () => {
      const args: any = { path: "/test" };
      expect(() => normalizeArgs("tool", args)).not.toThrow();
    });

    it("preserva args extras desconhecidos", () => {
      const args: any = { customArg: "value" };
      normalizeArgs("tool", args);
      expect(args.customArg).toBe("value");
    });
  });
});
