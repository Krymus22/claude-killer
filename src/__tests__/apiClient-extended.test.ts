/**
 * apiClient-extended.test.ts — Cobertura expandida do src/apiClient.ts
 *
 * Foca nas áreas NÃO cobertas por apiClient.test.ts:
 *   - SlidingWindowRateLimiter (via chat single-key)
 *   - Mutex (via chat single-key)
 *   - chat() top-level (pool vs single-key vs fallback)
 *   - chatWithPool() (aquisição, hedging)
 *   - chatSingleKey() (mutex+rateLimiter, retry 429)
 *   - createStreamRequest / consumeStream / buildChatResponse
 *   - createStreamState()
 *   - Retry logic (MAX_429_RETRIES)
 *
 * Estratégia: as classes/funções internas não são exportadas, então
 * testamos via a função pública chat() controlando mocks de openai,
 * apiKeyPool, apiProvider, modelRegistry e config.
 *
 * Para testar SlidingWindowRateLimiter com limite baixo, usamos
 * vi.resetModules() + dynamic import para reinstanciar o módulo com
 * rateLimitRpm=1 (o rateLimiter singleton é criado no module load).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── vi.hoisted: mocks compartilhados entre factory e testes ───────────────
const hoisted = vi.hoisted(() => {
  // Mock da classe APIError do pacote openai
  class MockAPIError extends Error {
    status?: number;
    headers?: Record<string, string>;
    constructor(message: string, status?: number, headers?: Record<string, string>) {
      super(message);
      this.name = "APIError";
      this.status = status;
      this.headers = headers;
    }
  }

  return {
    createMock: vi.fn(),
    MockAPIError,

    // Config mutável por teste (apiClient lê config.rateLimitRpm no módulo load)
    configMock: {
      nvidiaApiKey: "test-key",
      nvidiaApiKeys: "",
      nvidiaApiKeysFile: "",
      nvidiaBaseUrl: "https://integrate.api.nvidia.com/v1",
      model: "moonshotai/kimi-k2.6",
      rateLimitRpm: 1000,          // alto: rate limiter não bloqueia na maioria dos testes
      maxConcurrency: 1,
      maxHealRetries: 3,
      debug: false,
      contextWindowTokens: 128000,
      contextCompactThreshold: 0.75,
      contextWarnThreshold: 0.6,
      costPerKPrompt: 0,
      costPerKCompletion: 0,
      diffPreview: false,
      maxTokens: 4096,
      temperature: 0.6,
      topP: 0.9,
    },

    poolMock: {
      initApiKeyPool: vi.fn(() => false),
      getPoolSize: vi.fn(() => 0),
      acquireKeyForStreaming: vi.fn(),
      tryAcquireKeyImmediate: vi.fn(() => null),
      getAvailableKeyCount: vi.fn(() => 0),
      getTotalKeyCount: vi.fn(() => 0),
      getPoolStats: vi.fn(() => []),
      formatPoolStats: vi.fn(() => "[POOL] mock"),
    },

    providerMock: {
      providerSendsThinkingMode: vi.fn(() => false),
      getProviderReasoningField: vi.fn(() => "reasoning_content" as const),
      providerNeedsHedging: vi.fn(() => false),
      detectProvider: vi.fn(() => "nvidia" as const),
      getProviderConfig: vi.fn(() => ({
        name: "nvidia",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: "test-key",
        sendThinkingMode: false,
        reasoningField: "reasoning_content" as const,
        needsHeartbeat: true,
        needsHedging: false,
        needsMultiKeyPool: true,
        maxConcurrentSubAgents: 2,
        heartbeatMaxTokens: 1,
      })),
      providerNeedsHeartbeat: vi.fn(() => true),
      getProviderMaxSubAgents: vi.fn(() => 2),
      providerUsesMultiKeyPool: vi.fn(() => true),
    },

    modelRegistryMock: {
      getModelInfo: vi.fn(() => ({
        id: "moonshotai/kimi-k2.6",
        name: "Kimi K2.6",
        contextWindow: 128000,
        maxOutputTokens: 8192,
        costPer1MPrompt: 0,
        costPer1MCompletion: 0,
        supportsTools: true,
        supportsParallelTools: true,
        hasThinking: false,
        provider: "nvidia",
      })),
      getModelMaxOutputTokens: vi.fn(() => 8192),
      getModelContextWindow: vi.fn(() => 128000),
    },
  };
});

// ─── Mocks (devem vir antes de importar apiClient) ─────────────────────────

vi.mock("openai", () => {
  // A classe default precisa ter APIError como propriedade estática,
  // pois apiClient.ts usa `err instanceof OpenAI.APIError`.
  class MockOpenAI {
    static APIError = hoisted.MockAPIError;
    chat = {
      completions: {
        create: hoisted.createMock,
      },
    };
  }
  return {
    default: MockOpenAI,
    APIError: hoisted.MockAPIError,
  };
});

vi.mock("../config.js", () => ({ config: hoisted.configMock }));
vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
  throttle: vi.fn(),
}));
vi.mock("../apiKeyPool.js", () => hoisted.poolMock);
vi.mock("../apiProvider.js", () => hoisted.providerMock);
vi.mock("../modelRegistry.js", () => hoisted.modelRegistryMock);

// ─── Imports ───────────────────────────────────────────────────────────────

import { chat, type Message } from "../apiClient.js";

// ─── Helpers: streams mock ─────────────────────────────────────────────────

function mockStream(chunks: any[]): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => {
          if (i < chunks.length) return { value: chunks[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function contentChunk(text: string, opts: { id?: string; model?: string; created?: number } = {}): any {
  return {
    id: opts.id ?? "chatcmpl-test",
    model: opts.model ?? "moonshotai/kimi-k2.6",
    created: opts.created ?? 1700000000,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

function usageOnlyChunk(usage: any): any {
  return { id: "chatcmpl-test", model: "moonshotai/kimi-k2.6", created: 1700000000, usage };
}

function finishChunk(finishReason: string, usage?: any): any {
  return {
    id: "chatcmpl-test",
    model: "moonshotai/kimi-k2.6",
    created: 1700000000,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function simpleStream(text = "hello world"): AsyncIterable<any> {
  const parts = text.split(" ");
  const chunks = parts.map(p => contentChunk(p + " "));
  chunks.push(finishChunk("stop"));
  return mockStream(chunks);
}

const sampleMessages: Message[] = [{ role: "user", content: "test" }];

// ─── Setup global ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.createMock.mockReset();
  hoisted.createMock.mockImplementation(() => Promise.resolve(simpleStream()));

  hoisted.poolMock.getPoolSize.mockReturnValue(0);
  hoisted.poolMock.initApiKeyPool.mockReturnValue(false);
  hoisted.poolMock.acquireKeyForStreaming.mockReset();
  hoisted.poolMock.tryAcquireKeyImmediate.mockReset();
  hoisted.poolMock.tryAcquireKeyImmediate.mockReturnValue(null);
  hoisted.poolMock.getAvailableKeyCount.mockReturnValue(0);
  hoisted.poolMock.getTotalKeyCount.mockReturnValue(0);

  hoisted.providerMock.providerNeedsHedging.mockReturnValue(false);
  hoisted.providerMock.providerSendsThinkingMode.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── 1. SlidingWindowRateLimiter (via chat single-key) ─────────────────────
// Usa vi.resetModules() + dynamic import para reinstanciar o módulo com
// rateLimitRpm=1, permitindo testar o bloqueio do rate limiter.

describe("SlidingWindowRateLimiter (via chat single-key)", () => {
  let chatFresh: typeof chat;

  beforeEach(async () => {
    // Reinstancia o módulo com rateLimitRpm=1
    hoisted.configMock.rateLimitRpm = 1;
    vi.resetModules();
    const mod = await import("../apiClient.js");
    chatFresh = mod.chat;
    // Volta rateLimitRpm para o normal (não afeta o rateLimiter já criado)
    hoisted.configMock.rateLimitRpm = 1000;

    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    hoisted.createMock.mockImplementation(() => Promise.resolve(simpleStream()));
  });

  it("acquire() retorna imediatamente quando há slots disponíveis", async () => {
    const promise = chatFresh(sampleMessages);
    await vi.advanceTimersByTimeAsync(50);
    const response = await promise;

    expect(response).toBeDefined();
    expect(hoisted.createMock).toHaveBeenCalledTimes(1);
  });

  it("acquire() bloqueia quando window está cheio", async () => {
    // rateLimitRpm=1: primeira chamada consome o slot, segunda bloqueia
    const p1 = chatFresh(sampleMessages);
    await vi.advanceTimersByTimeAsync(50);
    await p1;

    // Segunda chamada: deve bloquear (janela cheia)
    hoisted.createMock.mockClear();
    const p2 = chatFresh(sampleMessages);
    // Avança pouco tempo — create ainda não foi chamado
    await vi.advanceTimersByTimeAsync(500);
    expect(hoisted.createMock).not.toHaveBeenCalled();

    // Limpa a promise pendente avançando o tempo
    await vi.advanceTimersByTimeAsync(60_500);
    await p2;
  });

  it("acquire() desbloqueia quando timestamp sai da janela", async () => {
    // Preenche o slot
    const p1 = chatFresh(sampleMessages);
    await vi.advanceTimersByTimeAsync(50);
    await p1;

    // Segunda chamada bloqueia
    hoisted.createMock.mockClear();
    const p2 = chatFresh(sampleMessages);
    await vi.advanceTimersByTimeAsync(500);
    expect(hoisted.createMock).not.toHaveBeenCalled();

    // Avança 60s+ — timestamp sai da janela, desbloqueia
    await vi.advanceTimersByTimeAsync(60_500);
    const response = await p2;

    expect(response).toBeDefined();
    expect(hoisted.createMock).toHaveBeenCalledTimes(1);
  });

  it("timestamps antigos são filtrados a cada chamada", async () => {
    // Faz 1 chamada (slot preenchido em T=0)
    const p1 = chatFresh(sampleMessages);
    await vi.advanceTimersByTimeAsync(50);
    await p1;

    // Avança 61s — timestamp antigo deve ser filtrado na próxima acquire()
    vi.setSystemTime(new Date(61_000));

    // Nova chamada deve prosseguir imediatamente (janela filtrada, vazia)
    hoisted.createMock.mockClear();
    const p2 = chatFresh(sampleMessages);
    await vi.advanceTimersByTimeAsync(50);
    const response = await p2;

    expect(response).toBeDefined();
    expect(hoisted.createMock).toHaveBeenCalledTimes(1);
  });
});

// ─── 2. Mutex (via chat single-key) ────────────────────────────────────────
// Testa via chamadas concorrentes com createMock controlado.

describe("Mutex (via chat single-key)", () => {
  it("lock() retorna imediatamente quando livre", async () => {
    const response = await chat(sampleMessages);
    expect(response).toBeDefined();
    expect(hoisted.createMock).toHaveBeenCalledTimes(1);
  });

  it("lock() enfileira chamadas concorrentes (FIFO)", async () => {
    // Controla quando o primeiro stream resolve
    let resolveFirst: (v: any) => void = () => {};
    const firstStream = new Promise((resolve) => { resolveFirst = resolve; });
    hoisted.createMock.mockReturnValueOnce(firstStream);

    // Primeira chamada — adquire mutex, fica pendente no create()
    const p1 = chat(sampleMessages);
    // Processa microtasks para p1 chegar ao await createMock
    await Promise.resolve();
    await Promise.resolve();

    // Segunda chamada — deve ficar enfileirada no mutex
    let secondCreateCalled = false;
    hoisted.createMock.mockImplementationOnce(() => {
      secondCreateCalled = true;
      return Promise.resolve(simpleStream());
    });
    const p2 = chat(sampleMessages);
    await Promise.resolve();
    await Promise.resolve();

    // p2 ainda não chamou create() — mutex bloqueia
    expect(secondCreateCalled).toBe(false);

    // Resolve o primeiro stream — mutex libera, p2 continua
    resolveFirst(simpleStream());
    await p1;
    await p2;

    expect(secondCreateCalled).toBe(true);
  });

  it("unlock() libera o próximo da fila", async () => {
    let resolveFirst: (v: any) => void = () => {};
    const firstStream = new Promise((resolve) => { resolveFirst = resolve; });
    hoisted.createMock.mockReturnValueOnce(firstStream);

    const p1 = chat(sampleMessages);
    await Promise.resolve();
    await Promise.resolve();

    let secondCalled = false;
    hoisted.createMock.mockImplementationOnce(() => {
      secondCalled = true;
      return Promise.resolve(simpleStream());
    });
    const p2 = chat(sampleMessages);
    await Promise.resolve();
    await Promise.resolve();
    expect(secondCalled).toBe(false);

    // Libera o primeiro — unlock() deve liberar p2
    resolveFirst(simpleStream());
    await p1;
    await p2;

    expect(secondCalled).toBe(true);
  });
});

// ─── 3. chat() — top-level function ────────────────────────────────────────

describe("chat() top-level function", () => {
  it("usa pool quando pool está ativo", async () => {
    hoisted.poolMock.getPoolSize.mockReturnValue(2);
    const poolRelease = vi.fn();
    hoisted.poolMock.acquireKeyForStreaming.mockResolvedValue({
      client: { chat: { completions: { create: hoisted.createMock } } },
      entry: { index: 0 },
      release: poolRelease,
    });

    const response = await chat(sampleMessages);

    expect(hoisted.poolMock.acquireKeyForStreaming).toHaveBeenCalled();
    expect(response).toBeDefined();
    expect(poolRelease).toHaveBeenCalled();
  });

  it("cai pra single-key quando pool falha", async () => {
    hoisted.poolMock.getPoolSize.mockReturnValue(2);
    hoisted.poolMock.acquireKeyForStreaming.mockRejectedValue(
      new Error("pool acquisition failed")
    );
    hoisted.createMock.mockResolvedValue(simpleStream());

    const response = await chat(sampleMessages);

    expect(hoisted.createMock).toHaveBeenCalled();
    expect(response).toBeDefined();
  });

  it("propaga erro quando ambos (pool e single-key) falham", async () => {
    hoisted.poolMock.getPoolSize.mockReturnValue(2);
    hoisted.poolMock.acquireKeyForStreaming.mockRejectedValue(new Error("pool error"));
    hoisted.createMock.mockRejectedValue(new Error("single-key error"));

    await expect(chat(sampleMessages)).rejects.toThrow("single-key error");
  });
});

// ─── 4. chatWithPool() ─────────────────────────────────────────────────────

describe("chatWithPool()", () => {
  it("adquire key do pool, faz request, libera key", async () => {
    hoisted.poolMock.getPoolSize.mockReturnValue(1);
    const poolRelease = vi.fn();
    const poolCreateMock = vi.fn().mockResolvedValue(simpleStream());
    hoisted.poolMock.acquireKeyForStreaming.mockResolvedValue({
      client: { chat: { completions: { create: poolCreateMock } } },
      entry: { index: 0 },
      release: poolRelease,
    });

    const response = await chat(sampleMessages);

    expect(hoisted.poolMock.acquireKeyForStreaming).toHaveBeenCalledTimes(1);
    expect(poolCreateMock).toHaveBeenCalledTimes(1);
    expect(poolRelease).toHaveBeenCalledTimes(1);
    expect(poolRelease.mock.calls[0][0]).toBe(true);
    expect(response).toBeDefined();
  });

  it("hedging dispara backup se primary demora >5s e há 2+ keys", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    hoisted.providerMock.providerNeedsHedging.mockReturnValue(true);
    hoisted.poolMock.getAvailableKeyCount.mockReturnValue(1);
    hoisted.poolMock.getTotalKeyCount.mockReturnValue(2);
    hoisted.poolMock.getPoolSize.mockReturnValue(2);

    let resolvePrimary: (v: any) => void = () => {};
    const primaryStreamPromise = new Promise((resolve) => { resolvePrimary = resolve; });
    const primaryCreate = vi.fn().mockReturnValue(primaryStreamPromise);
    hoisted.poolMock.acquireKeyForStreaming.mockResolvedValue({
      client: { chat: { completions: { create: primaryCreate } } },
      entry: { index: 0 },
      release: vi.fn(),
    });
    hoisted.poolMock.tryAcquireKeyImmediate.mockReturnValue({
      client: { chat: { completions: { create: vi.fn().mockResolvedValue(simpleStream()) } } },
      entry: { index: 1 },
      release: vi.fn(),
    });

    const p = chat(sampleMessages);
    // Antes de 5s — hedging não disparou
    await vi.advanceTimersByTimeAsync(50);
    expect(hoisted.poolMock.tryAcquireKeyImmediate).not.toHaveBeenCalled();

    // Após 5s — hedging dispara
    await vi.advanceTimersByTimeAsync(5_100);
    expect(hoisted.poolMock.tryAcquireKeyImmediate).toHaveBeenCalledTimes(1);

    // Resolve o primary — chat() completa
    resolvePrimary(simpleStream());
    await vi.advanceTimersByTimeAsync(200);
    await p;
  });

  it("hedging NÃO dispara se primary já começou a streamar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    hoisted.providerMock.providerNeedsHedging.mockReturnValue(true);
    hoisted.poolMock.getAvailableKeyCount.mockReturnValue(1);
    hoisted.poolMock.getTotalKeyCount.mockReturnValue(2);
    hoisted.poolMock.getPoolSize.mockReturnValue(2);
    const primaryCreate = vi.fn().mockResolvedValue(simpleStream());
    hoisted.poolMock.acquireKeyForStreaming.mockResolvedValue({
      client: { chat: { completions: { create: primaryCreate } } },
      entry: { index: 0 },
      release: vi.fn(),
    });

    const p = chat(sampleMessages);
    // Primary resolve rapidamente
    await vi.advanceTimersByTimeAsync(100);
    await p;

    // Avança além de 5s — hedging NÃO deveria ter disparado
    await vi.advanceTimersByTimeAsync(6_000);
    expect(hoisted.poolMock.tryAcquireKeyImmediate).not.toHaveBeenCalled();
  });
});

// ─── 5. chatSingleKey() ────────────────────────────────────────────────────

describe("chatSingleKey()", () => {
  it("usa mutex + rate limiter (single-key path)", async () => {
    const response = await chat(sampleMessages);

    expect(hoisted.createMock).toHaveBeenCalledTimes(1);
    expect(response).toBeDefined();
    expect(hoisted.poolMock.acquireKeyForStreaming).not.toHaveBeenCalled();
  });

  it("retry em 429 com Retry-After curto (<=90s)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    const err429 = new hoisted.MockAPIError("rate limited", 429, { "retry-after": "1" });
    hoisted.createMock
      .mockReturnValueOnce(Promise.reject(err429))
      .mockResolvedValueOnce(simpleStream());

    const p = chat(sampleMessages);
    // Retry-After=1s → sleep 1500ms
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await p;

    expect(hoisted.createMock).toHaveBeenCalledTimes(2);
    expect(response).toBeDefined();
  });

  it("NÃO retry em 429 com Retry-After longo (>90s) — quota exhausted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    const err429 = new hoisted.MockAPIError("rate limited", 429, { "retry-after": "100" });
    hoisted.createMock.mockRejectedValue(err429);

    const p = chat(sampleMessages);
    // Registra handler ANTES de avançar o tempo para evitar unhandled rejection
    const assertion = expect(p).rejects.toThrow(/429|quota/i);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    expect(hoisted.createMock).toHaveBeenCalledTimes(1);
  });
});

// ─── 6. createStreamRequest / consumeStream / buildChatResponse ────────────

describe("createStreamRequest / consumeStream / buildChatResponse", () => {
  it("createStreamRequest chama client.chat.completions.create com args corretos", async () => {
    hoisted.createMock.mockResolvedValue(simpleStream("hello"));
    await chat(sampleMessages);

    expect(hoisted.createMock).toHaveBeenCalledTimes(1);
    const args = hoisted.createMock.mock.calls[0][0];
    expect(args.model).toBe("moonshotai/kimi-k2.6");
    expect(args.messages).toBe(sampleMessages);
    expect(args.stream).toBe(true);
    expect(args.tool_choice).toBe("auto");
    expect(args.parallel_tool_calls).toBe(true);
    expect(typeof args.max_tokens).toBe("number");
    expect(args.temperature).toBe(0.6);
    expect(args.top_p).toBe(0.9);
    expect(Array.isArray(args.tools)).toBe(true);
    expect(args.tools.length).toBeGreaterThan(0);
  });

  it("consumeStream processa chunks SSE e chama onToken", async () => {
    const stream = mockStream([
      contentChunk("Hello "),
      contentChunk("world"),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const tokens: string[] = [];
    await chat(sampleMessages, undefined, (t) => tokens.push(t));

    expect(tokens).toEqual(["Hello ", "world"]);
  });

  it("consumeStream detecta usage em chunk sem choices", async () => {
    const stream = mockStream([
      contentChunk("resp"),
      usageOnlyChunk({ prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 }),
      finishChunk("stop", { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 }),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    expect(response.usage.prompt_tokens).toBe(42);
    expect(response.usage.completion_tokens).toBe(7);
    expect(response.usage.total_tokens).toBe(49);
  });

  it("buildChatResponse monta objeto ChatResponse final", async () => {
    const stream = mockStream([
      contentChunk("ans", { id: "chatcmpl-xyz", model: "m1", created: 12345 }),
      finishChunk("stop", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    expect(response.id).toBe("chatcmpl-xyz");
    expect(response.model).toBe("m1");
    expect(response.created).toBe(12345);
    expect(response.object).toBe("chat.completion");
    expect(response.choices).toHaveLength(1);
    expect(response.choices[0].message.role).toBe("assistant");
    expect(response.choices[0].message.content).toBe("ans");
    expect(response.choices[0].finish_reason).toBe("stop");
    expect(response.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 1,
      total_tokens: 4,
    });
  });
});

// ─── 7. createStreamState() ────────────────────────────────────────────────

describe("createStreamState()", () => {
  it("estado inicial vazio (promptTokens=0, completionTokens=0)", async () => {
    // Stream sem chunk de usage → tokens ficam em 0
    const stream = mockStream([
      contentChunk("só conteúdo"),
      { id: "c1", model: "m", created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    expect(response.usage.prompt_tokens).toBe(0);
    expect(response.usage.completion_tokens).toBe(0);
    expect(response.usage.total_tokens).toBe(0);
  });

  it("acumula conteúdo via appendContent (totalContent)", async () => {
    const stream = mockStream([
      contentChunk("parte1 "),
      contentChunk("parte2 "),
      contentChunk("parte3"),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    expect(response.choices[0].message.content).toBe("parte1 parte2 parte3");
  });

  it("setUsage sobrescreve contadores (chunk de usage define tokens)", async () => {
    const stream = mockStream([
      contentChunk("content"),
      finishChunk("stop", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    expect(response.usage.prompt_tokens).toBe(100);
    expect(response.usage.completion_tokens).toBe(50);
    expect(response.usage.total_tokens).toBe(150);
  });
});

// ─── 8. Retry logic (MAX_429_RETRIES) ──────────────────────────────────────

describe("Retry logic — MAX_429_RETRIES", () => {
  it("faz até MAX_429_RETRIES tentativas em 429 curto", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    const err429 = new hoisted.MockAPIError("rate limited", 429, { "retry-after": "1" });
    hoisted.createMock.mockRejectedValue(err429);

    const p = chat(sampleMessages);
    // Registra handler ANTES de avançar o tempo para evitar unhandled rejection
    const assertion = expect(p).rejects.toThrow(/429|quota/i);
    // MAX_429_RETRIES=4 → 4 retries, cada um dorme 1500ms. Total: 6000ms.
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    // initial (attempt=0) + 4 retries = 5 chamadas
    expect(hoisted.createMock).toHaveBeenCalledTimes(5);
  });

  it("para de tentar após MAX_429_RETRIES", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    const err429 = new hoisted.MockAPIError("rate limited", 429, { "retry-after": "1" });
    hoisted.createMock.mockRejectedValue(err429);

    const p = chat(sampleMessages);
    // Registra handler ANTES de avançar o tempo
    const assertion = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    const callsAfterFail = hoisted.createMock.mock.calls.length;
    // Avança mais tempo — não deve fazer novas tentativas
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hoisted.createMock.mock.calls.length).toBe(callsAfterFail);
    expect(callsAfterFail).toBe(5);
  });
});
