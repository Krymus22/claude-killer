/**
 * autoMemory.ts - IA escreve notas automaticamente em memory.md.
 *
 * Inspirado no "auto memory" do Claude Code, onde o Claude escreve notas
 * SOZINHO baseado em correções do usuário e padrões que descobre.
 * Reference: https://docs.anthropic.com/en/docs/claude-code/memory
 *
 * Como funciona:
 *   1. Após cada turno da IA, analisamos a conversa
 *   2. Se detectamos que o usuário CORRIGIU a IA (feedback implícito),
 *      sugerimos que a IA escreva uma nota
 *   3. A nota é salva em ~/.claude-killer/auto-memory.md
 *   4. No início da próxima sessão, as primeiras 200 linhas são carregadas
 *      no system prompt
 *
 * O que a IA deve anotar:
 *   - Correções do usuário ("não use X, use Y")
 *   - Preferências descobertas ("usuário prefere tabs sobre espaços")
 *   - Padrões do projeto ("sempre usar pcall com DataStore")
 *   - Bugs recorrentes ("esquecer GetAsync antes de SetAsync")
 *
 * O que NÃO anotar:
 *   - Informações triviais que não se repetem
 *   - Erros únicos que não vão se repetir
 *   - Preferências pessoais muito específicas
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Message } from "./history.js";

const AUTO_MEMORY_FILE = path.join(os.homedir(), ".claude-killer", "auto-memory.md");
const MAX_LINES = 200; // mesmo limite do Claude Code
const MAX_BYTES = 25 * 1024; // 25KB

/**
 * Ensure the auto-memory file exists (creates with header if not).
 */
export function ensureAutoMemoryFile(): void {
  const dir = path.dirname(AUTO_MEMORY_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(AUTO_MEMORY_FILE)) {
    const header = `# Auto Memory — Notas da IA\n\n` +
      `Este arquivo é escrito automaticamente pela IA quando ela aprende algo\n` +
      `com correções do usuário ou descobre padrões do projeto.\n\n` +
      `Carregado no início de cada sessão (primeiras ${MAX_LINES} linhas).\n\n` +
      `---\n\n`;
    fs.writeFileSync(AUTO_MEMORY_FILE, header, "utf8");
  }
}

/**
 * Read the auto-memory file (first MAX_LINES or MAX_BYTES).
 * Used at session start to inject into system prompt.
 */
export function readAutoMemory(): string {
  try {
    if (!fs.existsSync(AUTO_MEMORY_FILE)) return "";
    const content = fs.readFileSync(AUTO_MEMORY_FILE, "utf8");
    // Truncate to MAX_LINES
    const lines = content.split("\n").slice(0, MAX_LINES);
    let result = lines.join("\n");
    // Truncate to MAX_BYTES
    if (result.length > MAX_BYTES) {
      result = result.slice(0, MAX_BYTES) + "\n... (truncated)";
    }
    return result;
  } catch {
    return "";
  }
}

/**
 * Append a learning to the auto-memory file.
 * Called when the IA detects it should remember something.
 */
export function appendAutoMemory(entry: string): void {
  try {
    ensureAutoMemoryFile();
    const timestamp = new Date().toISOString().split("T")[0];
    const entryWithDate = `\n## ${timestamp}\n\n${entry.trim()}\n`;
    fs.appendFileSync(AUTO_MEMORY_FILE, entryWithDate, "utf8");
  } catch (err) {
    console.error(`[AUTO_MEMORY] Failed to write: ${(err as Error).message}`);
  }
}

/**
 * Detect if the user's latest message is a correction to the IA.
 * Returns the correction text if detected, null otherwise.
 *
 * Heuristics:
 *   - User says "não" / "no" followed by what the IA should do
 *   - User says "errado" / "wrong" / "incorrect"
 *   - User says "na verdade" / "actually" / "instead"
 *   - User says "sempre" / "always" (stating a rule)
 *   - User says "nunca" / "never" (stating a rule)
 */
export function detectUserCorrection(userMessage: string): string | null {
  const q = userMessage.toLowerCase().trim();

  // Patterns that indicate a correction or rule
  const correctionPatterns = [
    // Portuguese
    /não[,.\s]+(use|faça|escreva|coloque)/,
    /nunca\s+(use|faça|escreva|coloque)/,
    /sempre\s+(use|faça|escreva|coloque)/,
    /errado[,.\s]/,
    /na verdade/,
    /ao invés disso/,
    /em vez disso/,
    /o correto é/,
    // English
    /no[,.\s]+(use|do|write|put)/,
    /never\s+(use|do|write|put)/,
    /always\s+(use|do|write|put)/,
    /wrong[,.\s]/,
    /actually/,
    /instead/,
    /the correct (way|thing) is/,
    /you should (always|never)/,
  ];

  for (const pattern of correctionPatterns) {
    if (pattern.test(q)) {
      // Return the original message (not lowercased) for context
      return userMessage.trim();
    }
  }

  return null;
}

/**
 * Suggest that the IA writes a note to auto-memory.
 * Returns a system message to inject, or null if no correction detected.
 *
 * This is called AFTER the IA responds. If we detect the user was correcting
 * the IA, we inject a hint telling the IA to write a note for next time.
 */
export function maybeSuggestMemoryWrite(userMessage: string, iaResponse: string): string | null {
  const correction = detectUserCorrection(userMessage);
  if (!correction) return null;

  // Don't suggest if the IA already acknowledged the correction
  const iaLower = iaResponse.toLowerCase();
  if (iaLower.includes("anotad") || iaLower.includes("noted") ||
      iaLower.includes("lembrarei") || iaLower.includes("i'll remember")) {
    return null;
  }

  return `[AUTO_MEMORY] O usuário acabou de te corrigir. Considere usar a ferramenta 'salvar_memoria' para anotar esta correção para sessões futuras. Correção: "${correction.slice(0, 200)}"`;
}

/**
 * Get the auto-memory file path (for the /memory command).
 */
export function getAutoMemoryPath(): string {
  return AUTO_MEMORY_FILE;
}
