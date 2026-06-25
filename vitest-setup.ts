/**
 * vitest-setup.ts — Global test setup.
 *
 * Force English for all unit tests so they don't break when the default
 * language changes. Tests that specifically test i18n behavior (i18n.test.ts,
 * i18n-extended.test.ts) explicitly set/reset env vars themselves.
 *
 * This keeps unit tests stable: they test code logic, not language strings.
 */

// Force English for unit tests (default may be pt-BR for users, but tests
// should not depend on the project's default language)
process.env.CLAUDE_KILLER_LANG = "en";
