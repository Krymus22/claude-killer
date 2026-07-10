/**
 * multiFileEdit.ts - Edit multiple files in one atomic operation with rollback.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { applyEdits, type EditOperation } from "./fileEdit.js";
import { saveBackup } from "./rollbackStore.js";
import * as log from "./logger.js";

export interface FileEditRequest {
  filePath: string;
  edits: EditOperation[];
  createIfMissing?: boolean;
}

export interface MultiEditResult {
  success: boolean;
  filesEdited: string[];
  errors: Array<{ file: string; error: string }>;
  rolledBack: boolean;
}

interface PreparedEdit {
  resolved: string;
  original: string;
  result: ReturnType<typeof applyEdits>;
  /** True iff the file existed on disk BEFORE this multi-edit (false for createIfMissing creates). */
  existedBefore: boolean;
}

/**
 * In-memory record used by the failure-rollback path (`rollbackEdits`).
 * `existedBefore` distinguishes "restore original content" from "delete the
 * newly-created file" — both are required to preserve atomicity.
 */
interface BackupEntry {
  path: string;
  original: string;
  existedBefore: boolean;
}

function resolveFilePath(filePath: string, createIfMissing: boolean): string | null {
  const resolved = path.resolve(filePath);
  if (fs.existsSync(resolved)) return resolved;
  if (createIfMissing) return resolved;
  return null;
}

function prepareEdits(
  requests: FileEditRequest[],
  errors: Array<{ file: string; error: string }>
): PreparedEdit[] {
  const preparedEdits: PreparedEdit[] = [];

  for (const req of requests) {
    const resolved = resolveFilePath(req.filePath, !!req.createIfMissing);
    if (!resolved) {
      errors.push({ file: req.filePath, error: "File not found" });
      continue;
    }

    // Capture existence BEFORE reading so we can later distinguish
    // "restore original" from "delete newly-created file" during rollback.
    // (BUG FIX HIGH 2.)
    const existedBefore = fs.existsSync(resolved);
    const content = existedBefore ? fs.readFileSync(resolved, "utf8") : "";
    const result = applyEdits(content, req.edits);
    preparedEdits.push({ resolved, original: content, result, existedBefore });

    if (!result.success) {
      errors.push({ file: req.filePath, error: result.error ?? "Edit failed" });
    }
  }

  return preparedEdits;
}

function applyAllEdits(preparedEdits: PreparedEdit[]): string[] {
  const edited: string[] = [];

  for (const prepared of preparedEdits) {
    const dir = path.dirname(prepared.resolved);
    // SECURITY: mode 0o700 on parent dir + 0o600 on file (CWE-377).
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(prepared.resolved, prepared.result.content, { encoding: "utf8", mode: 0o600 });
    edited.push(prepared.resolved);
  }

  return edited;
}

function rollbackEdits(backups: BackupEntry[]): void {
  for (const backup of backups) {
    try {
      if (backup.existedBefore) {
        // File existed before the multi-edit: restore its original content.
        // SECURITY: mode 0o600 — restrictive perms on restored file (CWE-377).
        fs.writeFileSync(backup.path, backup.original, { encoding: "utf8", mode: 0o600 });
      } else {
        // File was newly created by this multi-edit (createIfMissing:true).
        // To preserve the atomicity promise ("all changes are rolled back"),
        // DELETE the file — leaving an empty file behind would still be a
        // partial write, not a true rollback to the pre-edit state.
        // (BUG FIX HIGH 2: previously newly-created files were left on disk.)
        fs.unlinkSync(backup.path);
      }
    } catch (err) {
      log.error(`Rollback failed for ${backup.path}: ${(err as Error).message}`);
    }
  }
}

/**
 * Edit multiple files atomically. If any edit fails, all changes are rolled back.
 */
export { applyAllEdits };

export function multiFileEdit(requests: FileEditRequest[]): MultiEditResult {
  log.toolCall("editar_multi_arquivos", { count: requests.length });

  const errors: Array<{ file: string; error: string }> = [];
  const preparedEdits = prepareEdits(requests, errors);

  if (errors.length > 0) {
    return { success: false, filesEdited: [], errors, rolledBack: false };
  }

  const backups: BackupEntry[] = [];
  try {
    const edited = applyAllEditsWithBackup(preparedEdits, backups);
    log.toolResult("editar_multi_arquivos", true, `${edited.length} files`);
    return { success: true, filesEdited: edited, errors: [], rolledBack: false };
  } catch (err) {
    rollbackEdits(backups);
    log.toolResult("editar_multi_arquivos", false, "rollback");
    return {
      success: false,
      filesEdited: [],
      errors: [{ file: "system", error: (err as Error).message }],
      rolledBack: true,
    };
  }
}

