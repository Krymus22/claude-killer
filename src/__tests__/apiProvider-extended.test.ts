/**
 * apiProvider-extended.test.ts — Casos edge / error handling / integração para
 * apiProvider.ts que NÃO estão cobertos pelo teste básico.
 *
 * Foco:
 *   - detectProvider (3 casos) — variações de env vars
 *   - getProviderConfig (2 casos) — multi-key + fallback de chaves
 *   - providerNeedsHeartbeat (1)
 *   - providerSendsThinkingMode (1)
 *   - providerUsesMultiKeyPool (1)
 *   + edge cases extras
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

const origEnv = { ...process.env };

beforeEach(() => {
  delete process.env.API_PROVIDER;
  delete process.env.ZENMUX_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEYS;
  delete process.env.NVIDIA_API_KEYS_FILE;
  delete process.env.MODEL;
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...origEnv };
  vi.resetModules();
});

// ─── detectProvider ────────────────────────────────────────────────────────
describe("detectProvider (variações de env)", () => {
  it("ignora espaços e casing em API_PROVIDER (ex: '  NVIDIA  ')", async () => {
    process.env.API_PROVIDER = "  NVIDIA  ";
    const { detectProvider } = await import("../apiProvider.js");
    expect(detectProvider()).toBe("nvidia");
  });

  it("trata valor desconhecido em API_PROVIDER como default nvidia", async () => {
    process.env.API_PROVIDER = "openai";
    process.env.NVIDIA_API_KEY = "nvapi-test";
    const { detectProvider } = await import("../apiProvider.js");
    expect(detectProvider()).toBe("nvidia");
  });

  it("prioriza explicit nvidia sobre ZENMUX_API_KEY setada", async () => {
    process.env.API_PROVIDER = "nvidia";
    process.env.ZENMUX_API_KEY = "sk-test";
    const { detectProvider } = await import("../apiProvider.js");
    expect(detectProvider()).toBe("nvidia");
  });
});

// ─── getProviderConfig ─────────────────────────────────────────────────────
describe("getProviderConfig (multi-key + fallback)", () => {
  it("usa a PRIMEIRA chave de NVIDIA_API_KEYS quando NVIDIA_API_KEY não está setada", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-keyA,nvapi-keyB,nvapi-keyC";
    const { getProviderConfig } = await import("../apiProvider.js");
    const cfg = getProviderConfig();
    expect(cfg.apiKey).toBe("nvapi-keyA");
    expect(cfg.name).toBe("nvidia");
  });

  it("prioriza NVIDIA_API_KEY sobre NVIDIA_API_KEYS quando ambas estão setadas", async () => {
    process.env.NVIDIA_API_KEY = "single-key";
    process.env.NVIDIA_API_KEYS = "multi1,multi2";
    const { getProviderConfig } = await import("../apiProvider.js");
    const cfg = getProviderConfig();
    expect(cfg.apiKey).toBe("single-key");
  });
});

// ─── providerNeedsHeartbeat ────────────────────────────────────────────────
describe("providerNeedsHeartbeat", () => {
  it("retorna true para nvidia e false para zenmux em uma única execução isolada", async () => {
    // Primeiro zenmux
    process.env.ZENMUX_API_KEY = "sk-test";
    const mod1 = await import("../apiProvider.js");
    expect(mod1.providerNeedsHeartbeat()).toBe(false);

    // Reset para nvidia
    vi.resetModules();
    delete process.env.ZENMUX_API_KEY;
    process.env.NVIDIA_API_KEY = "nvapi-x";
    const mod2 = await import("../apiProvider.js");
    expect(mod2.providerNeedsHeartbeat()).toBe(true);
  });
});

// ─── providerSendsThinkingMode ─────────────────────────────────────────────
describe("providerSendsThinkingMode", () => {
  it("é true para nvidia e false para zenmux (sem chamar getProviderConfig que daria exit)", async () => {
    // zenmux
    process.env.ZENMUX_API_KEY = "sk-test";
    const mod1 = await import("../apiProvider.js");
    expect(mod1.providerSendsThinkingMode()).toBe(false);

    vi.resetModules();
    delete process.env.ZENMUX_API_KEY;
    process.env.NVIDIA_API_KEY = "nvapi-y";
    const mod2 = await import("../apiProvider.js");
    expect(mod2.providerSendsThinkingMode()).toBe(true);
  });
});

// ─── providerUsesMultiKeyPool ──────────────────────────────────────────────
describe("providerUsesMultiKeyPool", () => {
  it("retorna true para nvidia e false para zenmux via detecção auto", async () => {
    // nvidia default
    process.env.NVIDIA_API_KEY = "nvapi-z";
    const mod1 = await import("../apiProvider.js");
    expect(mod1.providerUsesMultiKeyPool()).toBe(true);

    vi.resetModules();
    delete process.env.NVIDIA_API_KEY;
    process.env.ZENMUX_API_KEY = "sk-test-2";
    const mod2 = await import("../apiProvider.js");
    expect(mod2.providerUsesMultiKeyPool()).toBe(false);
  });
});

// ─── edge cases ────────────────────────────────────────────────────────────
describe("edge cases", () => {
  it("getProviderReasoningField + getProviderMaxSubAgents alternam corretamente entre providers", async () => {
    // nvidia
    process.env.NVIDIA_API_KEY = "nvapi-edge";
    const mod1 = await import("../apiProvider.js");
    expect(mod1.getProviderReasoningField()).toBe("reasoning_content");
    expect(mod1.getProviderMaxSubAgents()).toBe(2);

    vi.resetModules();
    delete process.env.NVIDIA_API_KEY;
    process.env.ZENMUX_API_KEY = "sk-edge";
    const mod2 = await import("../apiProvider.js");
    expect(mod2.getProviderReasoningField()).toBe("reasoning");
    expect(mod2.getProviderMaxSubAgents()).toBe(10);
  });

  it("getProviderConfig com ZENMUX_API_KEY vazio e API_PROVIDER=zenmux chama process.exit", async () => {
    process.env.API_PROVIDER = "zenmux";
    // Não seta ZENMUX_API_KEY
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit-called");
    }) as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getProviderConfig } = await import("../apiProvider.js");
    expect(() => getProviderConfig()).toThrow("exit-called");
    expect(errSpy).toHaveBeenCalled();
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
