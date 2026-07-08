/**
 * shell.ts - Shell/Bash execution tool with timeout, cwd, and output limits.
 */

import { execSync, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import * as log from "./logger.js";

const execAsync = promisify(execCb);

export interface ShellOptions {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 512 * 1024; // 512 KB
const MIN_TIMEOUT_MS = 1; // 0 / negative would fire setTimeout immediately

export async function runShell(opts: ShellOptions): Promise<ShellResult> {
  // Validate command — empty/null/non-string would throw TypeError inside
  // execAsync (synchronously, before the promise can be constructed in some
  // Node versions). Bug Hunter #9.
  if (opts == null || typeof opts.command !== "string" || opts.command.trim() === "") {
    log.toolResult("executar_comando", false, "invalid command");
    return {
      stdout: "",
      stderr: "command is required (empty or non-string)",
      exitCode: 1,
      timedOut: false,
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  // Clamp timeout: 0/negative/non-finite would kill the child before it
  // starts. Fall back to default. Bug Hunter #9.
  let timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeout !== "number" || !isFinite(timeout) || timeout < MIN_TIMEOUT_MS) {
    timeout = DEFAULT_TIMEOUT_MS;
  }
  // Clamp maxBytes: 0/negative would slice(-1) and corrupt the output,
  // and would also pass maxBuffer:0 to exec which throws. Bug Hunter #9.
  let maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  if (typeof maxBytes !== "number" || !isFinite(maxBytes) || maxBytes < 1) {
    maxBytes = DEFAULT_MAX_OUTPUT;
  }

  log.toolCall("executar_comando", { comando: opts.command, cwd });

  try {
    const { stdout, stderr } = await execAsync(opts.command, {
      cwd,
      timeout,
      maxBuffer: maxBytes,
      env: { ...process.env, ...opts.env },
      encoding: "utf8",
      shell: process.platform === "win32" ? "powershell.exe" : "/bin/bash",
    });

    const trimStdout = stdout.length > maxBytes ? stdout.slice(0, maxBytes) + "\n...[TRUNCATED]" : stdout;
    const trimStderr = stderr.length > maxBytes ? stderr.slice(0, maxBytes) + "\n...[TRUNCATED]" : stderr;

    log.toolResult("executar_comando", true, `exit=0`);
    return { stdout: trimStdout, stderr: trimStderr, exitCode: 0, timedOut: false };
  } catch (err: any) {
    const timedOut = err.killed === true || err.code === "ETIMEDOUT";
    const stdout = err.stdout ? String(err.stdout).slice(0, maxBytes) : "";
    const stderr = err.stderr ? String(err.stderr).slice(0, maxBytes) : "";
    const exitCode = err.status ?? 1;

    log.toolResult("executar_comando", false, `exit=${exitCode} timedOut=${timedOut}`);
    return { stdout, stderr, exitCode, timedOut };
  }
}

export function runShellSync(opts: ShellOptions): ShellResult {
  // Validate command — same rationale as runShell. Bug Hunter #9.
  if (opts == null || typeof opts.command !== "string" || opts.command.trim() === "") {
    log.toolResult("executar_comando", false, "invalid command");
    return {
      stdout: "",
      stderr: "command is required (empty or non-string)",
      exitCode: 1,
      timedOut: false,
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  let maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  if (typeof maxBytes !== "number" || !isFinite(maxBytes) || maxBytes < 1) {
    maxBytes = DEFAULT_MAX_OUTPUT;
  }
  let timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeout !== "number" || !isFinite(timeout) || timeout < MIN_TIMEOUT_MS) {
    timeout = DEFAULT_TIMEOUT_MS;
  }

  log.toolCall("executar_comando", { comando: opts.command, cwd });

  try {
    const output = execSync(opts.command, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
      maxBuffer: maxBytes,
      env: { ...process.env, ...opts.env },
      shell: process.platform === "win32" ? "powershell.exe" : "/bin/bash",
    });

    log.toolResult("executar_comando", true, "exit=0");
    return { stdout: output, stderr: "", exitCode: 0, timedOut: false };
  } catch (err: any) {
    const timedOut = err.killed === true || err.code === "ETIMEDOUT";
    const stdout = err.stdout ? String(err.stdout).slice(0, maxBytes) : "";
    const stderr = err.stderr ? String(err.stderr).slice(0, maxBytes) : "";
    log.toolResult("executar_comando", false, `exit=${err.status ?? 1}`);
    return { stdout, stderr, exitCode: err.status ?? 1, timedOut };
  }
}