function applyAllEditsWithBackup(
  preparedEdits: PreparedEdit[],
  backups: BackupEntry[]
): string[] {
  const edited: string[] = [];
  for (const prepared of preparedEdits) {
    // Track EVERY file we touch (existing OR newly-created) so the
    // failure-rollback path can either restore the original content OR
    // delete a new file to preserve the atomicity promise.
    // (BUG FIX HIGH 2: previously only existing files were tracked, so
    // newly-created files were left on disk after a rolled-back edit.)
    backups.push({
      path: prepared.resolved,
      original: prepared.original,
      existedBefore: prepared.existedBefore,
    });

    // --- Rollback store backup (ALWAYS saved when the file existed) --------
    // Mirrors the pattern in fileEdit.ts (lines 314-331) and tools.ts
    // aplicarDiff: snapshot the original content into .rollback/ BEFORE the
    // write so `desfazer_edicao` can later undo this edit. Newly-created
    // files have nothing to snapshot (saveBackup also guards internally).
    // (BUG FIX HIGH 1: previously `editar_multi_arquivos` never saved a
    // rollback-store backup, so desfazer_edicao couldn't undo multi-edits.)
    if (prepared.existedBefore) {
      try {
        saveBackup(prepared.resolved, prepared.original, "editar_multi_arquivos");
      } catch (err) {
        // Don't block the write — but log so the user knows desfazer_edicao
        // won't be available for this particular file.
        log.warn(`multiFileEdit: rollback backup failed for ${prepared.resolved}: ${(err as Error).message}`);
      }
    }

    const dir = path.dirname(prepared.resolved);
    // SECURITY: mode 0o700 on parent dir + 0o600 on file (CWE-377).
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(prepared.resolved, prepared.result.content, { encoding: "utf8", mode: 0o600 });
    edited.push(prepared.resolved);
  }
  return edited;
}

/**
 * Edit multiple files atomically, acquiring per-file locks BEFORE any edit.
 *
 * BUG FIX (concurrency race): previously, `editar_multi_arquivos` called
 * the sync `multiFileEdit` directly — which does NOT acquire file locks.
 * When two agents (main + sub-agent, or two parallel tool calls) tried to
 * edit overlapping files at the same time, the read-modify-write sequence
 * in `prepareEdits` → `applyAllEditsWithBackup` raced:
 *
 *   Agent A: reads file X (content="v1")
 *   Agent B: reads file X (content="v1")     ← same snapshot
 *   Agent A: writes file X (content="v2")    ← A's edit applied
 *   Agent B: writes file X (content="v2'")   ← B's edit applied on STALE
 *                                              "v1", overwriting A's change
 *
 * The single-file `editar_arquivo` already acquires a per-file lock via
 * fileLock.ts (see fileEdit.ts). This wrapper extends the same protection
 * to multi-file edits.
 *
 * Lock acquisition order: files are sorted by resolved path (ascending)
 * before locking. This prevents deadlocks when two concurrent calls have
 * overlapping file sets — both calls lock files in the same order, so
 * one waits for the other instead of acquiring locks in opposite orders.
 *
 * If any lock cannot be acquired (timeout), the operation fails WITHOUT
 * editing any file, and all already-acquired locks are released. The
 * caller (IA) sees a clear "file_lock_failed" error and can retry.
 *
 * @returns same MultiEditResult shape as multiFileEdit, with a
 *          `file_lock_failed: ...` message in `errors` when a lock couldn't
 *          be acquired.
 *
 * Options for multiFileEditWithLocks.
 *
 * Exposed primarily for tests that need to shorten the lock-acquire timeout
 * (the default 60s makes lock-contention tests impractical). Production
 * callers should omit `acquireTimeoutMs` to use the safe default.
 */
export interface MultiFileEditWithLocksOptions {
  /** Max ms to wait for any single file lock before failing the operation. */
  acquireTimeoutMs?: number;
  /** TTL for each acquired lock (auto-release if the holder crashes). */
  ttlMs?: number;
  /** Override the holder ID (defaults to getCurrentAgentId()). */
  holderId?: string;
}

export async function multiFileEditWithLocks(
  requests: FileEditRequest[],
  optionsOrHolderId?: MultiFileEditWithLocksOptions | string,
): Promise<MultiEditResult> {
  // Backwards-compatible overload: accept a plain string as the holder ID.
  const opts: MultiFileEditWithLocksOptions =
    typeof optionsOrHolderId === "string"
      ? { holderId: optionsOrHolderId }
      : (optionsOrHolderId ?? {});
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 60_000;
  const ttlMs = opts.ttlMs ?? 30_000;
  // De-duplicate file paths so we don't try to lock the same file twice
  // (which would deadlock the same holder against itself with the current
  // fileLock semantics — re-entrant same-holder returns a no-op release,
  // but it's cleaner to just dedupe here).
  const uniquePaths: string[] = [];
  const seen = new Set<string>();
  for (const req of requests) {
    if (typeof req.filePath !== "string" || req.filePath === "") continue;
    const resolved = path.resolve(req.filePath);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      uniquePaths.push(resolved);
    }
  }
  // Sort by path to acquire locks in a deterministic order — prevents
  // deadlocks between two concurrent calls with overlapping file sets.
  uniquePaths.sort();

  const { acquireLock, getCurrentAgentId } = await import("./fileLock.js");
  const id = opts.holderId ?? getCurrentAgentId();
  const releases: Array<() => void> = [];

  try {
    for (const p of uniquePaths) {
      try {
        const release = await acquireLock(p, id, ttlMs, acquireTimeoutMs);
        releases.push(release);
      } catch (err) {
        // Could not acquire a lock for this file — fail the whole operation
        // WITHOUT touching any file. Release already-acquired locks and
        // return a lock-failed error so the IA can retry.
        const message = (err as Error).message ?? String(err);
        log.warn(`multiFileEditWithLocks: could not acquire lock for ${p}: ${message}`);
        return {
          success: false,
          filesEdited: [],
          errors: [{ file: p, error: `file_lock_failed: ${message}` }],
          rolledBack: false,
        };
      }
    }
    // All locks acquired — perform the atomic multi-file edit.
    return multiFileEdit(requests);
  } finally {
    // Release locks in reverse acquisition order (LIFO) — matches typical
    // lock-release patterns and keeps the critical section minimal.
    for (let i = releases.length - 1; i >= 0; i--) {
      try { releases[i]!(); } catch { /* defensive */ }
    }
  }
}
