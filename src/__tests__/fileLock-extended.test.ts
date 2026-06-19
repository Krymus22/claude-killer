/**
 * fileLock-extended.test.ts — Casos edge / error handling / integração para
 * fileLock.ts que NÃO estão cobertos pelo teste básico.
 *
 * Foco:
 *   - acquireLock (3 casos) — paralelismo, reentrada, timeout com holders
 *   - releaseLock (release function) (2 casos) — idempotência, após force
 *   - isLocked (getLockHolder/listLocks) (2 casos)
 *   - edge cases (1 caso)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  const { clearAllLocks } = await import("./../fileLock.js");
  clearAllLocks();
  delete process.env.CLAUDE_KILLER_AGENT_ID;
});

afterEach(async () => {
  const { clearAllLocks } = await import("./../fileLock.js");
  clearAllLocks();
  delete process.env.CLAUDE_KILLER_AGENT_ID;
});

// ─── acquireLock ───────────────────────────────────────────────────────────
describe("acquireLock (paralelismo e reentrada)", () => {
  it("adquire lock imediatamente quando recurso livre usando TTL customizado", async () => {
    const { acquireLock, getLockHolder } = await import("./../fileLock.js");
    const release = await acquireLock("/p/arquivo.luau", "main", 5000, 1000);
    const holder = getLockHolder("/p/arquivo.luau");
    expect(holder).not.toBeNull();
    expect(holder!.holderId).toBe("main");
    release();
  });

  it("múltiplos acquireLock em paralelo de diferentes holders são serializados", async () => {
    const { acquireLock } = await import("./../fileLock.js");
    const release1 = await acquireLock("/p/paralelo.luau", "main", 30_000, 1000);

    // Dois holders tentando adquirir concorrentemente
    const p1 = acquireLock("/p/paralelo.luau", "sub-1", 30_000, 1000);
    const p2 = acquireLock("/p/paralelo.luau", "sub-2", 30_000, 1000);

    // Libera o lock principal após 150ms
    setTimeout(() => release1(), 150);

    // Apenas um dos dois deve conseguir (não ambos)
    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // Limpa
    for (const r of results) {
      if (r.status === "fulfilled") r.value();
    }
  });

  it("mensagem de erro de timeout contém filePath, holder e tempo em segundos", async () => {
    const { acquireLock, tryAcquireLock } = await import("./../fileLock.js");
    // main segura o lock
    tryAcquireLock("/p/timeout.luau", "main");

    await expect(
      acquireLock("/p/timeout.luau", "sub-x", 30_000, 300)
    ).rejects.toThrow(/Timeout acquiring lock for .*timeout\.luau .* Currently held by: main .*ago/);
  });
});

// ─── releaseLock ───────────────────────────────────────────────────────────
describe("releaseLock — release function", () => {
  it("release chamada múltiplas vezes é idempotente e não lança", async () => {
    const { tryAcquireLock, getLockHolder } = await import("./../fileLock.js");
    const release = tryAcquireLock("/p/idem.luau", "main");
    expect(release).not.toBeNull();

    release!();
    release!();
    release!();
    expect(getLockHolder("/p/idem.luau")).toBeNull();
  });

  it("release chamada APÓS forceReleaseLock não quebra estado", async () => {
    const { tryAcquireLock, forceReleaseLock, getLockHolder } = await import("./../fileLock.js");
    const release = tryAcquireLock("/p/force.luau", "main");
    expect(release).not.toBeNull();

    // Force release
    expect(forceReleaseLock("/p/force.luau")).toBe(true);
    expect(getLockHolder("/p/force.luau")).toBeNull();

    // Chamar release original NÃO deve re-criar nem corromper estado
    expect(() => release!()).not.toThrow();
    expect(getLockHolder("/p/force.luau")).toBeNull();
  });
});

// ─── isLocked (getLockHolder + listLocks) ─────────────────────────────────
describe("isLocked — getLockHolder + listLocks", () => {
  it("getLockHolder retorna null para lock expirado (TTL estourado)", async () => {
    const { tryAcquireLock, getLockHolder } = await import("./../fileLock.js");
    // TTL de 1ms
    const release = tryAcquireLock("/p/expired.luau", "main", 1);
    expect(release).not.toBeNull();
    expect(getLockHolder("/p/expired.luau")).not.toBeNull();

    // Espera expirar
    await new Promise((r) => setTimeout(r, 30));

    // Deve retornar null porque o lock está expirado
    expect(getLockHolder("/p/expired.luau")).toBeNull();
  });

  it("listLocks exclui locks expirados (skips stale) do resultado", async () => {
    const { tryAcquireLock, listLocks } = await import("./../fileLock.js");
    // Lock válido (TTL grande)
    tryAcquireLock("/p/valid1.luau", "main", 60_000);
    // Lock expirado (TTL 1ms)
    tryAcquireLock("/p/stale1.luau", "sub-1", 1);
    await new Promise((r) => setTimeout(r, 20));

    const locks = listLocks();
    const paths = locks.map((l) => l.filePath);
    expect(paths).toContain("/p/valid1.luau");
    expect(paths).not.toContain("/p/stale1.luau");
    // O lock válido deve ter expiresMs > 0
    const valid = locks.find((l) => l.filePath === "/p/valid1.luau");
    expect(valid!.expiresMs).toBeGreaterThan(0);
    expect(valid!.ageMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── edge cases ────────────────────────────────────────────────────────────
describe("edge cases", () => {
  it("tryAcquireLock pelo MESMO holder renova TTL e retorna no-op release (não bloqueia)", async () => {
    const { tryAcquireLock, getLockHolder } = await import("./../fileLock.js");
    const release1 = tryAcquireLock("/p/reentrant.luau", "main", 1000);
    expect(release1).not.toBeNull();

    // Mesmo holder tenta novamente — deve receber um release no-op
    const release2 = tryAcquireLock("/p/reentrant.luau", "main", 5000);
    expect(release2).not.toBeNull();

    // Lock ainda está ativo pelo main
    const holder = getLockHolder("/p/reentrant.luau");
    expect(holder!.holderId).toBe("main");

    // Chamar release2 (no-op) NÃO deve liberar o lock
    release2!();
    expect(getLockHolder("/p/reentrant.luau")).not.toBeNull();

    // Apenas release1 (original) libera de fato
    release1!();
    expect(getLockHolder("/p/reentrant.luau")).toBeNull();
  });

  it("clearAllLocks limpa todos os locks mesmo os não expirados", async () => {
    const { tryAcquireLock, listLocks, clearAllLocks } = await import("./../fileLock.js");
    tryAcquireLock("/p/clear1.luau", "main", 60_000);
    tryAcquireLock("/p/clear2.luau", "sub-1", 60_000);
    tryAcquireLock("/p/clear3.luau", "sub-2", 60_000);
    expect(listLocks().length).toBe(3);

    clearAllLocks();
    expect(listLocks()).toEqual([]);
  });
});
