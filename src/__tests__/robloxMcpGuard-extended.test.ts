/**
 * robloxMcpGuard-extended.test.ts — Mais testes para robloxMcpGuard.ts.
 *
 * Cobertura extra para classifyMcpTool, extractToolName, isRobloxStudioMcpTool,
 * evaluateMcpToolCall, getAllowedRobloxMcpTools, getBlockedRobloxMcpTools.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
}));

import {
  classifyMcpTool,
  extractToolName,
  isRobloxStudioMcpTool,
  evaluateMcpToolCall,
  getAllowedRobloxMcpTools,
  getBlockedRobloxMcpTools,
} from "../robloxMcpGuard.js";

describe("robloxMcpGuard — extended", () => {
  describe("classifyMcpTool", () => {
    it("classifica script_read como read", () => {
      expect(classifyMcpTool("script_read")).toBe("read");
    });

    it("classifica multi_edit como write", () => {
      expect(classifyMcpTool("multi_edit")).toBe("write");
    });

    it("classifica execute_luau como execute", () => {
      expect(classifyMcpTool("execute_luau")).toBe("execute");
    });

    it("classifica start_stop_play como playtest", () => {
      expect(classifyMcpTool("start_stop_play")).toBe("playtest");
    });

    it("classifica set_active_studio como session", () => {
      expect(classifyMcpTool("set_active_studio")).toBe("session");
    });

    it("classifica tool desconhecida como unknown", () => {
      expect(classifyMcpTool("nonexistent_tool_xyz")).toBe("unknown");
    });

    it("classifica string vazia como unknown", () => {
      expect(classifyMcpTool("")).toBe("unknown");
    });

    it("classifica get_studio_state como read (adicionada recentemente)", () => {
      expect(classifyMcpTool("get_studio_state")).toBe("read");
    });

    it("é case-sensitive (espera lowercase)", () => {
      // TOOL_CLASSIFICATION usa keys lowercase
      expect(classifyMcpTool("SCRIPT_READ")).toBe("unknown");
      expect(classifyMcpTool("Multi_Edit")).toBe("unknown");
    });
  });

  describe("extractToolName", () => {
    it("extrai tool name de Roblox_Studio__multi_edit", () => {
      expect(extractToolName("Roblox_Studio__multi_edit")).toBe("multi_edit");
    });

    it("extrai tool name de roblox_studio__script_read", () => {
      expect(extractToolName("roblox_studio__script_read")).toBe("script_read");
    });

    it("retorna nome original se não tem prefixo", () => {
      expect(extractToolName("multi_edit")).toBe("multi_edit");
    });

    it("lida com string vazia", () => {
      expect(extractToolName("")).toBe("");
    });

    it("lida com apenas prefixo", () => {
      expect(extractToolName("Roblox_Studio__")).toBe("");
    });

    it("lida com múltiplos __", () => {
      expect(extractToolName("Roblox_Studio__sub__tool")).toBe("sub__tool");
    });
  });

  describe("isRobloxStudioMcpTool", () => {
    it("true para Roblox_Studio__prefix", () => {
      expect(isRobloxStudioMcpTool("Roblox_Studio__multi_edit")).toBe(true);
    });

    it("true para roblox_studio__prefix (lowercase)", () => {
      expect(isRobloxStudioMcpTool("roblox_studio__script_read")).toBe(true);
    });

    it("true para RobloxStudio__prefix", () => {
      expect(isRobloxStudioMcpTool("RobloxStudio__tool")).toBe(true);
    });

    it("false para outro servidor MCP", () => {
      expect(isRobloxStudioMcpTool("github__search_repos")).toBe(false);
    });

    it("false para tool sem prefixo", () => {
      expect(isRobloxStudioMcpTool("multi_edit")).toBe(false);
    });

    it("false para string vazia", () => {
      expect(isRobloxStudioMcpTool("")).toBe(false);
    });
  });

  describe("evaluateMcpToolCall - read tools", () => {
    it("permite script_read", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__script_read", {});
      expect(result.allowed).toBe(true);
      expect(result.category).toBe("read");
    });

    it("permite get_studio_state", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__get_studio_state", {});
      expect(result.allowed).toBe(true);
      expect(result.category).toBe("read");
    });

    it("não loga para read tools", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__script_read", {});
      expect(result.shouldLog).toBe(false);
    });
  });

  describe("evaluateMcpToolCall - write tools", () => {
    it("bloqueia multi_edit", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__multi_edit", { path: "/test.luau" });
      expect(result.allowed).toBe(false);
      expect(result.category).toBe("write");
      expect(result.blockReason).toBeTruthy();
    });

    it("bloqueia generate_mesh", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__generate_mesh", {});
      expect(result.allowed).toBe(false);
    });

    it("bloqueia generate_material", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__generate_material", {});
      expect(result.allowed).toBe(false);
    });

    it("bloqueia generate_procedural_model", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__generate_procedural_model", {});
      expect(result.allowed).toBe(false);
    });

    it("bloqueia insert_from_creator_store", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__insert_from_creator_store", {});
      expect(result.allowed).toBe(false);
    });

    it("blockReason menciona aplicar_diff para multi_edit", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__multi_edit", { path: "/test.luau" });
      if (result.blockReason) {
        expect(result.blockReason.toLowerCase()).toContain("aplicar_diff");
      }
    });

    it("loga para write tools bloqueadas", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__multi_edit", {});
      expect(result.shouldLog).toBe(true);
    });
  });

  describe("evaluateMcpToolCall - execute tools", () => {
    it("permite execute_luau com log", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__execute_luau", {});
      expect(result.allowed).toBe(true);
      expect(result.category).toBe("execute");
      expect(result.shouldLog).toBe(true);
    });

    it("permite run_script_in_play_mode com log", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__run_script_in_play_mode", {});
      expect(result.allowed).toBe(true);
      expect(result.shouldLog).toBe(true);
    });
  });

  describe("evaluateMcpToolCall - playtest tools", () => {
    it("permite start_stop_play", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__start_stop_play", {});
      expect(result.allowed).toBe(true);
      expect(result.category).toBe("playtest");
    });

    it("permite screen_capture", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__screen_capture", {});
      expect(result.allowed).toBe(true);
    });

    it("permite keyboard_input", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__keyboard_input", {});
      expect(result.allowed).toBe(true);
    });

    it("permite mouse_input", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__mouse_input", {});
      expect(result.allowed).toBe(true);
    });

    it("não loga para playtest tools", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__start_stop_play", {});
      expect(result.shouldLog).toBe(false);
    });
  });

  describe("evaluateMcpToolCall - session tools", () => {
    it("permite set_active_studio", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__set_active_studio", {});
      expect(result.allowed).toBe(true);
      expect(result.category).toBe("session");
    });
  });

  describe("evaluateMcpToolCall - unknown tools (default-allow)", () => {
    it("permite tool desconhecida (default-allow policy)", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__unknown_new_tool", {});
      expect(result.allowed).toBe(true);
      expect(result.category).toBe("unknown");
    });

    it("não tem blockReason para unknown permitida", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__unknown_tool", {});
      expect(result.blockReason).toBeUndefined();
    });
  });

  describe("evaluateMcpToolCall - non-Roblox MCP", () => {
    it("permite tools de outros servidores MCP sem verificar", () => {
      const result = evaluateMcpToolCall("github__search_repos", {});
      expect(result.allowed).toBe(true);
      expect(result.category).toBe("unknown");
      expect(result.shouldLog).toBe(false);
    });
  });

  describe("getAllowedRobloxMcpTools", () => {
    it("retorna array", () => {
      const tools = getAllowedRobloxMcpTools();
      expect(Array.isArray(tools)).toBe(true);
    });

    it("inclui tools read", () => {
      const tools = getAllowedRobloxMcpTools();
      expect(tools).toContain("script_read");
    });

    it("inclui tools execute", () => {
      const tools = getAllowedRobloxMcpTools();
      expect(tools).toContain("execute_luau");
    });

    it("inclui tools playtest", () => {
      const tools = getAllowedRobloxMcpTools();
      expect(tools).toContain("start_stop_play");
    });

    it("NÃO inclui tools write", () => {
      const tools = getAllowedRobloxMcpTools();
      expect(tools).not.toContain("multi_edit");
      expect(tools).not.toContain("generate_mesh");
    });
  });

  describe("getBlockedRobloxMcpTools", () => {
    it("retorna array", () => {
      const tools = getBlockedRobloxMcpTools();
      expect(Array.isArray(tools)).toBe(true);
    });

    it("inclui multi_edit", () => {
      const tools = getBlockedRobloxMcpTools();
      expect(tools).toContain("multi_edit");
    });

    it("inclui generate_mesh", () => {
      const tools = getBlockedRobloxMcpTools();
      expect(tools).toContain("generate_mesh");
    });

    it("inclui insert_from_creator_store", () => {
      const tools = getBlockedRobloxMcpTools();
      expect(tools).toContain("insert_from_creator_store");
    });

    it("NÃO inclui tools read", () => {
      const tools = getBlockedRobloxMcpTools();
      expect(tools).not.toContain("script_read");
    });
  });
});
