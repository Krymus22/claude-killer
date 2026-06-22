/**
 * findToolBinary.test.ts — Testa a busca de binários em modes/<mode>/tools/.
 *
 * Sprint 12: Cobertura para findToolBinary, getModeToolsDir e listModeTools
 * do módulo toolDetector.ts. Usa um HOME temporário real para não afetar
 * o ambiente do desenvolvedor.
 *
 * Casos:
 *   - retorna path quando binary existe em modes/<mode>/tools/
 *   - retorna null quando binary não existe
 *   - adiciona .exe no Windows
 *   - não adiciona extensão no Linux/macOS
 *   - lida com mode null
 *   - lida com toolName vazio
 *   - olha no modo normal (base) quando não encontra no modo ativo
 *   - fallback para detectTool (legacy) quando não encontra em nenhum modo
 *   - getModeToolsDir retorna path correto
 *   - listModeTools lista arquivos na pasta tools/
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock logger para silenciar output
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock node:child_process para impedir que detectTool encontre binários
// via `which`/`where` no PATH — assim o fallback sempre retorna null e
// os testes ficam determinísticos.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("mocked: command not found");
  }),
  spawn: vi.fn(),
}));

import {
  findToolBinary,
  getModeToolsDir,
  listModeTools,
} from "../toolDetector.js";

describe("findToolBinary", () => {
  let tmpHome: string;
  let originalPlatform: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-ftb-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    originalPlatform = process.platform;
  });

  afterEach(() => {
    // Restaura platform
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.resetModules();
  });

  /** Helper: cria arquivo de tool em modes/<mode>/tools/. */
  function createToolFile(modeName: string, fileName: string): string {
    const dir = path.join(tmpHome, ".claude-killer", "modes", modeName, "tools");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, "fake binary", "utf8");
    return filePath;
  }

  it("retorna path quando binary existe em modes/<mode>/tools/", () => {
    const filePath = createToolFile("roblox", "rojo");
    const result = findToolBinary("rojo", "roblox");
    expect(result).toBe(filePath);
  });

  it("retorna null quando binary não existe", () => {
    const result = findToolBinary("nonexistent-tool-xyz-12345", "roblox");
    expect(result).toBeNull();
  });

  it("adiciona .exe no Windows", () => {
    // Simula Windows
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const filePath = createToolFile("roblox", "rojo.exe");
    const result = findToolBinary("rojo", "roblox");
    expect(result).toBe(filePath);
    expect(result).toMatch(/rojo\.exe$/);
  });

  it("não adiciona extensão no Linux/macOS", () => {
    // Plataforma atual (Linux no CI) — não adiciona extensão
    if (process.platform === "win32") return; // skip em Windows real
    const filePath = createToolFile("roblox", "rojo");
    const result = findToolBinary("rojo", "roblox");
    expect(result).toBe(filePath);
    expect(result).not.toMatch(/\.exe$/);
  });

  it("lida com mode null (pula busca em modes/ e vai pro normal/fallback)", () => {
    // Sem mode e sem binary em modes/normal/tools/ → fallback para detectTool → null
    const result = findToolBinary("no-such-binary-zzz", null);
    expect(result).toBeNull();
  });

  it("lida com toolName vazio", () => {
    const result = findToolBinary("", "roblox");
    expect(result).toBeNull();
  });

  it("olha no modo normal (base) quando não encontra no modo ativo", () => {
    // Cria o binary no modo normal, mas não no roblox
    const filePath = createToolFile("normal", "selene");
    // Não cria em roblox
    const result = findToolBinary("selene", "roblox");
    expect(result).toBe(filePath);
    expect(result).toContain(path.join("modes", "normal", "tools"));
  });

  it("fallback para detectTool (legacy) retorna null quando não encontra em nenhum modo", () => {
    // Não cria o binary em nenhum lugar; detectTool está mockado para falhar
    const result = findToolBinary("tool-que-nao-existe-em-lugar-nenhum", "roblox");
    expect(result).toBeNull();
  });

  describe("getModeToolsDir", () => {
    it("retorna path correto para o modo", () => {
      const dir = getModeToolsDir("roblox");
      expect(dir).toContain(path.join(".claude-killer", "modes", "roblox", "tools"));
      expect(dir).toContain(tmpHome);
    });
  });

  describe("listModeTools", () => {
    it("lista arquivos na pasta tools/", () => {
      // Cria 2 tools no modo roblox
      createToolFile("roblox", "rojo");
      createToolFile("roblox", "selene");
      // Cria um subdir (deve ser ignorado — só lista arquivos)
      fs.mkdirSync(path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools", "subdir"), {
        recursive: true,
      });

      const tools = listModeTools("roblox");
      expect(tools.length).toBe(2);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["rojo", "selene"]);
      // Paths devem ser completos
      expect(tools[0].path).toContain(tmpHome);
    });

    it("retorna vazio quando pasta tools/ não existe", () => {
      const tools = listModeTools("modo-inexistente-xyz");
      expect(tools).toEqual([]);
    });
  });
});
