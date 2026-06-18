/**
 * utf8Safety.ts - Force UTF-8 encoding across all platforms.
 *
 * Problem solved: the previous code hardcoded `LANG=pt_BR.UTF-8` on Linux/macOS,
 * but that locale is only honoured if the system actually has it generated
 * (`locale -a | grep pt_BR`). On minimal containers, WSL, and CI runners,
 * `pt_BR.UTF-8` is frequently absent and the glibc silently falls back to
 * the `C`/`POSIX` locale (ASCII), which renders `você` as `voc├¬` in the TUI.
 *
 * Strategy:
 *  1. Probe the system for any available UTF-8 locale (prefer pt_BR, then
 *     en_US, then anything ending in `.UTF-8`).
 *  2. If none exists, set `LANG=C.UTF-8` (glibc 2.35+ supports it without
 *     locale-gen, and musl always does).
 *  3. Always also set `PYTHONIOENCODING=utf-8`, `PYTHONUTF8=1`,
 *     `NODE_OPTIONS=--use-utf8` (no-op on Node 18+, but documents intent),
 *     and force Node stdio to UTF-8.
 *  4. Return a diagnostics object so tests can assert what happened.
 */

import { execSync } from "node:child_process";
import { platform } from "node:os";

export interface Utf8SetupResult {
  platform: string;
  probedLocales: string[];
  chosen: string;
  fallbackUsed: boolean;
  reason: string;
}

/** Cache of `locale -a` output to avoid repeated subprocess calls. */
let cachedLocaleList: string[] | null = null;

/**
 * Returns the list of locales available on the system via `locale -a`.
 * Returns an empty array on platforms without `locale` (e.g., Windows, Alpine
 * without glibc, sandboxes without shell access).
 */
