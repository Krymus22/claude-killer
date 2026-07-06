/**
 * unit-apiKeyPool-extended.test.ts — Deep unit tests for apiKeyPool.ts
 *
 * Covers behaviors NOT covered by apiKeyPool.test.ts / apiKeyPool-deep.test.ts
 * / apiKeyPool-extended.test.ts / apiKeyPool-prewarm.test.ts / apiKeyPool-coverage.test.ts:
 *   - getPoolSize (0 when not initialized, N when initialized)
 *   - formatPoolStats (string format with stats)
 *   - Round-robin distribution of keys
 *   - Mutex: only 1 concurrent per key
 *   - Key release after use
 *   - 429 cooldown handling (60s cooldown)
 *   - Error count tracking
 *   - Key prefix never leaks (no secret in logs/stats)
 *   - Multi-key from NVIDIA_API_KEYS env var (comma-separated)
 *   - Multi-key from NVIDIA_API_KEYS_FILE (one per line)
 *   - Single key backward compat (NVIDIA_API_KEY)
 *   - Pool initialization is idempotent
 *   - Prewarm tests (idempotent, skip when empty, parallel)
 *   - loadApiKeys priority order
 *   - tryAcquireKeyImmediate behavior
 *   - getAvailableKeyCount vs getTotalKeyCount
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
}));

// Mock OpenAI — controllable per-test
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
  loadApiKeys,
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
  poolChatCompletion,
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

// ═══════════════════════════════════════════════════════════════════════════
// 1. getPoolSize (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("apiKeyPool: getPoolSize", () => {
  it("returns 0 when not initialized", () => {
    expect(getPoolSize()).toBe(0);
  });

  it("returns N when initialized with N keys", () => {
    process.env.NVIDIA_API_KEYS = "nvapi-k1,nvapi-k2,nvapi-k3";
    initApiKeyPool();
    expect(getPoolSize()).toBe(3);
  });

  it("returns 1 when initialized with single NVIDIA_API_KEY", () => {
    process.env.NVIDIA_API_KEY = "nvapi-single-key";
    initApiKeyPool();
    expect(getPoolSize()).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. formatPoolStats (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("apiKeyPool: formatPoolStats", () => {
  it("returns 'Pool empty' message when pool is not initialized", () => {
    const formatted = formatPoolStats();
    expect(formatted).toContain("Pool empty");
  });

  it("returns formatted string with per-key stats when pool is initialized", () => {
    process.env.NVIDIA_API_KEYS = "nvapi-aaaa1111,nvapi-bbbb2222";
    initApiKeyPool();
    const formatted = formatPoolStats();
    expect(formatted).toContain("[API_POOL]");
    expect(formatted).toContain("2 key(s):");
    expect(formatted).toContain("#0");
    expect(formatted).toContain("#1");
    expect(formatted).toContain("calls=");
    expect(formatted).toContain("ok=");
  });

  it("shows cooldown status when a key is in 429 cooldown", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-cd1,nvapi-cd2";
    initApiKeyPool();
    // Trigger 429 cooldown by acquiring a key and releasing with status 429
    const h = await acquireKeyForStreaming();
    h.release(false, 429, 50);
    const formatted = formatPoolStats();
    expect(formatted).toContain("COOLDOWN");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Round-robin distribution (2 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("apiKeyPool: round-robin distribution", () => {
  it("distributes calls across keys in round-robin order", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-rr1,nvapi-rr2,nvapi-rr3";
    initApiKeyPool();
    const usedIndices: number[] = [];
    for (let i = 0; i < 3; i++) {
      const h = await acquireKeyForStreaming();
      usedIndices.push((h.entry as any).index);
      h.release(true, 200, 10);
    }
    // All 3 keys should have been used (round-robin)
    expect(new Set(usedIndices).size).toBe(3);
  });

  it("wraps around to first key when reaching end of pool", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-w1,nvapi-w2";
    initApiKeyPool();
    const indices: number[] = [];
    for (let i = 0; i < 4; i++) {
      const h = await acquireKeyForStreaming();
      indices.push((h.entry as any).index);
      h.release(true, 200, 10);
    }
    // Should use indices 0,1,0,1 (round-robin wraps)
    expect(indices[0]).toBe(0);
    expect(indices[1]).toBe(1);
    expect(indices[2]).toBe(0);
    expect(indices[3]).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Mutex: only 1 concurrent per key (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("apiKeyPool: mutex (1 concurrent per key)", () => {
  it("blocks second acquire on same key until first releases", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-mu1";  // Single key
    initApiKeyPool();
    const h1 = await acquireKeyForStreaming();
    // Second acquire should block
    let resolved = false;
    const waitP = acquireKeyForStreaming().then((h) => {
      resolved = true;
      h.release(true, 200, 10);
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(resolved).toBe(false);
    // Release first → second should resolve
    h1.release(true, 200, 10);
    await waitP;
    expect(resolved).toBe(true);
  });

  it("different keys can be acquired in parallel (no mutex contention)", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-para1,nvapi-para2";
    initApiKeyPool();
    const [h1, h2] = await Promise.all([
      acquireKeyForStreaming(),
      acquireKeyForStreaming(),
    ]);
    expect((h1.entry as any).index).not.toBe((h2.entry as any).index);
    h1.release(true, 200, 10);
    h2.release(true, 200, 10);
  });

  it("inFlight counter increments during use and resets after release", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-if1";
    initApiKeyPool();
    const h = await acquireKeyForStreaming();
    const duringUse = getPoolStats();
    expect(duringUse[0].inFlight).toBe(1);
    h.release(true, 200, 10);
    const afterRelease = getPoolStats();
    expect(afterRelease[0].inFlight).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Key release & stats tracking (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("apiKeyPool: key release & stats tracking", () => {
  it("successCount increments on successful release", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-success1";
    initApiKeyPool();
    const h = await acquireKeyForStreaming();
    h.release(true, 200, 42);
    const stats = getPoolStats();
    expect(stats[0].successCount).toBe(1);
    expect(stats[0].totalCalls).toBe(1);
  });

  it("errorCount increments on failed release", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-error1";
    initApiKeyPool();
    const h = await acquireKeyForStreaming();
    h.release(false, 500, 10);
    const stats = getPoolStats();
    expect(stats[0].errorCount).toBe(1);
    expect(stats[0].successCount).toBe(0);
  });

  it("latency is tracked (lastLatencyMs and avgLatencyMs)", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-lat1";
    initApiKeyPool();
    const h = await acquireKeyForStreaming();
    h.release(true, 200, 100);
    const stats = getPoolStats();
    expect(stats[0].lastLatencyMs).toBe(100);
    expect(stats[0].avgLatencyMs).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. 429 cooldown handling (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("apiKeyPool: 429 cooldown handling", () => {
  it("rateLimitedCount increments on 429 response", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-rl1";
    initApiKeyPool();
    const h = await acquireKeyForStreaming();
    h.release(false, 429, 10);
    const stats = getPoolStats();
    expect(stats[0].rateLimitedCount).toBe(1);
  });

  it("cooldownUntil is set to 60s in the future on 429", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-cdu1";
    initApiKeyPool();
    const before = Date.now();
    const h = await acquireKeyForStreaming();
    h.release(false, 429, 10);
    const stats = getPoolStats();
    // Cooldown should be ~60s in the future
    expect(stats[0].cooldownUntil).toBeGreaterThan(before + 50000);
    expect(stats[0].cooldownUntil).toBeLessThan(before + 70000);
  });

  it("cooled-down key is skipped by tryAcquireKeyImmediate", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-cds1,nvapi-cds2";
    initApiKeyPool();
    // Acquire key 0 and trigger 429 cooldown
    const h0 = await acquireKeyForStreaming();
    h0.release(false, 429, 10);
    // tryAcquireKeyImmediate should skip the cooled-down key and use the other one
    const immediate = tryAcquireKeyImmediate();
    expect(immediate).not.toBeNull();
    expect((immediate!.entry as any).index).not.toBe(0);  // Not the cooled-down one
    immediate!.release(true, 200, 10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Key prefix never leaks (2 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("apiKeyPool: key prefix never leaks", () => {
  it("keyPrefix contains only first 10 chars + '...'", () => {
    process.env.NVIDIA_API_KEYS = "nvapi-SECRET_PART_THAT_MUST_NEVER_LEAK_1234567890";
    initApiKeyPool();
    const stats = getPoolStats();
    expect(stats[0].keyPrefix).toContain("...");
    expect(stats[0].keyPrefix.startsWith("nvapi-")).toBe(true);
  });

  it("JSON.stringify of stats does not contain secret parts", () => {
    process.env.NVIDIA_API_KEYS = "nvapi-SECRET_CONTENT_ABC123XYZ";
    initApiKeyPool();
    const stats = getPoolStats();
    const json = JSON.stringify(stats);
    expect(json).not.toContain("SECRET_CONTENT");
    expect(json).not.toContain("ABC123XYZ");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Multi-key from NVIDIA_API_KEYS env var (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("apiKeyPool: multi-key from NVIDIA_API_KEYS", () => {
  it("parses comma-separated keys", () => {
    process.env.NVIDIA_API_KEYS = "nvapi-a,nvapi-b,nvapi-c";
    const keys = loadApiKeys();
    expect(keys).toEqual(["nvapi-a", "nvapi-b", "nvapi-c"]);
  });

  it("trims whitespace around keys", () => {
    process.env.NVIDIA_API_KEYS = "  nvapi-a , nvapi-b ,  nvapi-c  ";
    const keys = loadApiKeys();
    expect(keys).toEqual(["nvapi-a", "nvapi-b", "nvapi-c"]);
  });

  it("ignores keys that don't start with 'nvapi-'", () => {
    process.env.NVIDIA_API_KEYS = "nvapi-valid,invalid-key,nvapi-also-valid";
    const keys = loadApiKeys();
    expect(keys).toEqual(["nvapi-valid", "nvapi-also-valid"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Multi-key from NVIDIA_API_KEYS_FILE (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("apiKeyPool: multi-key from NVIDIA_API_KEYS_FILE", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `apikey-test-${Date.now()}.txt`);
  });
  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it("reads one key per line", () => {
    fs.writeFileSync(tmpFile, "nvapi-line1\nnvapi-line2\nnvapi-line3\n");
    process.env.NVIDIA_API_KEYS_FILE = tmpFile;
    const keys = loadApiKeys();
    expect(keys).toEqual(["nvapi-line1", "nvapi-line2", "nvapi-line3"]);
  });

  it("ignores blank lines and lines that don't start with 'nvapi-'", () => {
    fs.writeFileSync(tmpFile, "nvapi-1\n\n# comment\nnvapi-2\nnot-a-key\n");
    process.env.NVIDIA_API_KEYS_FILE = tmpFile;
    const keys = loadApiKeys();
    expect(keys).toEqual(["nvapi-1", "nvapi-2"]);
  });

  it("returns empty array when file doesn't exist", () => {
    process.env.NVIDIA_API_KEYS_FILE = "/nonexistent/path/file.txt";
    const keys = loadApiKeys();
    expect(keys).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Single key backward compat (2 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("apiKeyPool: single key backward compat", () => {
  it("falls back to NVIDIA_API_KEY when NVIDIA_API_KEYS not set", () => {
    process.env.NVIDIA_API_KEY = "nvapi-single-fallback";
    const keys = loadApiKeys();
    expect(keys).toEqual(["nvapi-single-fallback"]);
  });

  it("NVIDIA_API_KEYS takes priority over NVIDIA_API_KEY", () => {
    process.env.NVIDIA_API_KEYS = "nvapi-multi1,nvapi-multi2";
    process.env.NVIDIA_API_KEY = "nvapi-ignored";
    const keys = loadApiKeys();
    expect(keys).toEqual(["nvapi-multi1", "nvapi-multi2"]);
    expect(keys).not.toContain("nvapi-ignored");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Pool initialization is idempotent (2 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("apiKeyPool: idempotent initialization", () => {
  it("returns true on first init, true on second (no re-init)", () => {
    process.env.NVIDIA_API_KEYS = "nvapi-idem1,nvapi-idem2";
    expect(initApiKeyPool()).toBe(true);
    expect(getPoolSize()).toBe(2);
    // Change env and init again — should NOT re-init
    process.env.NVIDIA_API_KEYS = "nvapi-idem3,nvapi-idem4,nvapi-idem5";
    expect(initApiKeyPool()).toBe(true);
    expect(getPoolSize()).toBe(2);  // Still 2, not 3
  });

  it("returns false when no keys configured", () => {
    expect(initApiKeyPool()).toBe(false);
    expect(getPoolSize()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Prewarm tests (4 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("apiKeyPool: prewarm", () => {
  it("skips prewarm when pool is empty (no chat.create calls)", async () => {
    await prewarmPool();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("calls chat.create once per key on first prewarm", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-pw1,nvapi-pw2,nvapi-pw3";
    initApiKeyPool();
    await prewarmPool();
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("is idempotent: second prewarm call is a no-op", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-pw1,nvapi-pw2";
    initApiKeyPool();
    await prewarmPool();
    await prewarmPool();
    expect(mockCreate).toHaveBeenCalledTimes(2);  // Not 4
  });

  it("resetPrewarm allows re-prewarming", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-rp1";
    initApiKeyPool();
    await prewarmPool();
    resetPrewarm();
    await prewarmPool();
    expect(mockCreate).toHaveBeenCalledTimes(2);  // Once per prewarm
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. tryAcquireKeyImmediate (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("apiKeyPool: tryAcquireKeyImmediate", () => {
  it("returns null when pool is empty", () => {
    expect(tryAcquireKeyImmediate()).toBeNull();
  });

  it("returns handle immediately when key is free", () => {
    process.env.NVIDIA_API_KEYS = "nvapi-imm1";
    initApiKeyPool();
    const h = tryAcquireKeyImmediate();
    expect(h).not.toBeNull();
    expect(h!.client).toBeDefined();
    expect(typeof h!.release).toBe("function");
    h!.release(true, 200, 10);
  });

  it("returns null when all keys are in use", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-imm2";  // Single key
    initApiKeyPool();
    const h1 = await acquireKeyForStreaming();
    // Key is in use — tryAcquireImmediate should return null
    expect(tryAcquireKeyImmediate()).toBeNull();
    h1.release(true, 200, 10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. getAvailableKeyCount vs getTotalKeyCount (2 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("apiKeyPool: getAvailableKeyCount vs getTotalKeyCount", () => {
  it("both return 0 when pool is empty", () => {
    expect(getAvailableKeyCount()).toBe(0);
    expect(getTotalKeyCount()).toBe(0);
  });

  it("available decreases when a key is acquired, total stays the same", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-avail1,nvapi-avail2,nvapi-avail3";
    initApiKeyPool();
    expect(getTotalKeyCount()).toBe(3);
    expect(getAvailableKeyCount()).toBe(3);
    const h = await acquireKeyForStreaming();
    expect(getTotalKeyCount()).toBe(3);  // Unchanged
    expect(getAvailableKeyCount()).toBe(2);  // One less available
    h.release(true, 200, 10);
    expect(getAvailableKeyCount()).toBe(3);  // Back to 3
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. poolChatCompletion (2 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("apiKeyPool: poolChatCompletion", () => {
  it("auto-initializes pool when called with no prior init", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-pcc1";
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "response" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const response = await poolChatCompletion({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      stream: true,  // poolChatCompletion forces stream=false internally
    } as any);
    expect(response).toBeDefined();
    expect(response.choices[0].message.content).toBe("response");
    expect(getPoolSize()).toBe(1);  // Pool was initialized
  });

  it("throws when no API keys configured", async () => {
    // No env vars set, no prior init
    resetPool();
    await expect(poolChatCompletion({
      model: "x",
      messages: [],
      stream: false,
    } as any)).rejects.toThrow(/No API keys configured/);
  });
});
