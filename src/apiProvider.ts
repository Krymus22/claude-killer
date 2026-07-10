/**
 * apiProvider.ts — Abstraction over API providers (NVIDIA NIM, ZenMux).
 *
 * Each provider has different characteristics:
 *
 * NVIDIA NIM (build.nvidia.com):
 *   - Cold start: 5-60s (model unloaded from GPU after idle)
 *   - Concurrency: 1 per key (need multi-key pool for parallelism)
 *   - Rate limit: 40 RPM per key
 *   - Thinking: needs chat_template_kwargs: { thinking_mode: "enabled" }
 *   - Reasoning field: reasoning_content
 *   - Heartbeat: required (prevents cold start)
 *   - Hedging: useful (GPU queue contention)
 *
 * ZenMux (zenmux.ai):
 *   - Cold start: none (instant)
 *   - Concurrency: 10+ simultaneous (no GPU queue)
 *   - Rate limit: none apparent
 *   - Thinking: built-in per model (don't send chat_template_kwargs)
 *   - Reasoning field: "reasoning" (not "reasoning_content")
 *   - Heartbeat: not needed
 *   - Hedging: not needed
 *   - Sub-agents: 10+ parallel (no key contention)
 */

import * as fs from "node:fs";

export type ProviderName = "nvidia" | "zenmux";

export interface ProviderConfig {
  name: ProviderName;
  baseUrl: string;
  apiKey: string;
  /** Whether to send chat_template_kwargs with thinking_mode. */
  sendThinkingMode: boolean;
  /** Field name for reasoning content in stream chunks. */
  reasoningField: "reasoning_content" | "reasoning";
  /** Whether heartbeat is needed (prevents cold start). */
  needsHeartbeat: boolean;
  /** Whether delayed hedging is useful (GPU queue contention). */
  needsHedging: boolean;
  /** Whether multi-key pool is needed (NVIDIA: yes, ZenMux: no). */
  needsMultiKeyPool: boolean;
  /** Max concurrent sub-agents. */
  maxConcurrentSubAgents: number;
  /** Max tokens to request in heartbeat (1 for both). */
  heartbeatMaxTokens: number;
}

// --- Provider definitions ---------------------------------------------------

const NVIDIA_CONFIG: Omit<ProviderConfig, "apiKey"> = {
  name: "nvidia",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  sendThinkingMode: true,
  reasoningField: "reasoning_content",
  needsHeartbeat: true,
  needsHedging: true,
  needsMultiKeyPool: true,
  maxConcurrentSubAgents: 2,
  heartbeatMaxTokens: 1,
};

const ZENMUX_CONFIG: Omit<ProviderConfig, "apiKey"> = {
  name: "zenmux",
  baseUrl: "https://zenmux.ai/api/v1",
  sendThinkingMode: false,
  reasoningField: "reasoning",
  needsHeartbeat: false,
  needsHedging: false,
  needsMultiKeyPool: false,
  maxConcurrentSubAgents: 10,
  heartbeatMaxTokens: 1,
};

// --- Public API -------------------------------------------------------------

/**
 * Detect which provider to use based on env vars.
 *
 * Priority:
 *   1. API_PROVIDER env var (explicit choice)
 *   2. ZENMUX_API_KEY set → zenmux
 *   3. NVIDIA_API_KEY, NVIDIA_API_KEYS, or NVIDIA_API_KEYS_FILE set → nvidia (default)
 *
 * CRITICAL FIX (BH2 CRITICAL 2): previously, a user with ONLY
 * NVIDIA_API_KEYS_FILE set (a legitimate config per §5.2) was misrouted
 * to zenmux because detectProvider() didn't consider the file. Now the
 * auto-detect zenmux branch requires ALL THREE NVIDIA env vars to be
 * absent.
 */
export function detectProvider(): ProviderName {
  const explicit = process.env.API_PROVIDER?.toLowerCase().trim();
  if (explicit === "zenmux") return "zenmux";
  if (explicit === "nvidia") return "nvidia";

  // Auto-detect: zenmux only if NO NVIDIA key source is configured (§5.2).
  // Must include NVIDIA_API_KEYS_FILE — otherwise a file-only NVIDIA config
  // is misrouted to zenmux and the CLI exits with code 1 in getProviderConfig.
  if (
    process.env.ZENMUX_API_KEY &&
    !process.env.NVIDIA_API_KEY &&
    !process.env.NVIDIA_API_KEYS &&
    !process.env.NVIDIA_API_KEYS_FILE
  ) {
    return "zenmux";
  }

  // Default: nvidia
  return "nvidia";
}

/**
 * Pick the first valid NVIDIA API key from env vars (§5.2 precedence).
 *
 *   1. NVIDIA_API_KEY (single, backwards compat) — trim only, no `nvapi-`
 *      filter (legacy users may have keys without the prefix).
 *   2. NVIDIA_API_KEYS (comma-separated) — trim + filter `nvapi-` (HIGH 3).
 *   3. NVIDIA_API_KEYS_FILE (one per line) — same filter (§5.2, CRITICAL 2).
 *
 * HIGH 3 (BH2): trim + filter on NVIDIA_API_KEYS so that shell-quoted
 * whitespace (" nvapi-key1 , nvapi-key2 ") doesn't produce an apiKey
 * with embedded spaces that NVIDIA rejects as invalid credentials, and
 * so a malformed first entry (e.g. a ZenMux key pasted by mistake) is
 * skipped instead of used as-is. This matches loadApiKeys() in
 * apiKeyPool.ts so the provider config and the pool agree on the
 * "first key".
 *
 * CRITICAL 2 (BH2): also consult NVIDIA_API_KEYS_FILE so a file-only
 * NVIDIA config doesn't exit(1) before initApiKeyPool() ever runs.
 */
