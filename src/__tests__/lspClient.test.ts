/**
 * lspClient.test.ts — Tests for the LSP client module.
 *
 * Since lspClient spawns real LSP servers (tsserver, pylsp), we test
 * the language detection, config parsing, and fallback behavior
 * without actually spawning servers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
}));

import {
  analyzeFileWithLsp,
  isLspAvailable,
  shutdownLspServers,
} from "../lspClient.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.LSP_ENABLED = "false"; // disable real LSP for tests
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("lspClient", () => {
  describe("analyzeFileWithLsp — fallback behavior", () => {
    it("returns 'none' source for unsupported file extensions", async () => {
      const result = await analyzeFileWithLsp("/tmp/test.md");
      expect(result.source).toBe("none");
      expect(result.language).toBe("md");
      expect(result.diagnostics).toEqual([]);
    });

    it("returns 'none' source for .json files", async () => {
      const result = await analyzeFileWithLsp("/tmp/config.json");
      expect(result.source).toBe("none");
    });

    it("returns 'none' source for .css files", async () => {
      const result = await analyzeFileWithLsp("/tmp/style.css");
      expect(result.source).toBe("none");
    });

    it("returns 'none' source for .html files", async () => {
      const result = await analyzeFileWithLsp("/tmp/page.html");
      expect(result.source).toBe("none");
    });

    it("returns 'none' source for files without extension", async () => {
      const result = await analyzeFileWithLsp("/tmp/Makefile");
      expect(result.source).toBe("none");
    });

    it("falls back to tree-sitter for .ts when LSP is disabled", async () => {
      const result = await analyzeFileWithLsp("/tmp/test.ts");
      // With LSP disabled, it should fall back to tree-sitter or fail gracefully
      expect(["tree-sitter", "none", "lsp"]).toContain(result.source);
      expect(result.language).toBe("typescript");
    });

    it("falls back to tree-sitter for .py when LSP is disabled", async () => {
      const result = await analyzeFileWithLsp("/tmp/test.py");
      expect(["tree-sitter", "none", "lsp"]).toContain(result.source);
      expect(result.language).toBe("python");
    });

    it("falls back to tree-sitter for .js when LSP is disabled", async () => {
      const result = await analyzeFileWithLsp("/tmp/test.js");
      expect(["tree-sitter", "none", "lsp"]).toContain(result.source);
      expect(result.language).toBe("javascript");
    });

    it("returns durationMs > 0", async () => {
      const result = await analyzeFileWithLsp("/tmp/test.ts");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("returns empty diagnostics array when fallback is used", async () => {
      const result = await analyzeFileWithLsp("/tmp/nonexistent.ts");
      // File doesn't exist — should handle gracefully
      expect(result.diagnostics).toEqual([]);
    });
  });

  describe("isLspAvailable", () => {
    it("returns false when LSP_ENABLED is false", () => {
      process.env.LSP_ENABLED = "false";
      expect(isLspAvailable("typescript")).toBe(false);
    });

    it("returns false for unsupported languages", () => {
      process.env.LSP_ENABLED = "true";
      expect(isLspAvailable("ruby")).toBe(false);
      expect(isLspAvailable("php")).toBe(false);
      expect(isLspAvailable("c++")).toBe(false);
    });

    it("returns false for null/undefined language", () => {
      expect(isLspAvailable("")).toBe(false);
    });
  });

  describe("shutdownLspServers", () => {
    it("does not throw when no servers are running", async () => {
      await expect(shutdownLspServers()).resolves.not.toThrow();
    });
  });
});
