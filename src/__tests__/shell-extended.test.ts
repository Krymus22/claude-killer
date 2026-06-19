/**
 * shell-extended.test.ts - Expansão de cobertura de src/shell.ts.
 *
 * Foca em cenários não cobertos por shell.test.ts (que roda comandos reais):
 *   - runShell: erro com exit code não-zero (stderr capturada), timeout
 *     (killed=true), stdout/stderr truncados quando excedem maxOutputBytes,
 *     unicode no output
 *   - runShellSync: erro de execução (com stderr), timeout (killed=true),
 *     stdout truncada
 *   - executar_comando (logging via runShell/runShellSync): toolCall e
 *     toolResult são chamados com os args certos
 *   - Edge cases: comando vazio (não deve crashar o módulo), cwd inválido
 *     (deve ser passado adiante ao exec), env customizado mesclado com
 *     process.env, stdout/stderr muito grande (truncamento)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// --- Mocks controláveis de child_process ------------------------------------
// Usamos vi.hoisted para que os mocks estejam disponíveis antes do import
// do módulo shell.ts, que captura exec/execSync no topo do arquivo.

const { execMock, execSyncMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  exec: execMock,
  execSync: execSyncMock,
}));

vi.mock("node:util", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    // promisify(exec) precisa retornar uma função que retorna Promise
    promisify: (fn: any) => (...args: any[]) =>
      new Promise((resolve, reject) => fn(...args, (err: any, stdout: string, stderr: string) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      })),
  };
});

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  toolCall: vi.fn(),
  toolResult: vi.fn(),
}));

describe("shell (extended) - runShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    execMock.mockReset();
    execSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retorna sucesso quando exec resolve com stdout/stderr", async () => {
    execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => {
      cb(null, "ok-output", "");
    });
    const { runShell } = await import("../shell.js");
    const result = await runShell({ command: "echo ok" });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("ok-output");
    expect(result.stderr).toBe("");
  });

  it("captura exit code não-zero e stderr quando exec falha", async () => {
    const err: any = new Error("Command failed");
    err.status = 42;
    err.killed = false;
    err.code = undefined;
    err.stdout = "partial-out";
    err.stderr = "err-msg";
    execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => cb(err, "partial-out", "err-msg"));
    const { runShell } = await import("../shell.js");
    const result = await runShell({ command: "false" });
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("partial-out");
    expect(result.stderr).toBe("err-msg");
  });

  it("marca timedOut=true quando err.killed === true", async () => {
    const err: any = new Error("Timeout");
    err.killed = true;
    err.code = "ETIMEDOUT";
    err.status = null;
    err.stdout = "";
    err.stderr = "";
    execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => cb(err, "", ""));
    const { runShell } = await import("../shell.js");
    const result = await runShell({ command: "sleep 100", timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1); // fallback quando status é null
  });

  it("marca timedOut=true quando err.code === 'ETIMEDOUT' (sem killed)", async () => {
    const err: any = new Error("Timeout");
    err.killed = false;
    err.code = "ETIMEDOUT";
    err.status = 1;
    err.stdout = "";
    err.stderr = "";
    execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => cb(err, "", ""));
    const { runShell } = await import("../shell.js");
    const result = await runShell({ command: "sleep 100" });
    expect(result.timedOut).toBe(true);
  });

  it("trunca stdout quando excede maxOutputBytes", async () => {
    const big = "x".repeat(2048);
    execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => cb(null, big, ""));
    const { runShell } = await import("../shell.js");
    const result = await runShell({ command: "yes", maxOutputBytes: 100 });
    // trimStdout: se > maxBytes, slice + "\n...[TRUNCATED]"
    expect(result.stdout).toContain("...[TRUNCATED]");
    expect(result.stdout.length).toBeLessThan(big.length);
  });

  it("trunca stderr quando excede maxOutputBytes", async () => {
    const bigErr = "e".repeat(2048);
    const err: any = new Error("fail");
    err.status = 1;
    err.killed = false;
    err.stdout = "";
    err.stderr = bigErr;
    execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => cb(err, "", bigErr));
    const { runShell } = await import("../shell.js");
    const result = await runShell({ command: "fail", maxOutputBytes: 100 });
    // stderr é truncada via String(err.stderr).slice(0, maxBytes)
    expect(result.stderr.length).toBeLessThanOrEqual(100);
  });

  it("preserva unicode no stdout/stderr", async () => {
    execMock.mockImplementation((_cmd: string, _opts: any, cb: any) =>
      cb(null, "olá ☕ café 日本語", "erro: ñ válido ⚠")
    );
    const { runShell } = await import("../shell.js");
    const result = await runShell({ command: "unicode" });
    expect(result.stdout).toContain("olá ☕ café 日本語");
    expect(result.stderr).toContain("⚠");
  });

  it("passa cwd e env customizados para exec (mesclando com process.env)", async () => {
    let capturedOpts: any = null;
    execMock.mockImplementation((_cmd: string, opts: any, cb: any) => {
      capturedOpts = opts;
      cb(null, "out", "");
    });
    const { runShell } = await import("../shell.js");
    await runShell({ command: "ls", cwd: "/tmp", env: { FOO: "bar" } });
    expect(capturedOpts.cwd).toBe("/tmp");
    expect(capturedOpts.env.FOO).toBe("bar");
    // Deve preservar PATH do process.env
    expect(capturedOpts.env.PATH).toBe(process.env.PATH);
  });
});

describe("shell (extended) - runShellSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    execSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retorna sucesso quando execSync retorna stdout", async () => {
    execSyncMock.mockReturnValue("sync-out");
    const { runShellSync } = await import("../shell.js");
    const result = runShellSync({ command: "echo sync" });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("sync-out");
    expect(result.stderr).toBe("");
  });

  it("captura erro de execução com stdout/stderr e exit code", async () => {
    const err: any = new Error("Command failed");
    err.status = 7;
    err.killed = false;
    err.stdout = "sync-stdout-partial";
    err.stderr = "sync-stderr-partial";
    execSyncMock.mockImplementation(() => { throw err; });
    const { runShellSync } = await import("../shell.js");
    const result = runShellSync({ command: "fail-sync" });
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("sync-stdout-partial");
    expect(result.stderr).toBe("sync-stderr-partial");
  });

  it("marca timedOut=true quando err.killed === true", async () => {
    const err: any = new Error("Timeout");
    err.killed = true;
    err.status = null;
    err.stdout = "";
    err.stderr = "";
    execSyncMock.mockImplementation(() => { throw err; });
    const { runShellSync } = await import("../shell.js");
    const result = runShellSync({ command: "sleep 100", timeoutMs: 10 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1); // fallback
  });

  it("trunca stdout do sync quando excede maxOutputBytes", async () => {
    const err: any = new Error("fail");
    err.status = 1;
    err.killed = false;
    err.stdout = "y".repeat(2048);
    err.stderr = "";
    execSyncMock.mockImplementation(() => { throw err; });
    const { runShellSync } = await import("../shell.js");
    const result = runShellSync({ command: "fail", maxOutputBytes: 50 });
    expect(result.stdout.length).toBeLessThanOrEqual(50);
  });
});

describe("shell (extended) - logging (executar_comando)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    execMock.mockReset();
    execSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("chama log.toolCall antes e log.toolResult depois em runShell sucesso", async () => {
    execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => cb(null, "out", ""));
    const log = await import("../logger.js");
    const { runShell } = await import("../shell.js");
    await runShell({ command: "echo test", cwd: "/tmp" });
    expect(log.toolCall).toHaveBeenCalledWith(
      "executar_comando",
      expect.objectContaining({ comando: "echo test", cwd: "/tmp" })
    );
    expect(log.toolResult).toHaveBeenCalledWith("executar_comando", true, expect.stringContaining("exit=0"));
  });

  it("chama log.toolResult com false quando runShell falha", async () => {
    const err: any = new Error("fail");
    err.status = 5;
    err.killed = false;
    err.stdout = "";
    err.stderr = "err";
    execMock.mockImplementation((_cmd: string, _opts: any, cb: any) => cb(err, "", "err"));
    const log = await import("../logger.js");
    const { runShell } = await import("../shell.js");
    await runShell({ command: "false" });
    expect(log.toolResult).toHaveBeenCalledWith(
      "executar_comando",
      false,
      expect.stringContaining("exit=5")
    );
  });

  it("chama log.toolResult com false em runShellSync erro", async () => {
    const err: any = new Error("fail");
    err.status = 3;
    err.killed = false;
    err.stdout = "";
    err.stderr = "";
    execSyncMock.mockImplementation(() => { throw err; });
    const log = await import("../logger.js");
    const { runShellSync } = await import("../shell.js");
    runShellSync({ command: "false" });
    expect(log.toolResult).toHaveBeenCalledWith("executar_comando", false, expect.stringContaining("exit=3"));
  });
});
