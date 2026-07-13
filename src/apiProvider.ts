/**
 * apiProvider.ts — Abstraction over API providers (NVIDIA NIM, ZenMux, Bridge).
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
 *
 * Bridge (custom Cloudflare-tunneled OpenAI-compatible server):
 *   - Cold start: none (just network latency through tunnel)
 *   - Concurrency: 1 (single-threaded queue processor on the remote side)
 *   - Rate limit: BRIDGE_MAX_RPM env var (default 12, conservative)
 *   - Thinking: built-in on the remote LLM, don't send chat_template_kwargs
 *   - Reasoning field: "reasoning" (server emits OpenAI-compatible chunks)
 *   - Heartbeat: not needed (no GPU cold start)
 *   - Hedging: not needed (no GPU queue)
 *   - Sub-agents: 1 (sequential — remote processes queue one at a time)
 *   - Auth: BRIDGE_TOKEN shared secret in Authorization: Bearer header
 *   - When to use: when you want a remote LLM (e.g., a chat-based model
 *     accessed via a bridge server) to act as the agent's brain, instead of
 *     a hosted API. The CLI sees a normal OpenAI-compatible endpoint; the
 *     bridge server queues requests, an operator (or separate process)
 *     processes them, and responses flow back through the same HTTP
 *     connection.
 *
 * Configuration (env vars):
 *   - API_PROVIDER=bridge              → activate bridge provider
 *   - BRIDGE_URL=https://x.trycloudflare.com → bridge server URL (HTTPS only)
 *   - BRIDGE_TOKEN=<shared-secret>     → required auth token
 *   - BRIDGE_MAX_RPM=12                → optional, default 12
 *
 * Security:
 *   - BRIDGE_URL MUST be HTTPS (§17.11 rule 81)
 *   - BRIDGE_TOKEN MUST be set (§17.11 rule 82)
 *   - Server validates Authorization: Bearer on every request
 *   - Multi-key pool disabled (single token = single identity)
 */

import * as fs from "node:fs";

export type ProviderName = "nvidia" | "zenmux" | "bridge";

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

/**
 * BRIDGE_CONFIG: dynamic baseUrl (from BRIDGE_URL env var, validated HTTPS).
 * The apiKey field is the BRIDGE_TOKEN (shared secret) — set in getProviderConfig().
 *
 * Bridge behaves like ZenMux for transport concerns (no thinking kwargs,
 * no heartbeat, no hedging, no multi-key pool) but with concurrency=1
 * because the remote queue processor handles one request at a time.
 *
 * §17.11 rule 81: BRIDGE_URL MUST be HTTPS.
 * §17.11 rule 82: BRIDGE_TOKEN MUST be non-empty.
 */
