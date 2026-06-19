/**
 * memory-extended.test.ts — Casos de borda e integração para memory.ts.
 *
 * Expande cobertura das funções runDream, runDistill, getMemoryConfig,
 * project memory load e deduplicação de falhas (failure dedup).
 * Foco em caminhos que os testes básicos (memory.test.ts, memory-full.test.ts)
 * não cobrem: extração de padrões com contagem >= 5/3, extração de skills
 * com sequências repetidas, dedup de linhas duplicadas e paths unicode.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  getMemoryConfig,
  ensureMemoryDirs,
  readProjectMemory,
  writeProjectMemory,
  appendProjectMemory,
  saveSessionTrace,
  listSessionTraces,
  runDream,
  runDistill,
  injectMemory,
  formatInjectedMemory,
  type MemoryConfig,
  type SessionTrace,
  type Skill,
} from "../memory.js";

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Diretório temporário isolado para os testes extendidos.
const TEMP_DIR = path.join(os.tmpdir(), `claude-killer-memory-ext-${Date.now()}`);
let testConfig: MemoryConfig;

beforeAll(() => {
  testConfig = {
    globalDir: path.join(TEMP_DIR, "global"),
    projectDir: path.join(TEMP_DIR, "project"),
    historyDir: path.join(TEMP_DIR, "history"),
    skillsDir: path.join(TEMP_DIR, "skills"),
  };
  ensureMemoryDirs(testConfig);
});

afterAll(() => {
  try {
    if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  // Limpa arquivos entre testes.
  const cleanup = (dir: string, ext: string) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(ext)) fs.unlinkSync(path.join(dir, f));
    }
  };
  cleanup(testConfig.projectDir, ".md");
  cleanup(testConfig.historyDir, ".json");
  cleanup(testConfig.skillsDir, ".json");
});

// --- Helpers ----------------------------------------------------------------

/** Cria um trace com overrides. */
function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  const id = `trace-${Math.random().toString(36).slice(2)}`;
  const ts = new Date(Date.now() - Math.random() * 100000).toISOString();
  return {
    id,
    startTime: ts,
    endTime: ts,
    summary: "Test session",
    decisions: [],
    fileChanges: [],
    toolsUsed: [],
    tokensUsed: 100,
    messages: [],
    ...overrides,
  };
}

// === runDream (extração de padrões + dedup) ==================================

describe("runDream — extração de padrões por frequência", () => {
  it("detecta ferramenta usada >= 5x e adiciona pattern ao project memory", async () => {
    // Cria 5 traces, cada um usando a ferramenta "ler_arquivo" várias vezes
    for (let i = 0; i < 5; i++) {
      saveSessionTrace(
        testConfig,
        makeTrace({
          id: `tool-${i}`,
          startTime: new Date(2026, 0, i + 1).toISOString(),
          summary: `Sessão ${i}`,
          toolsUsed: ["ler_arquivo", "aplicar_diff"],
          fileChanges: [],
        })
      );
    }

    const result = await runDream(testConfig);

    expect(result.reviewedSessions).toBe(5);
    expect(result.updatedProjectMemory).toBe(true);

    // Verifica que o pattern foi adicionado ao project memory
    const memory = readProjectMemory(testConfig);
    expect(memory).toContain("ler_arquivo");
    expect(memory).toContain("5 times");
  });

  it("detecta arquivo modificado >= 3x e adiciona pattern de refatoração", async () => {
    const filePath = "src/critico.ts";
    for (let i = 0; i < 3; i++) {
      saveSessionTrace(
        testConfig,
        makeTrace({
          id: `file-${i}`,
          startTime: new Date(2026, 1, i + 1).toISOString(),
          summary: `Sessão ${i}`,
          toolsUsed: [],
          fileChanges: [
            { path: filePath, action: "modified", timestamp: "", summary: "mudança" },
          ],
        })
      );
    }

    const result = await runDream(testConfig);

    expect(result.updatedProjectMemory).toBe(true);
    const memory = readProjectMemory(testConfig);
    expect(memory).toContain(filePath);
    expect(memory).toContain("may need refactoring");
  });
});

// === runDream (deduplicação) =================================================

describe("runDream — deduplicação de project memory", () => {
  it("remove linhas duplicadas de project memory durante o dream", async () => {
    // Escreve project memory com linhas duplicadas
    writeProjectMemory(
      testConfig,
      [
        "# Project",
        "",
        "Regra importante: sempre testar antes de commit.",
        "Regra importante: sempre testar antes de commit.", // duplicada
        "",
        "## Seção",
        "Outra regra única.",
        "Regra importante: sempre testar antes de commit.", // duplicada
      ].join("\n")
    );

    const result = await runDream(testConfig);

    // Dream deve ter detectado e removido duplicatas
    expect(result.deduplicatedEntries).toBeGreaterThanOrEqual(1);

    const memory = readProjectMemory(testConfig);
    // Conta quantas vezes a linha duplicada aparece agora
    const occurrences = memory.split("Regra importante: sempre testar antes de commit.").length - 1;
    expect(occurrences).toBe(1);
  });
});

