import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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
  recordRead,
  recordWrite,
  checkReadBeforeWrite,
  hasBeenRead,
  clearReadPaths,
  setReadBeforeWriteEnabled,
  isReadBeforeWriteEnabled,
} from "../readBeforeWrite.js";

describe("readBeforeWrite", () => {
  beforeEach(() => {
    clearReadPaths();
    setReadBeforeWriteEnabled(true);
  });

  describe("enable/disable", () => {
    it("is enabled by default", () => {
      expect(isReadBeforeWriteEnabled()).toBe(true);
    });

    it("can be disabled", () => {
      setReadBeforeWriteEnabled(false);
      expect(isReadBeforeWriteEnabled()).toBe(false);
    });

    it("when disabled, checkReadBeforeWrite always allows", () => {
      setReadBeforeWriteEnabled(false);
      const r = checkReadBeforeWrite("aplicar_diff", { caminho: "/tmp/never-read.ts" });
      expect(r.allowed).toBe(true);
    });
  });

  describe("recordRead / hasBeenRead", () => {
    it("records reads for known read tools", () => {
      recordRead("ler_arquivo", "/tmp/foo.ts");
      expect(hasBeenRead("/tmp/foo.ts")).toBe(true);
    });

    it("ignores reads from non-read tools", () => {
      recordRead("aplicar_diff", "/tmp/foo.ts");
      expect(hasBeenRead("/tmp/foo.ts")).toBe(false);
    });

    it("resolves relative paths to absolute", () => {
      recordRead("ler_arquivo", "relative/path.ts");
      expect(hasBeenRead(path.resolve("relative/path.ts"))).toBe(true);
    });
  });

  describe("checkReadBeforeWrite", () => {
    it("blocks aplicar_diff on unread file", () => {
      const r = checkReadBeforeWrite("aplicar_diff", { caminho: "/tmp/unread.ts" });
      expect(r.allowed).toBe(false);
      expect(r.message).toContain("READ-BEFORE-WRITE");
      expect(r.message).toContain("/tmp/unread.ts");
    });

    it("allows aplicar_diff on file that was read first", () => {
      recordRead("ler_arquivo", "/tmp/read-first.ts");
      const r = checkReadBeforeWrite("aplicar_diff", { caminho: "/tmp/read-first.ts" });
      expect(r.allowed).toBe(true);
    });

    it("blocks editar_arquivo on unread file", () => {
      const r = checkReadBeforeWrite("editar_arquivo", { path: "/tmp/edit-unread.ts" });
      expect(r.allowed).toBe(false);
    });

    it("allows editar_arquivo after reading", () => {
      recordRead("ler_arquivo", "/tmp/edit-read.ts");
      const r = checkReadBeforeWrite("editar_arquivo", { path: "/tmp/edit-read.ts" });
      expect(r.allowed).toBe(true);
    });

    it("blocks editar_multi_arquivos if ANY file is unread", () => {
      recordRead("ler_arquivo", "/tmp/multi-a.ts");
      // multi-b.ts NOT read
      const r = checkReadBeforeWrite("editar_multi_arquivos", {
        requests: [
          { filePath: "/tmp/multi-a.ts", edits: [] },
          { filePath: "/tmp/multi-b.ts", edits: [] },
        ],
      });
      expect(r.allowed).toBe(false);
      expect(r.message).toContain("/tmp/multi-b.ts");
    });

    it("allows editar_multi_arquivos when ALL files were read", () => {
      recordRead("ler_arquivo", "/tmp/multi-c.ts");
      recordRead("ler_arquivo", "/tmp/multi-d.ts");
      const r = checkReadBeforeWrite("editar_multi_arquivos", {
        requests: [
          { filePath: "/tmp/multi-c.ts", edits: [] },
          { filePath: "/tmp/multi-d.ts", edits: [] },
        ],
      });
      expect(r.allowed).toBe(true);
    });

    it("passes through for non-write tools", () => {
      const r = checkReadBeforeWrite("ler_arquivo", { caminho: "/tmp/anything.ts" });
      expect(r.allowed).toBe(true);
    });

    it("treats recordWrite as also marking the file as read", () => {
      // Simulate: a write happened, then another write to the same file should be allowed
      recordWrite("aplicar_diff", "/tmp/written.ts");
      const r = checkReadBeforeWrite("aplicar_diff", { caminho: "/tmp/written.ts" });
      expect(r.allowed).toBe(true);
    });
  });

  describe("clearReadPaths", () => {
    it("clears the read tracking", () => {
      recordRead("ler_arquivo", "/tmp/clear.ts");
      expect(hasBeenRead("/tmp/clear.ts")).toBe(true);
      clearReadPaths();
      expect(hasBeenRead("/tmp/clear.ts")).toBe(false);
    });
  });
});
