/**
 * apiKeyPool.test.ts — Tests for the multi-key pool (Fase 1).
 *
 * Tests cover:
 *   - Initialization (env var parsing, file loading, single-key fallback)
 *   - Round-robin key selection
 *   - Per-key mutex (1 concurrent per key)
 *   - 429 cooldown (60s)
 *   - Metrics tracking
 *   - resetPool / resetPoolStats for test isolation
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
}));

import {
  initApiKeyPool,
  loadApiKeys,
  getPoolSize,
  acquireKeyForStreaming,
  getPoolStats,
  formatPoolStats,
  resetPool,
  resetPoolStats,
} from "../apiKeyPool.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEYS;
  delete process.env.NVIDIA_API_KEYS_FILE;
  resetPool();
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetPool();
});

describe("apiKeyPool — initialization", () => {
  describe("loadApiKeys", () => {
    it("returns empty array when no env vars set", () => {
      expect(loadApiKeys()).toEqual([]);
    });

    it("loads single key from NVIDIA_API_KEY (backwards compat)", () => {
      process.env.NVIDIA_API_KEY = "nvapi-test123";
      const keys = loadApiKeys();
      expect(keys).toEqual(["nvapi-test123"]);
    });

    it("loads multiple keys from NVIDIA_API_KEYS (comma-separated)", () => {
      process.env.NVIDIA_API_KEYS = "nvapi-key1,nvapi-key2,nvapi-key3";
      const keys = loadApiKeys();
      expect(keys).toEqual(["nvapi-key1", "nvapi-key2", "nvapi-key3"]);
    });

    it("trims whitespace in comma-separated keys", () => {
      process.env.NVIDIA_API_KEYS = " nvapi-key1 , nvapi-key2 , nvapi-key3 ";
      const keys = loadApiKeys();
      expect(keys).toEqual(["nvapi-key1", "nvapi-key2", "nvapi-key3"]);
    });

    it("skips entries that don't start with nvapi-", () => {
      process.env.NVIDIA_API_KEYS = "nvapi-key1,invalid-key,nvapi-key2";
      const keys = loadApiKeys();
      expect(keys).toEqual(["nvapi-key1", "nvapi-key2"]);
    });

    it("prefers NVIDIA_API_KEYS over NVIDIA_API_KEY", () => {
      process.env.NVIDIA_API_KEY = "nvapi-single";
      process.env.NVIDIA_API_KEYS = "nvapi-multi1,nvapi-multi2";
      const keys = loadApiKeys();
      expect(keys).toEqual(["nvapi-multi1", "nvapi-multi2"]);
    });
  });

  describe("initApiKeyPool", () => {
    it("returns false when no keys configured", () => {
      expect(initApiKeyPool()).toBe(false);
      expect(getPoolSize()).toBe(0);
    });

    it("initializes with single key from NVIDIA_API_KEY", () => {
      process.env.NVIDIA_API_KEY = "nvapi-test123";
      expect(initApiKeyPool()).toBe(true);
      expect(getPoolSize()).toBe(1);
    });

    it("initializes with 3 keys from NVIDIA_API_KEYS", () => {
      process.env.NVIDIA_API_KEYS = "nvapi-k1,nvapi-k2,nvapi-k3";
      expect(initApiKeyPool()).toBe(true);
      expect(getPoolSize()).toBe(3);
    });

    it("is idempotent — calling twice doesn't duplicate", () => {
      process.env.NVIDIA_API_KEYS = "nvapi-k1,nvapi-k2";
      initApiKeyPool();
      const size1 = getPoolSize();
      initApiKeyPool();
      const size2 = getPoolSize();
      expect(size1).toBe(size2);
      expect(size2).toBe(2);
    });
  });
});

describe("apiKeyPool — key acquisition", () => {
  beforeEach(() => {
    process.env.NVIDIA_API_KEYS = "nvapi-k1,nvapi-k2,nvapi-k3";
    initApiKeyPool();
  });

  it("acquireKeyForStreaming returns a client and release function", async () => {
    const handle = await acquireKeyForStreaming();
    expect(handle.client).toBeDefined();
    expect(typeof handle.release).toBe("function");
    handle.release(true, 200, 100);
  });

  it("round-robin: 3 sequential acquisitions use 3 different keys (4-key pool, last is reserve)", async () => {
    // BH2 HIGH 4 / §4 / §5.5: the LAST key in the pool is "reserva" for
    // heartbeat and is excluded from round-robin unless all non-reserve
    // keys are busy. Use 4 keys (3 non-reserve + 1 reserve) so 3 sequential
    // acquires can still hit 3 distinct non-reserve keys.
    process.env.NVIDIA_API_KEYS = "nvapi-k1,nvapi-k2,nvapi-k3,nvapi-k4";
    resetPool();
    initApiKeyPool();
    const handles: any[] = [];
    // Acquire and release sequentially
    const h1 = await acquireKeyForStreaming();
    const idx1 = (h1 as any).entry.index;
    h1.release(true, 200, 50);
    const h2 = await acquireKeyForStreaming();
    const idx2 = (h2 as any).entry.index;
    h2.release(true, 200, 50);
    const h3 = await acquireKeyForStreaming();
    const idx3 = (h3 as any).entry.index;
    h3.release(true, 200, 50);
    // Should have used 3 different non-reserve indices (0, 1, 2)
    const indices = new Set([idx1, idx2, idx3]);
    expect(indices.size).toBe(3);
    // Reserve key (last index = 3) must NOT be used in normal round-robin.
    expect(indices.has(3)).toBe(false);
  });

  it("reserves the LAST key for heartbeat — pool skips it in round-robin (§4, §5.5)", async () => {
    // 3-key pool: indices 0, 1 are non-reserve; index 2 is reserve.
    // 6 sequential acquires should only touch indices 0 and 1.
    const usedIndices = new Set<number>();
    for (let n = 0; n < 6; n++) {
      const h = await acquireKeyForStreaming();
      usedIndices.add((h as any).entry.index);
      h.release(true, 200, 5);
    }
    expect(usedIndices.has(2)).toBe(false);  // reserve never used in round-robin
    expect(usedIndices.size).toBe(2);        // only the 2 non-reserve keys
  });

  it("falls back to reserve key when all non-reserve keys are busy (§4)", async () => {
    // Lock both non-reserve keys; the 3rd acquire must use the reserve.
    const h1 = await acquireKeyForStreaming();  // idx 0
    const h2 = await acquireKeyForStreaming();  // idx 1
    const h3 = await acquireKeyForStreaming();  // idx 2 (reserve fallback)
    expect((h1 as any).entry.index).toBe(0);
    expect((h2 as any).entry.index).toBe(1);
    expect((h3 as any).entry.index).toBe(2);
    h1.release(true, 200, 5);
    h2.release(true, 200, 5);
    h3.release(true, 200, 5);
  });

  it("waits when all keys are busy (mutex enforcement)", async () => {
    // Acquire all 3 keys (don't release)
    const h1 = await acquireKeyForStreaming();
    const h2 = await acquireKeyForStreaming();
    const h3 = await acquireKeyForStreaming();
    // Now all 3 are locked — 4th acquisition should wait
    let acquired = false;
    const waitPromise = acquireKeyForStreaming().then((h) => {
      acquired = true;
      h.release(true, 200, 50);
    });
    // Wait 200ms — should still be waiting
    await new Promise((r) => setTimeout(r, 200));
    expect(acquired).toBe(false);
    // Release one — the waitPromise should resolve
    h1.release(true, 200, 50);
    await waitPromise;
    expect(acquired).toBe(true);
    // Cleanup
    h2.release(true, 200, 50);
    h3.release(true, 200, 50);
  });
});

describe("apiKeyPool — metrics", () => {
  beforeEach(() => {
    process.env.NVIDIA_API_KEYS = "nvapi-k1,nvapi-k2";
    initApiKeyPool();
  });

  it("getPoolStats returns one entry per key with correct fields", () => {
    const stats = getPoolStats();
    expect(stats).toHaveLength(2);
    for (const s of stats) {
      expect(s.index).toBeGreaterThanOrEqual(0);
      expect(s.keyPrefix).toContain("nvapi-");
      expect(s.keyPrefix).toContain("...");
      expect(s.totalCalls).toBe(0);
      expect(s.successCount).toBe(0);
      expect(s.errorCount).toBe(0);
      expect(s.rateLimitedCount).toBe(0);
      expect(s.cooldownUntil).toBe(0);
      expect(s.inFlight).toBe(0);
    }
  });

  it("updates stats after acquire+release with success", async () => {
    const handle = await acquireKeyForStreaming();
    handle.release(true, 200, 250);
    const stats = getPoolStats();
    const usedKey = stats.find((s) => s.totalCalls > 0);
    expect(usedKey).toBeDefined();
    expect(usedKey!.totalCalls).toBe(1);
    expect(usedKey!.successCount).toBe(1);
    expect(usedKey!.lastLatencyMs).toBe(250);
    expect(usedKey!.avgLatencyMs).toBe(250);
  });

  it("updates stats after acquire+release with error", async () => {
    const handle = await acquireKeyForStreaming();
    handle.release(false, 500, 100);
    const stats = getPoolStats();
    const usedKey = stats.find((s) => s.totalCalls > 0);
    expect(usedKey).toBeDefined();
    expect(usedKey!.errorCount).toBe(1);
    expect(usedKey!.successCount).toBe(0);
  });

  it("429 status triggers cooldown", async () => {
    const handle = await acquireKeyForStreaming();
    handle.release(false, 429, 100);
    const stats = getPoolStats();
    const cooledDown = stats.find((s) => s.cooldownUntil > 0);
    expect(cooledDown).toBeDefined();
    expect(cooledDown!.rateLimitedCount).toBe(1);
    expect(cooledDown!.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("formatPoolStats returns readable string", async () => {
    const handle = await acquireKeyForStreaming();
    handle.release(true, 200, 150);
    const formatted = formatPoolStats();
    expect(formatted).toContain("[API_POOL]");
    expect(formatted).toContain("2 key(s)");
    expect(formatted).toContain("nvapi-");
    expect(formatted).toContain("calls=1");
  });

  it("resetPoolStats zeros out all counters", async () => {
    const handle = await acquireKeyForStreaming();
    handle.release(true, 200, 100);
    expect(getPoolStats().some((s) => s.totalCalls > 0)).toBe(true);
    resetPoolStats();
    const stats = getPoolStats();
    for (const s of stats) {
      expect(s.totalCalls).toBe(0);
      expect(s.successCount).toBe(0);
    }
  });
});

describe("apiKeyPool — key prefix never leaks full key", () => {
  it("keyPrefix starts with nvapi- but does not contain the full secret", () => {
    process.env.NVIDIA_API_KEYS = "nvapi-VERY_LONG_SECRET_KEY_THAT_SHOULD_NOT_BE_LOGGED_1234567890";
    initApiKeyPool();
    const stats = getPoolStats();
    expect(stats[0].keyPrefix.startsWith("nvapi-")).toBe(true);
    expect(stats[0].keyPrefix).toContain("...");
    // Ensure the sensitive part of the key is NOT in the prefix
    expect(stats[0].keyPrefix).not.toContain("SECRET");
    expect(stats[0].keyPrefix).not.toContain("1234567890");
    // And the full key is definitely not there
    expect(stats[0].keyPrefix).not.toContain("SHOULD_NOT_BE_LOGGED");
  });

  it("formatPoolStats does not leak sensitive parts of the key", () => {
    process.env.NVIDIA_API_KEYS = "nvapi-VERY_LONG_SECRET_KEY_THAT_SHOULD_NOT_BE_LOGGED_1234567890";
    initApiKeyPool();
    const formatted = formatPoolStats();
    expect(formatted).not.toContain("SECRET");
    expect(formatted).not.toContain("1234567890");
    expect(formatted).not.toContain("SHOULD_NOT_BE_LOGGED");
    // But the safe prefix is there
    expect(formatted).toContain("nvapi-VERY");
    expect(formatted).toContain("...");
  });
});
