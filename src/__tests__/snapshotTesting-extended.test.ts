/**
 * snapshotTesting-extended.test.ts — Expandindo cobertura do snapshotTesting.
 *
 * O módulo snapshotTesting captura output de funções puras antes/depois de
 * edições, para detectar regressões silenciosas. Este arquivo expande a
 * cobertura das funções captureBeforeSnapshot, captureAfterSnapshot,
 * getSnapshots, clearSnapshots e hasBeforeSnapshot, incluindo:
 *   - Criação de snapshots para arquivos JS/TS
 *   - Comparação de output antes/depois
 *   - Tratamento de erros (spawn failure, __SNAPSHOT_ERROR__)
 *   - Metadados (timestamp, functionName, filePath, inputs)
 *   - Serialização JSON round-trip
 *   - Paths unicode
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

// Estado controlável compartilhado entre o mock de spawn e os testes.
// vi.hoisted garante que o estado existe antes do factory do mock rodar.
const snapState = vi.hoisted(() => ({
  stdout: "",
  error: false,
  spawnThrows: false,
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    // Throw sincrono simula ENOENT (binary não encontrado) — pego pelo catch
    if (snapState.spawnThrows) {
      throw new Error("spawn ENOENT: node binary not found");
    }
    const dataListeners: Array<(d: Buffer) => void> = [];
    const closeListeners: Array<() => void> = [];
    const errorListeners: Array<(e: Error) => void> = [];

    const child: any = {
      stdout: {
        on: (ev: string, cb: any) => {
          if (ev === "data") dataListeners.push(cb);
        },
      },
      stderr: { on: () => {} },
      on: (ev: string, cb: any) => {
        if (ev === "close") closeListeners.push(cb);
        if (ev === "error") errorListeners.push(cb);
      },
    };

    // Emite eventos no próximo tick (após listeners serem registrados)
    process.nextTick(() => {
      if (snapState.error) {
        errorListeners.forEach((cb) => cb(new Error("spawn ENOENT")));
      } else {
        if (snapState.stdout) {
          dataListeners.forEach((cb) => cb(Buffer.from(snapState.stdout)));
        }
        closeListeners.forEach((cb) => cb());
      }
    });

    return child;
  }),
}));

describe("snapshotTesting — cobertura estendida", () => {
  beforeEach(async () => {
    snapState.stdout = "";
    snapState.error = false;
    snapState.spawnThrows = false;
    vi.clearAllMocks();
    const { clearSnapshots } = await import("./../snapshotTesting.js");
    clearSnapshots();
  });

  // --- createSnapshot (captureBeforeSnapshot) ---

  it("createSnapshot cria snapshot de arquivo JS/TS válido", async () => {
    snapState.stdout = "hello-result";
    const { captureBeforeSnapshot, hasBeforeSnapshot } = await import(
      "./../snapshotTesting.js"
    );
    const result = await captureBeforeSnapshot("foo", "/tmp/test.ts", "[]");
    expect(result.captured).toBe(true);
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot!.outputBefore).toBe("hello-result");
    expect(result.snapshot!.functionName).toBe("foo");
    expect(result.snapshot!.filePath).toBe("/tmp/test.ts");
    expect(result.snapshot!.timestamp).toBeGreaterThan(0);
    expect(hasBeforeSnapshot("foo", "/tmp/test.ts")).toBe(true);
  });

  it("createSnapshot lida com arquivo inexistente gracefully (spawn throw sincrono)", async () => {
    // spawn throws sincronamente → pego pelo catch em tryRunFunction → retorna null
    snapState.spawnThrows = true;
    const { captureBeforeSnapshot, hasBeforeSnapshot } = await import(
      "./../snapshotTesting.js"
    );
    const result = await captureBeforeSnapshot("foo", "/tmp/missing.ts", "[]");
    expect(result.captured).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(result.message).toContain("Could not run");
    expect(hasBeforeSnapshot("foo", "/tmp/missing.ts")).toBe(false);
  });

  it("createSnapshot rejeita extensões não-suportadas (.luau) sem chamar spawn", async () => {
    const { captureBeforeSnapshot } = await import("./../snapshotTesting.js");
    const result = await captureBeforeSnapshot("foo", "/tmp/test.luau", "[]");
    expect(result.captured).toBe(false);
    expect(result.message).toContain("Could not run");
  });

  it("createSnapshot rejeita extensão .py (requer runtime Python)", async () => {
    const { captureBeforeSnapshot } = await import("./../snapshotTesting.js");
    const result = await captureBeforeSnapshot("foo", "/tmp/test.py", "[]");
    expect(result.captured).toBe(false);
  });

  it("createSnapshot trata erro do Node (__SNAPSHOT_ERROR__) como não-capturado", async () => {
    snapState.stdout = "__SNAPSHOT_ERROR__: function not found";
    const { captureBeforeSnapshot } = await import("./../snapshotTesting.js");
    const result = await captureBeforeSnapshot("foo", "/tmp/test.ts", "[]");
    expect(result.captured).toBe(false);
    expect(result.snapshot).toBeNull();
  });

  it("createSnapshot lida com binary files gracefully (erro de syntax)", async () => {
    snapState.stdout = "__SNAPSHOT_ERROR__: SyntaxError: Unexpected token";
    const { captureBeforeSnapshot } = await import("./../snapshotTesting.js");
    const result = await captureBeforeSnapshot("foo", "/tmp/binary.ts", "[]");
    expect(result.captured).toBe(false);
    expect(result.message).toContain("Could not run");
  });

  it("createSnapshot retorna 'undefined' como output quando stdout é vazio", async () => {
    snapState.stdout = "";
    const { captureBeforeSnapshot } = await import("./../snapshotTesting.js");
    const result = await captureBeforeSnapshot("foo", "/tmp/test.ts", "[]");
    // stdout vazio → módulo retorna "undefined" (string)
    expect(result.captured).toBe(true);
    expect(result.snapshot!.outputBefore).toBe("undefined");
  });

  // --- compareSnapshots (captureAfterSnapshot) ---

  it("compareSnapshots detecta modificação (output diferente → matched=false)", async () => {
    snapState.stdout = "before-output";
    const { captureBeforeSnapshot, captureAfterSnapshot } = await import(
      "./../snapshotTesting.js"
    );
    await captureBeforeSnapshot("foo", "/tmp/test.ts", "[]");
    snapState.stdout = "after-output-modified";
    const result = await captureAfterSnapshot("foo", "/tmp/test.ts");
    expect(result.captured).toBe(true);
    expect(result.snapshot!.matched).toBe(false);
    expect(result.snapshot!.outputAfter).toBe("after-output-modified");
    expect(result.snapshot!.outputBefore).toBe("before-output");
    expect(result.message).toContain("CHANGED");
  });

  it("compareSnapshots detecta que output não mudou (matched=true)", async () => {
    snapState.stdout = "stable-output";
    const { captureBeforeSnapshot, captureAfterSnapshot } = await import(
      "./../snapshotTesting.js"
    );
    await captureBeforeSnapshot("foo", "/tmp/test.ts", "[]");
    const result = await captureAfterSnapshot("foo", "/tmp/test.ts");
    expect(result.captured).toBe(true);
    expect(result.snapshot!.matched).toBe(true);
    expect(result.snapshot!.outputAfter).toBe("stable-output");
    expect(result.message).toContain("OK");
  });

  it("compareSnapshots retorna vazio quando não há before-snapshot", async () => {
    const { captureAfterSnapshot } = await import("./../snapshotTesting.js");
    const result = await captureAfterSnapshot("missing", "/tmp/test.ts");
    expect(result.captured).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(result.message).toContain("No before-snapshot");
  });

  it("compareSnapshots lida com falha de execução após edição (__SNAPSHOT_ERROR__)", async () => {
    snapState.stdout = "before";
    const { captureBeforeSnapshot, captureAfterSnapshot } = await import(
      "./../snapshotTesting.js"
    );
    await captureBeforeSnapshot("foo", "/tmp/test.ts", "[]");
    // Simula erro de execução após edição (ex: function foi deletada)
    snapState.stdout = "__SNAPSHOT_ERROR__: function foo not found";
    const result = await captureAfterSnapshot("foo", "/tmp/test.ts");
    expect(result.captured).toBe(false);
    expect(result.snapshot).not.toBeNull();
    expect(result.message).toContain("Could not run");
  });

  // --- Metadados e serialização ---

  it("Snapshot inclui metadados (functionName, filePath, inputs, timestamp)", async () => {
    snapState.stdout = "result-data";
    const { captureBeforeSnapshot, getSnapshots } = await import(
      "./../snapshotTesting.js"
    );
    await captureBeforeSnapshot("myFunc", "/tmp/path.ts", "[1,2]");
    const snaps = getSnapshots();
    expect(snaps.length).toBe(1);
    expect(snaps[0]!.functionName).toBe("myFunc");
    expect(snaps[0]!.filePath).toBe("/tmp/path.ts");
    expect(snaps[0]!.inputs).toBe("[1,2]");
    expect(snaps[0]!.outputBefore).toBe("result-data");
    expect(snaps[0]!.outputAfter).toBeNull();
    expect(snaps[0]!.matched).toBeNull();
    expect(snaps[0]!.timestamp).toBeGreaterThan(0);
  });

  it("Snapshot suporta serialização/deserialização JSON (round-trip)", async () => {
    snapState.stdout = "serial-output";
    const { captureBeforeSnapshot, getSnapshots } = await import(
      "./../snapshotTesting.js"
    );
    await captureBeforeSnapshot("fn", "/tmp/test.ts", "[42]");
    const snap = getSnapshots()[0]!;
    const json = JSON.stringify(snap);
    const restored = JSON.parse(json) as typeof snap;
    expect(restored.functionName).toBe(snap.functionName);
    expect(restored.filePath).toBe(snap.filePath);
    expect(restored.inputs).toBe(snap.inputs);
    expect(restored.outputBefore).toBe(snap.outputBefore);
    expect(restored.outputAfter).toBe(snap.outputAfter);
    expect(restored.matched).toBe(snap.matched);
    expect(restored.timestamp).toBe(snap.timestamp);
  });

  it("Snapshot lida com paths unicode (caracteres japoneses e acentos)", async () => {
    snapState.stdout = "unicode-ok";
    const { captureBeforeSnapshot, hasBeforeSnapshot, getSnapshots } = await import(
      "./../snapshotTesting.js"
    );
    const result = await captureBeforeSnapshot(
      "função",
      "/tmp/テスト/ファイル.ts",
      "[1]"
    );
    expect(result.captured).toBe(true);
    expect(result.snapshot!.functionName).toBe("função");
    expect(result.snapshot!.filePath).toBe("/tmp/テスト/ファイル.ts");
    expect(hasBeforeSnapshot("função", "/tmp/テスト/ファイル.ts")).toBe(true);
    expect(getSnapshots()[0]!.filePath).toBe("/tmp/テスト/ファイル.ts");
  });

  // --- Múltiplos snapshots e chave composta ---

  it("getSnapshots retorna múltiplos snapshots cadastrados", async () => {
    snapState.stdout = "r1";
    const { captureBeforeSnapshot, getSnapshots } = await import(
      "./../snapshotTesting.js"
    );
    await captureBeforeSnapshot("fn1", "/tmp/a.ts", "[]");
    snapState.stdout = "r2";
    await captureBeforeSnapshot("fn2", "/tmp/b.ts", "[]");
    const snaps = getSnapshots();
    expect(snaps.length).toBe(2);
  });

  it("Snapshot distingue por chave composta filePath::functionName", async () => {
    snapState.stdout = "v1";
    const { captureBeforeSnapshot, hasBeforeSnapshot } = await import(
      "./../snapshotTesting.js"
    );
    await captureBeforeSnapshot("fn", "/tmp/a.ts", "[]");
    expect(hasBeforeSnapshot("fn", "/tmp/a.ts")).toBe(true);
    // Mesma função, arquivo diferente → não deve ter snapshot
    expect(hasBeforeSnapshot("fn", "/tmp/b.ts")).toBe(false);
    // Função diferente, mesmo arquivo → não deve ter snapshot
    expect(hasBeforeSnapshot("other", "/tmp/a.ts")).toBe(false);
  });

  it("hasBeforeSnapshot retorna false antes de capturar, true depois", async () => {
    snapState.stdout = "x";
    const { captureBeforeSnapshot, hasBeforeSnapshot } = await import(
      "./../snapshotTesting.js"
    );
    expect(hasBeforeSnapshot("fn", "/tmp/x.ts")).toBe(false);
    await captureBeforeSnapshot("fn", "/tmp/x.ts", "[]");
    expect(hasBeforeSnapshot("fn", "/tmp/x.ts")).toBe(true);
  });

  it("clearSnapshots limpa todos os snapshots registrados", async () => {
    snapState.stdout = "x";
    const {
      captureBeforeSnapshot,
      clearSnapshots,
      getSnapshots,
      hasBeforeSnapshot,
    } = await import("./../snapshotTesting.js");
    await captureBeforeSnapshot("fn1", "/tmp/a.ts", "[]");
    snapState.stdout = "y";
    await captureBeforeSnapshot("fn2", "/tmp/b.ts", "[]");
    expect(getSnapshots().length).toBe(2);
    clearSnapshots();
    expect(getSnapshots().length).toBe(0);
    expect(hasBeforeSnapshot("fn1", "/tmp/a.ts")).toBe(false);
    expect(hasBeforeSnapshot("fn2", "/tmp/b.ts")).toBe(false);
  });

  it("captureAfterSnapshot atualiza outputAfter e matched no snapshot original", async () => {
    snapState.stdout = "original";
    const { captureBeforeSnapshot, captureAfterSnapshot, getSnapshots } = await import(
      "./../snapshotTesting.js"
    );
    await captureBeforeSnapshot("fn", "/tmp/test.ts", "[]");
    const beforeSnap = getSnapshots()[0]!;
    expect(beforeSnap.outputAfter).toBeNull();
    expect(beforeSnap.matched).toBeNull();

    snapState.stdout = "original"; // mesmo output → matched=true
    await captureAfterSnapshot("fn", "/tmp/test.ts");
    const afterSnap = getSnapshots()[0]!;
    expect(afterSnap.outputAfter).toBe("original");
    expect(afterSnap.matched).toBe(true);
    // Deve ser o mesmo objeto (mutado in-place)
    expect(afterSnap).toBe(beforeSnap);
  });
});
