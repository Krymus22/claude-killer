/**
 * taskState-extended.test.ts — Cobertura adicional para taskState.ts.
 *
 * Os nomes pedidos (saveTaskState, loadTaskState, updateTaskProgress,
 * getActiveTasks) não correspondem exatamente aos do módulo. As funções
 * reais são: readTaskState, writeTaskState, updateTaskState,
 * appendTaskStateItem, markTaskItemDone, initTaskStateFromUserMessage,
 * getTaskStateSummary, clearTaskState. Este arquivo expande a cobertura
 * com casos edge não cobertos pelo taskState.test.ts.
 */

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
  readTaskState,
  writeTaskState,
  updateTaskState,
  appendTaskStateItem,
  markTaskItemDone,
  initTaskStateFromUserMessage,
  getTaskStateSummary,
  clearTaskState,
  type TaskState,
} from "../taskState.js";

let tmpProject: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "taskstate_ext_"));
  process.chdir(tmpProject);
});

afterEach(() => {
  process.chdir(originalCwd);
  try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch { /* ignore */ }
});

function freshState(extras: Partial<TaskState> = {}): TaskState {
  return {
    title: "Extended test",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    done: [],
    todo: [],
    decisions: [],
    bugs: [],
    dependencies: [],
    notes: "",
    ...extras,
  };
}

