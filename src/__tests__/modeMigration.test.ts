/**
 * modeMigration.test.ts — Testa a migração do formato antigo para o novo.
 *
 * Sprint 12: Cobertura para modeMigration.ts:
 *   - needsMigration: false quando não há .claude-killer
 *   - needsMigration: false quando nova estrutura já existe
 *   - needsMigration: true quando hub.json existe mas config.json não
 *   - migrateToModeStructure: cria pastas para cada modo
 *   - migrateToModeStructure: copia config.json
 *   - migrateToModeStructure: copia skills
 *   - migrateToModeStructure: faz backup de hub.json
 *   - runMigrationIfNeeded: retorna false quando não precisa migrar
 *
 * Usa um HOME temporário real. cwd é a raiz do projeto, onde defaults/modes/
 * está disponível como fonte da migração.
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

import {
  needsMigration,
  migrateToModeStructure,
  runMigrationIfNeeded,
} from "../modeMigration.js";

describe("modeMigration", () => {
  let tmpHome: string;
  let origCwd: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-migration-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    origCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("needsMigration", () => {
    it("retorna false quando não há .claude-killer", () => {
      // tmpHome está vazio — sem .claude-killer
      expect(needsMigration()).toBe(false);
    });

    it("retorna false quando nova estrutura já existe", () => {
      // Cria a nova estrutura: ~/.claude-killer/modes/roblox/config.json
      const newConfigPath = path.join(tmpHome, ".claude-killer", "modes", "roblox", "config.json");
      fs.mkdirSync(path.dirname(newConfigPath), { recursive: true });
      fs.writeFileSync(newConfigPath, "{}", "utf8");
      expect(needsMigration()).toBe(false);
    });

    it("retorna true quando hub.json existe mas config.json não", () => {
      // Cria hub.json (formato antigo) mas SEM modes/roblox/config.json
      const ckDir = path.join(tmpHome, ".claude-killer");
      fs.mkdirSync(ckDir, { recursive: true });
      fs.writeFileSync(path.join(ckDir, "hub.json"), '{"old":"format"}', "utf8");
      expect(needsMigration()).toBe(true);
    });
  });

  describe("migrateToModeStructure", () => {
    beforeEach(() => {
      // Garante que existe um hub.json para a migração fazer backup
      const ckDir = path.join(tmpHome, ".claude-killer");
      fs.mkdirSync(ckDir, { recursive: true });
      fs.writeFileSync(path.join(ckDir, "hub.json"), '{"old":"format"}', "utf8");
      // Garante cwd = raiz do projeto (onde defaults/modes/ existe)
      process.chdir(origCwd);
    });

    it("cria pastas para cada modo (tools, manifests, skills, hooks, mcps, inbox)", () => {
      const result = migrateToModeStructure();
      // Verifica que pelo menos roblox mode foi criado com as subpastas
      const robloxDir = path.join(tmpHome, ".claude-killer", "modes", "roblox");
      expect(fs.existsSync(path.join(robloxDir, "tools"))).toBe(true);
      expect(fs.existsSync(path.join(robloxDir, "manifests"))).toBe(true);
      expect(fs.existsSync(path.join(robloxDir, "skills"))).toBe(true);
      expect(fs.existsSync(path.join(robloxDir, "hooks"))).toBe(true);
      expect(fs.existsSync(path.join(robloxDir, "mcps"))).toBe(true);
      expect(fs.existsSync(path.join(robloxDir, "inbox"))).toBe(true);
      // Deve ter criado alguma coisa
      expect(result.created.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    it("copia config.json de defaults para user dir", () => {
      migrateToModeStructure();
      const userConfig = path.join(tmpHome, ".claude-killer", "modes", "roblox", "config.json");
      expect(fs.existsSync(userConfig)).toBe(true);
      // O conteúdo deve ser JSON válido
      const content = JSON.parse(fs.readFileSync(userConfig, "utf8"));
      expect(content.name).toBe("roblox");
    });

    it("copia skills da defaults para user dir (roblox tem skills/)", () => {
      migrateToModeStructure();
      const userSkillsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "skills");
      // defaults/modes/roblox/skills/ tem vários .md (rokit-cli.md, etc.)
      const files = fs.existsSync(userSkillsDir) ? fs.readdirSync(userSkillsDir) : [];
      expect(files.length).toBeGreaterThan(0);
      expect(files.some((f) => f.endsWith(".md"))).toBe(true);
    });

    it("faz backup de hub.json → hub.json.bak", () => {
      const result = migrateToModeStructure();
      const backupPath = path.join(tmpHome, ".claude-killer", "hub.json.bak");
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(result.backedUp.some((b) => b.includes("hub.json"))).toBe(true);
      // Conteúdo do backup deve ser igual ao original
      const backupContent = fs.readFileSync(backupPath, "utf8");
      expect(backupContent).toContain('{"old":"format"}');
    });
  });

  describe("runMigrationIfNeeded", () => {
    it("retorna false quando não precisa migrar (sem .claude-killer)", () => {
      // tmpHome vazio — não tem .claude-killer, não precisa migrar
      const result = runMigrationIfNeeded();
      expect(result).toBe(false);
    });

    it("retorna true e migra quando precisa (hub.json existe, nova estrutura não)", () => {
      const ckDir = path.join(tmpHome, ".claude-killer");
      fs.mkdirSync(ckDir, { recursive: true });
      fs.writeFileSync(path.join(ckDir, "hub.json"), '{"old":"format"}', "utf8");
      const result = runMigrationIfNeeded();
      expect(result).toBe(true);
      // Verifica que a migração realmente aconteceu
      expect(fs.existsSync(path.join(ckDir, "modes", "roblox", "config.json"))).toBe(true);
    });
  });
});
