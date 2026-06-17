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
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "taskstate_test_"));
  process.chdir(tmpProject);
});

afterEach(() => {
  process.chdir(originalCwd);
  try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch { /* ignore */ }
});

function freshState(): TaskState {
  return {
    title: "Test task",
    updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    done: [],
    todo: [],
    decisions: [],
    bugs: [],
    dependencies: [],
    notes: "",
  };
}

describe("taskState", () => {
  describe("writeTaskState / readTaskState roundtrip", () => {
    it("writes and reads back a TaskState", () => {
      const state = freshState();
      state.done = ["did A", "did B"];
      state.todo = ["do C", "do D"];
      state.decisions = ["use Approach X"];
      state.bugs = ["foo.ts:42 has off-by-one"];
      state.dependencies = ["need libfoo >= 1.2"];
      state.notes = "Important context here";
      writeTaskState(state);

      const read = readTaskState();
      expect(read).not.toBeNull();
      expect(read!.title).toBe("Test task");
      expect(read!.done).toEqual(["did A", "did B"]);
      expect(read!.todo).toEqual(["do C", "do D"]);
      expect(read!.decisions).toEqual(["use Approach X"]);
      expect(read!.bugs).toEqual(["foo.ts:42 has off-by-one"]);
      expect(read!.dependencies).toEqual(["need libfoo >= 1.2"]);
      expect(read!.notes).toBe("Important context here");
    });

    it("returns null when no TASK_STATE.md exists", () => {
      expect(readTaskState()).toBeNull();
    });
  });

  describe("updateTaskState (merge)", () => {
    it("creates a new state when none exists", () => {
      const updated = updateTaskState({ title: "Brand new", done: ["a"] });
      expect(updated.title).toBe("Brand new");
      expect(updated.done).toEqual(["a"]);
      expect(updated.todo).toEqual([]);
    });

    it("merges patch into existing state", () => {
      writeTaskState({ ...freshState(), done: ["old"], todo: ["x"] });
      const updated = updateTaskState({ done: ["new"] });
      expect(updated.done).toEqual(["new"]); // replaced, not appended
      expect(updated.todo).toEqual(["x"]); // untouched
    });

    it("updates updatedAt timestamp", async () => {
      writeTaskState({ ...freshState() });
      const before = readTaskState()!.updatedAt;
      await new Promise((r) => setTimeout(r, 10));
      updateTaskState({ notes: "hi" });
      const after = readTaskState()!.updatedAt;
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    });
  });

  describe("appendTaskStateItem", () => {
    it("appends to specified section", () => {
      appendTaskStateItem("done", "did X");
      appendTaskStateItem("done", "did Y");
      appendTaskStateItem("todo", "do Z");
      const state = readTaskState();
      expect(state!.done).toEqual(["did X", "did Y"]);
      expect(state!.todo).toEqual(["do Z"]);
    });

    it("does not add duplicates", () => {
      appendTaskStateItem("bugs", "bug in foo.ts:1");
      appendTaskStateItem("bugs", "bug in foo.ts:1");
      expect(readTaskState()!.bugs).toEqual(["bug in foo.ts:1"]);
    });
  });

  describe("markTaskItemDone", () => {
    it("moves a todo item to done by substring match", () => {
      writeTaskState({ ...freshState(), todo: ["Implement auth", "Write tests"], done: [] });
      const updated = markTaskItemDone("auth");
      expect(updated.done).toContain("Implement auth");
      expect(updated.todo).not.toContain("Implement auth");
      expect(updated.todo).toEqual(["Write tests"]);
    });

    it("is case-insensitive", () => {
      writeTaskState({ ...freshState(), todo: ["Implement AUTH"], done: [] });
      const updated = markTaskItemDone("auth");
      expect(updated.done).toContain("Implement AUTH");
    });

    it("does nothing when substring doesn't match", () => {
      writeTaskState({ ...freshState(), todo: ["X"], done: [] });
      const updated = markTaskItemDone("nonexistent");
      expect(updated.todo).toEqual(["X"]);
      expect(updated.done).toEqual([]);
    });
  });

  describe("initTaskStateFromUserMessage", () => {
    it("creates a new TASK_STATE.md from a user message", () => {
      initTaskStateFromUserMessage("Fix the bug in parser.ts");
      const state = readTaskState();
      expect(state).not.toBeNull();
      expect(state!.title).toContain("Fix the bug");
    });

    it("does not overwrite an existing state", () => {
      writeTaskState({ ...freshState(), title: "Existing" });
      initTaskStateFromUserMessage("New task");
      expect(readTaskState()!.title).toBe("Existing");
    });
  });

  describe("getTaskStateSummary", () => {
    it("returns null when no state exists", () => {
      expect(getTaskStateSummary()).toBeNull();
    });

    it("returns a formatted summary with all sections", () => {
      writeTaskState({
        ...freshState(),
        done: ["d1"],
        todo: ["t1"],
        decisions: ["dec1"],
        bugs: ["b1"],
        dependencies: ["dep1"],
        notes: "my notes",
      });
      const s = getTaskStateSummary()!;
      expect(s).toContain("TASK_STATE");
      expect(s).toContain("d1");
      expect(s).toContain("t1");
      expect(s).toContain("dec1");
      expect(s).toContain("b1");
      expect(s).toContain("dep1");
      expect(s).toContain("my notes");
    });
  });

  describe("clearTaskState", () => {
    it("removes the TASK_STATE.md file", () => {
      writeTaskState({ ...freshState() });
      expect(readTaskState()).not.toBeNull();
      clearTaskState();
      expect(readTaskState()).toBeNull();
    });

    it("does not throw when file doesn't exist", () => {
      expect(() => clearTaskState()).not.toThrow();
    });
  });
});
