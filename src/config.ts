/**
 * config.ts - Centralized configuration loaded from environment variables.
 * All runtime tunables live here; the rest of the codebase imports from this
 * module instead of reading process.env directly.
 */

import "dotenv/config";
import { getModelContextWindow, getModelCost } from "./modelRegistry.js";
import { detectProvider, getProviderConfig } from "./apiProvider.js";

// --- Helpers ----------------------------------------------------------------

function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalBool(key: string, fallback: boolean): boolean {
  // BUG FIX: previously did not trim whitespace, so DEBUG="  true  " (with
  // surrounding whitespace from shell quoting or .env files) would fail the
  // strict equality check and silently fall back to the default. This caused
  // confusing behavior where users thought they enabled debug mode but it
  // stayed off. Trim before comparing to handle these cases.
  const raw = process.env[key]?.trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return fallback;
}

function optionalFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalString(key: string, defaultValue: string): string {
  const val = process.env[key];
  return val && val.trim() ? val.trim() : defaultValue;
}

// --- Detect API provider (NVIDIA NIM or ZenMux) -----------------------------

const _provider = detectProvider();
// Note: getProviderConfig() ALREADY validates that an API key is configured
// (NVIDIA_API_KEY / NVIDIA_API_KEYS / NVIDIA_API_KEYS_FILE / ZENMUX_API_KEY)
// and calls process.exit(1) with a helpful message listing ALL allowed env
// vars if none is set. The redundant `if (!hasNvidiaKey && !hasZenmuxKey)`
// block that used to live here was dead code (it could only run when
// getProviderConfig had already exited) AND had a stale error message that
// omitted NVIDIA_API_KEYS_FILE. Both issues (BH14 LOW 1 + LOW 2) are fixed
// simply by removing the dead block — getProviderConfig's message is the
// single source of truth. See apiProvider.ts:getProviderConfig.
const _providerConfig = getProviderConfig();

// --- Exported Config --------------------------------------------------------