function pickFirstNvidiaKey(): string {
  // 1. NVIDIA_API_KEY (single, backwards compat) — trim only.
  const single = process.env.NVIDIA_API_KEY?.trim();
  if (single) return single;

  // 2. NVIDIA_API_KEYS (comma-separated) — trim + filter `nvapi-` (§5.2).
  const multiKeys = process.env.NVIDIA_API_KEYS?.split(",")
    .map((k) => k.trim())
    .filter((k) => k.startsWith("nvapi-"));
  if (multiKeys && multiKeys.length > 0) return multiKeys[0];

  // 3. NVIDIA_API_KEYS_FILE (one per line) — same filter (§5.2).
  const fileFirst = readFirstKeyFromFile(process.env.NVIDIA_API_KEYS_FILE);
  if (fileFirst) return fileFirst;

  return "";
}

/**
 * Read the first valid (`nvapi-`-prefixed) key from a file (one per line).
 * Returns "" if the file is unset, missing, or contains no valid keys.
 * Mirrors the parsing in apiKeyPool.ts:loadKeysFromFile so the provider
 * config and the pool agree on what counts as a valid key.
 */
function readFirstKeyFromFile(filePath: string | undefined): string {
  const path = filePath?.trim();
  if (!path) return "";
  try {
    const content = fs.readFileSync(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("nvapi-")) return trimmed;
    }
    return "";
  } catch {
    // File missing or unreadable — let the caller fall through to exit(1)
    // with a helpful message (same behavior as loadKeysFromFile's warn).
    return "";
  }
}

/**
 * Get the full provider config, including API key from env vars.
 */
export function getProviderConfig(): ProviderConfig {
  const provider = detectProvider();

  if (provider === "zenmux") {
    const apiKey = process.env.ZENMUX_API_KEY ?? "";
    if (!apiKey) {
      console.error(
        `[claude-killer] API_PROVIDER=zenmux but ZENMUX_API_KEY is not set.\n` +
        `  Get your key at https://zenmux.ai and set ZENMUX_API_KEY=sk-ai-v1-...\n`
      );
      process.exit(1);
    }
    return { ...ZENMUX_CONFIG, apiKey };
  }

  // NVIDIA — pick first key from any of the 3 §5.2 sources.
  const apiKey = pickFirstNvidiaKey();
  if (!apiKey) {
    console.error(
      `[claude-killer] No API key configured.\n` +
      `  Set NVIDIA_API_KEY or NVIDIA_API_KEYS (comma-separated)\n` +
      `  or NVIDIA_API_KEYS_FILE (one key per line) for NVIDIA NIM,\n` +
      `  or ZENMUX_API_KEY for ZenMux.\n`
    );
    process.exit(1);
  }
  return { ...NVIDIA_CONFIG, apiKey };
}

/**
 * Check if the current provider needs heartbeat.
 * Uses detectProvider() (no exit) instead of getProviderConfig() (which exits on missing key).
 */
export function providerNeedsHeartbeat(): boolean {
  const provider = detectProvider();
  return provider === "nvidia" ? NVIDIA_CONFIG.needsHeartbeat : ZENMUX_CONFIG.needsHeartbeat;
}

/**
 * Check if the current provider needs hedging.
 */
export function providerNeedsHedging(): boolean {
  const provider = detectProvider();
  return provider === "nvidia" ? NVIDIA_CONFIG.needsHedging : ZENMUX_CONFIG.needsHedging;
}

/**
 * Get the max concurrent sub-agents for the current provider.
 */
export function getProviderMaxSubAgents(): number {
  const provider = detectProvider();
  return provider === "nvidia" ? NVIDIA_CONFIG.maxConcurrentSubAgents : ZENMUX_CONFIG.maxConcurrentSubAgents;
}

/**
 * Get the reasoning field name for the current provider.
 * NVIDIA uses "reasoning_content", ZenMux uses "reasoning".
 */
export function getProviderReasoningField(): "reasoning_content" | "reasoning" {
  const provider = detectProvider();
  return provider === "nvidia" ? NVIDIA_CONFIG.reasoningField : ZENMUX_CONFIG.reasoningField;
}

/**
 * Whether to send chat_template_kwargs with thinking_mode.
 * NVIDIA: yes (enables thinking mode on the server).
 * ZenMux: no (thinking is built-in per model, sending it may cause errors).
 */
export function providerSendsThinkingMode(): boolean {
  const provider = detectProvider();
  return provider === "nvidia" ? NVIDIA_CONFIG.sendThinkingMode : ZENMUX_CONFIG.sendThinkingMode;
}

/**
 * Whether the provider uses a multi-key pool.
 * NVIDIA: yes (each key = 1 concurrent, 40 RPM).
 * ZenMux: no (single key handles 10+ concurrent, no rate limit).
 */
export function providerUsesMultiKeyPool(): boolean {
  const provider = detectProvider();
  return provider === "nvidia" ? NVIDIA_CONFIG.needsMultiKeyPool : ZENMUX_CONFIG.needsMultiKeyPool;
}
