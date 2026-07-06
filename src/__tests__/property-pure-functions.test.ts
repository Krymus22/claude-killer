/**
 * property-pure-functions.test.ts — Testes property-based para funções PURAS.
 *
 * Usa fast-check v4.8.0 para gerar inputs aleatórios e verificar PROPRIEDADES
 * que devem ser verdadeiras para TODOS os inputs válidos.
 *
 * Funções testadas:
 *   - truncateMiddle(s, maxChars)        — src/tui/useTerminal.ts
 *   - truncateStr(s, maxChars)           — src/tui/useTerminal.ts
 *   - formatTok(n)                        — src/tui/StatusBar.tsx (CÓPIA LOCAL — ver nota abaixo)
 *   - extractConfidence(text)            — src/honestySystem.ts
 *   - calculateCardWidth(w, c, g, p)     — src/tui/useTerminal.ts
 *
 * Padrão adotado: fc.assert(fc.property(arbitrário, predicado))
 *   - O predicado retorna true (passa) ou false (falha).
 *   - fast-check roda 100 runs (default) por propriedade e exibe o
 *     counterexample minimal quando uma propriedade falha.
 *
 * IMPORTANTE: propriedades marcadas com `.skip` falharam ao rodar e foram
 * desativadas com comentário explicando o bug. Ver relatório do QA.
 */

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import {
  truncateMiddle,
  truncateStr,
  calculateCardWidth,
} from "../tui/useTerminal.js";
import { extractConfidence } from "../honestySystem.js";

// Mock logger so argsNormalizer/pokaYoke/etc. don't print debug noise during tests.
vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  throttle: vi.fn(),
}));

