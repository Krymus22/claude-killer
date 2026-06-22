/**
 * toolConfigurator.test.ts — Testa o configurador de tools (IA sub-agente).
 *
 * Sprint 12: Cobertura para toolConfigurator.ts:
 *   - detectToolsWithoutManifest: lista tools sem manifest, retorna vazio
 *     quando pasta tools/ não existe, retorna vazio quando todas têm manifest
 *   - isSafeCommand: permite --help, --version, where/find/ls; rejeita rm -rf
 *     e comandos arbitrários
 *
 * Mocka: logger, config.js, apiClient.js, toolDetector.js, fileFinder.js.
 * Usa um HOME temporário real.
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

// Mock config.js (importado mas não usado diretamente nos testes)
vi.mock("../config.js", () => ({
  config: { apiKey: "test-key", model: "test-model" },
}));

// Mock apiClient.js (chat é importado mas só usado em configureTool)
vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
}));

// Mock toolDetector.js (findToolBinary importado mas só usado em configureTool)
vi.mock("../toolDetector.js", () => ({
  findToolBinary: vi.fn(() => null),
}));

// Mock fileFinder.js (searchInDefinedFolders e copyToModeTools importados
// mas só usados em configureTool)
vi.mock("../fileFinder.js", () => ({
  searchInDefinedFolders: vi.fn(() => []),
  copyToModeTools: vi.fn(() => null),
}));

import { detectToolsWithoutManifest, isSafeCommand } from "../toolConfigurator.js";

describe("toolConfigurator", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-configurator-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("detectToolsWithoutManifest", () => {
    it("lista tools sem manifest (tool existe, manifest não existe)", () => {
      // Cria 2 tools em modes/roblox/tools/ sem manifests correspondentes
      const toolsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
      fs.mkdirSync(toolsDir, { recursive: true });
      fs.writeFileSync(path.join(toolsDir, "darklua"), "fake", "utf8");
      fs.writeFileSync(path.join(toolsDir, "rojo"), "fake", "utf8");

      // Cria manifest apenas para rojo
      const manifestsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "manifests");
      fs.mkdirSync(manifestsDir, { recursive: true });
      fs.writeFileSync(path.join(manifestsDir, "rojo.json"), "[]", "utf8");

      const result = detectToolsWithoutManifest("roblox");
      expect(result).toContain("darklua");
      expect(result).not.toContain("rojo");
    });

    it("retorna vazio quando pasta tools/ não existe", () => {
      // Não cria tools/ em lugar nenhum
      const result = detectToolsWithoutManifest("roblox");
      expect(result).toEqual([]);
    });

    it("retorna vazio quando todas as tools têm manifest", () => {
      // Cria tool + manifest correspondente
      const toolsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
      const manifestsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "manifests");
      fs.mkdirSync(toolsDir, { recursive: true });
      fs.mkdirSync(manifestsDir, { recursive: true });
      fs.writeFileSync(path.join(toolsDir, "rojo"), "fake", "utf8");
      fs.writeFileSync(path.join(manifestsDir, "rojo.json"), "[]", "utf8");

      const result = detectToolsWithoutManifest("roblox");
      expect(result).toEqual([]);
    });

    it("retorna vazio quando modeName é null", () => {
      expect(detectToolsWithoutManifest(null)).toEqual([]);
    });
  });

  describe("isSafeCommand", () => {
    it("permite '<bin> --help'", () => {
      expect(isSafeCommand("darklua --help")).toBe(true);
      expect(isSafeCommand("rojo --help")).toBe(true);
    });

    it("permite '<bin> --version'", () => {
      expect(isSafeCommand("darklua --version")).toBe(true);
      expect(isSafeCommand("/usr/bin/selene --version")).toBe(true);
    });

    it("permite 'where', 'find', 'ls' (e variantes)", () => {
      expect(isSafeCommand("where rojo")).toBe(true);
      expect(isSafeCommand("find . -name rojo")).toBe(true);
      expect(isSafeCommand("ls -la")).toBe(true);
    });

    it("rejeita 'rm -rf' (comando perigoso)", () => {
      expect(isSafeCommand("rm -rf /")).toBe(false);
      expect(isSafeCommand("rm -rf ~/Documents")).toBe(false);
    });

    it("rejeita comandos arbitrários (ex: curl, wget, npm install)", () => {
      expect(isSafeCommand("curl http://exemplo.com")).toBe(false);
      expect(isSafeCommand("npm install -g malware")).toBe(false);
      expect(isSafeCommand("echo hacked > /etc/passwd")).toBe(false);
    });
  });
});