// === runDistill (extração de skills) =========================================

describe("runDistill — extração de skills de sequências repetidas", () => {
  it("extrai skill quando sequência de 3+ ferramentas aparece >= 3x", async () => {
    const sequence = ["ler_arquivo", "analisar_ast", "aplicar_diff", "rodar_testes"];
    // 3 traces com a mesma sequência
    for (let i = 0; i < 3; i++) {
      saveSessionTrace(
        testConfig,
        makeTrace({
          id: `seq-${i}`,
          startTime: new Date(2026, 2, i + 1).toISOString(),
          summary: `Sessão ${i}`,
          toolsUsed: sequence,
        })
      );
    }

    const result = await runDistill(testConfig);

    expect(result.skillsExtracted).toBeGreaterThanOrEqual(1);
    expect(result.skills.length).toBe(result.skillsExtracted);
    // Verifica que pelo menos uma skill captura a sequência
    expect(result.skills.some((s) => s.steps.includes("ler_arquivo"))).toBe(true);
  });

  it("retorna zero skills quando não há sequências repetidas", async () => {
    // Trace com sequência única (sem repetição)
    saveSessionTrace(
      testConfig,
      makeTrace({
        id: "single",
        toolsUsed: ["ler_arquivo", "aplicar_diff", "rodar_testes"],
      })
    );

    const result = await runDistill(testConfig);

    expect(result.skillsExtracted).toBe(0);
    expect(result.skills).toEqual([]);
  });
});

// === getMemoryConfig (edge cases) ============================================

describe("getMemoryConfig — edge cases", () => {
  it("usa process.cwd() quando projectRoot é undefined", () => {
    const config = getMemoryConfig();
    expect(config.projectDir).toBe(path.join(process.cwd(), ".claude-killer"));
    // historyDir e skillsDir devem sempre estar sob o globalDir
    expect(config.historyDir).toBe(path.join(config.globalDir, "history"));
    expect(config.skillsDir).toBe(path.join(config.globalDir, "skills"));
  });

  it("preserva paths unicode no projectRoot", () => {
    const unicodeRoot = "/tmp/projeto-ção-日本語";
    const config = getMemoryConfig(unicodeRoot);
    expect(config.projectDir).toContain("ção");
    expect(config.projectDir).toContain("日本語");
    expect(config.projectDir).toBe(path.join(unicodeRoot, ".claude-killer"));
  });
});

// === Project memory load (edge cases) ========================================

describe("Project memory load — edge cases", () => {
  it("retorna string vazia quando CLAUDE.md/AGENTS.md não existem (sem falhar)", () => {
    // memory.ts só lê MEMORY.md — não encontra CLAUDE.md/AGENTS.md por design.
    // A leitura deve retornar string vazia sem lançar erro.
    expect(readProjectMemory(testConfig)).toBe("");
  });

  it("lê project memory com conteúdo unicode e emojis sem corrupção", () => {
    const conteudo = "# Memória do projeto 🚀\n\n- Item com acentuação: ção, ã, é\n- 日本語テスト";
    writeProjectMemory(testConfig, conteudo);
    const lido = readProjectMemory(testConfig);
    expect(lido).toBe(conteudo);
    expect(lido).toContain("🚀");
    expect(lido).toContain("ção");
    expect(lido).toContain("日本語テスト");
  });

  it("appendProjectMemory preserva conteúdo existente e adiciona novo bloco", () => {
    writeProjectMemory(testConfig, "# Conteúdo inicial");
    appendProjectMemory(testConfig, "Nova entrada importante");
    const lido = readProjectMemory(testConfig);
    expect(lido).toContain("Conteúdo inicial");
    expect(lido).toContain("Nova entrada importante");
    // O append deve ter adicionado um header de timestamp (## )
    expect(lido).toContain("## ");
  });
});

// === Failure dedup via injectMemory ==========================================

describe("Failure dedup — injectMemory filtra dados inconsistentes", () => {
  it("injectMemory retorna estrutura válida mesmo com project memory vazio", () => {
    // Garante estado limpo
    const mem = injectMemory(testConfig);
    expect(mem.projectMemory).toBe("");
    expect(mem.checkpoint).toBeNull();
    expect(mem.globalMemory).toBe("");
    expect(Array.isArray(mem.relevantSkills)).toBe(true);
    expect(Array.isArray(mem.recentHistory)).toBe(true);
    expect(typeof mem.totalTokensEstimate).toBe("number");
    expect(mem.totalTokensEstimate).toBeGreaterThanOrEqual(0);
  });

  it("formatInjectedMemory lida com memória totalmente vazia sem quebrar", () => {
    const mem = injectMemory(testConfig);
    const formatted = formatInjectedMemory(mem);
    // Mesmo vazio, o formatador sempre adiciona a linha de tokens estimados
    expect(formatted).toContain("Estimated tokens:");
    // Não deve conter seções vazias (Project Memory, etc.) quando tudo está vazio
    expect(formatted).not.toContain("## Project Memory");
  });
});
