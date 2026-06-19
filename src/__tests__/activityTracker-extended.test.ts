/**
 * activityTracker-extended.test.ts — Casos edge / error handling / integração
 * para activityTracker.ts que NÃO estão cobertos pelo teste básico.
 *
 * Foco:
 *   - pushActivity (3 casos) — stacks profundas e cenários extras
 *   - popActivity (2 casos) — pop fora de ordem / pop profundo
 *   - getSnapshot (getActivitySnapshot) (2 casos)
 *   - edge cases (1 caso)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  pushActivity,
  clearActivity,
  getActivitySnapshot,
  subscribeToActivity,
  withActivity,
  withActivitySync,
  notifyActivity,
  _resetActivityForTests,
  type ActivitySnapshot,
} from "../activityTracker.js";

beforeEach(() => {
  _resetActivityForTests();
});

// ─── pushActivity ──────────────────────────────────────────────────────────
describe("pushActivity (stacks profundas)", () => {
  it("suporta stack com 5+ atividades aninhadas mantendo ordem LIFO", () => {
    const done1 = pushActivity("api_call", "kimi");
    const done2 = pushActivity("tool", "ler_arquivo");
    const done3 = pushActivity("quality_gate", "tsc");
    const done4 = pushActivity("compacting", "");
    const done5 = pushActivity("checkpoint", "");

    const snap = getActivitySnapshot();
    expect(snap.depth).toBe(5);
    // O topo deve ser o último push
    expect(snap.current?.category).toBe("checkpoint");
    expect(snap.displayLabel).toBe("Salvando checkpoint…");

    // Pop na ordem inversa
    done5();
    expect(getActivitySnapshot().current?.category).toBe("compacting");
    done4();
    expect(getActivitySnapshot().current?.category).toBe("quality_gate");
    done3();
    expect(getActivitySnapshot().current?.category).toBe("tool");
    done2();
    expect(getActivitySnapshot().current?.category).toBe("api_call");
    done1();
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("push com categoria 'idle' retorna label cru no displayLabel", () => {
    const done = pushActivity("idle", "aguardando usuário");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toBe("aguardando usuário");
    expect(snap.shortLabel).toBe("");
    done();
  });

  it("push com categoria 'streaming' e label não-vazio inclui o label após dois-pontos", () => {
    const done = pushActivity("streaming", "kimi-k2.6");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toBe("Gerando resposta: kimi-k2.6");
    expect(snap.shortLabel).toBe("streaming");
    done();
  });
});

// ─── popActivity (fora de ordem / intermediário) ──────────────────────────
describe("popActivity (fora de ordem e intermediário)", () => {
  it("pop de atividade no MEIO da stack remove ela E todas as descendentes", () => {
    const done1 = pushActivity("api_call", "kimi");
    const done2 = pushActivity("tool", "ler_arquivo");
    const done3 = pushActivity("quality_gate", "tsc");
    expect(getActivitySnapshot().depth).toBe(3);

    // Pop do done1 (base da stack) — deve limpar toda a pilha
    done1();
    expect(getActivitySnapshot().depth).toBe(0);
    expect(getActivitySnapshot().current).toBeNull();

    // done2 e done3 agora são no-ops
    done2();
    done3();
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("pop chamado depois do stack já ter sido cleared é no-op seguro", () => {
    const done = pushActivity("tool", "ler_arquivo");
    clearActivity();
    expect(getActivitySnapshot().depth).toBe(0);

    // Pop após clear não deve lançar nem alterar estado
    expect(() => done()).not.toThrow();
    expect(getActivitySnapshot().depth).toBe(0);
  });
});

// ─── getSnapshot (getActivitySnapshot) ─────────────────────────────────────
describe("getSnapshot (getActivitySnapshot)", () => {
  it("elapsedMs aumenta conforme o tempo passa (sem chamar pop)", async () => {
    const done = pushActivity("tool", "ler_arquivo");
    const snap1 = getActivitySnapshot();
    expect(snap1.elapsedMs).toBeGreaterThanOrEqual(0);

    await new Promise((r) => setTimeout(r, 50));

    const snap2 = getActivitySnapshot();
    expect(snap2.elapsedMs).toBeGreaterThan(snap1.elapsedMs);
    expect(snap2.elapsedMs).toBeGreaterThanOrEqual(40);

    done();
  });

  it("shortLabel retorna o PRIMEIRO token da label para tool category", () => {
    const done = pushActivity("tool", "aplicar_diff /home/user/file.ts");
    const snap = getActivitySnapshot();
    expect(snap.shortLabel).toBe("aplicar_diff");
    done();

    // Categoria subagent também usa a label original, mas retorna "sub-agente"
    const done2 = pushActivity("subagent", "worker-1");
    expect(getActivitySnapshot().shortLabel).toBe("sub-agente");
    done2();

    // api_call retorna "API" fixo
    const done3 = pushActivity("api_call", "kimi-k2.6");
    expect(getActivitySnapshot().shortLabel).toBe("API");
    done3();
  });
});

// ─── edge cases ────────────────────────────────────────────────────────────
describe("edge cases", () => {
  it("notifyActivity força notificação mesmo sem mudança de estado (tick do UI)", () => {
    const listener = vi.fn();
    subscribeToActivity(listener);

    pushActivity("tool", "ler_arquivo");
    const initialCalls = listener.mock.calls.length;

    // notifyActivity dispara mais uma notificação sem alterar a stack
    notifyActivity();
    expect(listener.mock.calls.length).toBe(initialCalls + 1);

    const snap = listener.mock.calls[listener.mock.calls.length - 1]?.[0] as ActivitySnapshot;
    expect(snap.depth).toBe(1);
    expect(snap.current?.category).toBe("tool");
  });

  it("withActivity/withActivitySync propagam valores de retorno e suportam tipos genéricos", async () => {
    // Sync retornando number
    const syncResult = withActivitySync("tool", "calc", () => 42);
    expect(syncResult).toBe(42);

    // Async retornando objeto
    const asyncResult = await withActivity("api_call", "kimi", async () => ({
      tokens: 100,
      model: "kimi-k2.6",
    }));
    expect(asyncResult.tokens).toBe(100);
    expect(asyncResult.model).toBe("kimi-k2.6");

    // Stack deve estar limpa após ambos
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("múltiplos listeners são notificados independentemente, em ordem de inscrição", () => {
    const calls: string[] = [];
    const l1 = () => { calls.push("l1"); };
    const l2 = () => { calls.push("l2"); };
    const l3 = () => { calls.push("l3"); };
    subscribeToActivity(l1);
    subscribeToActivity(l2);
    subscribeToActivity(l3);

    pushActivity("tool", "ler_arquivo");

    expect(calls).toEqual(["l1", "l2", "l3"]);
  });
});
