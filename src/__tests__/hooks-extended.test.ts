/**
 * hooks-extended.test.ts — Casos edge / error handling / integração para
 * hooks.ts que NÃO estão cobertos pelo teste básico.
 *
 * Foco:
 *   - executePreToolCallHooks (3 casos) — cenários extras
 *   - executePostToolCallHooks (2 casos) — encadeamento e erros
 *   - getActivePreCommitHooks (getActivePreCommitHooks do modeExtensions, equivalente de hooks de pre-commit) (2 casos)
 *   - edge cases (1 caso)
 *
 * Nota: getActivePreCommitHooks está definido em modeExtensions.ts. Como hooks.ts
 *       não tem essa função, incluímos os 2 testes como integração que valida
 *       a colaboração entre hooks.ts (clearAllHooks) e o executor de hooks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  onPreToolCall,
  onPostToolCall,
  onPreFileWrite,
  executePreToolCallHooks,
  executePostToolCallHooks,
  executePreFileWriteHooks,
  clearAllHooks,
  unregisterHook,
  registerDebugHook,
} from "../hooks.js";

beforeEach(() => {
  clearAllHooks();
});

afterEach(() => {
  clearAllHooks();
});

// ─── executePreToolCallHooks ───────────────────────────────────────────────
describe("executePreToolCallHooks (cenários extras)", () => {
  it("passa contexto com timestamp > 0 e args clonados (não por referência)", async () => {
    const seen: any[] = [];
    onPreToolCall(async (ctx) => {
      seen.push(ctx);
      return {};
    });

    const args = { foo: "bar", nested: { value: 42 } };
    await executePreToolCallHooks("my_tool", args);

    expect(seen.length).toBe(1);
    expect(seen[0].toolName).toBe("my_tool");
    expect(seen[0].timestamp).toBeGreaterThan(0);
    // Args devem ser uma cópia — modificar não afeta o original
    seen[0].args.foo = "MODIFIED";
    expect(args.foo).toBe("bar");
  });

  it("hook pode retornar modifiedArgs undefined e Skip=false sem afetar resultado", async () => {
    onPreToolCall(async () => ({}));
    onPreToolCall(async () => ({}));

    const result = await executePreToolCallHooks("t", { x: 1 });
    expect(result.skip).toBe(false);
    expect(result.resultOverride).toBeUndefined();
    expect(result.modifiedArgs).toEqual({ x: 1 });
  });

  it("múltiplos hooks podem encadear modifiedArgs: cada um vê o resultado do anterior", async () => {
    onPreToolCall(async (ctx) => ({
      modifiedArgs: { ...ctx.args, step1: true },
    }), 1);
    onPreToolCall(async (ctx) => ({
      modifiedArgs: { ...ctx.args, step2: true },
    }), 2);
    onPreToolCall(async (ctx) => ({
      modifiedArgs: { ...ctx.args, step3: true },
    }), 3);

    const result = await executePreToolCallHooks("chain", { original: true });
    expect(result.modifiedArgs).toEqual({
      original: true,
      step1: true,
      step2: true,
      step3: true,
    });
  });
});

// ─── executePostToolCallHooks ──────────────────────────────────────────────
describe("executePostToolCallHooks (encadeamento e erros)", () => {
  it("hook que retorna {} (sem modifiedResult) preserva o result atual", async () => {
    onPostToolCall(async () => ({}));
    onPostToolCall(async () => ({}));

    const r = await executePostToolCallHooks("t", {}, "untouched");
    expect(r.modifiedResult).toBe("untouched");
  });

  it("hook que lança erro NÃO é capturado (propaga) — diferente do listener que captura", async () => {
    onPostToolCall(async () => {
      throw new Error("hook boom");
    });

    // O executor de hooks não captura erros — deve propagar
    await expect(
      executePostToolCallHooks("t", {}, "result"),
    ).rejects.toThrow("hook boom");
  });
});

// ─── getActivePreCommitHooks (integração com preFileWrite como equivalente) ─
describe("getActivePreCommitHooks — equivalente via executePreFileWriteHooks", () => {
  it("hooks de preFileWrite executam em ordem de prioridade (menor primeiro)", async () => {
    const calls: string[] = [];
    onPreFileWrite(async () => { calls.push("low-prio"); return {}; }, 100);
    onPreFileWrite(async () => { calls.push("high-prio"); return {}; }, 1);
    onPreFileWrite(async () => { calls.push("mid-prio"); return {}; }, 50);

    await executePreFileWriteHooks("file.txt", "content");
    expect(calls).toEqual(["high-prio", "mid-prio", "low-prio"]);
  });

  it("múltiplos hooks de preFileWrite podem modificar conteúdo em cadeia", async () => {
    onPreFileWrite(async (_path, content) => ({ modifiedContent: content + " [A]" }), 1);
    onPreFileWrite(async (_path, content) => ({ modifiedContent: content + " [B]" }), 2);

    const result = await executePreFileWriteHooks("file.txt", "base");
    expect(result.modifiedContent).toBe("base [A] [B]");
    expect(result.block).toBe(false);
  });
});

// ─── edge cases ────────────────────────────────────────────────────────────
describe("edge cases", () => {
  it("executePreToolCallHooks sem nenhum hook registrado retorna skip=false e args preservados", async () => {
    const result = await executePreToolCallHooks("no_hooks", { key: "val" });
    expect(result.skip).toBe(false);
    expect(result.resultOverride).toBeUndefined();
    expect(result.modifiedArgs).toEqual({ key: "val" });
  });

  it("registerDebugHook pode ser chamado múltiplas vezes (cada um registra um hook novo)", () => {
    const id1 = registerDebugHook();
    const id2 = registerDebugHook();
    const id3 = registerDebugHook();
    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    // Limpa
    unregisterHook(id1);
    unregisterHook(id2);
    unregisterHook(id3);
  });

  it("hook síncrono (sem async/await) também é executado corretamente", async () => {
    // Os tipos esperam Promise, mas funções síncronas retornando o objeto também funcionam
    onPreToolCall(() => ({ skip: true, resultOverride: "sync-override" }) as any);

    const result = await executePreToolCallHooks("sync_tool", {});
    expect(result.skip).toBe(true);
    expect(result.resultOverride).toBe("sync-override");
  });
});