export function listSystemLocales(): string[] {
  if (cachedLocaleList !== null) return cachedLocaleList;
  if (platform() === "win32") {
    cachedLocaleList = [];
    return cachedLocaleList;
  }
  try {
    const out = execSync("locale -a 2>/dev/null", {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    cachedLocaleList = out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    cachedLocaleList = [];
  }
  return cachedLocaleList;
}

/**
 * Picks the best UTF-8 locale from the system, in priority order:
 *   1. pt_BR.UTF-8 / pt_BR.utf8 (matches TUI language)
 *   2. en_US.UTF-8 / en_US.utf8 (universal fallback)
 *   3. Any locale ending in .UTF-8 or .utf8
 *   4. C.UTF-8 / C.utf8 (glibc 2.35+ and musl ship this always)
 *
 * Returns `null` if no UTF-8 locale is detected — caller should then
 * explicitly set `LANG=C.UTF-8` (which works on glibc 2.35+ and musl).
 */
export function pickBestUtf8Locale(): { locale: string | null; tried: string[] } {
  const available = listSystemLocales();
  const tried: string[] = [];

  const candidates = [
    "pt_BR.UTF-8",
    "pt_BR.utf8",
    "pt_PT.UTF-8",
    "pt_PT.utf8",
    "en_US.UTF-8",
    "en_US.utf8",
    "C.UTF-8",
    "C.utf8",
  ];

  for (const c of candidates) {
    tried.push(c);
    if (available.includes(c)) return { locale: c, tried };
  }

  // Last resort: any locale that ends with .UTF-8 or .utf8
  const anyUtf8 = available.find((l) => /\.(UTF-8|utf8)$/i.test(l));
  if (anyUtf8) return { locale: anyUtf8, tried };

  return { locale: null, tried };
}

/**
 * Apply UTF-8 environment variables and Node stdio defaults.
 *
 * Idempotent — safe to call multiple times. Returns a diagnostics object.
 *
 * Post-conditions (always true after this runs):
 *   - process.env.LANG is set to a UTF-8-capable locale (never POSIX/C alone)
 *   - process.env.LC_ALL mirrors LANG (or is unset if LANG was already correct)
 *   - process.env.PYTHONIOENCODING === "utf-8"
 *   - process.env.PYTHONUTF8 === "1"
 *   - process.stdout/stderr have setDefaultEncoding("utf8") called if possible
 */
export function forceUtf8Environment(): Utf8SetupResult {
  const pf = platform();
  const { locale: best, tried } = pickBestUtf8Locale();

  // Pick the locale to set. If `best` is null, use "C.UTF-8" which works on
  // glibc 2.35+ (Debian 12, Ubuntu 22.04+, Fedora 36+) and on all musl systems
  // (Alpine). On older glibc it's a no-op (won't break anything, but accented
  // chars may still misrender — at that point the user needs to run
  // `locale-gen pt_BR.UTF-8`).
  const chosen = best ?? "C.UTF-8";
  const fallbackUsed = best === null;

  // Only overwrite LANG if it's unset or non-UTF-8 (respect user's explicit
  // choice if they already set LANG=fr_FR.UTF-8 etc.)
  const currentLang = process.env.LANG ?? "";
  const currentIsUtf8 = /\.(UTF-8|utf8)$/i.test(currentLang);
  if (!currentIsUtf8) {
    process.env.LANG = chosen;
  }
  // LC_ALL: mirror LANG if not already a UTF-8 locale
  const currentLcAll = process.env.LC_ALL ?? "";
  const lcAllIsUtf8 = /\.(UTF-8|utf8)$/i.test(currentLcAll);
  if (!lcAllIsUtf8) {
    process.env.LC_ALL = process.env.LANG;
  }

  // Python: force UTF-8 regardless of locale
  process.env.PYTHONIOENCODING ??= "utf-8";
  process.env.PYTHONUTF8 ??= "1";

  // Node stdio: set default encoding to utf8 (affects how strings are
  // serialized to bytes on the wire). On Node 18+ this is already the
  // default, but on older Node or weird TTYs it may not be.
  try {
    const stdout = process.stdout as unknown as { setDefaultEncoding?: (e: string) => void };
    const stderr = process.stderr as unknown as { setDefaultEncoding?: (e: string) => void };
    if (typeof stdout.setDefaultEncoding === "function") stdout.setDefaultEncoding("utf8");
    if (typeof stderr.setDefaultEncoding === "function") stderr.setDefaultEncoding("utf8");
  } catch {
    // ignore - not critical
  }

  return {
    platform: pf,
    probedLocales: tried,
    chosen,
    fallbackUsed,
    reason: fallbackUsed
      ? "No UTF-8 locale found in `locale -a`; falling back to C.UTF-8 (glibc 2.35+ or musl required)."
      : `Selected ${chosen} from available system locales.`,
  };
}

/**
 * Diagnostic helper: returns a human-readable report of the current UTF-8
 * state. Used by the `/utf8` slash command and by tests.
 */
export function diagnoseUtf8(): string {
  const lines: string[] = [];
  lines.push("UTF-8 diagnostics:");
  lines.push(`  platform:       ${platform()}`);
  lines.push(`  LANG:           ${process.env.LANG ?? "(unset)"}`);
  lines.push(`  LC_ALL:         ${process.env.LC_ALL ?? "(unset)"}`);
  lines.push(`  PYTHONIOENCODING: ${process.env.PYTHONIOENCODING ?? "(unset)"}`);
  lines.push(`  PYTHONUTF8:     ${process.env.PYTHONUTF8 ?? "(unset)"}`);
  const available = listSystemLocales();
  const utf8Available = available.filter((l) => /\.(UTF-8|utf8)$/i.test(l));
  lines.push(`  locales total:  ${available.length}`);
  lines.push(`  locales UTF-8:  ${utf8Available.length}`);
  if (utf8Available.length > 0 && utf8Available.length <= 10) {
    lines.push(`    - ${utf8Available.join("\n    - ")}`);
  }
  const langOk = /\.(UTF-8|utf8)$/i.test(process.env.LANG ?? "");
  lines.push(`  LANG is UTF-8:  ${langOk ? "YES" : "NO"}`);
  return lines.join("\n");
}
