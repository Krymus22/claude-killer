/**
 * configSchema.test.ts — Tests for config.json schema validation (Sprint 12).
 *
 * Verifica que o validador:
 *   - Aceita configs válidos
 *   - Rejeita configs sem campos requireds (name, label)
 *   - Rejeita campos com tipo incorreto (validators não-array, etc)
 *   - Valida a estrutura de cada validator (tool, filePattern, blocking)
 *   - Valida a estrutura de cada hook (name, file, trigger)
 *   - isValidModeConfig retorna true/false corretamente
 */

import { describe, it, expect } from "vitest";
import { validateModeConfig, isValidModeConfig } from "../configSchema.js";

describe("configSchema", () => {
  /** Config base válido usado por vários testes. */
  const validConfig = {
    name: "roblox",
    label: "Roblox (External)",
    toolsDir: "tools",
    tools: ["tool:rojo_build"],
    skills: ["skill:profilestore"],
    validators: [
      { tool: "selene_lint", filePattern: "*.luau", blocking: true },
    ],
    hooks: [
      { name: "auto-build", file: "auto-build.js", trigger: "before_write" },
    ],
  };

  describe("validateModeConfig", () => {
    it("config válido retorna 0 errors", () => {
      const errors = validateModeConfig(validConfig);
      expect(errors).toEqual([]);
    });

    it("config sem name retorna error", () => {
      const errors = validateModeConfig({ ...validConfig, name: undefined });
      expect(errors.some((e) => e.field === "name")).toBe(true);
    });

    it("config sem label retorna error", () => {
      const errors = validateModeConfig({ ...validConfig, label: undefined });
      expect(errors.some((e) => e.field === "label")).toBe(true);
    });

    it("config com validators não-array retorna error", () => {
      const errors = validateModeConfig({ ...validConfig, validators: "not-an-array" });
      expect(errors.some((e) => e.field === "validators")).toBe(true);
    });

    it("config com validator sem tool retorna error", () => {
      const errors = validateModeConfig({
        ...validConfig,
        validators: [{ filePattern: "*.luau", blocking: true }],
      });
      expect(errors.some((e) => e.field === "validators[0].tool")).toBe(true);
    });

    it("config com hook sem trigger retorna error", () => {
      const errors = validateModeConfig({
        ...validConfig,
        hooks: [{ name: "h", file: "h.js" }],
      });
      expect(errors.some((e) => e.field === "hooks[0].trigger")).toBe(true);
    });

    it("config com trigger inválido retorna error", () => {
      const errors = validateModeConfig({
        ...validConfig,
        hooks: [{ name: "h", file: "h.js", trigger: "invalid_trigger" }],
      });
      expect(errors.some((e) => e.field === "hooks[0].trigger")).toBe(true);
    });

    it("config com validator.blocking não-boolean retorna error", () => {
      const errors = validateModeConfig({
        ...validConfig,
        validators: [{ tool: "selene_lint", filePattern: "*.luau", blocking: "yes" }],
      });
      expect(errors.some((e) => e.field === "validators[0].blocking")).toBe(true);
    });
  });

  describe("isValidModeConfig", () => {
    it("retorna true para config válido", () => {
      expect(isValidModeConfig(validConfig)).toBe(true);
    });

    it("retorna false para config inválido", () => {
      expect(isValidModeConfig({ name: 123 })).toBe(false);
    });
  });
});
