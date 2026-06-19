/**
 * extensionCenter-extended.test.ts — Casos edge que NÃO estão no teste básico.
 * Foco em: syncExtensions (3 extras), toggleExtension (2 extras),
 * executeTrigger (2 extras) e edge cases (1).
 *
 * PT-BR nos comentários.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false, size: 100 })),
  },
}));

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

const { mockGetRegistry, mockGetActiveMCPServers } = vi.hoisted(() => ({
  mockGetRegistry: vi.fn(),
  mockGetActiveMCPServers: vi.fn(),
}));

vi.mock("../externalTools.js", () => ({
  getRegistry: (...args: any[]) => mockGetRegistry(...args),
}));

vi.mock("../extensions.js", () => ({
  getActiveMCPServers: (...args: any[]) => mockGetActiveMCPServers(...args),
}));

import {
  getAllExtensions,
  getExtension,
  syncExtensions,
  toggleExtension,
  setTriggerMode,
  cycleTriggerMode,
  enableAllInCategory,
  disableAll,
  executeTrigger,
  registerExecutor,
  subscribeToHubChanges,
  getHubVersion,
  getHubSummary,
  type ExtensionEntry,
} from "../extensionCenter.js";

function makeExt(overrides: Partial<ExtensionEntry> = {}): Omit<ExtensionEntry, "enabled" | "triggerMode"> {
  return {
    id: overrides.id ?? "test:ext1",
    name: overrides.name ?? "Test Extension",
    category: overrides.category ?? "skill",
    description: overrides.description ?? "A test extension",
    installed: overrides.installed ?? true,
    ...overrides,
  } as Omit<ExtensionEntry, "enabled" | "triggerMode">;
}

describe("extensionCenter — extended", () => {
  beforeEach(() => {
    syncExtensions([]);
  });

  // ─── syncExtensions (3 extras) ─────────────────────────────────────────────

  describe("syncExtensions — extras", () => {
    it("features internas default ON com triggerMode='always'", () => {
      syncExtensions([makeExt({ id: "feature:x", category: "feature", installed: true })]);
      const ext = getExtension("feature:x");
      expect(ext?.enabled).toBe(true);
      expect(ext?.triggerMode).toBe("always");
    });

    it("tools externas default OFF mesmo quando instaladas", () => {
      syncExtensions([makeExt({ id: "tool:x", category: "tool", installed: true })]);
      const ext = getExtension("tool:x");
      expect(ext?.enabled).toBe(false);
      expect(ext?.triggerMode).toBe("disabled");
    });

    it("MCPs default ON quando instalados", () => {
      syncExtensions([makeExt({ id: "mcp:x", category: "mcp", installed: true })]);
      const ext = getExtension("mcp:x");
      expect(ext?.enabled).toBe(true);
    });

    it("syncExtensions vazio limpa o hub", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      expect(getAllExtensions().length).toBe(1);
      syncExtensions([]);
      expect(getAllExtensions().length).toBe(0);
    });
  });

  // ─── toggleExtension (2 extras) ────────────────────────────────────────────

  describe("toggleExtension — extras", () => {
    it("toggle desliga e religa mantendo consistência", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      setTriggerMode("test:1", "on_file");
      // Toggle off
      expect(toggleExtension("test:1")).toBe(false);
      expect(getExtension("test:1")?.triggerMode).toBe("disabled");
      // Toggle on (volta enabled, mas triggerMode continua disabled até ser setado)
      expect(toggleExtension("test:1")).toBe(true);
      expect(getExtension("test:1")?.enabled).toBe(true);
    });

    it("toggle em extensão inexistente retorna null", () => {
      expect(toggleExtension("xyz_nao_existe")).toBeNull();
    });
  });

  // ─── executeTrigger (2 extras) ─────────────────────────────────────────────

  describe("executeTrigger — extras", () => {
    it("retorna [] quando não há extensões no trigger mode pedido", async () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      setTriggerMode("test:1", "on_task");
      // Dispara on_file: ninguém escuta
      const r = await executeTrigger("on_file", { cwd: "/tmp" });
      expect(r).toEqual([]);
    });

    it("executor recebe contexto com filePath e toolName quando fornecidos", async () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      setTriggerMode("test:1", "on_file");
      const exec = vi.fn().mockResolvedValue("ok");
      registerExecutor(exec);
      await executeTrigger("on_file", { cwd: "/p", filePath: "/p/f.luau", toolName: "aplicar_diff" });
      expect(exec).toHaveBeenCalledTimes(1);
      const arg = exec.mock.calls[0];
      expect(arg[1].filePath).toBe("/p/f.luau");
      expect(arg[1].toolName).toBe("aplicar_diff");
    });
  });

  // ─── Edge cases (1) ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("subscribeToHubChanges dispara callback em mutações", () => {
      let calls = 0;
      const unsub = subscribeToHubChanges(() => { calls++; });
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      toggleExtension("test:1");
      setTriggerMode("test:1", "always");
      expect(calls).toBeGreaterThanOrEqual(3);
      unsub();
    });

    it("getHubVersion incrementa a cada mutação", () => {
      const v0 = getHubVersion();
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      const v1 = getHubVersion();
      expect(v1).toBeGreaterThan(v0);
    });

    it("disableAll reseta todas extensões para disabled", () => {
      syncExtensions([
        makeExt({ id: "test:1", category: "feature", installed: true }),
        makeExt({ id: "test:2", category: "feature", installed: true }),
      ]);
      disableAll();
      const summary = getHubSummary();
      expect(summary.enabled).toBe(0);
    });

    it("enableAllInCategory não habilita extensões não-instaladas", () => {
      syncExtensions([
        makeExt({ id: "skill:1", category: "skill", installed: true }),
        makeExt({ id: "skill:2", category: "skill", installed: false }),
      ]);
      const count = enableAllInCategory("skill", "always");
      expect(count).toBe(1); // só a instalada
    });
  });
});