export const config = {
  /** API provider name ("nvidia" or "zenmux"). */
  apiProvider: _provider,

  /** API key for the active provider.
   *
   * BUG FIX: trimmed to remove accidental leading/trailing whitespace from
   * shell quoting or .env files. Without this, NVIDIA_API_KEY="  nvapi-xxx  "
   * would be sent verbatim to the API and cause confusing 401 Unauthorized
   * errors. The apiProvider.ts getProviderConfig() does NOT trim, so we do
   * it here as a defensive measure. */
  nvidiaApiKey: _providerConfig.apiKey.trim(),

  /**
   * Multi-key pool (optional). Comma-separated list of NVIDIA API keys
   * for parallel requests. Each key gets its own 40 RPM / 1 concurrent quota.
   * Set NVIDIA_API_KEYS or NVIDIA_API_KEYS_FILE to enable multi-key mode.
   * Falls back to NVIDIA_API_KEY (single-key) if not set.
   */
  nvidiaApiKeys: process.env.NVIDIA_API_KEYS ?? "",
  nvidiaApiKeysFile: process.env.NVIDIA_API_KEYS_FILE ?? "",

  /** Base URL for the API endpoint (provider-specific).
   *
   * For NVIDIA: https://integrate.api.nvidia.com/v1
   * For ZenMux: https://zenmux.ai/api/v1
   * For Bridge: BRIDGE_URL env var (HTTPS only, §17.11 rule 81)
   *
   * Note: the field name `nvidiaBaseUrl` is kept for backwards compat
   * (existing code references it); for non-NVIDIA providers it simply
   * holds whichever baseUrl the active provider uses.
   */
  nvidiaBaseUrl: _providerConfig.baseUrl,

  /** Bridge provider config (only meaningful when apiProvider === "bridge").
   *
   * Exposed separately so other modules can reference bridge-specific values
   * by their proper names without poking at `nvidiaApiKey`/`nvidiaBaseUrl`.
   * - bridgeUrl: same as nvidiaBaseUrl when provider=bridge, "" otherwise
   * - bridgeToken: same as nvidiaApiKey when provider=bridge, "" otherwise
   * - bridgeMaxRpm: BRIDGE_MAX_RPM env var (default 12)
   *
   * §17.11 rule 83: bridgeMaxRpm >= 1 (NaN guard like §17.9 rule 48).
   * Note: we use `Number.isNaN` (not `||`) so that "0" and negative numbers
   * are clamped to 1 rather than silently replaced with the default 12.
   * (Bug found during apiProvider-bridge testing.)
   */
  bridgeUrl: _provider === "bridge" ? _providerConfig.baseUrl : "",
  bridgeToken: _provider === "bridge" ? _providerConfig.apiKey.trim() : "",
  bridgeMaxRpm: (() => {
    const parsed = parseInt(process.env.BRIDGE_MAX_RPM ?? "12", 10);
    return Math.max(1, Number.isNaN(parsed) ? 12 : parsed);
  })(),

  /**
   * Model identifier for the model on NVIDIA NIM.
   *
   * FIX-LOW-1 (BH14 LOW 5): use `?.trim() || default` so that an explicitly
   * empty or whitespace-only MODEL env var (e.g. `MODEL=""` or `MODEL=" "`)
   * falls back to the default instead of producing a broken `config.model`
   * (empty string) that would later cause API 400 errors and break
   * modelRegistry lookups. The bare `??` operator only catches `undefined`/
   * `null`, NOT empty strings, so `MODEL=""` slipped through.
   */
  model: process.env.MODEL?.trim() || "moonshotai/kimi-k2.6",

  /** Temperature for sampling (0.0-2.0). Default: 1.0 (NVIDIA recommended). */
  temperature: optionalFloat("TEMPERATURE", 1.0),

  /** Top-p for nucleus sampling (0.0-1.0). Default: 0.95 (NVIDIA recommended). */
  topP: optionalFloat("TOP_P", 0.95),

  /** Orchestrator mode — uses a lightweight model as orchestrator that delegates
   *  to a heavy model for planning and coding. Default: off (uses traditional mode). */
  orchestratorMode: optionalBool("ORCHESTRATOR_MODE", false),

  /** Model to use as orchestrator (lightweight, fast). Default: google/gemma-4-31b-it */
  orchestratorModel: optionalString("ORCHESTRATOR_MODEL", "google/gemma-4-31b-it"),

  /** Heavy model for planning and coding (intelligent, slower). Default: z-ai/glm-5.2 */
  heavyModel: optionalString("HEAVY_MODEL", "z-ai/glm-5.2"),

  /**
   * Max tokens per response.
   *
   * FIX-LOW-1 (BH14 LOW 3) — updated JSDoc to match actual behavior:
   *   - Default: 131072 (128k). This is intentionally higher than any
   *     model's maxOutputTokens in the registry so the registry is the
   *     real cap, NOT this config value.
   *   - The ACTUAL limit sent to the API is enforced by apiClient.ts via
   *     `Math.min(config.maxTokens, getModelMaxOutputTokens(config.model))`,
   *     so if you use kimi-k2.6 (8k max) it sends 8k; if you use GLM 5.2
   *     (32k max) it sends 32k.
   *   - Historically this was hardcoded to 16384, which capped reasoning
   *     models at 16k even though they support 32k (reasoning eats the
   *     budget before visible content is produced). Bug Hunter rodada 2
   *     changed it to `getModelMaxOutputTokens(defaultModel)` = 8192, but
   *     that capped GLM 5.2 at 8k via the Math.min. The 131072 default
   *     fixes both regressions.
   *   - Override via the MAX_TOKENS env var (rarely needed).
   */
  maxTokens: optionalInt(
    "MAX_TOKENS",
    131072, // 128k — higher than any model's maxOutputTokens, so the registry is the real cap
  ),

  /**
   * Maximum requests per minute the CLI is allowed to send.
   * The rate-limiter uses a sliding-window token bucket.
   */
  rateLimitRpm: optionalInt("RATE_LIMIT_RPM", 40),

  /**
   * Maximum number of simultaneous API calls (hard limit: 1 for MVP).
   * The concurrency mutex enforces this.
   *
   * BUG FIX: previously `Math.min(optionalInt(...), 1)` — Math.min returns
   * the smaller value, so MAX_CONCURRENCY=-1 resulted in -1 (negative!),
   * which broke the concurrency limiter (a negative limit means unlimited
   * or always-block depending on the loop). Now clamped to [1, 1] so the
   * hard limit is enforced regardless of user input. Per BUSINESS_RULES §2:
   * maxConcurrency is "Hard limit (MVP)" = 1.
   */
  maxConcurrency: Math.max(1, Math.min(optionalInt("MAX_CONCURRENCY", 1), 1)),

  /**
   * How many times the auto-heal loop may retry writing a file
   * whose generated code failed syntax validation.
   */
  maxHealRetries: optionalInt("MAX_HEAL_RETRIES", 3),

    /** When true, prints verbose internal logs to stderr. */
  debug: optionalBool("DEBUG", false),

  /** Model's context window size in tokens (used for status bar). */
  // BUG FIX: previously hardcoded to 128000. Now we look up the actual
  // context window for the active model from MODEL_REGISTRY. The user can
  // still override via CONTEXT_WINDOW_TOKENS env var.
  // FIX-LOW-1 (BH14 LOW 5): apply the same `?.trim() || default` defensive
  // fallback as `config.model` so MODEL="" doesn't break the registry lookup.
  contextWindowTokens: optionalInt(
    "CONTEXT_WINDOW_TOKENS",
    getModelContextWindow(process.env.MODEL?.trim() || "moonshotai/kimi-k2.6"),
  ),

  /** Threshold (0.0-1.0) of context window that triggers auto-compact.
   *  Default 0.70 — when context reaches 70%, LLM-based compaction runs
   *  FIRST (priority strategy), preserving architectural decisions and
   *  unresolved bugs. Heuristic/mechanical compaction only runs as fallback
   *  if LLM fails or effortLevel="low". */
  contextCompactThreshold: optionalFloat("CONTEXT_COMPACT_THRESHOLD", 0.70),

  /** Threshold (0.0-1.0) of context window that warns user with yellow bar. */
  contextWarnThreshold: optionalFloat("CONTEXT_WARN_THRESHOLD", 0.65),

  /** Approximate USD cost per 1k prompt tokens (estimate only). */
  // BUG FIX: previously defaulted to 0. Now we look up the actual cost
  // for the active model from MODEL_REGISTRY. The user can still override.
  // FIX-LOW-1 (BH14 LOW 5): same defensive `?.trim() || default` as
  // `config.model` so MODEL="" doesn't break the cost lookup.
  costPerKPrompt: optionalFloat(
    "COST_PER_K_PROMPT",
    getModelCost(process.env.MODEL?.trim() || "moonshotai/kimi-k2.6").prompt / 1000,
  ),

    /** Approximate USD cost per 1k completion tokens. */
  // FIX-LOW-1 (BH14 LOW 5): same defensive `?.trim() || default` as
  // `config.model` so MODEL="" doesn't break the cost lookup.
  costPerKCompletion: optionalFloat(
    "COST_PER_K_COMPLETION",
    getModelCost(process.env.MODEL?.trim() || "moonshotai/kimi-k2.6").completion / 1000,
  ),

  /** When true, shows a diff preview and asks for user confirmation before applying file changes. */
  diffPreview: optionalBool("DIFF_PREVIEW", true),
} as const;

export type Config = typeof config;
