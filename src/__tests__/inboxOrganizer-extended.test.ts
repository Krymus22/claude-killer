/**
 * inboxOrganizer-extended.test.ts — Testa a classificação e organização de inbox.
 *
 * Sprint 12: Cobertura para inboxOrganizer.ts:
 *   - classifyFile: .exe → tool, .md → skill, .js (module.exports.run) → hook,
 *     .js (JSON-RPC) → mcp, .json com category → manifest, .zip → archive,
 *     .txt → docs, extensão desconhecida → unknown
 *   - organizeInbox: move arquivo pra pasta correta, retorna erro sem modo ativo
 *
 * Usa um HOME temporário real com inbox/ populado para cada teste.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

import {
  classifyFile,
  organizeInbox,
  type FileType,
} from "../inboxOrganizer.js";

describe("inboxOrganizer", () => {
  let tmpHome: string;
  let tmpInbox: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-inbox-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    tmpInbox = path.join(tmpHome, ".claude-killer", "modes", "roblox", "inbox");
    fs.mkdirSync(tmpInbox, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.resetModules();
  });

  /** Helper: cria arquivo no inbox com conteúdo opcional. */
  function writeInboxFile(name: string, content: string = ""): string {
    const filePath = path.join(tmpInbox, name);
    fs.writeFileSync(filePath, content, "utf8");
    return filePath;
  }

  describe("classifyFile", () => {
    it(".exe → tool", () => {
      const f = writeInboxFile("rojo.exe", "fake binary");
      expect(classifyFile(f)).toBe<FileType>("tool");
    });

    it(".md → skill", () => {
      const f = writeInboxFile("profilestore.md", "# ProfileStore\nDocs");
      expect(classifyFile(f)).toBe<FileType>("skill");
    });

    it(".js com module.exports.run → hook", () => {
      const f = writeInboxFile(
        "auto-build.js",
        "module.exports = { trigger: 'before_write', run: function() {} };\n",
      );
      expect(classifyFile(f)).toBe<FileType>("hook");
    });

    it(".js com JSON-RPC → mcp", () => {
      const f = writeInboxFile(
        "mcp-server.js",
        "// @modelcontextprotocol/server\nconst stdio = require('stdio');\n",
      );
      expect(classifyFile(f)).toBe<FileType>("mcp");
    });

    it(".json com category → manifest", () => {
      const f = writeInboxFile(
        "tool.json",
        JSON.stringify({ name: "x", category: "action", command: "x", args: [] }),
      );
      expect(classifyFile(f)).toBe<FileType>("manifest");
    });

    it(".zip → archive", () => {
      const f = writeInboxFile("backup.zip", "fake zip content");
      expect(classifyFile(f)).toBe<FileType>("archive");
    });

    it(".txt → docs", () => {
      const f = writeInboxFile("notes.txt", "notas do projeto");
      expect(classifyFile(f)).toBe<FileType>("docs");
    });

    it("extensão desconhecida → unknown", () => {
      const f = writeInboxFile("misterio.xyz", "????");
      expect(classifyFile(f)).toBe<FileType>("unknown");
    });
  });

  describe("organizeInbox", () => {
    it("move arquivo pra pasta correta (.md → skills/)", () => {
      writeInboxFile("profilestore.md", "# ProfileStore");
      const result = organizeInbox("roblox");
      expect(result.organized.length).toBe(1);
      expect(result.organized[0].fileType).toBe("skill");
      // Arquivo deve ter sido movido pra skills/
      const destPath = path.join(tmpHome, ".claude-killer", "modes", "roblox", "skills", "profilestore.md");
      expect(fs.existsSync(destPath)).toBe(true);
      // Não deve estar mais no inbox
      expect(fs.existsSync(path.join(tmpInbox, "profilestore.md"))).toBe(false);
    });

    it("retorna erro quando sem modo ativo (modeName null)", () => {
      const result = organizeInbox(null);
      expect(result.organized.length).toBe(0);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].error).toMatch(/No active mode/);
    });
  });
});
