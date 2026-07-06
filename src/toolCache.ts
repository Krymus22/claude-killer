/**
 * toolCache.ts - Tool result caching to avoid redundant calls.
 */

import * as log from "./logger.js";

interface CacheEntry {
  key: string;
  result: string;
  timestamp: number;
  ttlMs: number;
}

export class ToolCache {
  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs: number = 60_000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  private makeKey(toolName: string, args: Record<string, unknown>): string {
    const sorted = Object.keys(args)
      .sort((a, b) => a.localeCompare(b))
      .map((k) => `${k}=${JSON.stringify(args[k])}`)
      .join("&");
    return `${toolName}:${sorted}`;
  }

  get(toolName: string, args: Record<string, unknown>): string | null {
    const key = this.makeKey(toolName, args);
    const entry = this.cache.get(key);

    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    log.debug(`Cache hit: ${toolName}`);
    return entry.result;
  }

  set(toolName: string, args: Record<string, unknown>, result: string, ttlMs?: number): void {
    const key = this.makeKey(toolName, args);
    this.cache.set(key, {
      key,
      result,
      timestamp: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs,
    });
  }

  invalidate(toolName: string, args?: Record<string, unknown>): void {
    if (args) {
      const key = this.makeKey(toolName, args);
      this.cache.delete(key);
    } else {
      // Invalidate all entries for this tool
      for (const [key] of this.cache) {
        if (key.startsWith(`${toolName}:`)) {
          this.cache.delete(key);
        }
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  has(toolName: string, args: Record<string, unknown>): boolean {
    return this.get(toolName, args) !== null;
  }

  getStats(): { entries: number; hitRate: number } {
    return { entries: this.cache.size, hitRate: 0 };
  }
}

// Singleton cache for read-only tools (ler_arquivo, buscar_arquivos, etc.)
export const readOnlyCache = new ToolCache(30_000); // 30 second TTL

// Cache for search results (longer TTL since search results are more stable)
export const searchCache = new ToolCache(120_000); // 2 minute TTL

export function shouldCacheResult(toolName: string): boolean {
  // BUG FIX: the list previously contained only "buscar_texto_no_projeto"
  // (an internal log identifier used by contentSearch.ts), but the actual
  // tool name exposed to the model via TOOL_DEFINITIONS in apiClient.ts is
  // "buscar_texto". The agent's dispatchToolCall invokes
  // shouldCacheResult(name) with the model-facing name, so buscar_texto
  // results were NEVER cached. We now include BOTH the model-facing name
  // (buscar_texto) and the legacy internal alias (buscar_texto_no_projeto)
  // so existing callers/tests that use the alias still work.
  const cacheableTools = [
    "ler_arquivo",
    "buscar_arquivos",
    "buscar_texto",            // model-facing name (apiClient TOOL_DEFINITIONS)
    "buscar_texto_no_projeto", // legacy internal alias (contentSearch.ts log)
    "git_status",
    "git_log",
  ];
  return cacheableTools.includes(toolName);
}

export function getCachedOrExecute<T>(
  cache: ToolCache,
  toolName: string,
  args: Record<string, unknown>,
  fn: () => T
): T {
  const cached = cache.get(toolName, args);
  if (cached !== null) {
    return cached as unknown as T;
  }

  const result = fn();
  cache.set(toolName, args, result as unknown as string);
  return result;
}
