import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock logger to avoid noise
vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import {
  saveBackup,
  restoreBackup,
  listBackups,
  pruneOldBackups,
  getRollbackDirPath,
  clearAllBackups,
  resetRollbackState,
  type BackupRecord,
} from "../rollbackStore.js";

// We need to control the "project root" that rollbackStore discovers.
// It walks up from process.cwd() looking for package.json etc.
// We'll create a temp project and chdir into it.
let tmpProject: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "rbw_test_"));
  // Create a package.json so findProjectRoot stops here
  fs.writeFileSync(path.join(tmpProject, "package.json"), JSON.stringify({ name: "test" }), "utf8");
  process.chdir(tmpProject);
  resetRollbackState();
});

afterEach(() => {
  process.chdir(originalCwd);
  resetRollbackState();
  try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("rollbackStore", () => {
  describe("saveBackup", () => {
    it("saves a backup when the file exists", () => {
      const filePath = path.join(tmpProject, "foo.ts");
      fs.writeFileSync(filePath, "original content", "utf8");

      const record = saveBackup(filePath, "original content", "aplicar_diff");
      expect(record).not.toBeNull();
      expect(record!.originalPath).toBe(path.resolve(filePath));
      expect(record!.toolName).toBe("aplicar_diff");
      expect(fs.existsSync(record!.backupPath)).toBe(true);
      expect(fs.existsSync(record!.metaPath)).toBe(true);
      expect(fs.readFileSync(record!.backupPath, "utf8")).toBe("original content");
    });

    it("returns null when the file does not exist (new file creation)", () => {
      const filePath = path.join(tmpProject, "new.ts");
      const record = saveBackup(filePath, "", "aplicar_diff");
      expect(record).toBeNull();
    });

    it("writes an index.json after saving", () => {
      const filePath = path.join(tmpProject, "bar.ts");
      fs.writeFileSync(filePath, "v1", "utf8");
      saveBackup(filePath, "v1", "aplicar_diff");
      const index = JSON.parse(fs.readFileSync(path.join(getRollbackDirPath(), "index.json"), "utf8"));
      expect(index.version).toBe(1);
      expect(index.entries).toHaveLength(1);
    });
  });

  describe("restoreBackup", () => {
    it("restores the most recent backup for a file", () => {
      const filePath = path.join(tmpProject, "restore.ts");
      fs.writeFileSync(filePath, "v1", "utf8");
      saveBackup(filePath, "v1", "aplicar_diff");
      fs.writeFileSync(filePath, "v2", "utf8");
      // Now restore
      const ok = restoreBackup(filePath);
      expect(ok).toBe(true);
      expect(fs.readFileSync(filePath, "utf8")).toBe("v1");
    });

    it("returns false when no backup exists", () => {
      const filePath = path.join(tmpProject, "no-backup.ts");
      fs.writeFileSync(filePath, "x", "utf8");
      const ok = restoreBackup(filePath);
      expect(ok).toBe(false);
    });

    it("restores older backups in sequence (LIFO)", () => {
      const filePath = path.join(tmpProject, "seq.ts");
      fs.writeFileSync(filePath, "v1", "utf8");
      saveBackup(filePath, "v1", "aplicar_diff");
      fs.writeFileSync(filePath, "v2", "utf8");
      saveBackup(filePath, "v2", "aplicar_diff");
      fs.writeFileSync(filePath, "v3", "utf8");

      // Restore once → back to v2
      expect(restoreBackup(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, "utf8")).toBe("v2");
      // Restore again → back to v1
      expect(restoreBackup(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, "utf8")).toBe("v1");
      // Restore again → no more backups
      expect(restoreBackup(filePath)).toBe(false);
    });
  });

  describe("listBackups", () => {
    it("lists all backups sorted oldest-first", () => {
      const fileA = path.join(tmpProject, "a.ts");
      const fileB = path.join(tmpProject, "b.ts");
      fs.writeFileSync(fileA, "a1", "utf8");
      fs.writeFileSync(fileB, "b1", "utf8");
      saveBackup(fileA, "a1", "aplicar_diff");
      saveBackup(fileB, "b1", "aplicar_diff");

      const all = listBackups();
      expect(all).toHaveLength(2);
      expect(all[0].originalPath).toBe(path.resolve(fileA));
      expect(all[1].originalPath).toBe(path.resolve(fileB));
    });

    it("filters by file path when given", () => {
      const fileA = path.join(tmpProject, "filterA.ts");
      const fileB = path.join(tmpProject, "filterB.ts");
      fs.writeFileSync(fileA, "a1", "utf8");
      fs.writeFileSync(fileB, "b1", "utf8");
      saveBackup(fileA, "a1", "aplicar_diff");
      saveBackup(fileB, "b1", "aplicar_diff");

      const onlyA = listBackups(fileA);
      expect(onlyA).toHaveLength(1);
      expect(onlyA[0].originalPath).toBe(path.resolve(fileA));
    });
  });

  describe("pruneOldBackups", () => {
    it("removes backups older than maxAgeMs", () => {
      const file = path.join(tmpProject, "old.ts");
      fs.writeFileSync(file, "v1", "utf8");
      saveBackup(file, "v1", "aplicar_diff");

      // Manually backdate the timestamp in the index
      const indexPath = path.join(getRollbackDirPath(), "index.json");
      const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      index.entries[0].timestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
      fs.writeFileSync(indexPath, JSON.stringify(index), "utf8");

      const pruned = pruneOldBackups(5 * 60 * 1000); // 5 min cutoff
      expect(pruned).toBe(1);
      expect(listBackups()).toHaveLength(0);
    });

    it("returns 0 when there's nothing to prune", () => {
      expect(pruneOldBackups()).toBe(0);
    });
  });

  describe("clearAllBackups", () => {
    it("removes all backups and resets the index", () => {
      const file = path.join(tmpProject, "clear.ts");
      fs.writeFileSync(file, "v1", "utf8");
      saveBackup(file, "v1", "aplicar_diff");
      expect(listBackups()).toHaveLength(1);

      const count = clearAllBackups();
      expect(count).toBe(1);
      expect(listBackups()).toHaveLength(0);
    });
  });
});