// ---------------------------------------------------------------------------
// CÓPIA LOCAL de formatTok (src/tui/StatusBar.tsx:57-74).
//
// MOTIVO: formatTok NÃO é exportada de StatusBar.tsx (é uma função privada
// do módulo). Para testar suas propriedades sem modificar o código fonte,
// copiamos a implementação exata abaixo. Se o código-fonte mudar, esta cópia
// DEVE ser atualizada — recomenda-se exportar formatTok para teste direto.
// ---------------------------------------------------------------------------
function formatTok(n: number): string {
  // Milhões: 1M, 1.5M, 2M (não 1000k, 1500k)
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m === Math.floor(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  // Milhares: 1k, 1.5k, 10k, 100k, 999k (não 1.0k, 153.6k)
  if (n >= 1000) {
    const k = n / 1000;
    if (k >= 100) {
      // Para 100k+, arredonda para inteiro (100k, 154k, 999k)
      return `${Math.round(k)}k`;
    }
    // Para 1k-99k, mostra uma casa decimal só se não for redondo (1k, 1.5k, 10k, 50.5k)
    return k === Math.floor(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return `${n}`;
}

describe("property-pure-functions", () => {
  // ========================================================================
  // 1. truncateMiddle(s, maxChars) — 3 propriedades especificadas + 1 extra
  // ========================================================================
  describe("truncateMiddle", () => {
    it("truncateMiddle(s, n).length <= n para qualquer s e n >= 0", () => {
      fc.assert(
        fc.property(fc.string(), fc.nat(200), (s, n) => {
          return truncateMiddle(s, n).length <= n;
        }),
        { numRuns: 100 },
      );
    });

    it("truncateMiddle(s, s.length) === s (não trunca se couber)", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          return truncateMiddle(s, s.length) === s;
        }),
        { numRuns: 100 },
      );
    });

    // BUG P-2 DOCUMENTADO (property-pure-functions #1):
    //   truncateMiddle não adiciona "..." quando maxChars <= 3. Nesses casos
    //   a função retorna s.slice(0, maxChars) (apenas os primeiros caracteres).
    //   Counterexample encontrado pelo fast-check (ANTES do ajuste):
    //     truncateMiddle("hello", 3) === "hel"   (não contém "...")
    //     truncateMiddle("hello", 0) === ""      (não contém "...")
    //   DECISÃO: comportamento INTENCIONAL — o próprio "..." ocupa 3 chars,
    //   então para maxChars <= 3 não haveria espaço para conteúdo além das
    //   reticências. O JSDoc da função agora documenta isso explicitamente.
    //   A propriedade "sempre contém '...' quando trunca" só vale para n > 3
    //   (há espaço suficiente para os 3 chars de "..."). Pré-condição
    //   ajustada de min: 0 para min: 4 abaixo.
    it(
      "truncateMiddle(s, n) sempre contém '...' quando trunca (s.length > n e n > 3)",
      () => {
        fc.assert(
          fc.property(
            fc
              .integer({ min: 4, max: 200 })
              .chain((n) =>
                fc.tuple(
                  fc.constant(n),
                  fc.string({ minLength: n + 1, maxLength: n + 50 }),
                ),
              ),
            ([n, s]) => {
              // Pré-condição garantida pelo chain: s.length > n e n > 3.
              return truncateMiddle(s, n).includes("...");
            },
          ),
          { numRuns: 100 },
        );
      },
    );

    // Propriedade extra (refinada) — versão canônica para n > 3.
    // Mantida como sanity check adicional; semanticamente equivalente à
    // acima (ambas garantem "..." presente quando há espaço para ele).
    it("truncateMiddle(s, n) contém '...' quando s.length > n e n > 3", () => {
      fc.assert(
        fc.property(
          fc
            .integer({ min: 4, max: 200 })
            .chain((n) =>
              fc.tuple(
                fc.constant(n),
                fc.string({ minLength: n + 1, maxLength: n + 50 }),
              ),
            ),
          ([n, s]) => {
            return truncateMiddle(s, n).includes("...");
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ========================================================================
  // 2. truncateStr(s, maxChars) — 2 propriedades
  // ========================================================================
  describe("truncateStr", () => {
    it("truncateStr(s, n).length <= n", () => {
      fc.assert(
        fc.property(fc.string(), fc.nat(200), (s, n) => {
          return truncateStr(s, n).length <= n;
        }),
        { numRuns: 100 },
      );
    });

    it("truncateStr(s, s.length) === s", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          return truncateStr(s, s.length) === s;
        }),
        { numRuns: 100 },
      );
    });
  });

  // ========================================================================
  // 3. formatTok(n) — 3 propriedades (testadas contra CÓPIA LOCAL)
  // ========================================================================
  describe("formatTok", () => {
    it("formatTok(n) sempre retorna string não-vazia para n >= 0", () => {
      fc.assert(
        fc.property(fc.nat(10_000_000), (n) => {
          return formatTok(n).length > 0;
        }),
        { numRuns: 100 },
      );
    });

    it("formatTok(n) nunca contém caracteres inválidos (só dígitos, k, M, ponto)", () => {
      fc.assert(
        fc.property(fc.nat(10_000_000), (n) => {
          const result = formatTok(n);
          // Permite apenas dígitos, 'k', 'M' e '.'.
          return /^[0-9.kM]+$/.test(result);
        }),
        { numRuns: 100 },
      );
    });

    it("formatTok(n) para n >= 1.000.000 sempre contém 'M'", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1_000_000, max: 1_000_000_000 }),
          (n) => {
            return formatTok(n).includes("M");
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ========================================================================
  // 4. extractConfidence(text) — 2 propriedades especificadas + 1 extra
  // ========================================================================
  describe("extractConfidence", () => {
    it("extractConfidence(text) sempre retorna número entre 0 e 10 (inclusive)", () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          const result = extractConfidence(text);
          return result >= 0 && result <= 10;
        }),
        { numRuns: 100 },
      );
    });

    // BUG P-1 CORRIGIDO: a função extractConfidence agora distingue o
    // inteiro "1" (escala 1-10 → retorna 1) do decimal "1.0" (escala
    // 0.0-1.0 → retorna 10) checando a presença do ponto no match.
    // Antes, ambos caíam no branch `raw <= 1.0` e eram multiplicados
    // por 10 — assim "confianca: 1" retornava 10 (confiança MÁXIMA),
    // bypassando o gate confidence <= 3 do checkConfidenceAction.
    //   Counterexample (ANTES do fix):
    //     extractConfidence("confianca: 1") === 10   (esperado: 1)
    //     extractConfidence("confidence: 1") === 10  (esperado: 1)
    //   Após o fix: retorna N para qualquer N em 1..10 (inteiro).
    it(
      "extractConfidence('confianca: N' ou 'confidence: N') retorna N para N entre 1-10",
      () => {
        fc.assert(
          fc.property(
            fc.integer({ min: 1, max: 10 }),
            fc.boolean(),
            (n, useEn) => {
              const text = useEn ? `confidence: ${n}` : `confianca: ${n}`;
              return extractConfidence(text) === n;
            },
          ),
          { numRuns: 100 },
        );
      },
    );

    // Propriedade extra (refinada) — SUBSTITUI a acima para N em 2..10.
    // Esta versão DEVE passar: a condição `raw <= 1.0` só captura N=1.
    it("extractConfidence('confianca: N' ou 'confidence: N') retorna N para N entre 2-10", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 10 }),
          fc.boolean(),
          (n, useEn) => {
            const text = useEn ? `confidence: ${n}` : `confianca: ${n}`;
            return extractConfidence(text) === n;
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ========================================================================
  // 5. calculateCardWidth(terminalWidth, columns, gap, padding) — 2 props
  // ========================================================================
  describe("calculateCardWidth", () => {
    it("calculateCardWidth(w, c, g, p) >= 10 (sempre retorna pelo menos 10)", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 500 }),   // terminalWidth
          fc.integer({ min: 1, max: 20 }),    // columns
          fc.integer({ min: 0, max: 10 }),    // gap
          fc.integer({ min: 0, max: 20 }),    // padding
          (w, c, g, p) => {
            return calculateCardWidth(w, c, g, p) >= 10;
          },
        ),
        { numRuns: 100 },
      );
    });

    it("calculateCardWidth(w, c, g, p) é decrescente em c (mais colunas = cards menores)", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 60, max: 400 }),  // terminalWidth (realista)
          fc.integer({ min: 1, max: 19 }),    // columns (1..19, +1 = 20)
          fc.integer({ min: 0, max: 5 }),     // gap
          fc.integer({ min: 0, max: 10 }),    // padding
          (w, c, g, p) => {
            const widthC = calculateCardWidth(w, c, g, p);
            const widthCplus1 = calculateCardWidth(w, c + 1, g, p);
            return widthCplus1 <= widthC;
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

// ============================================================================
// 6-14. NEW property-based tests for additional pure functions
//
// These tests verify universal invariants for:
//   - argsNormalizer.normalizeArgs (aliases, idempotency)
//   - toolReduction.detectIntent (empty/null → "general")
//   - effortLevels (set/get roundtrip, all levels produce non-empty snippets)
//   - robloxMcpGuard (classify/extract/isRobloxStudioMcpTool)
//   - syntaxHighlight.detectLanguageFromExt (defaults)
//   - configSchema.validateModeConfig (empty/null invalid)
//   - pokaYoke.pokaYokeCheck (empty path blocks for path-taking tools)
//   - utf8Safety.listSystemLocales / pickBestUtf8Locale (return types)
// ============================================================================

import { normalizeArgs } from "../argsNormalizer.js";
import { detectIntent } from "../toolReduction.js";
import {
  getEffortLevel,
  setEffortLevel,
  getEffortPromptSnippet,
  getEffortLabel,
  shouldAutoGenerateTests,
  shouldUseSubAgents,
  shouldUseIntelligentCompaction,
  type EffortLevel,
} from "../effortLevels.js";
import {
  classifyMcpTool,
  extractToolName,
  isRobloxStudioMcpTool,
  evaluateMcpToolCall,
  getAllowedRobloxMcpTools,
  getBlockedRobloxMcpTools,
} from "../robloxMcpGuard.js";
import { detectLanguageFromExt } from "../syntaxHighlight.js";
import { validateModeConfig, isValidModeConfig } from "../configSchema.js";
import { pokaYokeCheck } from "../pokaYoke.js";
import {
  listSystemLocales,
  pickBestUtf8Locale,
} from "../utf8Safety.js";

describe("property-pure-functions — additional (NEW)", () => {
  // ========================================================================
  // 6. argsNormalizer.normalizeArgs — 5 properties
  // ========================================================================
  describe("argsNormalizer.normalizeArgs (aliases)", () => {
    it("aliases always copy correctly: { caminho: s } → args.path === s for any string s", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 200 }), (s) => {
          const args: Record<string, unknown> = { caminho: s };
          normalizeArgs("ler_arquivo", args);
          return args.path === s;
        }),
        { numRuns: 50 },
      );
    });

    it("aliases preserve original: { caminho: s } → args.caminho still === s after normalize", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 200 }), (s) => {
          const args: Record<string, unknown> = { caminho: s };
          normalizeArgs("ler_arquivo", args);
          return args.caminho === s && args.path === s;
        }),
        { numRuns: 50 },
      );
    });

    it("aliases never overwrite an existing canonical field", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 100 }), fc.string({ maxLength: 100 }), (orig, alias) => {
          const args: Record<string, unknown> = { path: orig, caminho: alias };
          normalizeArgs("ler_arquivo", args);
          return args.path === orig;
        }),
        { numRuns: 50 },
      );
    });

    it("type coercion is idempotent: normalize(normalize(args)) === normalize(args)", () => {
      fc.assert(
        fc.property(
          fc.string({ maxLength: 50 }).map((s) => ({ maxResults: s })),
          (baseArgs) => {
            const schema = { properties: { maxResults: { type: "number" } } };
            // First normalize
            const args1: Record<string, unknown> = { ...baseArgs };
            normalizeArgs("tool", args1, schema);
            // Second normalize on top of already-normalized args
            const args2: Record<string, unknown> = { ...args1 };
            normalizeArgs("tool", args2, schema);
            // Result should be deeply equal (idempotent)
            return JSON.stringify(args1) === JSON.stringify(args2);
          },
        ),
        { numRuns: 50 },
      );
    });

    it("JSON-string parsing is idempotent: parsing an already-parsed array leaves it as array", () => {
      fc.assert(
        fc.property(fc.array(fc.record({ search: fc.string(), replace: fc.string() })), (edits) => {
          const args: Record<string, unknown> = { edits };
          normalizeArgs("editar_arquivo", args);
          // edits was already an array — should still be an array (not double-parsed)
          return Array.isArray(args.edits);
        }),
        { numRuns: 50 },
      );
    });
  });

  // ========================================================================
  // 7. toolReduction.detectIntent — 5 properties
  // ========================================================================
  describe("toolReduction.detectIntent (defaults to general)", () => {
    it("empty string always returns 'general'", () => {
      fc.assert(
        fc.property(fc.constant(""), (s) => detectIntent(s) === "general"),
        { numRuns: 10 },
      );
    });

    it("null input always returns 'general' (coerced to 'null' string, no pattern matches)", () => {
      fc.assert(
        fc.property(fc.constant(null), (n) => {
          // detectIntent(n as unknown as string) — JS coerces null to "null"
          const result = detectIntent(n as unknown as string);
          return result === "general";
        }),
        { numRuns: 10 },
      );
    });

    it("undefined input always returns 'general' (coerced to 'undefined' string)", () => {
      fc.assert(
        fc.property(fc.constant(undefined), (u) => {
          const result = detectIntent(u as unknown as string);
          return result === "general";
        }),
        { numRuns: 10 },
      );
    });

    it("whitespace-only string always returns 'general' (no keywords match)", () => {
      fc.assert(
        fc.property(fc.stringMatching(/^\s+$/), (s) => {
          return detectIntent(s) === "general";
        }),
        { numRuns: 30 },
      );
    });

    it("deterministic: detectIntent(s) === detectIntent(s) for any s", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 100 }), (s) => {
          return detectIntent(s) === detectIntent(s);
        }),
        { numRuns: 50 },
      );
    });
  });

  // ========================================================================
  // 8. effortLevels — 5 properties
  // ========================================================================
  describe("effortLevels (set/get roundtrip + invariants)", () => {
    it("setEffortLevel(L) then getEffortLevel() returns L for all 4 valid levels", () => {
      const levels: EffortLevel[] = ["low", "medium", "high", "max"];
      for (const level of levels) {
        setEffortLevel(level);
        expect(getEffortLevel()).toBe(level);
      }
    });

    it("all 4 levels produce non-empty prompt snippets", () => {
      const levels: EffortLevel[] = ["low", "medium", "high", "max"];
      for (const level of levels) {
        setEffortLevel(level);
        const snippet = getEffortPromptSnippet();
        expect(typeof snippet).toBe("string");
        expect(snippet.length).toBeGreaterThan(0);
      }
    });

    it("setEffortLevel returns false for any invalid level (random strings)", () => {
      fc.assert(
        fc.property(
          fc.string({ maxLength: 30 }).filter((s) => !["low", "medium", "high", "max"].includes(s)),
          (invalidLevel) => {
            const result = setEffortLevel(invalidLevel as unknown as EffortLevel);
            return result === false;
          },
        ),
        { numRuns: 50 },
      );
      // Restore valid level after property runs
      setEffortLevel("medium");
    });

    it("getEffortLabel always returns a non-empty string for any valid level", () => {
      const levels: EffortLevel[] = ["low", "medium", "high", "max"];
      for (const level of levels) {
        setEffortLevel(level);
        const label = getEffortLabel();
        expect(typeof label).toBe("string");
        expect(label.length).toBeGreaterThan(0);
      }
    });

    it("shouldAutoGenerateTests/shouldUseSubAgents/shouldUseIntelligentCompaction always return boolean", () => {
      const levels: EffortLevel[] = ["low", "medium", "high", "max"];
      for (const level of levels) {
        setEffortLevel(level);
        expect(typeof shouldAutoGenerateTests()).toBe("boolean");
        expect(typeof shouldUseSubAgents()).toBe("boolean");
        expect(typeof shouldUseIntelligentCompaction()).toBe("boolean");
      }
    });
  });

  // ========================================================================
  // 9. robloxMcpGuard — 5 properties
  // ========================================================================
  describe("robloxMcpGuard (classify / extract / isRobloxStudioMcpTool)", () => {
    it("classifyMcpTool always returns 'unknown' for any unrecognized tool name", () => {
      fc.assert(
        fc.property(
          fc.string({ maxLength: 50 }).filter(
            (s) =>
              s.length > 0 &&
              ![
                "script_read", "script_search", "script_grep", "search_game_tree",
                "inspect_instance", "explore_subagent", "list_roblox_studios",
                "console_output", "get_studio_state",
                "multi_edit", "insert_from_creator_store", "generate_mesh",
                "generate_material", "generate_procedural_model",
                "execute_luau", "run_script_in_play_mode",
                "start_stop_play", "screen_capture", "playtest_subagent",
                "character_navigation", "keyboard_input", "mouse_input",
                "set_active_studio",
              ].includes(s),
          ),
          (tool) => classifyMcpTool(tool) === "unknown",
        ),
        { numRuns: 50 },
      );
    });

    it("extractToolName roundtrip: extract(prefix+name) then extract(prefix+extract(...)) is stable", () => {
      fc.assert(
        fc.property(
          fc.constantFrom("Roblox_Studio__", "roblox_studio__", "RobloxStudio__"),
          fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes("__")),
          (prefix, toolName) => {
            const fullName = `${prefix}${toolName}`;
            const first = extractToolName(fullName);
            const second = extractToolName(`${prefix}${first}`);
            return first === second && first === toolName;
          },
        ),
        { numRuns: 50 },
      );
    });

    it("isRobloxStudioMcpTool returns true for all 3 documented prefix variations", () => {
      fc.assert(
        fc.property(
          fc.constantFrom("Roblox_Studio__", "roblox_studio__", "RobloxStudio__"),
          fc.string({ minLength: 1, maxLength: 30 }),
          (prefix, tool) => isRobloxStudioMcpTool(`${prefix}${tool}`) === true,
        ),
        { numRuns: 50 },
      );
    });

    it("isRobloxStudioMcpTool returns false for any name WITHOUT a recognized prefix", () => {
      fc.assert(
        fc.property(
          fc.string({ maxLength: 50 }).filter(
            (s) =>
              !s.startsWith("Roblox_Studio__") &&
              !s.startsWith("roblox_studio__") &&
              !s.startsWith("RobloxStudio__"),
          ),
          (s) => s.length === 0 || isRobloxStudioMcpTool(s) === false,
        ),
        { numRuns: 50 },
      );
    });

    it("evaluateMcpToolCall never throws for any string input (stringent robustness check)", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 100 }), fc.object({ maxKeys: 5 }), (name, args) => {
          let threw = false;
          try {
            evaluateMcpToolCall(name, args as Record<string, unknown>);
          } catch {
            threw = true;
          }
          return !threw;
        }),
        { numRuns: 50 },
      );
    });

    it("getAllowedRobloxMcpTools and getBlockedRobloxMcpTools never share a tool name", () => {
      const allowed = new Set(getAllowedRobloxMcpTools());
      const blocked = new Set(getBlockedRobloxMcpTools());
      for (const tool of allowed) {
        expect(blocked.has(tool)).toBe(false);
      }
      for (const tool of blocked) {
        expect(allowed.has(tool)).toBe(false);
      }
    });
  });

  // ========================================================================
  // 10. syntaxHighlight.detectLanguageFromExt — 3 properties
  // ========================================================================
  describe("syntaxHighlight.detectLanguageFromExt (defaults)", () => {
    it("unknown extensions always return 'typescript' (fallback default)", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 10 }).filter(
            (s) =>
              ![
                ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs",
                ".py", ".pyw", ".rs", ".go", ".java",
              ].includes(s.toLowerCase()),
          ),
          (ext) => detectLanguageFromExt(ext) === "typescript",
        ),
        { numRuns: 50 },
      );
    });

    it("empty string returns 'typescript' (fallback default)", () => {
      expect(detectLanguageFromExt("")).toBe("typescript");
    });

    it("case-insensitive: detectLanguageFromExt(ext.toUpperCase()) === detectLanguageFromExt(ext.toLowerCase())", () => {
      fc.assert(
        fc.property(
          fc.constantFrom(".ts", ".tsx", ".js", ".py", ".rs", ".go", ".java", ".xyz", ".unknown"),
          (ext) => detectLanguageFromExt(ext.toUpperCase()) === detectLanguageFromExt(ext.toLowerCase()),
        ),
        { numRuns: 30 },
      );
    });
  });

  // ========================================================================
  // 11. configSchema.validateModeConfig — 4 properties
  // ========================================================================
  describe("configSchema.validateModeConfig (invalid inputs)", () => {
    it("empty object always invalid (returns at least one error)", () => {
      const errors = validateModeConfig({});
      expect(Array.isArray(errors)).toBe(true);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("null input always invalid (returns at least one error)", () => {
      const errors = validateModeConfig(null);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.field === "root")).toBe(true);
    });

    it("array input always invalid (config must be a non-null object, not array)", () => {
      fc.assert(
        fc.property(fc.array(fc.anything(), { maxLength: 5 }), (arr) => {
          const errors = validateModeConfig(arr);
          return errors.some((e) => e.field === "root");
        }),
        { numRuns: 30 },
      );
    });

    it("config with name containing spaces but missing label always invalid", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.includes(" ") || s.trim().length === 0),
          (nameWithSpaces) => {
            const errors = validateModeConfig({ name: nameWithSpaces });
            // Without label, config is always invalid (regardless of name content)
            return errors.length > 0 && errors.some((e) => e.field === "label");
          },
        ),
        { numRuns: 30 },
      );
    });

    it("isValidModeConfig(emptyObject) === false (consistent with validateModeConfig)", () => {
      expect(isValidModeConfig({})).toBe(false);
    });
  });

  // ========================================================================
  // 12. pokaYoke.pokaYokeCheck — 4 properties
  // ========================================================================
  describe("pokaYoke.pokaYokeCheck (empty path blocks path-taking tools)", () => {
    const PATH_TAKING_TOOLS = [
      "ler_arquivo", "ler_arquivo_avancado", "aplicar_diff",
      "editar_arquivo", "desfazer_edicao", "git_blame", "git_show", "parse_ast",
    ];

    it("empty path always blocks for any path-taking tool", () => {
      for (const tool of PATH_TAKING_TOOLS) {
        const result = pokaYokeCheck(tool, {});
        expect(result.ok).toBe(false);
      }
    });

    it("null path always blocks for any path-taking tool", () => {
      for (const tool of PATH_TAKING_TOOLS) {
        const result = pokaYokeCheck(tool, { caminho: null });
        expect(result.ok).toBe(false);
      }
    });

    it("non-string path (number/boolean/object/array) always blocks for path-taking tools", () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...PATH_TAKING_TOOLS),
          fc.oneof(fc.integer(), fc.boolean(), fc.object(), fc.array(fc.anything())),
          (tool, nonStringPath) => {
            const result = pokaYokeCheck(tool, { caminho: nonStringPath });
            return result.ok === false;
          },
        ),
        { numRuns: 50 },
      );
    });

    it("pokaYokeCheck never throws for any tool name and args combination (robustness)", () => {
      fc.assert(
        fc.property(
          fc.string({ maxLength: 50 }),
          fc.object({ maxKeys: 5, values: [fc.string(), fc.integer(), fc.boolean(), fc.constant(null)] }),
          (toolName, args) => {
            let threw = false;
            try {
              pokaYokeCheck(toolName, args as Record<string, unknown>);
            } catch {
              threw = true;
            }
            return !threw;
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // ========================================================================
  // 13. utf8Safety.listSystemLocales / pickBestUtf8Locale — 3 properties
  // ========================================================================
  describe("utf8Safety (return type invariants)", () => {
    it("listSystemLocales always returns an array", () => {
      const result = listSystemLocales();
      expect(Array.isArray(result)).toBe(true);
    });

    it("pickBestUtf8Locale always returns an object with 'locale' and 'tried' properties", () => {
      const result = pickBestUtf8Locale();
      expect(result).toBeTypeOf("object");
      expect(result).not.toBeNull();
      expect("locale" in result).toBe(true);
      expect("tried" in result).toBe(true);
    });

    it("pickBestUtf8Locale 'tried' is always an array, and 'locale' is string or null", () => {
      const result = pickBestUtf8Locale();
      expect(Array.isArray(result.tried)).toBe(true);
      expect(result.locale === null || typeof result.locale === "string").toBe(true);
    });

    it("listSystemLocales is cached: calling twice returns the same reference", () => {
      const a = listSystemLocales();
      const b = listSystemLocales();
      expect(a).toBe(b); // same reference (cache)
    });
  });
});

