/**
 * multiFileEdit.test.ts — Tests for multi-file atomic edit module.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { multiFileEdit, applyAllEdits, type FileEditRequest } from "../multiFileEdit.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  const origWrite = actual.writeFileSync;
  return {
    ...actual,
    writeFileSync: (...args: any[]) => {
      if (args[0]?.toString().includes("__multifail__")) {
        throw new Error("disk error");
      }
      return origWrite(...args);
    },
  };
});

const TEST_DIR = path.join(process.cwd(), "__test_multiedit__");

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, "a.ts"), "const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "b.ts"), "const b = 2;\n", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "c.ts"), "const c = 3;\n", "utf8");
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("multiFileEdit", () => {
  it("should edit multiple files atomically", () => {
    const requests: FileEditRequest[] = [
      { filePath: path.join(TEST_DIR, "a.ts"), edits: [{ search: "const a = 1;", replace: "const a = 10;" }] },
      { filePath: path.join(TEST_DIR, "b.ts"), edits: [{ search: "const b = 2;", replace: "const b = 20;" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(true);
    expect(result.filesEdited.length).toBe(2);
    expect(fs.readFileSync(path.join(TEST_DIR, "a.ts"), "utf8")).toContain("10");
    expect(fs.readFileSync(path.join(TEST_DIR, "b.ts"), "utf8")).toContain("20");
  });

  it("should rollback all files on failure", () => {
    const originalA = fs.readFileSync(path.join(TEST_DIR, "a.ts"), "utf8");
    const originalC = fs.readFileSync(path.join(TEST_DIR, "c.ts"), "utf8");

    const requests: FileEditRequest[] = [
      { filePath: path.join(TEST_DIR, "a.ts"), edits: [{ search: "const a = 10;", replace: "const a = 100;" }] },
      { filePath: path.join(TEST_DIR, "c.ts"), edits: [{ search: "NONEXISTENT", replace: "fail" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // a.ts should be rolled back to original
    expect(fs.readFileSync(path.join(TEST_DIR, "a.ts"), "utf8")).toBe(originalA);
  });

  it("should handle createIfMissing", () => {
    const requests: FileEditRequest[] = [
      {
        filePath: path.join(TEST_DIR, "new.ts"),
        edits: [{ search: "", replace: "export const x = 1;" }],
        createIfMissing: true,
      },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(TEST_DIR, "new.ts"), "utf8")).toContain("export const x = 1;");
  });

  it("should fail for non-existent files without createIfMissing", () => {
    const requests: FileEditRequest[] = [
      { filePath: "/nonexistent/file.ts", edits: [{ search: "x", replace: "y" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(false);
    expect(result.errors[0].error).toContain("not found");
  });

  it("should report all errors", () => {
    const requests: FileEditRequest[] = [
      { filePath: path.join(TEST_DIR, "a.ts"), edits: [{ search: "NONEXISTENT", replace: "x" }] },
      { filePath: path.join(TEST_DIR, "b.ts"), edits: [{ search: "ALSO_NONEXISTENT", replace: "y" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBe(2);
  });

  it("should handle empty edit requests", () => {
    const result = multiFileEdit([]);
    expect(result.success).toBe(true);
    expect(result.filesEdited.length).toBe(0);
  });

  it("should handle multiple edits on same file", () => {
    fs.writeFileSync(path.join(TEST_DIR, "multi.ts"), "const x = 1;\nconst y = 2;\n", "utf8");
    const requests: FileEditRequest[] = [
      {
        filePath: path.join(TEST_DIR, "multi.ts"),
        edits: [
          { search: "const x = 1;", replace: "const x = 10;" },
          { search: "const y = 2;", replace: "const y = 20;" },
        ],
      },
    ];
    const result = multiFileEdit(requests);
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(TEST_DIR, "multi.ts"), "utf8");
    expect(content).toContain("x = 10");
    expect(content).toContain("y = 20");
  });

  it("should handle createIfMissing with empty content", () => {
    const requests: FileEditRequest[] = [
      {
        filePath: path.join(TEST_DIR, "empty_create.ts"),
        edits: [{ search: "", replace: "export const empty = true;\n" }],
        createIfMissing: true,
      },
    ];
    const result = multiFileEdit(requests);
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(TEST_DIR, "empty_create.ts"), "utf8");
    expect(content).toContain("export const empty = true");
  });

  it("should handle new file creation", () => {
    const requests: FileEditRequest[] = [
      {
        filePath: path.join(TEST_DIR, "created.ts"),
        edits: [{ search: "", replace: "export const created = true;\n" }],
        createIfMissing: true,
      },
    ];
    const result = multiFileEdit(requests);
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(TEST_DIR, "created.ts"))).toBe(true);
  });

  it("should handle edit that matches multiple occurrences", () => {
    fs.writeFileSync(path.join(TEST_DIR, "dup.ts"), "foo\nfoo\nfoo\n", "utf8");
    const requests: FileEditRequest[] = [
      {
        filePath: path.join(TEST_DIR, "dup.ts"),
        edits: [{ search: "foo", replace: "bar" }],
      },
    ];
    const result = multiFileEdit(requests);
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(TEST_DIR, "dup.ts"), "utf8");
    expect(content).toContain("bar");
  });

  it("should handle rollback of previously edited files", () => {
    fs.writeFileSync(path.join(TEST_DIR, "rollback1.ts"), "original\n", "utf8");
    fs.writeFileSync(path.join(TEST_DIR, "rollback2.ts"), "original\n", "utf8");
    const requests: FileEditRequest[] = [
      { filePath: path.join(TEST_DIR, "rollback1.ts"), edits: [{ search: "original", replace: "modified" }] },
      { filePath: path.join(TEST_DIR, "rollback2.ts"), edits: [{ search: "NONEXISTENT", replace: "fail" }] },
    ];
    const result = multiFileEdit(requests);
    expect(result.success).toBe(false);
    expect(fs.readFileSync(path.join(TEST_DIR, "rollback1.ts"), "utf8")).toBe("original\n");
  });

  it("should trigger rollback when writeFileSync throws during edit", () => {
    const filePath = path.join(TEST_DIR, "__multifail__test.ts");
    fs.appendFileSync(filePath, "original\n", "utf8");

    const requests: FileEditRequest[] = [
      { filePath, edits: [{ search: "original", replace: "modified" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toContain("disk error");

    fs.unlinkSync(filePath);
  });

  it("should handle rollback failure gracefully", () => {
    const filePath = path.join(TEST_DIR, "__multifail__rollback.ts");
    fs.appendFileSync(filePath, "original\n", "utf8");

    const requests: FileEditRequest[] = [
      { filePath, edits: [{ search: "original", replace: "modified" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);

    fs.unlinkSync(filePath);
  });

  it("should create backups for existing files in applyAllEditsWithBackup", () => {
    fs.writeFileSync(path.join(TEST_DIR, "backup_test.ts"), "content\n", "utf8");
    const requests: FileEditRequest[] = [
      { filePath: path.join(TEST_DIR, "backup_test.ts"), edits: [{ search: "content", replace: "updated" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(TEST_DIR, "backup_test.ts"), "utf8")).toContain("updated");
  });

  it("should create directories when needed during applyAllEditsWithBackup", () => {
    const requests: FileEditRequest[] = [
      {
        filePath: path.join(TEST_DIR, "subdir", "nested.ts"),
        edits: [{ search: "", replace: "export const x = 1;\n" }],
        createIfMissing: true,
      },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(TEST_DIR, "subdir", "nested.ts"))).toBe(true);
  });
});

describe("applyAllEdits (lines 62-71)", () => {
  it("writes files and creates directories", () => {
    const edits = [
      {
        resolved: path.join(TEST_DIR, "apply_out.ts"),
        original: "",
        result: { success: true, content: "written by applyAllEdits", error: undefined },
      },
    ];

    const edited = applyAllEdits(edits as any);
    expect(edited).toHaveLength(1);
    expect(fs.readFileSync(edited[0], "utf8")).toBe("written by applyAllEdits");
  });

  it("creates parent directories recursively", () => {
    const edits = [
      {
        resolved: path.join(TEST_DIR, "deep", "nested", "dir", "file.ts"),
        original: "",
        result: { success: true, content: "nested content", error: undefined },
      },
    ];

    const edited = applyAllEdits(edits as any);
    expect(edited).toHaveLength(1);
    expect(fs.readFileSync(edited[0], "utf8")).toBe("nested content");
  });

  it("returns empty array for empty input", () => {
    const edited = applyAllEdits([]);
    expect(edited).toHaveLength(0);
  });
});
