/**
 * externalTools-extended.test.ts — Casos edge que NÃO estão no teste básico.
 * Foco em: getRegistry (3 extras), detectFromContext (2 extras), suggest (2 extras)
 * e edge cases (1).
 *
 * PT-BR nos comentários.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ToolRegistry,
  ToolDetector,
  ToolExecutor,
  ToolSuggester,
  type Tool,
} from "../externalTools.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

// Mock do toolDetector (módulo externo) usado pelo isInstalled para deep detection
vi.mock("../toolDetector.js", () => ({
  detectTool: vi.fn(() => ({ status: "missing", binaryPath: null, version: null })),
}));

const baseTool: Tool = {
  name: "base_tool",
  description: "Base",
  category: "custom",
  command: "echo",
  args: ["hi"],
  flags: [],
  detection: { method: "binary", check: "echo --version" },
  context: { whenToUse: ["run tests"], examples: [] },
  outputParser: "raw",
};

describe("externalTools — extended", () => {
  // ─── getRegistry / ToolRegistry (3 extras) ─────────────────────────────────

  describe("ToolRegistry — extras", () => {
    let registry: ToolRegistry;
    beforeEach(() => {
      registry = new ToolRegistry();
    });

    it("getByCategory retorna array vazio para categoria sem tools", () => {
      registry.register(baseTool); // category: custom
      expect(registry.getByCategory("rust")).toEqual([]);
      expect(registry.getByCategory("docker")).toEqual([]);
    });

    it("searchByIntent é case-insensitive", () => {
      registry.register({
        ...baseTool,
        name: "ci_tool",
        context: { whenToUse: ["Run Tests"], examples: [] },
      });
      // Mensagens com variações de case devem todas bater
      expect(registry.searchByIntent("RUN TESTS").length).toBeGreaterThan(0);
      expect(registry.searchByIntent("run tests").length).toBeGreaterThan(0);
      expect(registry.searchByIntent("Run Tests Now").length).toBeGreaterThan(0);
    });

    it("registerAll adiciona múltiplas tools preservando ordem de inserção", () => {
      const tools: Tool[] = [
        { ...baseTool, name: "t1" },
        { ...baseTool, name: "t2" },
        { ...baseTool, name: "t3" },
      ];
      registry.registerAll(tools);
      const all = registry.getAll();
      expect(all.map((t) => t.name)).toEqual(["t1", "t2", "t3"]);
    });

    it("getToolStatus retorna 'missing' para tool inexistente", () => {
      expect(registry.getToolStatus("ghost")).toBe("missing");
    });
  });

  // ─── detectFromContext (2 extras) ──────────────────────────────────────────

  describe("ToolDetector — extras", () => {
    let registry: ToolRegistry;
    let detector: ToolDetector;
    beforeEach(() => {
      registry = new ToolRegistry();
      detector = new ToolDetector(registry);
    });

    it("detectFromContext respeita 'requiresProject' com múltiplos arquivos", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-et-"));
      // Só cria 1 dos 2 arquivos exigidos → não detecta
      fs.writeFileSync(path.join(tmp, "a.txt"), "");
      registry.register({
        ...baseTool,
        name: "multi_req",
        context: { whenToUse: [], requiresProject: ["a.txt", "b.txt"], examples: [] },
      });
      const r1 = detector.detectFromContext(tmp);
      expect(r1).toEqual([]);

      // Cria o segundo arquivo → detecta
      fs.writeFileSync(path.join(tmp, "b.txt"), "");
      const r2 = detector.detectFromContext(tmp);
      expect(r2.some((t) => t.name === "multi_req")).toBe(true);

      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("detect retorna {intent, context} simultaneamente", () => {
      registry.register({
        ...baseTool,
        name: "t_intent",
        context: { whenToUse: ["deploy"], requiresProject: ["package.json"], examples: [] },
      });
      const result = detector.detect("please deploy this", ".");
      expect(result.intent?.tool).toBe("t_intent");
      expect(Array.isArray(result.context)).toBe(true);
    });
  });

  // ─── suggest (2 extras) ────────────────────────────────────────────────────

  describe("ToolSuggester — extras", () => {
    let registry: ToolRegistry;
    let suggester: ToolSuggester;
    beforeEach(() => {
      registry = new ToolRegistry();
      suggester = new ToolSuggester(registry);
    });

    it("boost de confidence acumula: intent (0.5) + command (0.3) = 0.8", () => {
      registry.register({
        ...baseTool,
        name: "pytest_run",
        command: "pytest",
        context: { whenToUse: ["run pytest"], examples: [] },
      });
      const suggestions = suggester.suggest("run pytest on code");
      const first = suggestions[0];
      expect(first.confidence).toBeGreaterThanOrEqual(0.8);
      expect(first.reason).toContain("pattern");
      expect(first.reason).toContain("command");
    });

    it("suggestions incluem tool cujo pattern casa com a mensagem", () => {
      registry.register({
        ...baseTool,
        name: "exact_match",
        command: "uniquecmd",
        context: { whenToUse: ["unique_pattern_xyz"], examples: [] },
      });
      const suggestions = suggester.suggest("please run unique_pattern_xyz now");
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].tool.name).toBe("exact_match");
      expect(suggestions[0].confidence).toBeGreaterThan(0);
    });
  });

  // ─── Edge cases (1) ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("addTool rejeita tool sem command (falha validação básica)", () => {
      const registry = new ToolRegistry();
      const r = registry.addTool({
        name: "x",
        description: "desc",
        command: "", // command vazio
        category: "custom",
        args: [],
        flags: [],
        detection: { method: "binary", check: "" },
        context: { whenToUse: [], examples: [] },
        outputParser: "raw",
      });
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/name and command/i);
    });

    it("updateUserTool em tool inexistente retorna falha descritiva", () => {
      const registry = new ToolRegistry();
      const r = registry.updateUserTool("ghost", { description: "x" });
      expect(r.success).toBe(false);
      expect(r.message).toContain("not found");
    });

    it("ToolExecutor retorna erro específico quando tool não está instalada", async () => {
      const registry = new ToolRegistry();
      registry.register({
        ...baseTool,
        name: "uninstalled_xyz",
        detection: { method: "manual", check: "", installed: false },
      });
      const executor = new ToolExecutor(registry);
      const r = await executor.execute("uninstalled_xyz");
      expect(r.success).toBe(false);
      expect(r.errors?.[0]).toContain("not installed");
      expect(r.suggestions?.[0]).toContain("Install");
    });
  });
});
