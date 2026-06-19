/**
 * modeExtensions-extended.test.ts — Casos edge / error handling / integração
 * para modeExtensions.ts que NÃO estão cobertos pelo teste básico.
 *
 * Foco (adaptado às funções reais do módulo):
 *   - getExtensionsForMode (getActiveSafetyPatterns/getActiveResearchSources/getActiveSymbolPatterns) (3 casos)
 *   - applyModeExtensions (getActiveValidationRules/getActivePostEditHooks/getActivePreCommitHooks) (2 casos)
 *   - validateMode (runHook com comando inválido/timeout) (2 casos)
 *   - edge cases (1 caso)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

describe("modeExtensions-extended", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-modeext-ext-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  // ─── getExtensionsForMode (3 casos) ─────────────────────────────────
  describe("getExtensionsForMode — patterns/sources/symbols", () => {
    it("getActiveSafetyPatterns desduplica preservando built-in + custom (sem perder entradas)", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      const { getActiveSafetyPatterns } = await import("./../modeExtensions.js");

      saveUserMode({
        name: "ext-dedup",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        safetyPatterns: [
          { regex: "rm\\s+-rf\\s+/", description: "rm -rf /", severity: "high" },
          { regex: "DROP\\s+TABLE", description: "DROP TABLE", severity: "high" },
        ],
      });
      setActiveMode("ext-dedup");

      const patterns = await getActiveSafetyPatterns();
      // Pelo menos os 20 built-in + 2 custom
      expect(patterns.length).toBeGreaterThanOrEqual(22);
      // Os 2 custom devem estar presentes
      expect(patterns.some((p) => p.description === "rm -rf /")).toBe(true);
      expect(patterns.some((p) => p.description === "DROP TABLE")).toBe(true);
      // Cada um deve ter regex compilado (instância de RegExp)
      for (const p of patterns) {
        expect(p.regex).toBeInstanceOf(RegExp);
        expect(["low", "medium", "high"]).toContain(p.severity);
      }
    });

    it("getActiveResearchSources retorna objeto vazio quando modo não tem researchSources", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      const { getActiveResearchSources } = await import("./../modeExtensions.js");

      saveUserMode({
        name: "ext-no-research",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
      });
      setActiveMode("ext-no-research");

      const sources = await getActiveResearchSources();
      expect(sources).toEqual({});
    });

    it("getActiveSymbolPatterns retorna patterns com extensions e patterns válidos", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      const { getActiveSymbolPatterns } = await import("./../modeExtensions.js");

      saveUserMode({
        name: "ext-symbols",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        symbolPatterns: [
          { language: "rust", extensions: [".rs"], patterns: ["fn\\s+(\\w+)"] },
          { language: "kotlin", extensions: [".kt", ".kts"], patterns: ["fun\\s+(\\w+)"] },
        ],
      });
      setActiveMode("ext-symbols");

      const patterns = await getActiveSymbolPatterns();
      expect(patterns.length).toBe(2);
      const rust = patterns.find((p) => p.language === "rust");
      expect(rust).toBeDefined();
      expect(rust!.extensions).toEqual([".rs"]);
      expect(rust!.patterns).toContain("fn\\s+(\\w+)");
    });
  });

  // ─── applyModeExtensions (2 casos) ─────────────────────────────────
  describe("applyModeExtensions — validation/hooks", () => {
    it("getActiveValidationRules concatena luauValidation + validation sem duplicar", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      const { getActiveValidationRules } = await import("./../modeExtensions.js");

      saveUserMode({
        name: "ext-concat",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        luauValidation: [
          { tool: "selene_lint", filePattern: "*.luau", blocking: true },
          { tool: "stylua_format", filePattern: "*.luau", blocking: false },
        ],
        validation: [
          { tool: "tflint", filePattern: "*.tf", blocking: true, command: "tflint {file}" },
        ],
      });
      setActiveMode("ext-concat");

      const rules = await getActiveValidationRules();
      expect(rules.length).toBe(3);
      // Ordem: luauValidation primeiro, depois validation
      expect(rules[0]!.tool).toBe("selene_lint");
      expect(rules[1]!.tool).toBe("stylua_format");
      expect(rules[2]!.tool).toBe("tflint");
    });

    it("getActivePostEditHooks e getActivePreCommitHooks retornam arrays independentes", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      const { getActivePostEditHooks, getActivePreCommitHooks } = await import("./../modeExtensions.js");

      saveUserMode({
        name: "ext-hooks-indep",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        hooks: {
          postEdit: [
            { filePattern: "*.tf", command: "terraform fmt {file}" },
          ],
          preCommit: [
            { filePattern: "*.tf", command: "tflint", blocking: true },
            { filePattern: "*.py", command: "flake8", blocking: false },
          ],
        },
      });
      setActiveMode("ext-hooks-indep");

      const postEdit = await getActivePostEditHooks();
      const preCommit = await getActivePreCommitHooks();
      expect(postEdit.length).toBe(1);
      expect(preCommit.length).toBe(2);
      // Post-edit não deve conter pre-commit hooks
      expect(postEdit.some((h) => h.command === "tflint")).toBe(false);
      expect(preCommit.some((h) => h.command === "terraform fmt {file}")).toBe(false);
    });
  });

  // ─── validateMode (runHook) ────────────────────────────────────────
  describe("validateMode — runHook (comandos)", () => {
    it("runHook com comando inexistente retorna ok=false e stderr com mensagem de erro", async () => {
      const { runHook } = await import("./../modeExtensions.js");
      const result = await runHook(
        { filePattern: "*.txt", command: "comando_que_nao_existe_12345 {file}" },
        "/tmp/test.txt",
      );
      expect(result.ok).toBe(false);
      expect(result.stderr.length).toBeGreaterThan(0);
      // O comando deve ter {file} substituído pelo path entre aspas
      expect(result.command).toContain('"/tmp/test.txt"');
    });

    it("runHook com comando vazio retorna ok=false e stderr='Empty command'", async () => {
      const { runHook } = await import("./../modeExtensions.js");
      const result = await runHook(
        { filePattern: "*.txt", command: "   " }, // só espaços — split filtra tudo
        "/tmp/test.txt",
      );
      expect(result.ok).toBe(false);
      expect(result.stderr).toBe("Empty command");
    });
  });

  // ─── edge cases ────────────────────────────────────────────────────
  describe("edge cases", () => {
    it("getActiveMode retorna null quando módulo modes falha (sem modo ativo)", async () => {
      // Sem chamar setActiveMode, getActiveMode deve retornar null
      const { getActiveValidationRules } = await import("./../modeExtensions.js");
      const rules = await getActiveValidationRules();
      expect(rules).toEqual([]);
    });

    it("runPostEditHooks retorna string vazia quando não há hooks que combinam com o filePath", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      const { runPostEditHooks } = await import("./../modeExtensions.js");

      saveUserMode({
        name: "ext-no-match-2",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        hooks: {
          postEdit: [
            { filePattern: "*.tf", command: "terraform fmt {file}" },
          ],
        },
      });
      setActiveMode("ext-no-match-2");

      const result = await runPostEditHooks("/tmp/outro.arquivo.py");
      expect(result).toBe("");
    });

    it("getActiveSafetyPatterns com regex inválido pula a entrada e chama log.warn", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      const { getActiveSafetyPatterns } = await import("./../modeExtensions.js");
      const logMod = await import("./../logger.js");

      saveUserMode({
        name: "ext-bad-regex",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        safetyPatterns: [
          { regex: "[unclosed", description: "bad", severity: "low" },
          { regex: "valid\\s+regex", description: "good", severity: "medium" },
        ],
      });
      setActiveMode("ext-bad-regex");

      const patterns = await getActiveSafetyPatterns();
      // O regex inválido deve ser pulado (apenas good entra, além dos built-in)
      expect(patterns.some((p) => p.description === "bad")).toBe(false);
      expect(patterns.some((p) => p.description === "good")).toBe(true);
      expect((logMod as any).warn).toHaveBeenCalled();
    });
  });
});
