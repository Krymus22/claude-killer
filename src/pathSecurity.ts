/**
 * pathSecurity.ts — Shared path-traversal defense utilities.
 *
 * Used by scoutAgent.ts (scout sub-agent), subAgents.ts (read-only and
 * powerful sub-agents), and smallTaskAgent.ts (small task agent) to ensure
 * every model-driven path operation stays inside the project directory.
 *
 * WHY THIS EXISTS (BH9 / FIX-SCOUT):
 *   Before this module, `resolveAndCheckPath` was duplicated in
 *   scoutAgent.ts:210-237 and smallTaskAgent.ts:216-248, while
 *   subAgents.ts had NO path-traversal protection at all — its
 *   `executeSubAgentTool` used `args.caminho?.startsWith("/") ? args.caminho
 *   : \`${cwd}/${args.caminho}\``, which allowed absolute paths AND `../`
 *   escape. A sub-agent could read /etc/passwd or ~/.ssh/id_rsa.
 *
 *   This module extracts the canonical implementation so all three
 *   sub-agent entry points share the same hard boundary.
 *
 * SPEC: BUSINESS_RULES.md §10.7 ("Path traversal blocking: resolveAndCheckPath
 * usa path.relative() + fs.realpathSync() para bloquear ../, paths absolutos
 * fora do projeto, e symlinks").
 */

import * as nodePath from "node:path";
import * as nodeFs from "node:fs";

/**
 * Resolve a path relative to `cwd` and enforce a boundary check so the
 * caller cannot read files outside `cwd` (defense-in-depth against path
 * traversal: `../../../etc/passwd`, absolute paths, symlinks, etc).
 *
 * Algorithm:
 *   1. Resolve the raw path against cwd.
 *   2. Use `path.relative()` to check if the resolved path is within cwd.
 *      If the relative path starts with `..` or is absolute, the path
 *      escapes cwd → throw.
 *   3. BUG FIX (round 3 - symlink escape): use `fs.realpathSync()` to
 *      resolve symlinks BEFORE checking the boundary. Without this, a
 *      symlink inside the project pointing to `/etc/passwd` would bypass
 *      the lexical check.
 *
 * @param rawPath The path to resolve (may be relative or absolute).
 * @param cwd The base directory to resolve against (must already be validated).
 * @returns The resolved real path (symlinks followed).
 * @throws Error if the path (or its symlink target) escapes `cwd`.
 */
export function resolveAndCheckPath(rawPath: string, cwd: string): string {
  const resolved = nodePath.resolve(cwd, rawPath);
  const normalizedCwd = nodePath.resolve(cwd);
  // Use path.relative to robustly check if resolved is within cwd.
  const relative = nodePath.relative(normalizedCwd, resolved);
  if (relative.startsWith("..") || nodePath.isAbsolute(relative)) {
    throw new Error(`Path traversal blocked: "${rawPath}" resolves outside project directory (${resolved})`);
  }
  // BUG FIX (symlink-escape): resolve symlinks with realpath and re-check.
  // A symlink inside the project could point to /etc/passwd — realpath
  // follows it and we verify the REAL target is still within cwd.
  try {
    const realPath = nodeFs.realpathSync(resolved);
    const realRelative = nodePath.relative(normalizedCwd, realPath);
    if (realRelative.startsWith("..") || nodePath.isAbsolute(realRelative)) {
      throw new Error(`Symlink escape blocked: "${rawPath}" resolves to "${realPath}" (outside project)`);
    }
    return realPath;
  } catch (err) {
    // If realpath fails (file doesn't exist), re-throw path traversal errors
    // but let other errors (ENOENT) pass through to the tool executor.
    if (err instanceof Error && err.message.includes("blocked")) {
      throw err;
    }
    // File doesn't exist yet — return the resolved path (tool will handle ENOENT)
    return resolved;
  }
}

/**
 * Validate that a caller-supplied `cwd` is within the project root
 * (`process.cwd()`). Used by `runSubAgent` and `runScout` to prevent a
 * prompt-injected model from passing `cwd: "/etc"` and then reading any
 * file under `/etc` via relative paths.
 *
 * @param rawCwd The caller-supplied cwd. If `undefined`, returns the
 *   `projectRoot` directly (no validation needed).
 * @param projectRoot The project root (typically `process.cwd()`).
 * @returns An object with `ok: true` and the resolved cwd on success,
 *   or `ok: false` with an `error` message on failure.
 */
export function validateCwd(
  rawCwd: string | undefined,
  projectRoot: string,
): { ok: true; cwd: string } | { ok: false; error: string } {
  if (rawCwd === undefined) {
    return { ok: true, cwd: nodePath.resolve(projectRoot) };
  }
  const resolvedCwd = nodePath.resolve(rawCwd);
  const relative = nodePath.relative(projectRoot, resolvedCwd);
  if (relative.startsWith("..") || nodePath.isAbsolute(relative)) {
    return {
      ok: false,
      error: `cwd "${rawCwd}" is outside project directory (${projectRoot})`,
    };
  }
  return { ok: true, cwd: resolvedCwd };
}