const BRIDGE_CONFIG: Omit<ProviderConfig, "apiKey" | "baseUrl"> = {
  name: "bridge",
  // baseUrl is filled in dynamically by getProviderConfig() from BRIDGE_URL.
  sendThinkingMode: false,
  reasoningField: "reasoning",
  needsHeartbeat: false,
  needsHedging: false,
  needsMultiKeyPool: false,
  maxConcurrentSubAgents: 1,
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
  if (explicit === "bridge") return "bridge";

  // BH-BRIDGE-1 HIGH-3 fix: if API_PROVIDER is set but doesn't match any known
  // provider, exit with a helpful error instead of silently falling through to
  // auto-detect. This catches typos like "bridg" or "aws" early.
  if (explicit && explicit !== "") {
    console.error(
      `[claude-killer] API_PROVIDER="${explicit}" is not a valid provider.\n` +
      `  Valid values: nvidia, zenmux, bridge.\n` +
      `  Unset API_PROVIDER to auto-detect (zenmux if ZENMUX_API_KEY set, else nvidia).\n`
    );
    process.exit(1);
  }

  // Auto-detect: zenmux only if NO NVIDIA key source is configured (§5.2).
  // Must include NVIDIA_API_KEYS_FILE — otherwise a file-only NVIDIA config
  // is misrouted to zenmux and the CLI exits with code 1 in getProviderConfig.
  // Note: bridge is NEVER auto-detected — it must be explicitly set via
  // API_PROVIDER=bridge because it requires both BRIDGE_URL and BRIDGE_TOKEN.
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

  if (provider === "bridge") {
    // §17.11 rule 81: BRIDGE_URL MUST be HTTPS.
    const rawUrl = process.env.BRIDGE_URL?.trim() ?? "";
    if (!rawUrl) {
      console.error(
        `[claude-killer] API_PROVIDER=bridge but BRIDGE_URL is not set.\n` +
        `  Set BRIDGE_URL to your bridge server URL (must be HTTPS):\n` +
        `    BRIDGE_URL=https://random-words.trycloudflare.com\n` +
        `  See bridge/README.md for how to start a bridge server.\n`
      );
      process.exit(1);
    }
    if (!/^https:\/\//i.test(rawUrl)) {
      // §17.11 rule 81: reject non-HTTPS URLs to prevent token leak over plaintext.
      // BH-BRIDGE-1 LOW-8 fix: don't log the full rawUrl — it might contain a
      // token if the user mistakenly put it in the URL. Only show the scheme.
      const scheme = rawUrl.split(":")[0] ?? "(unknown)";
      console.error(
        `[claude-killer] BRIDGE_URL must be HTTPS (got scheme: "${scheme}://").\n` +
        `  Bridge tokens are sent in Authorization headers — never send them\n` +
        `  over plaintext HTTP. Use a Cloudflare tunnel (HTTPS by default) or\n` +
        `  any HTTPS reverse proxy.\n`
      );
      process.exit(1);
    }
    // BH-BRIDGE-1 LOW-7 fix: validate URL well-formedness (not just https:// prefix).
    // Without this, "https://" (prefix only) passes the regex but fails later in
    // the OpenAI SDK with an opaque error.
    try {
      new URL(rawUrl);
    } catch {
      console.error(
        `[claude-killer] BRIDGE_URL is not a valid URL.\n` +
        `  Got a malformed URL (starts with https:// but is not parseable).\n` +
        `  Check for typos and trailing characters.\n`
      );
      process.exit(1);
    }
    // §17.11 rule 82: BRIDGE_TOKEN MUST be non-empty.
    const token = process.env.BRIDGE_TOKEN?.trim() ?? "";
    if (!token) {
      console.error(
        `[claude-killer] API_PROVIDER=bridge but BRIDGE_TOKEN is not set.\n` +
        `  Generate a shared secret and set it in BOTH the CLI .env and the\n` +
        `  bridge server's .env. Example:\n` +
        `    BRIDGE_TOKEN=$(openssl rand -hex 32)\n` +
        `  The bridge server rejects requests without a matching token.\n`
      );
      process.exit(1);
    }
    return { ...BRIDGE_CONFIG, baseUrl: rawUrl, apiKey: token };
  }

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
      `  or ZENMUX_API_KEY for ZenMux,\n` +
      `  or API_PROVIDER=bridge + BRIDGE_URL + BRIDGE_TOKEN for Bridge.\n`
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
  if (provider === "nvidia") return NVIDIA_CONFIG.needsHeartbeat;
  if (provider === "bridge") return BRIDGE_CONFIG.needsHeartbeat;
  return ZENMUX_CONFIG.needsHeartbeat;
}

/**
 * Check if the current provider needs hedging.
 */
export function providerNeedsHedging(): boolean {
  const provider = detectProvider();
  if (provider === "nvidia") return NVIDIA_CONFIG.needsHedging;
  if (provider === "bridge") return BRIDGE_CONFIG.needsHedging;
  return ZENMUX_CONFIG.needsHedging;
}

/**
 * Get the max concurrent sub-agents for the current provider.
 */
export function getProviderMaxSubAgents(): number {
  const provider = detectProvider();
  if (provider === "nvidia") return NVIDIA_CONFIG.maxConcurrentSubAgents;
  if (provider === "bridge") return BRIDGE_CONFIG.maxConcurrentSubAgents;
  return ZENMUX_CONFIG.maxConcurrentSubAgents;
}

