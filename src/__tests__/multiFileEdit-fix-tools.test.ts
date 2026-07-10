/**
 * multiFileEdit-fix-tools.test.ts — Regression tests for the two HIGH bugs
 * fixed by FIX-TOOLS (BH8 report):
 *
 *   HIGH 1: `editar_multi_arquivos` did NOT call `saveBackup()` from
 *           `rollbackStore.ts`, so `desfazer_edicao` could not undo
 *           multi-file edits.
 *
 *   HIGH 2: Multi-file edit rollback did NOT delete newly-created files
 *           (createIfMissing:true). Atomicity was broken — the new file
 *           stayed on disk after "rollback".
 *
 * Uses a temp project directory + chdir so the rollback store writes to
 * an isolated `.rollback/` and we can assert on `listBackups()` counts
 * without polluting the project's real `.rollback/` dir.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { multiFileEdit, type FileEditRequest } from "../multiFileEdit.js";
import { listBackups, resetRollbackState } from "../rollbackStore.js";

// Reuse the __multifail__ mock pattern from multiFileEdit.test.ts so we can
// deterministically trigger a writeFileSync failure mid-batch (forcing the
// rollback path) without depending on real disk errors.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  const origWrite = actual.writeFileSync;
  return {
    ...actual,
    writeFileSync: (...args: any[]) => {
      if (args[0]?.toString().includes("__fixtools_fail__")) {
        throw new Error("disk error (fix-tools)");
      }
      return origWrite(...args);
    },
  };
});

let tmpProject: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "fixtools_mfe_"));
  // Marker so rollbackStore.findProjectRoot() stops here.
  fs.writeFileSync(path.join(tmpProject, "package.json"), JSON.stringify({ name: "fixtools" }), "utf8");
  process.chdir(tmpProject);
  resetRollbackState();
});

afterAll(() => {
  process.chdir(originalCwd);
  resetRollbackState();
  try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("FIX-TOOLS HIGH 1: editar_multi_arquivos saves rollback store backup", () => {
  it("saves a .rollback/ snapshot for an EXISTING file (so desfazer_edicao can undo it)", () => {
    const filePath = path.join(tmpProject, "existing.ts");
    fs.writeFileSync(filePath, "ORIGINAL\n", "utf8");

    const beforeCount = listBackups(filePath).length;

    const requests: FileEditRequest[] = [
      { filePath, edits: [{ search: "ORIGINAL", replace: "MODIFIED" }] },
    ];
    const result = multiFileEdit(requests);

    expect(result.success).toBe(true);
    const afterCount = listBackups(filePath).length;
    expect(afterCount).toBeGreaterThan(beforeCount);

    // The snapshot's recorded toolName must be editar_multi_arquivos so
    // desfazer_edicao can show provenance to the user.
    const latest = listBackups(filePath).at(-1);
    expect(latest?.toolName).toBe("editar_multi_arquivos");
    expect(latest?.originalPath).toBe(path.resolve(filePath));
  });

  it("does NOT save a snapshot for a newly-created file (nothing to roll back to)", () => {
    const filePath = path.join(tmpProject, "brand_new.ts");
    try { fs.unlinkSync(filePath); } catch { /* not present */ }

    const beforeCount = listBackups(filePath).length;

    const requests: FileEditRequest[] = [
      {
        filePath,
        edits: [{ search: "", replace: "BRAND_NEW_CONTENT\n" }],
        createIfMissing: true,
      },
    ];
    const result = multiFileEdit(requests);

    expect(result.success).toBe(true);
    const afterCount = listBackups(filePath).length;
    expect(afterCount).toBe(beforeCount);
  });
});

describe("FIX-TOOLS HIGH 2: rolled-back multi-edit deletes newly-created files", () => {
  it("deletes a newly-created file when a LATER file in the batch fails (atomicity preserved)", () => {
    const existingPath = path.join(tmpProject, "old_existing.ts");
    const newFilePath = path.join(tmpProject, "to_be_deleted.ts");
    const failPath = path.join(tmpProject, "__fixtools_fail__atomic.ts");

    // Setup: an existing file that will be successfully edited then rolled back,
    // plus a brand-new file (createIfMissing:true) that should be DELETED on rollback,
    // plus a path whose writeFileSync throws → triggers the rollback.
    fs.writeFileSync(existingPath, "OLD_ORIG\n", "utf8");
    // Use appendFileSync (NOT mocked) to seed the fail path with content.
    fs.appendFileSync(failPath, "PRE_EXISTING_FAIL\n", "utf8");
    try { fs.unlinkSync(newFilePath); } catch { /* not present */ }

    const requests: FileEditRequest[] = [
      // 1) Create a brand-new file (will be DELETED on rollback).
      {
        filePath: newFilePath,
        edits: [{ search: "", replace: "THIS_SHOULD_BE_DELETED_ON_ROLLBACK\n" }],
        createIfMissing: true,
      },
      // 2) Edit an existing file (will be RESTORED to OLD_ORIG on rollback).
      {
        filePath: existingPath,
        edits: [{ search: "OLD_ORIG", replace: "OLD_MODIFIED" }],
      },
      // 3) Path with __fixtools_fail__ → writeFileSync throws → rollback fires.
      {
        filePath: failPath,
        edits: [{ search: "PRE_EXISTING_FAIL", replace: "FAIL_AFTER" }],
      },
    ];

    const result = multiFileEdit(requests);

    // Rollback path was triggered.
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);

    // HIGH 2 core assertion: the newly-created file MUST be DELETED by rollback.
    expect(fs.existsSync(newFilePath)).toBe(false);

    // And the existing file MUST be RESTORED to its original content.
    expect(fs.readFileSync(existingPath, "utf8")).toBe("OLD_ORIG\n");

    // Cleanup fail-path file for the next run.
    try { fs.unlinkSync(failPath); } catch { /* may already be gone */ }
  });

  it("does NOT delete a pre-existing file during rollback — restores original content instead", () => {
    const existingA = path.join(tmpProject, "preserve_A.ts");
    const existingB = path.join(tmpProject, "__fixtools_fail__preserve.ts");
    fs.writeFileSync(existingA, "A_ORIG\n", "utf8");
    fs.appendFileSync(existingB, "B_ORIG\n", "utf8");

    const requests: FileEditRequest[] = [
      { filePath: existingA, edits: [{ search: "A_ORIG", replace: "A_MODIFIED" }] },
      { filePath: existingB, edits: [{ search: "B_ORIG", replace: "B_MODIFIED" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);

    // existingA still exists (was NOT deleted) and is restored.
    expect(fs.existsSync(existingA)).toBe(true);
    expect(fs.readFileSync(existingA, "utf8")).toBe("A_ORIG\n");

    try { fs.unlinkSync(existingB); } catch { /* */ }
  });
});
