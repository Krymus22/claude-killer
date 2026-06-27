/**
 * bugHunter-cleanup.test.ts — Testes de regressão para limpeza de Bug Hunter findings.
 *
 * O Bug Hunter injeta findings via addSystemMessage. Cada round pode ser ~13K chars.
 * Sem cleanup, após 2 rounds = ~26K chars de findings OBSOLETOS no contexto.
 * Após 10 rounds (max) = ~130K chars — mais que a janela inteira.
 *
 * A correção em history.ts (addSystemMessage): quando uma nova mensagem
 * [BUG_HUNTER] é injetada, a mensagem [BUG_HUNTER] ANTERIOR é substituída
 * por um resumo de 1 linha. Só o round mais recente fica completo.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  },
  toolCall: vi.fn(), toolResult: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
  success: vi.fn(), throttle: vi.fn(),
}));

import {
  addSystemMessage,
  getHistory,
  resetHistory,
} from "../history.js";

// Helper: simula uma mensagem de Bug Hunter com N findings
function makeBugHunterMessage(round: number, findingCount: number, blocking: boolean = true): string {
  const findings = [];
  for (let i = 0; i < findingCount; i++) {
    findings.push(`🔴 [CRITICAL] /tmp/project/src/file${i}.ts:${i + 10} — bug description ${i}`);
    findings.push(`  Fix: suggestion for bug ${i}`);
    findings.push("");
  }

  const header = blocking
    ? `[BUG_HUNTER] ✗ ISSUES FOUND — you MUST fix or dismiss EACH finding before finishing:`
    : `[BUG_HUNTER] Review complete. No issues found.`;

  return `${header}

IMPORTANT: You are NOT allowed to finish until every finding below is either FIXED or DISMISSED.

## All Findings (${findingCount} total)

${findings.join("\n")}

## How to address these findings:
1. Fix ONE finding at a time
2. READ the file FIRST
3. Edit with editar_arquivo
4. For each finding: either FIX it or DISMISS it with a concrete reason.

Round ${round} of 10.`;
}

// ─── Testes: sumarização de rounds anteriores ─────────────────────────────

describe("Bug Hunter cleanup: sumariza rounds anteriores", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("quando Round 2 é injetado, Round 1 é substituído por resumo", () => {
    // Round 1
    const round1 = makeBugHunterMessage(1, 38, true);
    addSystemMessage(round1);

    let h = getHistory();
    const round1Msg = h.find(m => m.role === "system" && (m as any).content?.startsWith("[BUG_HUNTER]"));
    expect(round1Msg).toBeDefined();
    expect((round1Msg as any).content.length).toBeGreaterThan(1000); // mensagem completa

    // Round 2
    const round2 = makeBugHunterMessage(2, 15, true);
    addSystemMessage(round2);

    h = getHistory();
    const bhMessages = h.filter(m => m.role === "system" && (m as any).content?.startsWith("[BUG_HUNTER]"));
    expect(bhMessages.length).toBe(2);

    // A mensagem mais recente (Round 2) deve estar completa
    const lastMsg = bhMessages[bhMessages.length - 1];
    expect((lastMsg as any).content).toContain("All Findings (15 total)");
    expect((lastMsg as any).content).toContain("Round 2 of 10");

    // A mensagem anterior (Round 1) deve estar SUMARIZADA
    const firstMsg = bhMessages[0];
    expect((firstMsg as any).content).toContain("Previous round complete");
    expect((firstMsg as any).content).toContain("38 findings");
    expect((firstMsg as any).content).toContain("was blocking");
    // NÃO deve mais ter os findings detalhados
    expect((firstMsg as any).content).not.toContain("All Findings (38 total)");
    expect((firstMsg as any).content).not.toContain("bug description 0");
  });

  it("após 3 rounds, apenas o mais recente fica completo", () => {
    addSystemMessage(makeBugHunterMessage(1, 10, true));
    addSystemMessage(makeBugHunterMessage(2, 8, true));
    addSystemMessage(makeBugHunterMessage(3, 5, true));

    const h = getHistory();
    const bhMessages = h.filter(m => m.role === "system" && (m as any).content?.startsWith("[BUG_HUNTER]"));
    expect(bhMessages.length).toBe(3);

    // Round 1 e 2: sumarizados
    expect((bhMessages[0] as any).content).toContain("Previous round complete");
    expect((bhMessages[1] as any).content).toContain("Previous round complete");
    // Round 3: completo
    expect((bhMessages[2] as any).content).toContain("All Findings (5 total)");
    expect((bhMessages[2] as any).content).not.toContain("Previous round complete");
  });

  it("resumo inclui contagem de findings", () => {
    addSystemMessage(makeBugHunterMessage(1, 42, true));
    addSystemMessage(makeBugHunterMessage(2, 3, true));

    const h = getHistory();
    const bhMessages = h.filter(m => m.role === "system" && (m as any).content?.startsWith("[BUG_HUNTER]"));
    const round1Summary = (bhMessages[0] as any).content;
    expect(round1Summary).toContain("42 findings");
  });

  it("resumo marca se era blocking ou advisory", () => {
    // Round 1 blocking
    addSystemMessage(makeBugHunterMessage(1, 5, true));
    // Round 2 advisory (clean pass)
    addSystemMessage("[BUG_HUNTER] ✓ No bugs found. Code passed critical review.");
    // Round 3 blocking
    addSystemMessage(makeBugHunterMessage(3, 2, true));

    const h = getHistory();
    const bhMessages = h.filter(m => m.role === "system" && (m as any).content?.startsWith("[BUG_HUNTER]"));

    // Round 1 (blocking) → sumarizado com "was blocking"
    expect((bhMessages[0] as any).content).toContain("was blocking");

    // Round 2 (advisory/clean) → sumarizado, deve marcar como advisory
    const round2Summary = (bhMessages[1] as any).content;
    expect(round2Summary).toContain("Previous round complete");
    // Clean pass não tem "ISSUES FOUND", então deve dizer "was advisory"
    expect(round2Summary).toContain("was advisory");
  });
});

// ─── Testes: economia de tokens ───────────────────────────────────────────

describe("Bug Hunter cleanup: economia de tokens", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("após 2 rounds, apenas ~1 resumo + 1 completo no contexto", () => {
    const round1 = makeBugHunterMessage(1, 38, true);
    addSystemMessage(round1);
    const round1Len = round1.length;

    const round2 = makeBugHunterMessage(2, 15, true);
    addSystemMessage(round2);

    const h = getHistory();
    const bhMessages = h.filter(m => m.role === "system" && (m as any).content?.startsWith("[BUG_HUNTER]"));

    const totalChars = bhMessages.reduce((sum, m) => sum + ((m as any).content as string).length, 0);

    // Sem cleanup: round1Len + round2.length ≈ 13K + 8K = 21K chars
    // Com cleanup: ~200 chars (resumo) + round2.length ≈ 8K chars = ~8.2K chars
    // Economia: > 12K chars
    expect(totalChars).toBeLessThan(round1Len + round2.length);
    expect(totalChars - round2.length).toBeLessThan(500); // resumo é pequeno
  });

  it("após 5 rounds, economia é massiva", () => {
    // Sem cleanup: 5 × ~13K = ~65K chars de Bug Hunter
    // Com cleanup: 4 × ~200 chars (resumos) + 1 × ~13K (completo) = ~14K chars
    for (let i = 1; i <= 5; i++) {
      addSystemMessage(makeBugHunterMessage(i, 30, true));
    }

    const h = getHistory();
    const bhMessages = h.filter(m => m.role === "system" && (m as any).content?.startsWith("[BUG_HUNTER]"));
    const totalChars = bhMessages.reduce((sum, m) => sum + ((m as any).content as string).length, 0);

    // Deve ser bem menos que 5 × 13K = 65K
    expect(totalChars).toBeLessThan(20000); // < 20K
    // Apenas 1 mensagem completa (a última)
    const completeMsgs = bhMessages.filter(m => (m as any).content.includes("All Findings"));
    expect(completeMsgs.length).toBe(1);
  });
});

// ─── Testes: não afeta outras system messages ─────────────────────────────

describe("Bug Hunter cleanup: não afeta outras system messages", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("não sumariza mensagens que não são [BUG_HUNTER]", () => {
    addSystemMessage("## TASK_STATE\n\nSome task state here.");
    addSystemMessage("[PLAN]\n\nSome plan here.");
    addSystemMessage(makeBugHunterMessage(1, 5, true));

    const h = getHistory();
    // TASK_STATE e PLAN não devem ter sido tocados
    const taskState = h.find(m => m.role === "system" && (m as any).content?.startsWith("## TASK_STATE"));
    expect(taskState).toBeDefined();
    expect((taskState as any).content).toContain("Some task state here.");

    const plan = h.find(m => m.role === "system" && (m as any).content?.startsWith("[PLAN]"));
    expect(plan).toBeDefined();
    expect((plan as any).content).toContain("Some plan here.");
  });

  it("não quebra quando não há Bug Hunter message anterior", () => {
    // Primeira mensagem Bug Hunter — não deve tentar sumarizar nada
    expect(() => {
      addSystemMessage(makeBugHunterMessage(1, 5, true));
    }).not.toThrow();

    const h = getHistory();
    const bhMessages = h.filter(m => m.role === "system" && (m as any).content?.startsWith("[BUG_HUNTER]"));
    expect(bhMessages.length).toBe(1);
    expect((bhMessages[0] as any).content).toContain("All Findings (5 total)");
  });
});

// ─── Testes: detecção de blocking vs advisory ─────────────────────────────

describe("Bug Hunter cleanup: detecção de blocking vs advisory", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("detecta round blocking (ISSUES FOUND)", () => {
    addSystemMessage(makeBugHunterMessage(1, 5, true));
    addSystemMessage(makeBugHunterMessage(2, 3, true));

    const h = getHistory();
    const bhMessages = h.filter(m => m.role === "system" && (m as any).content?.startsWith("[BUG_HUNTER]"));
    expect((bhMessages[0] as any).content).toContain("was blocking");
  });

  it("detecta round advisory (clean pass)", () => {
    addSystemMessage("[BUG_HUNTER] ✓ No bugs found. Code passed critical review.");
    addSystemMessage(makeBugHunterMessage(2, 3, true));

    const h = getHistory();
    const bhMessages = h.filter(m => m.role === "system" && (m as any).content?.startsWith("[BUG_HUNTER]"));
    expect((bhMessages[0] as any).content).toContain("was advisory");
  });

  it("detecta round de cap reached (medium/low advisory)", () => {
    addSystemMessage("[BUG_HUNTER] Medium/low review cap reached. 5 findings remain unaddressed.");
    addSystemMessage(makeBugHunterMessage(2, 3, true));

    const h = getHistory();
    const bhMessages = h.filter(m => m.role === "system" && (m as any).content?.startsWith("[BUG_HUNTER]"));
    // Cap reached não tem "ISSUES FOUND" → marcado como advisory
    expect((bhMessages[0] as any).content).toContain("was advisory");
  });
});