/**
 * Get the reasoning field name for the current provider.
 * NVIDIA uses "reasoning_content", ZenMux/Bridge use "reasoning".
 */
export function getProviderReasoningField(): "reasoning_content" | "reasoning" {
  const provider = detectProvider();
  if (provider === "nvidia") return NVIDIA_CONFIG.reasoningField;
  if (provider === "bridge") return BRIDGE_CONFIG.reasoningField;
  return ZENMUX_CONFIG.reasoningField;
}

/**
 * Whether to send chat_template_kwargs with thinking_mode.
 * NVIDIA: yes (enables thinking mode on the server).
 * ZenMux/Bridge: no (thinking is built-in per model, sending it may cause errors).
 */
export function providerSendsThinkingMode(): boolean {
  const provider = detectProvider();
  if (provider === "nvidia") return NVIDIA_CONFIG.sendThinkingMode;
  if (provider === "bridge") return BRIDGE_CONFIG.sendThinkingMode;
  return ZENMUX_CONFIG.sendThinkingMode;
}

/**
 * Whether the provider uses a multi-key pool.
 * NVIDIA: yes (each key = 1 concurrent, 40 RPM).
 * ZenMux/Bridge: no (single key/token handles all concurrency).
 */
export function providerUsesMultiKeyPool(): boolean {
  const provider = detectProvider();
  if (provider === "nvidia") return NVIDIA_CONFIG.needsMultiKeyPool;
  if (provider === "bridge") return BRIDGE_CONFIG.needsMultiKeyPool;
  return ZENMUX_CONFIG.needsMultiKeyPool;
}

// --- Scout provider (multi-provider support) --------------------------------

/**
 * Detect which provider the SCOUT sub-agent should use.
 *
 * Default: same as the main provider (detectProvider()).
 * Override: SCOUT_PROVIDER env var ("nvidia" | "zenmux" | "bridge").
 *
 * Use case: when API_PROVIDER=bridge (so the main agent uses a remote LLM
 * via Cloudflare tunnel), you can set SCOUT_PROVIDER=nvidia so the scout
 * uses the fast local NVIDIA API instead of routing through the bridge.
 * This keeps the scout fast (DiffusionGemma 26B at 700 tok/s) and avoids
 * consuming the operator's attention for trivial read/search tasks.
 *
 * §17.11 rule 102: SCOUT_PROVIDER must be a valid provider name.
 * §17.11 rule 103: if SCOUT_PROVIDER is set but invalid, exit(1) (mirrors
 * API_PROVIDER behavior in detectProvider).
 * §17.11 rule 104: scout provider config uses the SAME env vars as the
 * main provider (NVIDIA_API_KEY, BRIDGE_TOKEN, etc.) — no separate
 * SCOUT_API_KEY. This avoids key duplication.
 */
export function detectScoutProvider(): ProviderName {
  const explicit = process.env.SCOUT_PROVIDER?.toLowerCase().trim();
  if (!explicit || explicit === "") {
    // Default: same as main provider
    return detectProvider();
  }
  if (explicit === "nvidia") return "nvidia";
  if (explicit === "zenmux") return "zenmux";
  if (explicit === "bridge") return "bridge";

  // §17.11 rule 103: invalid SCOUT_PROVIDER = exit(1)
  console.error(
    `[claude-killer] SCOUT_PROVIDER="${explicit}" is not a valid provider.\n` +
    `  Valid values: nvidia, zenmux, bridge.\n` +
    `  Unset SCOUT_PROVIDER to use the same provider as the main agent.\n`
  );
  process.exit(1);
}

/**
 * Get the provider config for the SCOUT sub-agent.
 *
 * When SCOUT_PROVIDER is unset, returns the same config as getProviderConfig().
 * When SCOUT_PROVIDER is set, returns the config for that provider (using the
 * same env vars — NVIDIA_API_KEY, BRIDGE_TOKEN, etc.).
 *
 * §17.11 rule 104: no separate SCOUT_API_KEY — reuses main provider's keys.
 */
