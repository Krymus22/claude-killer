/**
 * i18n-extended.test.ts — Casos edge / error handling / integração para
 * i18n.ts que NÃO estão cobertos pelo teste básico.
 *
 * Foco:
 *   - translate (getCommandI18n) (3 casos) — fallbacks e línguas raras
 *   - detectLocale (detectLanguage) (2 casos) — variações de casing/formato
 *   - getLocalizedSlashCommands (2 casos)
 *   - edge cases (1 caso)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalEnv = { ...process.env };

beforeEach(async () => {
  // Reset language-related env vars EXCEPT CLAUDE_KILLER_LANG (set by vitest-setup.ts)
  delete process.env.LANG;
  delete process.env.LC_ALL;
  delete process.env.LC_MESSAGES;
  delete process.env.LANGUAGE;
  // Keep CLAUDE_KILLER_LANG=en (from setup) so tests default to English
  process.env.CLAUDE_KILLER_LANG = "en";
  vi.resetModules();
  // Reset i18n cache after module reset
  const mod = await import("./../i18n.js");
  mod.resetAllLanguageState();
});

afterEach(async () => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  const mod = await import("./../i18n.js");
  mod.resetAllLanguageState();
});

// ─── translate (getCommandI18n) ────────────────────────────────────────────
describe("translate — getCommandI18n (fallbacks e variações)", () => {
  it("faz fallback para inglês quando idioma detectado não tem tradução (apenas en)", async () => {
    const { getCommandI18n } = await import("./../i18n.js");
    // /exit tem apenas en e pt-BR — mas o fallback interno é sempre en
    const i18n = getCommandI18n("/exit");
    expect(i18n.desc).toBe("Exit");
  });

  it("respeita case-insensitive em CLAUDE_KILLER_LANG (PT-BR maiúsculo)", async () => {
    process.env.CLAUDE_KILLER_LANG = "PT-BR"; // maiúsculo
    const { getCommandI18n } = await import("./../i18n.js");
    const i18n = getCommandI18n("/help");
    expect(i18n.desc).toBe("Mostrar ajuda");
  });

  it("trata comando desconhecido retornando {desc: ''} sem subcommands", async () => {
    const { getCommandI18n } = await import("./../i18n.js");
    const i18n = getCommandI18n("/command-that-does-not-exist");
    expect(i18n.desc).toBe("");
    expect(i18n.subcommands).toBeUndefined();
  });
});

// ─── detectLocale (detectLanguage) ─────────────────────────────────────────
describe("detectLocale — detectLanguage (variações de formato)", () => {
  it("detecta pt-BR a partir de variações de formatação (pt-br, pt_BR, pt, pt-PT)", async () => {
    delete process.env.CLAUDE_KILLER_LANG;
    // pt-br (com hífen, lowercase)
    process.env.LC_MESSAGES = "pt-br";
    let { detectLanguage, resetLanguageCache } = await import("./../i18n.js");
    resetLanguageCache();
    expect(detectLanguage()).toBe("pt-BR");

    delete process.env.LC_MESSAGES;
    vi.resetModules();

    // pt (apenas prefixo)
    process.env.LC_ALL = "pt";
    ({ detectLanguage, resetLanguageCache } = await import("./../i18n.js"));
    resetLanguageCache();
    expect(detectLanguage()).toBe("pt-BR");
    process.env.CLAUDE_KILLER_LANG = "en";
    resetLanguageCache();
  });

  it("prioriza CLAUDE_KILLER_LANG sobre LANG/LC_ALL mesmo quando estes estão em pt-BR", async () => {
    process.env.CLAUDE_KILLER_LANG = "en-US";
    process.env.LANG = "pt_BR.UTF-8";
    process.env.LC_ALL = "pt_BR.UTF-8";
    const { detectLanguage } = await import("./../i18n.js");
    expect(detectLanguage()).toBe("en");
  });
});

// ─── getLocalizedSlashCommands ─────────────────────────────────────────────
describe("getLocalizedSlashCommands (integrações)", () => {
  it("retorna array ordenado pelas chaves do COMMAND_I18N em ordem de definição", async () => {
    const { getLocalizedSlashCommands, COMMAND_I18N } = await import("./../i18n.js");
    const cmds = getLocalizedSlashCommands();
    const keys = Object.keys(COMMAND_I18N);
    expect(cmds.length).toBe(keys.length);
    // Cada chave de COMMAND_I18N deve aparecer exatamente uma vez no resultado
    for (const k of keys) {
      expect(cmds.filter((c) => c.cmd === k)).toHaveLength(1);
    }
  });

  it("traduz TODOS os comandos para pt-BR quando idioma detectado é pt-BR", async () => {
    delete process.env.CLAUDE_KILLER_LANG;
    process.env.LANG = "pt_BR.UTF-8";
    const { getLocalizedSlashCommands, resetLanguageCache } = await import("./../i18n.js");
    resetLanguageCache();
    const cmds = getLocalizedSlashCommands();
    // Todos os comandos devem ter uma descrição não-vazia em pt-BR
    for (const c of cmds) {
      expect(c.desc.length).toBeGreaterThan(0);
    }
    // Pelo menos /help deve estar em português
    const help = cmds.find((c) => c.cmd === "/help");
    expect(help?.desc).toBe("Mostrar ajuda");
    // /exit deve estar em português
    const exit = cmds.find((c) => c.cmd === "/exit");
    expect(exit?.desc).toBe("Sair");
    process.env.CLAUDE_KILLER_LANG = "en";
    resetLanguageCache();
  });
});

// ─── edge cases ────────────────────────────────────────────────────────────
describe("edge cases", () => {
  it("setLanguage persiste entre chamadas de getCommandI18n dentro da mesma instância", async () => {
    const { setLanguage, getCommandI18n, resetLanguageCache } = await import("./../i18n.js");
    resetLanguageCache();
    setLanguage("pt-BR");
    expect(getCommandI18n("/memory").desc).toBe("Mostrar memória do projeto");
    // Segunda chamada deve continuar em pt-BR (cacheado)
    expect(getCommandI18n("/todos").desc).toBe("Mostrar lista de tarefas");
    // Alterna para en
    setLanguage("en");
    expect(getCommandI18n("/memory").desc).toBe("Show project memory");
    expect(getCommandI18n("/todos").desc).toBe("Show todo list");
    resetLanguageCache();
  });

  it("CLAUDE_KILLER_LANG com valor inválido/não-reconhecido cai para detecção por LANG", async () => {
    process.env.CLAUDE_KILLER_LANG = "fr-FR"; // francês não suportado
    process.env.LANG = "en_US.UTF-8";
    const { detectLanguage } = await import("./../i18n.js");
    // Como CLAUDE_KILLER_LANG não é pt nem en, deve cair para LANG
    expect(detectLanguage()).toBe("en");
  });

  it("comandos /effort e /mode preservam subcommands em ambas as línguas", async () => {
    const { setLanguage, getCommandI18n } = await import("./../i18n.js");
    setLanguage("en");
    const effEn = getCommandI18n("/effort");
    const modeEn = getCommandI18n("/mode");
    expect(effEn.subcommands).toEqual(["low", "medium", "high", "max"]);
    expect(modeEn.subcommands).toEqual(["roblox", "devops", "off", "create", "confirm", "new", "keep"]);

    setLanguage("pt-BR");
    const effPt = getCommandI18n("/effort");
    const modePt = getCommandI18n("/mode");
    expect(effPt.subcommands).toEqual(["low", "medium", "high", "max"]);
    expect(modePt.subcommands).toEqual(["roblox", "devops", "off", "create", "confirm", "new", "keep"]);
  });
});
