/**
 * autoMemory.test.ts — Testes do sistema de auto memory
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  detectUserCorrection,
  maybeSuggestMemoryWrite,
  ensureAutoMemoryFile,
  readAutoMemory,
  appendAutoMemory,
  getAutoMemoryPath,
} from "../autoMemory.js";

// Use a temp file for testing
const TEST_FILE = path.join(os.tmpdir(), "test-auto-memory.md");

describe("autoMemory", () => {
  describe("detectUserCorrection", () => {
    it("detecta correção em português 'não use X'", () => {
      const result = detectUserCorrection("Não use print, use warn");
      expect(result).not.toBeNull();
    });

    it("detecta correção em inglês 'never use X'", () => {
      const result = detectUserCorrection("Never use var, use let instead");
      expect(result).not.toBeNull();
    });

    it("detecta 'sempre use X'", () => {
      const result = detectUserCorrection("Sempre use pcall com DataStore");
      expect(result).not.toBeNull();
    });

    it("detecta 'errado'", () => {
      const result = detectUserCorrection("Errado, o correto é usar WaitForChild");
      expect(result).not.toBeNull();
    });

    it("detecta 'actually' (English)", () => {
      const result = detectUserCorrection("Actually, you should use await here");
      expect(result).not.toBeNull();
    });

    it("detecta 'na verdade'", () => {
      const result = detectUserCorrection("Na verdade, o método correto é outro");
      expect(result).not.toBeNull();
    });

    it("NÃO detecta mensagem normal", () => {
      const result = detectUserCorrection("Pode me ajudar com isso?");
      expect(result).toBeNull();
    });

    it("NÃO detecta pergunta", () => {
      const result = detectUserCorrection("Como funciona isso?");
      expect(result).toBeNull();
    });

    it("NÃO detecta string vazia", () => {
      const result = detectUserCorrection("");
      expect(result).toBeNull();
    });
  });

  describe("maybeSuggestMemoryWrite", () => {
    it("sugere escrita quando há correção e IA não anotou", () => {
      const result = maybeSuggestMemoryWrite(
        "Não use print, use warn",
        "Entendi, vou usar warn."
      );
      expect(result).not.toBeNull();
      expect(result).toContain("AUTO_MEMORY");
    });

    it("NÃO sugere se a IA já anotou", () => {
      const result = maybeSuggestMemoryWrite(
        "Não use print, use warn",
        "Anotado! Vou lembrar disso."
      );
      expect(result).toBeNull();
    });

    it("NÃO sugere se não há correção", () => {
      const result = maybeSuggestMemoryWrite(
        "Como faz isso?",
        "Você pode fazer assim..."
      );
      expect(result).toBeNull();
    });
  });

  describe("file operations", () => {
    // Temporarily override the file path for testing
    const originalFile = getAutoMemoryPath();

    beforeEach(() => {
      // Clean up before each test
      try { fs.unlinkSync(TEST_FILE); } catch { /* ignore */ }
    });

    afterEach(() => {
      try { fs.unlinkSync(TEST_FILE); } catch { /* ignore */ }
    });

    it("ensureAutoMemoryFile cria arquivo com header", () => {
      ensureAutoMemoryFile();
      const file = getAutoMemoryPath();
      expect(fs.existsSync(file)).toBe(true);
      const content = fs.readFileSync(file, "utf8");
      expect(content).toContain("Auto Memory");
    });

    it("readAutoMemory retorna string (pode estar vazia se arquivo não existe)", () => {
      const content = readAutoMemory();
      expect(typeof content).toBe("string");
    });

    it("appendAutoMemory adiciona entrada", () => {
      ensureAutoMemoryFile();
      appendAutoMemory("Teste de entrada");
      const content = readAutoMemory();
      expect(content).toContain("Teste de entrada");
    });
  });
});
