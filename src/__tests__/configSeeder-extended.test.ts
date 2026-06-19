/**
 * configSeeder-extended.test.ts — Casos edge / error handling / integração para
 * configSeeder.ts que NÃO estão cobertos pelo teste básico.
 *
 * Foco (adaptado às funções reais do módulo):
 *   - seedUserConfig (3 casos) — fluxos não cobertos
 *   - shouldSeed (isSeeded/forceReseedOnNextRun) (2 casos)
 *   - mergeConfigs (idempotência + skip de arquivos existentes) (2 casos)
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

describe("configSeeder-extended", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-seed-ext-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  // ─── seedUserConfig ────────────────────────────────────────────────────
  describe("seedUserConfig (fluxos adicionais)", () => {
    it("escreve arquivo de marker (.seeded-v5) com versão correta após seed", async () => {
      const { seedUserConfig, isSeeded } = await import("./../configSeeder.js");
      seedUserConfig();
      expect(isSeeded()).toBe(true);

      // Verifica conteúdo do marker
      const markerPath = path.join(tmpHome, ".claude-killer", ".seeded-v5");
      expect(fs.existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      expect(marker.version).toBe("v5");
      expect(marker.seededAt).toBeDefined();
      expect(typeof marker.filesCopied).toBe("number");
    });

    it("segunda chamada retorna 0 (marker já existe) e não reescreve marker", async () => {
      const { seedUserConfig } = await import("./../configSeeder.js");
      const first = seedUserConfig();
      const markerPath = path.join(tmpHome, ".claude-killer", ".seeded-v5");
      const markerStat1 = fs.statSync(markerPath).mtimeMs;

      // Pequena espera para garantir mtime diferente
      await new Promise((r) => setTimeout(r, 20));

      const second = seedUserConfig();
      expect(second).toBe(0);
      expect(first).toBeGreaterThanOrEqual(0);

      // Marker não deve ser reescrito na segunda chamada
      const markerStat2 = fs.statSync(markerPath).mtimeMs;
      expect(markerStat2).toBe(markerStat1);
    });

    it("deve falhar graciosamente ao escrever marker (warn chamado, fluxo continua)", async () => {
      const { seedUserConfig } = await import("./../configSeeder.js");
      // Spy no writeFileSync e força erro APENAS para o arquivo marker
      const realWriteFileSync = fs.writeFileSync;
      const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((p: any, _data: any) => {
        const s = String(p);
        if (s.endsWith(".seeded-v5")) {
          throw new Error("simulated write error");
        }
        // Para outros arquivos, usa real
        return realWriteFileSync(p, _data);
      });

      // Recarrega módulo para usar fs spy
      vi.resetModules();
      const { seedUserConfig: seedAgain, isSeeded } = await import("./../configSeeder.js");
      expect(() => seedAgain()).not.toThrow();

      const logMod = await import("./../logger.js");
      expect(logMod.warn).toHaveBeenCalled();

      spy.mockRestore();
      void isSeeded;
    });
  });

  // ─── shouldSeed / isSeeded / forceReseedOnNextRun ─────────────────────
  describe("shouldSeed — isSeeded + forceReseedOnNextRun", () => {
    it("isSeeded retorna false antes de seedUserConfig e true depois", async () => {
      const { isSeeded, seedUserConfig } = await import("./../configSeeder.js");
      expect(isSeeded()).toBe(false);
      seedUserConfig();
      expect(isSeeded()).toBe(true);
    });

    it("forceReseedOnNextRun remove marker e permite re-seed", async () => {
      const { seedUserConfig, forceReseedOnNextRun, isSeeded } = await import("./../configSeeder.js");
      seedUserConfig();
      expect(isSeeded()).toBe(true);

      // Marca para re-seed
      forceReseedOnNextRun();
      // Marker deve ter sido removido (se existia)
      const markerPath = path.join(tmpHome, ".claude-killer", ".seeded-v5");
      // Como seedUserConfig foi chamado antes, marker existia — agora não mais
      expect(fs.existsSync(markerPath)).toBe(false);

      // Re-seed deve funcionar novamente
      const count = seedUserConfig();
      expect(count).toBeGreaterThanOrEqual(0);
      expect(isSeeded()).toBe(true);
    });
  });

  // ─── mergeConfigs — equivalente: não sobrescrever arquivos existentes ─
  describe("mergeConfigs — não sobrescreve customizações do usuário", () => {
    it("NÃO sobrescreve arquivo já existente na pasta tools/", async () => {
      const { seedUserConfig } = await import("./../configSeeder.js");
      seedUserConfig(); // primeira execução

      const userToolsDir = path.join(tmpHome, ".claude-killer", "tools");
      if (!fs.existsSync(userToolsDir)) {
        // Se não há tools/, pula este teste (depende do defaults/ existir)
        return;
      }

      // Cria arquivo custom fake com conteúdo único
      const customPath = path.join(userToolsDir, "custom_user_tool.json");
      fs.writeFileSync(customPath, JSON.stringify({ user: "custom" }), "utf8");

      // Re-seed (após forçar) não deve sobrescrever custom_user_tool.json
      const { forceReseedOnNextRun } = await import("./../configSeeder.js");
      forceReseedOnNextRun();
      seedUserConfig();

      const content = fs.readFileSync(customPath, "utf8");
      expect(content).toBe(JSON.stringify({ user: "custom" }));
    });

    it("seedUserConfig é idempotente: contagem de arquivos não cresce entre execuções após marker", async () => {
      const { seedUserConfig, forceReseedOnNextRun } = await import("./../configSeeder.js");
      const first = seedUserConfig();
      // Segunda chamada sem forçar re-seed retorna 0
      const second = seedUserConfig();
      expect(second).toBe(0);
      // Após forçar re-seed, contagem deve ser <= first (arquivos existentes não são re-copiados)
      forceReseedOnNextRun();
      const reseed = seedUserConfig();
      expect(reseed).toBeLessThanOrEqual(first);
    });
  });

  // ─── edge cases ────────────────────────────────────────────────────────
  describe("edge cases", () => {
    it("forceReseedOnNextRun não quebra quando marker não existe", async () => {
      const { forceReseedOnNextRun, isSeeded } = await import("./../configSeeder.js");
      expect(isSeeded()).toBe(false);
      // Não deve lançar
      expect(() => forceReseedOnNextRun()).not.toThrow();
      expect(isSeeded()).toBe(false);
    });

    it("seedUserConfig cria diretório .claude-killer se não existir", async () => {
      const { seedUserConfig, isSeeded } = await import("./../configSeeder.js");
      const configDir = path.join(tmpHome, ".claude-killer");
      // Remove qualquer diretório pré-existente
      if (fs.existsSync(configDir)) {
        fs.rmSync(configDir, { recursive: true, force: true });
      }
      expect(fs.existsSync(configDir)).toBe(false);

      seedUserConfig();
      // Diretório deve ter sido criado (mesmo que 0 arquivos copiados)
      expect(fs.existsSync(configDir)).toBe(true);
    });
  });
});
