/**
 * manifestLoader.test.ts — Testa o carregamento de manifests por modo.
 *
 * Sprint 12: Cobertura para manifestLoader.ts:
 *   - loadModeManifests: carrega de user dir, fallback para bundled,
 *     tratamento de pasta inexistente e JSON inválido
 *   - loadActiveManifests: combina modo ativo + normal, sobrescreve normal
 *   - generateFunctionCallsFromManifests: 1 call por tool, ignora sem binary,
 *     inclui flags no schema
 *   - isManifestTool: true/false corretamente
 *   - executeFromManifest: erros quando tool não encontrada ou binary não encontrado
 *
 * Mocka: logger, modes.js (getActiveMode), toolDetector.js (findToolBinary),
 *        node:child_process (executeFromManifest).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock modes.js para controlar getActiveMode
const modesMock = vi.hoisted(() => ({
  getActiveMode: vi.fn(() => null),
}));
vi.mock("../modes.js", () => ({
  getActiveMode: modesMock.getActiveMode,
}));

// Mock toolDetector.js para controlar findToolBinary
const toolDetectorMock = vi.hoisted(() => ({
  findToolBinary: vi.fn(() => null),
}));
vi.mock("../toolDetector.js", () => ({
  findToolBinary: toolDetectorMock.findToolBinary,
}));

// Mock node:child_process para executeFromManifest
const cpMock = vi.hoisted(() => ({
  execSync: vi.fn(() => "ok output"),
}));
vi.mock("node:child_process", () => ({
  execSync: cpMock.execSync,
  spawn: vi.fn(),
}));

import {
  loadModeManifests,
  loadActiveManifests,
  generateFunctionCallsFromManifests,
  isManifestTool,
  executeFromManifest,
  type ToolManifest,
} from "../manifestLoader.js";

describe("manifestLoader", () => {
  let tmpHome: string;
  let origCwd: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-manifest-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    origCwd = process.cwd();
    vi.clearAllMocks();
    // Reset default mock returns
    modesMock.getActiveMode.mockReturnValue(null);
    toolDetectorMock.findToolBinary.mockReturnValue(null);
    cpMock.execSync.mockReturnValue("ok output");
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  /** Helper: cria um manifest JSON no dir do usuário. */
  function writeUserManifest(modeName: string, fileName: string, content: unknown): string {
    const dir = path.join(tmpHome, ".claude-killer", "modes", modeName, "manifests");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(content), "utf8");
    return filePath;
  }

  describe("loadModeManifests", () => {
    it("carrega manifests de user dir", () => {
      writeUserManifest("roblox", "rojo.json", [
        {
          name: "rojo_build",
          description: "Build .rbxl place file",
          category: "roblox",
          command: "rojo",
          args: ["build"],
        },
      ]);
      const manifests = loadModeManifests("roblox");
      expect(manifests.length).toBe(1);
      expect(manifests[0].name).toBe("rojo_build");
      expect(manifests[0].command).toBe("rojo");
    });

    it("carrega de bundled defaults quando user dir vazio", () => {
      // cwd aponta para a raiz do projeto, onde defaults/modes/roblox/manifests/ existe
      // Vai pular user dir (não existe) e usar bundled
      const manifests = loadModeManifests("roblox");
      // Pelo menos 1 manifest (rojo.json tem 3 tools, wally.json, etc.)
      expect(manifests.length).toBeGreaterThan(0);
      const names = manifests.map((m) => m.name);
      expect(names).toContain("rojo_build");
    });

    it("retorna vazio quando pasta não existe", () => {
      const manifests = loadModeManifests("modo-que-nao-existe-xyz");
      expect(manifests).toEqual([]);
    });

    it("ignora JSON inválido (continua carregando os outros)", () => {
      // Cria um JSON inválido
      const dir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "manifests");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "broken.json"), "{ not valid json", "utf8");
      // Cria um JSON válido
      writeUserManifest("roblox", "good.json", {
        name: "good_tool",
        description: "OK",
        category: "roblox",
        command: "good",
        args: [],
      });
      const manifests = loadModeManifests("roblox");
      // Apenas o válido deve ser carregado
      expect(manifests.length).toBe(1);
      expect(manifests[0].name).toBe("good_tool");
    });
  });

  describe("loadActiveManifests", () => {
    it("carrega do modo ativo + normal", () => {
      // Configura modo ativo = roblox
      modesMock.getActiveMode.mockReturnValue({ name: "roblox" });
      // Cria manifest no modo roblox (user dir)
      writeUserManifest("roblox", "rojo.json", [
        {
          name: "rojo_build",
          description: "Build",
          category: "roblox",
          command: "rojo",
          args: ["build"],
        },
      ]);
      // Cria manifest no modo normal (user dir)
      writeUserManifest("normal", "darklua.json", [
        {
          name: "darklua_process",
          description: "Process",
          category: "normal",
          command: "darklua",
          args: ["process"],
        },
      ]);
      const manifests = loadActiveManifests();
      const names = manifests.map((m) => m.name);
      expect(names).toContain("rojo_build");
      expect(names).toContain("darklua_process");
    });

    it("manifest do modo específico sobrescreve normal (mesmo name)", () => {
      modesMock.getActiveMode.mockReturnValue({ name: "roblox" });
      // Manifest "x" no normal
      writeUserManifest("normal", "x.json", {
        name: "shared_tool",
        description: "Normal version",
        category: "normal",
        command: "normal-cmd",
        args: [],
      });
      // Manifest "x" no roblox (sobrescreve)
      writeUserManifest("roblox", "x.json", {
        name: "shared_tool",
        description: "Roblox version",
        category: "roblox",
        command: "roblox-cmd",
        args: [],
      });
      const manifests = loadActiveManifests();
      const shared = manifests.find((m) => m.name === "shared_tool");
      expect(shared).toBeDefined();
      expect(shared!.description).toBe("Roblox version");
      expect(shared!.command).toBe("roblox-cmd");
    });
  });

  describe("generateFunctionCallsFromManifests", () => {
    it("gera 1 call por tool (quando binary existe)", () => {
      toolDetectorMock.findToolBinary.mockReturnValue("/path/to/binary");
      const manifests: ToolManifest[] = [
        {
          name: "tool_a",
          description: "Tool A",
          category: "x",
          command: "a",
          args: [],
        },
        {
          name: "tool_b",
          description: "Tool B",
          category: "x",
          command: "b",
          args: [],
        },
      ];
      const calls = generateFunctionCallsFromManifests(manifests, "roblox");
      expect(calls.length).toBe(2);
      expect(calls[0].function.name).toBe("tool_a");
      expect(calls[1].function.name).toBe("tool_b");
    });

    it("não inclui tools sem binary", () => {
      // Primeira chamada retorna path, segunda retorna null
      toolDetectorMock.findToolBinary
        .mockReturnValueOnce("/path/to/a")
        .mockReturnValueOnce(null);
      const manifests: ToolManifest[] = [
        { name: "tool_a", description: "A", category: "x", command: "a", args: [] },
        { name: "tool_b", description: "B", category: "x", command: "b", args: [] },
      ];
      const calls = generateFunctionCallsFromManifests(manifests, "roblox");
      expect(calls.length).toBe(1);
      expect(calls[0].function.name).toBe("tool_a");
    });

    it("inclui flags no schema de propriedades", () => {
      toolDetectorMock.findToolBinary.mockReturnValue("/path/to/binary");
      const manifests: ToolManifest[] = [
        {
          name: "rojo_build",
          description: "Build",
          category: "roblox",
          command: "rojo",
          args: ["build"],
          flags: [
            { name: "--output", type: "string", description: "Output path" },
            { name: "--watch", type: "boolean", description: "Watch mode" },
          ],
        },
      ];
      const calls = generateFunctionCallsFromManifests(manifests, "roblox");
      expect(calls.length).toBe(1);
      const props = calls[0].function.parameters.properties;
      // flag --output vira "output" (sem --)
      expect(props.output).toBeDefined();
      expect(props.output.type).toBe("string");
      // flag --watch vira "watch"
      expect(props.watch).toBeDefined();
      expect(props.watch.type).toBe("boolean");
      // dir sempre está presente
      expect(props.dir).toBeDefined();
    });
  });

  describe("isManifestTool", () => {
    it("retorna true quando tool está na lista de manifests", () => {
      const manifests: ToolManifest[] = [
        { name: "rojo_build", description: "Build", category: "x", command: "rojo", args: [] },
      ];
      expect(isManifestTool("rojo_build", manifests)).toBe(true);
    });

    it("retorna false quando tool NÃO está na lista de manifests", () => {
      const manifests: ToolManifest[] = [
        { name: "rojo_build", description: "Build", category: "x", command: "rojo", args: [] },
      ];
      expect(isManifestTool("outro_tool", manifests)).toBe(false);
    });
  });

  describe("executeFromManifest", () => {
    it("retorna erro quando tool não encontrada nos manifests", async () => {
      const manifests: ToolManifest[] = [
        { name: "rojo_build", description: "Build", category: "x", command: "rojo", args: [] },
      ];
      const result = await executeFromManifest("tool_inexistente", {}, manifests, "roblox");
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toMatch(/not found in manifests/);
    });

    it("retorna erro quando binary não encontrado", async () => {
      toolDetectorMock.findToolBinary.mockReturnValue(null);
      const manifests: ToolManifest[] = [
        { name: "rojo_build", description: "Build", category: "x", command: "rojo", args: ["build"] },
      ];
      const result = await executeFromManifest("rojo_build", {}, manifests, "roblox");
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toMatch(/Binary "rojo" not found/);
    });
  });
});
