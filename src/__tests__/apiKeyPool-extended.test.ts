/**
 * apiKeyPool-extended.test.ts
 *
 * Expande cobertura do apiKeyPool.ts focando em:
 *   - initApiKeyPool: idempotência, fallback quando vazio, contagem
 *   - acquireKeyForStreaming: bloqueio quando todas ocupadas, liberação pós-release
 *   - tryAcquireKeyImmediate: retorno null quando vazio, retorno imediato quando livre
 *   - prewarmPool: skip quando pool vazio, paralelismo
 *   - getPoolStats: formato, prefixo seguro, never leak
 * Não duplica testes do apiKeyPool.test.ts / apiKeyPool-prewarm.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  setTuiMode: vi.fn(),
  isTuiMode: vi.fn(() => false),
}));

// Mock do OpenAI para controlar respostas do prewarm
const mockCreate = vi.hoisted(() => vi.fn(async () => ({
  choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    apiKey: string;
    baseURL: string;
    timeout: number;
    chat = { completions: { create: mockCreate } };
    constructor(opts: any) {
      this.apiKey = opts.apiKey;
      this.baseURL = opts.baseURL;
      this.timeout = opts.timeout;
    }
  },
}));

import {
  initApiKeyPool,
  acquireKeyForStreaming,
  tryAcquireKeyImmediate,
  prewarmPool,
  resetPrewarm,
  getPoolStats,
  getPoolSize,
  getAvailableKeyCount,
  getTotalKeyCount,
  formatPoolStats,
  resetPool,
  resetPoolStats,
} from "../apiKeyPool.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEYS;
  delete process.env.NVIDIA_API_KEYS_FILE;
  delete process.env.MODEL;
  resetPool();
  resetPrewarm();
  resetPoolStats();
  mockCreate.mockClear();
  mockCreate.mockResolvedValue({
    choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetPool();
  resetPrewarm();
});

describe("apiKeyPool-extended — initApiKeyPool", () => {
  it("retorna false e loga warning quando nenhuma chave configurada", () => {
    expect(initApiKeyPool()).toBe(false);
    expect(getPoolSize()).toBe(0);
    expect(getPoolStats()).toEqual([]);
  });

  it("é idempotente: re-chamada com chaves novas não recriia o pool", () => {
    process.env.NVIDIA_API_KEYS = "nvapi-k1,nvapi-k2";
    expect(initApiKeyPool()).toBe(true);
    expect(getPoolSize()).toBe(2);
    // Muda env e chama de novo — deve ser no-op
    process.env.NVIDIA_API_KEYS = "nvapi-k3,nvapi-k4,nvapi-k5";
    initApiKeyPool();
    expect(getPoolSize()).toBe(2);
  });
});

describe("apiKeyPool-extended — acquireKeyForStreaming", () => {
  beforeEach(() => {
    process.env.NVIDIA_API_KEYS = "nvapi-k1,nvapi-k2,nvapi-k3";
    initApiKeyPool();
  });

  it("bloqueia até liberação quando todas as chaves estão ocupadas (mutex)", async () => {
    const h1 = await acquireKeyForStreaming();
    const h2 = await acquireKeyForStreaming();
    const h3 = await acquireKeyForStreaming();
    // Todas ocupadas — a 4ª deve esperar
    let resolved = false;
    const waitP = acquireKeyForStreaming().then((h) => {
      resolved = true;
      h.release(true, 200, 10);
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(resolved).toBe(false);
    // Libera 1 → a 4ª deve resolver
    h1.release(true, 200, 10);
    await waitP;
    expect(resolved).toBe(true);
    h2.release(true, 200, 10);
    h3.release(true, 200, 10);
  });

  it("atualiza inFlight + totalCalls após acquire+release com sucesso", async () => {
    const statsBefore = getPoolStats();
    const totalBefore = statsBefore.reduce((s, e) => s + e.totalCalls, 0);
    const h = await acquireKeyForStreaming();
    // Enquanto em uso, inFlight deve ser 1 para alguma chave
    const inFlightAfter = getPoolStats().reduce((s, e) => s + e.inFlight, 0);
    expect(inFlightAfter).toBe(1);
    h.release(true, 200, 42);
    const statsAfter = getPoolStats();
    const totalAfter = statsAfter.reduce((s, e) => s + e.totalCalls, 0);
    expect(totalAfter).toBe(totalBefore + 1);
    const used = statsAfter.find((s) => s.totalCalls > 0);
    expect(used!.successCount).toBe(1);
    expect(used!.lastLatencyMs).toBe(42);
    // inFlight zerado após release
    expect(statsAfter.reduce((s, e) => s + e.inFlight, 0)).toBe(0);
  });
});

describe("apiKeyPool-extended — tryAcquireKeyImmediate", () => {
  it("retorna null quando pool está vazio", () => {
    expect(tryAcquireKeyImmediate()).toBeNull();
  });

  it("retorna handle imediatamente livre e null quando todas ocupadas", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-a,nvapi-b";
    initApiKeyPool();
    // 2 chaves livres — primeira tentativa deve funcionar
    const h1 = tryAcquireKeyImmediate();
    expect(h1).not.toBeNull();
    expect(h1!.client).toBeDefined();
    expect(typeof h1!.release).toBe("function");
    // 2ª: ainda tem 1 livre
    const h2 = tryAcquireKeyImmediate();
    expect(h2).not.toBeNull();
    // 3ª: todas ocupadas, deve retornar null sem bloquear
    const h3 = tryAcquireKeyImmediate();
    expect(h3).toBeNull();
    // Limpa
    h1!.release(true, 200, 10);
    h2!.release(true, 200, 10);
  });

  it("pula chaves em cooldown (após 429)", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-x,nvapi-y";
    initApiKeyPool();
    // Adquire 1ª e libera com 429 — entra em cooldown
    const h1 = await acquireKeyForStreaming();
    h1.release(false, 429, 10);
    // Agora tryAcquireImmediate deve pular a 1ª e usar a 2ª
    const immediate = tryAcquireKeyImmediate();
    expect(immediate).not.toBeNull();
    // Verifica que a chave adquirida é diferente da que está em cooldown
    const stats = getPoolStats();
    const cooldownKey = stats.find((s) => s.cooldownUntil > 0);
    const acquiredIdx = (immediate as any).entry.index;
    expect(cooldownKey!.index).not.toBe(acquiredIdx);
    immediate!.release(true, 200, 10);
  });
});

describe("apiKeyPool-extended — prewarmPool", () => {
  it("não dispara requests quando pool está vazio (skip)", async () => {
    // Pool não inicializado
    expect(getPoolSize()).toBe(0);
    await prewarmPool();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("é idempotente: chamar 2x só prewarmiza 1x", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-pw1,nvapi-pw2";
    initApiKeyPool();
    await prewarmPool();
    await prewarmPool();
    // 2 chaves × 1 chamada cada
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

describe("apiKeyPool-extended — getPoolStats / getAvailableKeyCount", () => {
  it("getPoolStats retorna array com stats por chave e nunca vaza chave completa", () => {
    process.env.NVIDIA_API_KEYS = "nvapi-SECRET_KEY_PART_THAT_MUST_NOT_LEAK_12345";
    initApiKeyPool();
    const stats = getPoolStats();
    expect(stats).toHaveLength(1);
    const s = stats[0];
    expect(s.index).toBe(0);
    expect(s.keyPrefix).toContain("...");
    // Verifica que partes sensíveis não estão no stats
    const json = JSON.stringify(stats);
    expect(json).not.toContain("SECRET_KEY_PART");
    expect(json).not.toContain("MUST_NOT_LEAK");
    expect(json).not.toContain("12345");
  });

  it("getAvailableKeyCount retorna 0 quando pool vazio e N quando livre", async () => {
    expect(getAvailableKeyCount()).toBe(0);
    expect(getTotalKeyCount()).toBe(0);
    process.env.NVIDIA_API_KEYS = "nvapi-a1,nvapi-a2,nvapi-a3";
    initApiKeyPool();
    expect(getTotalKeyCount()).toBe(3);
    expect(getAvailableKeyCount()).toBe(3);
    // Ocupa 1
    const h = await acquireKeyForStreaming();
    expect(getAvailableKeyCount()).toBe(2);
    h.release(true, 200, 10);
    expect(getAvailableKeyCount()).toBe(3);
  });

  it("formatPoolStats mostra mensagem apropriada quando pool vazio", () => {
    const formatted = formatPoolStats();
    expect(formatted).toContain("Pool empty");
  });
});