describe("taskState (extended)", () => {
  describe("writeTaskState (saveTaskState)", () => {
    it("escreve arquivo TASK_STATE.md no formato markdown esperado", () => {
      writeTaskState(freshState({
        title: "My Task",
        done: ["item 1"],
        todo: ["pending 1"],
        notes: "minhas notas",
      }));

      const filePath = path.join(tmpProject, ".claude-killer", "TASK_STATE.md");
      expect(fs.existsSync(filePath)).toBe(true);
      const raw = fs.readFileSync(filePath, "utf8");
      expect(raw).toContain("# TASK_STATE");
      expect(raw).toContain("**Title:** My Task");
      expect(raw).toContain("## Done");
      expect(raw).toContain("- [x] item 1");
      expect(raw).toContain("## Todo");
      expect(raw).toContain("- [ ] pending 1");
      expect(raw).toContain("## Notes");
      expect(raw).toContain("minhas notas");
    });

    it("cria o diretório .claude-killer automaticamente se não existir", () => {
      const dir = path.join(tmpProject, ".claude-killer");
      expect(fs.existsSync(dir)).toBe(false);
      writeTaskState(freshState());
      expect(fs.existsSync(dir)).toBe(true);
    });
  });

  describe("readTaskState (loadTaskState)", () => {
    it("retorna null quando o arquivo é vazio", () => {
      const dir = path.join(tmpProject, ".claude-killer");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "TASK_STATE.md"), "", "utf8");
      expect(readTaskState()).toBeNull();
    });

    it("retorna null quando o arquivo contém só whitespace", () => {
      const dir = path.join(tmpProject, ".claude-killer");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "TASK_STATE.md"), "   \n\t  \n", "utf8");
      expect(readTaskState()).toBeNull();
    });

    it("preenche defaults quando markdown está incompleto (faltam seções)", () => {
      const dir = path.join(tmpProject, ".claude-killer");
      fs.mkdirSync(dir, { recursive: true });
      // Markdown sem nenhuma seção conhecida
      fs.writeFileSync(path.join(dir, "TASK_STATE.md"), "# TASK_STATE\n\nTexto aleatório sem seções\n", "utf8");
      const state = readTaskState();
      expect(state).not.toBeNull();
      expect(state!.done).toEqual([]);
      expect(state!.todo).toEqual([]);
      expect(state!.decisions).toEqual([]);
      expect(state!.bugs).toEqual([]);
      expect(state!.dependencies).toEqual([]);
    });

    it("preserva timestamps Started e Updated do markdown", () => {
      const dir = path.join(tmpProject, ".claude-killer");
      fs.mkdirSync(dir, { recursive: true });
      const md = [
        "# TASK_STATE",
        "",
        "**Title:** Test",
        "**Started:** 2025-01-01T10:00:00.000Z",
        "**Updated:** 2025-06-15T12:30:00.000Z",
        "",
        "## Done",
        "_(nothing yet)_",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(dir, "TASK_STATE.md"), md, "utf8");
      const state = readTaskState();
      expect(state!.startedAt).toBe("2025-01-01T10:00:00.000Z");
      expect(state!.updatedAt).toBe("2025-06-15T12:30:00.000Z");
    });
  });

  describe("updateTaskState (updateTaskProgress)", () => {
    it("aceita patch vazio e só atualiza updatedAt preservando startedAt", () => {
      writeTaskState(freshState({
        startedAt: "2025-01-01T00:00:00.000Z",
        title: "Original",
      }));
      const updated = updateTaskState({});
      expect(updated.title).toBe("Original");
      expect(updated.startedAt).toBe("2025-01-01T00:00:00.000Z");
      // updatedAt deve ter sido alterado
      expect(updated.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
    });

    it("mescla múltiplos campos simultaneamente mantendo os não fornecidos", () => {
      writeTaskState(freshState({
        title: "Original",
        done: ["old"],
        todo: ["pending"],
        decisions: ["dec1"],
        bugs: ["bug1"],
      }));
      const updated = updateTaskState({
        title: "Novo título",
        todo: ["new todo"],
        notes: "notas novas",
      });
      expect(updated.title).toBe("Novo título");
      expect(updated.todo).toEqual(["new todo"]);
      expect(updated.notes).toBe("notas novas");
      // Campos não fornecidos são preservados
      expect(updated.done).toEqual(["old"]);
      expect(updated.decisions).toEqual(["dec1"]);
      expect(updated.bugs).toEqual(["bug1"]);
    });
  });

  describe("getTaskStateSummary (getActiveTasks equivalente)", () => {
    it("omite seções vazias do sumário", () => {
      writeTaskState(freshState({
        title: "T",
        done: ["d1"],
        todo: [],
        decisions: [],
        bugs: [],
        dependencies: [],
        notes: "",
      }));
      const summary = getTaskStateSummary()!;
      // Done deve aparecer (tem 1 item)
      expect(summary).toContain("d1");
      // Seções vazias não devem aparecer no sumário
      expect(summary).not.toContain("Todo:");
      expect(summary).not.toContain("Decisions:");
      expect(summary).not.toContain("Bugs:");
      expect(summary).not.toContain("Dependencies:");
    });

    it("inclui Notes somente quando preenchidas", () => {
      writeTaskState(freshState({ notes: "anotação importante" }));
      const summary = getTaskStateSummary()!;
      expect(summary).toContain("anotação importante");
      expect(summary).toContain("Notes:");
    });
  });

  describe("appendTaskStateItem — edge case", () => {
    it("cria estado novo quando chamado sem estado prévio", () => {
      const result = appendTaskStateItem("todo", "novo item sem estado anterior");
      expect(result.todo).toEqual(["novo item sem estado anterior"]);
      expect(readTaskState()!.todo).toEqual(["novo item sem estado anterior"]);
    });
  });

  describe("markTaskItemDone — edge case", () => {
    it("retorna estado vazio quando não há estado prévio (BH15 LOW 1 fix: não cria arquivo)", () => {
      const result = markTaskItemDone("qualquer coisa");
      expect(result.todo).toEqual([]);
      expect(result.done).toEqual([]);
      // BH15 LOW 1 fix: previously, calling markTaskItemDone with no
      // existing state file would CREATE a new (empty) state file as a
      // side effect. The fix returns a default in-memory state WITHOUT
      // writing to disk — so readTaskState() should still be null.
      expect(readTaskState()).toBeNull();
    });

    it("remove apenas o primeiro item que casa com a substring", () => {
      writeTaskState(freshState({
        todo: ["Implement auth login", "Implement auth logout", "Outra tarefa"],
        done: [],
      }));
      const updated = markTaskItemDone("auth");
      // Deve remover o primeiro "Implement auth login"
      expect(updated.todo).toEqual(["Implement auth logout", "Outra tarefa"]);
      expect(updated.done).toEqual(["Implement auth login"]);
    });
  });

  describe("initTaskStateFromUserMessage — edge case", () => {
    it("trunca título em 100 caracteres e troca newlines por espaços", () => {
      const longMessage = "Linha 1\nLinha 2\n" + "x".repeat(120);
      initTaskStateFromUserMessage(longMessage);
      const state = readTaskState();
      expect(state).not.toBeNull();
      expect(state!.title.length).toBeLessThanOrEqual(100);
      expect(state!.title).not.toContain("\n");
      // Deve conter "Linha 1 Linha 2"
      expect(state!.title).toContain("Linha 1 Linha 2");
    });

    it("usa título default quando userMessage é vazia ou só whitespace", () => {
      initTaskStateFromUserMessage("   \n\t  ");
      const state = readTaskState();
      expect(state).not.toBeNull();
      expect(state!.title).toBe("Untitled task");
    });
  });

  describe("clearTaskState — edge case", () => {
    it("não lança erro quando diretório .claude-killer não existe", () => {
      const dir = path.join(tmpProject, ".claude-killer");
      expect(fs.existsSync(dir)).toBe(false);
      expect(() => clearTaskState()).not.toThrow();
    });
  });
});