export function getScoutProviderConfig(): ProviderConfig {
  const scoutProvider = detectScoutProvider();
  const mainProvider = detectProvider();

  // If scout provider == main provider, just return the main config
  if (scoutProvider === mainProvider) {
    return getProviderConfig();
  }

  // Otherwise, build the config for the scout provider
  if (scoutProvider === "bridge") {
    const rawUrl = process.env.BRIDGE_URL?.trim() ?? "";
    const token = process.env.BRIDGE_TOKEN?.trim() ?? "";
    if (!rawUrl || !/^https:\/\//i.test(rawUrl) || !token) {
      console.error(
        `[claude-killer] SCOUT_PROVIDER=bridge but BRIDGE_URL or BRIDGE_TOKEN is missing/invalid.\n` +
        `  The scout provider uses the SAME env vars as the main bridge provider.\n` +
        `  Ensure BRIDGE_URL (HTTPS) and BRIDGE_TOKEN are both set.\n`
      );
      process.exit(1);
    }
    try { new URL(rawUrl); } catch {
      console.error(`[claude-killer] SCOUT_PROVIDER=bridge but BRIDGE_URL is malformed.\n`);
      process.exit(1);
    }
    return { ...BRIDGE_CONFIG, baseUrl: rawUrl, apiKey: token };
  }

  if (scoutProvider === "zenmux") {
    const apiKey = process.env.ZENMUX_API_KEY?.trim() ?? "";
    if (!apiKey) {
      console.error(
        `[claude-killer] SCOUT_PROVIDER=zenmux but ZENMUX_API_KEY is not set.\n`
      );
      process.exit(1);
    }
    return { ...ZENMUX_CONFIG, apiKey };
  }

  // nvidia
  const apiKey = pickFirstNvidiaKey();
  if (!apiKey) {
    console.error(
      `[claude-killer] SCOUT_PROVIDER=nvidia but no NVIDIA API key is configured.\n` +
      `  Set NVIDIA_API_KEY or NVIDIA_API_KEYS or NVIDIA_API_KEYS_FILE.\n`
    );
    process.exit(1);
  }
  return { ...NVIDIA_CONFIG, apiKey };
}

/**
 * Helper functions for the SCOUT provider (mirror the main provider helpers
 * but use detectScoutProvider() instead of detectProvider()).
 *
 * §17.11 rule 105: scout provider helpers are independent of main provider.
 * E.g., main=bridge (no heartbeat) + scout=nvidia (needs heartbeat) →
 * scout SHOULD send heartbeats. These helpers make that possible.
 */
export function scoutProviderNeedsHeartbeat(): boolean {
  const provider = detectScoutProvider();
  if (provider === "nvidia") return NVIDIA_CONFIG.needsHeartbeat;
  if (provider === "bridge") return BRIDGE_CONFIG.needsHeartbeat;
  return ZENMUX_CONFIG.needsHeartbeat;
}

export function scoutProviderSendsThinkingMode(): boolean {
  const provider = detectScoutProvider();
  if (provider === "nvidia") return NVIDIA_CONFIG.sendThinkingMode;
  if (provider === "bridge") return BRIDGE_CONFIG.sendThinkingMode;
  return ZENMUX_CONFIG.sendThinkingMode;
}

export function scoutProviderUsesMultiKeyPool(): boolean {
  const provider = detectScoutProvider();
  if (provider === "nvidia") return NVIDIA_CONFIG.needsMultiKeyPool;
  if (provider === "bridge") return BRIDGE_CONFIG.needsMultiKeyPool;
  return ZENMUX_CONFIG.needsMultiKeyPool;
}

export function getScoutProviderReasoningField(): "reasoning_content" | "reasoning" {
  const provider = detectScoutProvider();
  if (provider === "nvidia") return NVIDIA_CONFIG.reasoningField;
  if (provider === "bridge") return BRIDGE_CONFIG.reasoningField;
  return ZENMUX_CONFIG.reasoningField;
}
