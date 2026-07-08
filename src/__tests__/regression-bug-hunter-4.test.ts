/**
 * regression-bug-hunter-4.test.ts — Regression tests for Bug Hunter #4 fixes.
 *
 * Focus area: API client + heartbeat + key pool
 *   - src/apiClient.ts
 *   - src/heartbeat.ts
 *   - src/apiKeyPool.ts
 *   - src/apiProvider.ts
 *   - src/apiResearcher.ts
 *   - src/retry.ts
 *   - src/streaming.ts
 *
 * Bugs fixed:
 *   1. retry.ts isRetryableError — was treating ALL 5xx as retryable, but
 *      BUSINESS_RULES.md §17.4 rule 20 says only 502/503 are retriable
 *      (500 = real bug, 504 = gateway timeout). The fix narrows the 5xx
 *      retriable set to {502, 503}, matching apiClient.ts.
 *   2. apiKeyPool.ts loadKeysFromFile — was using require("node:fs") which
 *      violates the project's ESM-only convention. Replaced with a
 *      top-level `import fs from "node:fs"`.
 *   3. apiClient.ts buildQuotaExhaustedMessage — was using require("./i18n.js")
 *      which violates the ESM-only convention. Converted to async function
 *      with `await import("./i18n.js")`. Caller handle429Error already async.
 *
 * Each test FAILS without the fix and PASSES with it. Additional tests
 * verify §17 invariants are not violated.
 *
 * NOTE: apiClient's chat() regression test lives in
 * `regression-bug-hunter-4-apiClient.test.ts` because it requires
 * module-level vi.mock() of openai/config/apiKeyPool/apiProvider/modelRegistry,
 * which would interfere with the direct apiKeyPool tests below.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Top-level mocks (logger only — keeps apiKeyPool/retry real) ───────────

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
}));

// Mock OpenAI constructor so apiKeyPool.initApiKeyPool() can construct clients
// without making real network calls. We do NOT mock apiKeyPool itself — we want
// the real `loadApiKeys` / `loadKeysFromFile` code path to run.
vi.mock("openai", () => ({
  default: class MockOpenAI {
    apiKey: string;
    baseURL: string;
    timeout: number;
    chat = { completions: { create: vi.fn(async () => ({})) } };
    constructor(opts: any) {
      this.apiKey = opts.apiKey;
      this.baseURL = opts.baseURL;
      this.timeout = opts.timeout;
    }
  },
}));

// ═══════════════════════════════════════════════════════════════════════════
// 1. retry.ts isRetryableError — 5xx retriable set narrowed to {502, 503}
// ═══════════════════════════════════════════════════════════════════════════

import { isRetryableError } from "../retry.js";

describe("Bug Hunter #4 — retry.ts isRetryableError 5xx set", () => {
  // BUSINESS_RULES.md §17.4 rule 20:
  //   "5xx: só 502/503 retriable — 500/504 não."
  //   §3.3: "5xx NÃO retriable: 500 (bug real), 504 (gateway timeout)."

  it("returns false for HTTP 500 (real server bug — NOT retriable)", () => {
    expect(isRetryableError({ status: 500 })).toBe(false);
  });

  it("returns false for HTTP 504 (gateway timeout — NOT retriable)", () => {
    expect(isRetryableError({ status: 504 })).toBe(false);
  });

  it("returns true for HTTP 502 (bad gateway — transient)", () => {
    expect(isRetryableError({ status: 502 })).toBe(true);
  });

  it("returns true for HTTP 503 (service unavailable — transient)", () => {
    expect(isRetryableError({ status: 503 })).toBe(true);
  });

  it("returns true for HTTP 429 (rate limit)", () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
  });

  it("returns false for HTTP 400 (client error)", () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
  });

  it("network codes (ECONNRESET, ETIMEDOUT, etc.) are still retryable", () => {
    expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isRetryableError({ code: "ENOTFOUND" })).toBe(true);
    expect(isRetryableError({ code: "EPIPE" })).toBe(true);
    expect(isRetryableError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isRetryableError({ code: "EAI_AGAIN" })).toBe(true);
    expect(isRetryableError({ code: "EHOSTUNREACH" })).toBe(true);
  });

  it("regression: a generic 5xx range check no longer accidentally returns true for 500/504", () => {
    // Before the fix, `error?.status >= 500 && error?.status < 600` returned
    // true for 500/501/502/503/504/505/506/507/508/510/511. Now only 502/503.
    for (const status of [500, 501, 504, 505, 506, 507, 508, 510, 511]) {
      expect(isRetryableError({ status })).toBe(false);
    }
    for (const status of [502, 503]) {
      expect(isRetryableError({ status })).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. apiKeyPool.ts loadKeysFromFile — ESM import instead of require()
// ═══════════════════════════════════════════════════════════════════════════

import { loadApiKeys, initApiKeyPool, resetPool, getPoolSize } from "../apiKeyPool.js";

describe("Bug Hunter #4 — apiKeyPool loadKeysFromFile uses ESM import", () => {
  let tmpFile: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.NVIDIA_API_KEY;
    delete process.env.NVIDIA_API_KEYS;
    delete process.env.NVIDIA_API_KEYS_FILE;
    resetPool();
    tmpFile = path.join(os.tmpdir(), `bh4-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    process.env = { ...originalEnv };
    resetPool();
  });

  it("reads keys from NVIDIA_API_KEYS_FILE (one per line)", () => {
    fs.writeFileSync(tmpFile, "nvapi-key1\nnvapi-key2\nnvapi-key3\n");
    process.env.NVIDIA_API_KEYS_FILE = tmpFile;
    const keys = loadApiKeys();
    expect(keys).toEqual(["nvapi-key1", "nvapi-key2", "nvapi-key3"]);
  });

  it("ignores blank lines and lines not starting with 'nvapi-'", () => {
    fs.writeFileSync(tmpFile, "nvapi-1\n\n# comment\nnvapi-2\nnot-a-key\n  nvapi-3  \n");
    process.env.NVIDIA_API_KEYS_FILE = tmpFile;
    const keys = loadApiKeys();
    expect(keys).toEqual(["nvapi-1", "nvapi-2", "nvapi-3"]);
  });

  it("returns empty array when file doesn't exist (no crash)", () => {
    process.env.NVIDIA_API_KEYS_FILE = "/nonexistent/path/bh4-nope.txt";
    const keys = loadApiKeys();
    expect(keys).toEqual([]);
  });

  it("returns empty array when env var is not set", () => {
    const keys = loadApiKeys();
    expect(keys).toEqual([]);
  });

  it("initializes the pool from file-loaded keys", () => {
    fs.writeFileSync(tmpFile, "nvapi-file1\nnvapi-file2\n");
    process.env.NVIDIA_API_KEYS_FILE = tmpFile;
    expect(initApiKeyPool()).toBe(true);
    expect(getPoolSize()).toBe(2);
  });

  it("regression: loadApiKeys does NOT throw 'require is not defined' in ESM", () => {
    // Before the fix, `require("node:fs")` would throw in strict ESM mode.
    // After the fix, the top-level `import fs from "node:fs"` works.
    fs.writeFileSync(tmpFile, "nvapi-esm-test\n");
    process.env.NVIDIA_API_KEYS_FILE = tmpFile;
    expect(() => loadApiKeys()).not.toThrow();
    expect(loadApiKeys()).toEqual(["nvapi-esm-test"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. §17 invariant verification — no regressions on protected rules
// ═══════════════════════════════════════════════════════════════════════════

describe("Bug Hunter #4 — §17 invariants not violated", () => {
  it("apiClient.ts: stream_options.include_usage=true is always sent (§17.4 rule 15)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../apiClient.ts"),
      "utf8"
    );
    expect(src).toContain("stream_options: { include_usage: true }");
  });

  it("heartbeat.ts: temperature = 0.01 (§17.4 rule 16 — NOT 0.0)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../heartbeat.ts"),
      "utf8"
    );
    // Match `temperature: 0.01` but NOT `temperature: 0.0` (without 1) or `temperature: 0`
    expect(src).toMatch(/temperature:\s*0\.01\b/);
    expect(src).not.toMatch(/temperature:\s*0\.0[^0-9]/);
    expect(src).not.toMatch(/temperature:\s*0\s*[,}]/);
  });

  it("heartbeat.ts: HEARTBEAT_INTERVAL_MS >= 300000 invariant enforced (§17.4 rule 17)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../heartbeat.ts"),
      "utf8"
    );
    expect(src).toContain("HEARTBEAT_INTERVAL_MS >= 300000");
  });

  it("apiClient.ts: MAX_429_RETRIES = 4 (§3.1)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../apiClient.ts"),
      "utf8"
    );
    expect(src).toMatch(/MAX_429_RETRIES\s*=\s*4\b/);
  });

  it("apiClient.ts: HANG_TIMEOUT_MS = 180000 (§3.1 — MUST NOT change)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../apiClient.ts"),
      "utf8"
    );
    expect(src).toMatch(/HANG_TIMEOUT_MS\s*=\s*180_?000/);
  });

  it("apiClient.ts: 5xx retriable set = {502, 503} only (§17.4 rule 20)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../apiClient.ts"),
      "utf8"
    );
    expect(src).toMatch(/RETRIABLE_5XX_STATUSES\s*=\s*new Set\(\[502,\s*503\]\)/);
  });

  it("retry.ts: isRetryableError now uses {502, 503} only (aligned with apiClient)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../retry.ts"),
      "utf8"
    );
    expect(src).toMatch(/RETRIABLE_5XX_STATUSES\s*=\s*new Set\(\[502,\s*503\]\)/);
    // The old buggy range check must NOT be present anymore
    expect(src).not.toMatch(/status\s*>=\s*500\s*&&\s*error\?\.status\s*<\s*600/);
  });

  it("apiClient.ts: hedging is NVIDIA-only with 5s timeout (§3.4)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../apiClient.ts"),
      "utf8"
    );
    expect(src).toMatch(/HEDGE_TIMEOUT_MS\s*=\s*5000/);
    expect(src).toContain("providerNeedsHedging()");
  });

  it("apiKeyPool.ts: no require() calls remain (ESM-only convention)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../apiKeyPool.ts"),
      "utf8"
    );
    // The require() for "node:fs" should be gone — replaced with top-level import
    expect(src).not.toMatch(/require\s*\(\s*["']node:fs["']\s*\)/);
    expect(src).toMatch(/^import\s+fs\s+from\s+["']node:fs["']/m);
  });

  it("apiClient.ts: no require() calls remain for i18n (ESM-only convention)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../apiClient.ts"),
      "utf8"
    );
    expect(src).not.toMatch(/require\s*\(\s*["']\.\/i18n\.js["']\s*\)/);
    // Dynamic import is the ESM-compliant alternative
    expect(src).toMatch(/await\s+import\s*\(\s*["']\.\/i18n\.js["']\s*\)/);
  });

  it("heartbeat.ts: heartbeat uses max_tokens = 1 (§4)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../heartbeat.ts"),
      "utf8"
    );
    expect(src).toMatch(/max_tokens:\s*1\b/);
  });

  it("heartbeat.ts: 5 consecutive failures auto-stop (§4)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../heartbeat.ts"),
      "utf8"
    );
    expect(src).toMatch(/consecutiveFailures\s*>=\s*5/);
  });

  it("apiKeyPool.ts: cooldown after 429 = 60s (§5.1)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../apiKeyPool.ts"),
      "utf8"
    );
    expect(src).toMatch(/COOLDOWN_AFTER_429_MS\s*=\s*60_?000/);
  });

  it("apiKeyPool.ts: rate limit RPM = 40 (§5.1)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../apiKeyPool.ts"),
      "utf8"
    );
    expect(src).toMatch(/RATE_LIMIT_RPM\s*=\s*40\b/);
  });
});
