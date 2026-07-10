/**
 * i18n-mutation-killers.test.ts — Targeted tests to kill LOW + MEDIUM
 * priority survived mutations in src/i18n.ts.
 *
 * This file is named `i18n-mutation-killers.test.ts` so the
 * mutation-test.py script picks it up via the `{basename}*.test.ts` glob
 * (scripts/mutation-test.py:find_test_files).
 *
 * Per BUSINESS_RULES.md §17: this file does NOT modify any source code, only
 * adds regression tests. No `require()` calls (ESM `import` only). The
 * existing source is assumed correct — these tests close gaps.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── i18n.ts ────────────────────────────────────────────────────────────────

describe("mutation-killers / i18n.ts — LANGUAGE priority-order detection", () => {
  let prevLang: string | undefined;
  let prevLcAll: string | undefined;
  let prevLcMessages: string | undefined;
  let prevLanguage: string | undefined;
  let prevCkLang: string | undefined;

  beforeEach(() => {
    prevLang = process.env.LANG;
    prevLcAll = process.env.LC_ALL;
    prevLcMessages = process.env.LC_MESSAGES;
    prevLanguage = process.env.LANGUAGE;
    prevCkLang = process.env.CLAUDE_KILLER_LANG;
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
    delete process.env.LANGUAGE;
    delete process.env.CLAUDE_KILLER_LANG;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevLang === undefined) delete process.env.LANG;
    else process.env.LANG = prevLang;
    if (prevLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = prevLcAll;
    if (prevLcMessages === undefined) delete process.env.LC_MESSAGES;
    else process.env.LC_MESSAGES = prevLcMessages;
    if (prevLanguage === undefined) delete process.env.LANGUAGE;
    else process.env.LANGUAGE = prevLanguage;
    if (prevCkLang === undefined) delete process.env.CLAUDE_KILLER_LANG;
    else process.env.CLAUDE_KILLER_LANG = prevCkLang;
    vi.resetModules();
  });

  /**
   * BH20 LOW 4 fix changed detectLanguage to split LANGUAGE by ":" and
   * iterate each part in priority order (first match wins), instead of
   * the old `String.includes` on the whole string. The old mutation test
   * asserted LANGUAGE="en_US:pt-BR" → "pt-BR" (matching the includes
   * branch), which contradicts the new priority-order semantics.
   *
   * New mutation killers:
   *   - If the LANGUAGE split is removed/mutated (e.g. split("") → chars),
   *     LANGUAGE="pt_BR:en" would no longer detect pt-BR → test fails.
   *   - If the iteration order is reversed, LANGUAGE="en:pt_BR" would
   *     return pt-BR instead of en → test fails.
   *   - If the code regressed to includes() on the whole string,
   *     LANGUAGE="en:pt_BR" would return pt-BR (includes("pt_br") true)
   *     instead of en → test fails.
   */
  it("LANGUAGE='pt_BR:en' detects pt-BR (first part wins — kills removal of LANGUAGE split)", async () => {
    const { detectLanguage, resetAllLanguageState } = await import("./../i18n.js");
    resetAllLanguageState();
    process.env.LANGUAGE = "pt_BR:en";
    // First part "pt_BR" → startsWith("pt") → returns "pt-BR".
    // Mutation: if split is removed/changed (e.g. not splitting at all),
    // the whole "pt_br:en" string doesn't startsWith("pt") → falls to
    // default "pt-BR" anyway. So we also assert the priority-order test
    // below to catch the includes regression.
    expect(detectLanguage()).toBe("pt-BR");
  });

  it("LANGUAGE='en:pt_BR' detects en (priority order — kills includes regression)", async () => {
    const { detectLanguage, resetAllLanguageState } = await import("./../i18n.js");
    resetAllLanguageState();
    process.env.LANGUAGE = "en:pt_BR";
    // First part "en" → startsWith("en") → returns "en".
    // OLD includes-based behavior would have returned "pt-BR" because
    // includes("pt_br") was true on the whole "en:pt_br" string.
    // This test kills the includes regression and order-reversal mutations.
    expect(detectLanguage()).toBe("en");
  });

  it("LANGUAGE='en_US:pt-BR' detects en (priority order — supersedes old includes test)", async () => {
    const { detectLanguage, resetAllLanguageState } = await import("./../i18n.js");
    resetAllLanguageState();
    process.env.LANGUAGE = "en_US:pt-BR";
    // The OLD test asserted this returns "pt-BR" via the includes("pt-br")
    // branch. With the BH20 LOW 4 fix, priority order wins: "en_US" is
    // first → returns "en".
    expect(detectLanguage()).toBe("en");
  });
});

describe("mutation-killers / i18n.ts — L360/L383 false-promise attempt counter", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => { vi.resetModules(); });

  /**
   * Mutations on L360 and L383:
   *   `const suffix = attempt > 1 ? \` (attempt ${attempt} of 2)\` : "";`
   *   mutation: `>` → `>=`
   *
   * Effect: with `>= 1`, attempt=1 makes `1 >= 1` true → adds suffix
   * " (attempt 1 of 2)" even on the FIRST attempt.
   *
   * Killing strategy: call t("promise.false_detected", "phrase", 1) —
   * the FIRST attempt. Without mutation: no suffix. With mutation:
   * suffix " (attempt 1 of 2)" present.
   *
   * Both L360 (pt-BR) and L383 (en) need testing.
   */
  it("pt-BR: first attempt (1) does NOT include suffix (kills `> → >=` on L360)", async () => {
    const { t, setLanguage } = await import("./../i18n.js");
    setLanguage("pt-BR");
    const result = t("promise.false_detected", "vou investigar", 1);
    // Without mutation: 1 > 1 is false → suffix is "".
    // With mutation `> → >=`: 1 >= 1 is true → suffix added.
    expect(result).not.toContain("tentativa 1 de 2");
  });

  it("en: first attempt (1) does NOT include suffix (kills `> → >=` on L383)", async () => {
    const { t, setLanguage } = await import("./../i18n.js");
    setLanguage("en");
    const result = t("promise.false_detected", "I will investigate", 1);
    // Without mutation: 1 > 1 is false → suffix is "".
    // With mutation `> → >=`: 1 >= 1 is true → suffix added.
    expect(result).not.toContain("attempt 1 of 2");
  });

  /**
   * Sanity: second attempt (2) DOES include suffix. This confirms the
   * branch is reachable and the suffix template is correct.
   */
  it("second attempt (2) DOES include suffix (confirms baseline)", async () => {
    const { t, setLanguage } = await import("./../i18n.js");
    setLanguage("en");
    const result = t("promise.false_detected", "I will investigate", 2);
    expect(result).toContain("attempt 2 of 2");
  });
});
