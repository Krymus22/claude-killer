/**
 * ensureRobloxTools.test.ts — Testes para verificação de tools Roblox.
 *
 * ensureRobloxTools.ts verifica se selene, stylua, rojo, lune estão instalados.
 * Como roda em CI sem essas tools, mockamos execSync.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
}));

// Mock child_process
const mockExecSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
}));

import { checkRobloxTools, warnIfMissingTools } from "../ensureRobloxTools.js";

describe("ensureRobloxTools", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  describe("checkRobloxTools", () => {
    it("retorna 4 tools", () => {
      // Simula: todas tools encontradas
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("which") || cmd.includes("where")) return "/usr/bin/selene";
        if (cmd.includes("--version")) return "1.0.0";
        return "";
      });
      const tools = checkRobloxTools();
      expect(tools).toHaveLength(4);
    });

    it("selene é required", () => {
      mockExecSync.mockImplementation(() => "/usr/bin/selene");
      const tools = checkRobloxTools();
      const selene = tools.find(t => t.name === "selene");
      expect(selene?.required).toBe(true);
    });

    it("stylua é required", () => {
      mockExecSync.mockImplementation(() => "/usr/bin/stylua");
      const tools = checkRobloxTools();
      const stylua = tools.find(t => t.name === "stylua");
      expect(stylua?.required).toBe(true);
    });

    it("rojo é opcional", () => {
      mockExecSync.mockImplementation(() => "/usr/bin/rojo");
      const tools = checkRobloxTools();
      const rojo = tools.find(t => t.name === "rojo");
      expect(rojo?.required).toBe(false);
    });

    it("lune é opcional", () => {
      mockExecSync.mockImplementation(() => "/usr/bin/lune");
      const tools = checkRobloxTools();
      const lune = tools.find(t => t.name === "lune");
      expect(lune?.required).toBe(false);
    });

    it("marca tool como installed quando encontra binary", () => {
      mockExecSync.mockImplementation(() => "/usr/bin/selene");
      const tools = checkRobloxTools();
      const selene = tools.find(t => t.name === "selene");
      expect(selene?.installed).toBe(true);
    });

    it("marca tool como NOT installed quando não encontra binary", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not found");
      });
      const tools = checkRobloxTools();
      for (const t of tools) {
        expect(t.installed).toBe(false);
        expect(t.path).toBeNull();
      }
    });

    it("cada tool tem installUrl", () => {
      mockExecSync.mockImplementation(() => "/usr/bin/x");
      const tools = checkRobloxTools();
      for (const t of tools) {
        expect(t.installUrl).toMatch(/^https?:\/\//);
      }
    });

    it("extrai versão quando --version funciona", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("--version")) return "selene 0.25.0";
        return "/usr/bin/selene";
      });
      const tools = checkRobloxTools();
      const selene = tools.find(t => t.name === "selene");
      expect(selene?.version).toContain("0.25.0");
    });

    it("version fica null se --version falha", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("--version")) throw new Error("no version");
        return "/usr/bin/selene";
      });
      const tools = checkRobloxTools();
      const selene = tools.find(t => t.name === "selene");
      expect(selene?.version).toBeNull();
    });
  });

  describe("warnIfMissingTools", () => {
    it("não lança erro quando todas tools estão instaladas", () => {
      mockExecSync.mockImplementation(() => "/usr/bin/x");
      expect(() => warnIfMissingTools()).not.toThrow();
    });

    it("não lança erro quando tools faltam (só warn)", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not found");
      });
      expect(() => warnIfMissingTools()).not.toThrow();
    });
  });
});
