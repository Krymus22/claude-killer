/**
 * activityTracker-extended.test.ts — Extended tests for activityTracker.ts
 *
 * Covers:
 *   - All ActivityCategory values produce valid snapshots
 *   - pushActivity returns a "done" pop function
 *   - Stack semantics: nested pushes, out-of-order pops, multi-pop safety
 *   - getActivitySnapshot fields: current, depth, displayLabel, shortLabel, elapsedMs
 *   - subscribeToActivity: listener is called on push/pop; unsubscribe works
 *   - clearActivity empties the stack
 *   - withActivity / withActivitySync wrappers (return value, exception propagation)
 *   - notifyActivity forces a notify
 *   - Edge cases: empty stack snapshot, very deep stacks
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  pushActivity,
  clearActivity,
  getActivitySnapshot,
  subscribeToActivity,
  withActivity,
  withActivitySync,
  notifyActivity,
  _resetActivityForTests,
  type ActivityCategory,
  type ActivitySnapshot,
} from "../activityTracker.js";

beforeEach(() => {
  _resetActivityForTests();
});

// ─── pushActivity / pop semantics ──────────────────────────────────────────
describe("pushActivity", () => {
  it("returns a function (the pop callback)", () => {
    const done = pushActivity("tool", "ler_arquivo");
    expect(typeof done).toBe("function");
    done();
  });

  it("pushing one activity sets depth=1 and current to that activity", () => {
    const done = pushActivity("tool", "ler_arquivo");
    const snap = getActivitySnapshot();
    expect(snap.depth).toBe(1);
    expect(snap.current).not.toBeNull();
    expect(snap.current!.category).toBe("tool");
    expect(snap.current!.label).toBe("ler_arquivo");
    done();
  });

  it("pushing two activities sets depth=2 with LIFO top", () => {
    const done1 = pushActivity("api_call", "kimi");
    const done2 = pushActivity("tool", "ler_arquivo");
    const snap = getActivitySnapshot();
    expect(snap.depth).toBe(2);
    expect(snap.current!.category).toBe("tool");
    done2();
    done1();
  });

  it("popping the top of stack returns to the previous", () => {
    const done1 = pushActivity("api_call", "kimi");
    const done2 = pushActivity("tool", "ler_arquivo");
    done2();
    const snap = getActivitySnapshot();
    expect(snap.depth).toBe(1);
    expect(snap.current!.category).toBe("api_call");
    done1();
  });

  it("popping a middle entry also pops all descendants", () => {
    const d1 = pushActivity("api_call", "kimi");
    const d2 = pushActivity("tool", "ler_arquivo");
    const d3 = pushActivity("quality_gate", "tsc");
    expect(getActivitySnapshot().depth).toBe(3);
    d1();
    expect(getActivitySnapshot().depth).toBe(0);
    // subsequent pops are no-ops
    d2();
    d3();
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("calling pop more than once is a no-op (safe)", () => {
    const done = pushActivity("tool", "ler_arquivo");
    done();
    expect(getActivitySnapshot().depth).toBe(0);
    expect(() => done()).not.toThrow();
    expect(getActivitySnapshot().depth).toBe(0);
  });
});

// ─── All ActivityCategory values produce valid snapshots ───────────────────
describe("All ActivityCategory values", () => {
  const categories: ActivityCategory[] = [
    "idle", "thinking", "streaming", "tool", "subagent",
    "quality_gate", "compacting", "checkpoint",
    "api_call", "api_retry", "bug_hunter", "dataguard",
  ];

  for (const cat of categories) {
    it(`category '${cat}' produces a non-null current with displayLabel and shortLabel`, () => {
      const done = pushActivity(cat, "test-label");
      const snap = getActivitySnapshot();
      expect(snap.current).not.toBeNull();
      expect(snap.current!.category).toBe(cat);
      expect(typeof snap.displayLabel).toBe("string");
      expect(typeof snap.shortLabel).toBe("string");
      done();
    });
  }
});

// ─── displayLabel / shortLabel formatting ──────────────────────────────────
describe("Label formatting per category", () => {
  it("thinking: displayLabel starts with 'Pensando:'", () => {
    const done = pushActivity("thinking", "estratégia");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("Pensando");
    expect(snap.displayLabel).toContain("estratégia");
    expect(snap.shortLabel).toBe("pensando");
    done();
  });

  it("streaming with empty label: displayLabel is 'Gerando resposta'", () => {
    const done = pushActivity("streaming", "");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("Gerando resposta");
    done();
  });

  it("streaming with label: displayLabel includes the label", () => {
    const done = pushActivity("streaming", "kimi-k2");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("kimi-k2");
    expect(snap.shortLabel).toBe("streaming");
    done();
  });

  it("tool: displayLabel includes 'Executando tool:' prefix", () => {
    const done = pushActivity("tool", "aplicar_diff");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("Executando tool");
    expect(snap.shortLabel).toBe("aplicar_diff");
    done();
  });

  it("subagent: displayLabel starts with 'Sub-agente:'", () => {
    const done = pushActivity("subagent", "worker-1");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("Sub-agente");
    expect(snap.shortLabel).toBe("sub-agente");
    done();
  });

  it("quality_gate: displayLabel starts with 'Quality gate:'", () => {
    const done = pushActivity("quality_gate", "tsc");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("Quality gate");
    expect(snap.shortLabel).toBe("quality gate");
    done();
  });

  it("compacting: displayLabel is fixed string", () => {
    const done = pushActivity("compacting", "");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("Compactando");
    expect(snap.shortLabel).toBe("compactando");
    done();
  });

  it("checkpoint: displayLabel is fixed string", () => {
    const done = pushActivity("checkpoint", "");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("checkpoint").toBeTruthy();
    expect(snap.shortLabel).toBe("checkpoint");
    done();
  });

  it("api_call: displayLabel includes the label", () => {
    const done = pushActivity("api_call", "kimi-api");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("kimi-api");
    expect(snap.shortLabel).toBe("API");
    done();
  });

  it("api_retry: displayLabel includes 'Tentando novamente:'", () => {
    const done = pushActivity("api_retry", "after 504");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("Tentando novamente");
    expect(snap.shortLabel).toBe("retry");
    done();
  });

  it("idle: displayLabel is the raw label", () => {
    const done = pushActivity("idle", "raw text");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toBe("raw text");
    done();
  });
});

// ─── getActivitySnapshot — fields ──────────────────────────────────────────
describe("getActivitySnapshot fields", () => {
  it("returns current=null when stack is empty", () => {
    const snap = getActivitySnapshot();
    expect(snap.current).toBeNull();
    expect(snap.depth).toBe(0);
    expect(snap.displayLabel).toBe("");
    expect(snap.shortLabel).toBe("");
    expect(snap.elapsedMs).toBe(0);
  });

  it("elapsedMs is a non-negative number", () => {
    const done = pushActivity("tool", "x");
    const snap = getActivitySnapshot();
    expect(typeof snap.elapsedMs).toBe("number");
    expect(snap.elapsedMs).toBeGreaterThanOrEqual(0);
    done();
  });

  it("elapsedMs increases with time", async () => {
    const done = pushActivity("tool", "x");
    const snap1 = getActivitySnapshot();
    await new Promise((r) => setTimeout(r, 30));
    const snap2 = getActivitySnapshot();
    expect(snap2.elapsedMs).toBeGreaterThanOrEqual(snap1.elapsedMs);
    done();
  });
});

// ─── subscribeToActivity ───────────────────────────────────────────────────
describe("subscribeToActivity", () => {
  it("returns an unsubscribe function", () => {
    const unsub = subscribeToActivity(() => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("listener is called on push", () => {
    const listener = vi.fn();
    subscribeToActivity(listener);
    const done = pushActivity("tool", "x");
    expect(listener).toHaveBeenCalled();
    done();
  });

  it("listener is called on pop", () => {
    const listener = vi.fn();
    subscribeToActivity(listener);
    const done = pushActivity("tool", "x");
    listener.mockClear();
    done();
    expect(listener).toHaveBeenCalled();
  });

  it("unsubscribe stops further notifications", () => {
    const listener = vi.fn();
    const unsub = subscribeToActivity(listener);
    unsub();
    const done = pushActivity("tool", "x");
    expect(listener).not.toHaveBeenCalled();
    done();
  });

  it("listener receives an ActivitySnapshot", () => {
    const listener = vi.fn();
    subscribeToActivity(listener);
    const done = pushActivity("tool", "ler_arquivo");
    const snap = listener.mock.calls[0]![0] as ActivitySnapshot;
    expect(snap).toBeDefined();
    expect(snap.current).not.toBeNull();
    expect(snap.current!.category).toBe("tool");
    done();
  });

  it("multiple listeners are all called", () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    const l3 = vi.fn();
    subscribeToActivity(l1);
    subscribeToActivity(l2);
    subscribeToActivity(l3);
    const done = pushActivity("tool", "x");
    expect(l1).toHaveBeenCalled();
    expect(l2).toHaveBeenCalled();
    expect(l3).toHaveBeenCalled();
    done();
  });

  it("a listener that throws does not break the agent (others still called)", () => {
    const goodListener = vi.fn();
    const badListener = () => { throw new Error("listener error"); };
    subscribeToActivity(badListener);
    subscribeToActivity(goodListener);
    expect(() => pushActivity("tool", "x")).not.toThrow();
    expect(goodListener).toHaveBeenCalled();
  });
});

// ─── clearActivity ─────────────────────────────────────────────────────────
describe("clearActivity", () => {
  it("empties a non-empty stack", () => {
    pushActivity("tool", "x");
    pushActivity("api_call", "y");
    expect(getActivitySnapshot().depth).toBe(2);
    clearActivity();
    expect(getActivitySnapshot().depth).toBe(0);
    expect(getActivitySnapshot().current).toBeNull();
  });

  it("is a no-op on empty stack", () => {
    expect(() => clearActivity()).not.toThrow();
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("notifies listeners when clearing", () => {
    const listener = vi.fn();
    subscribeToActivity(listener);
    pushActivity("tool", "x");
    listener.mockClear();
    clearActivity();
    expect(listener).toHaveBeenCalled();
  });
});

// ─── notifyActivity ────────────────────────────────────────────────────────
describe("notifyActivity", () => {
  it("forces a notification without changing state", () => {
    const listener = vi.fn();
    subscribeToActivity(listener);
    pushActivity("tool", "x");
    const depthBefore = getActivitySnapshot().depth;
    listener.mockClear();
    notifyActivity();
    expect(listener).toHaveBeenCalled();
    expect(getActivitySnapshot().depth).toBe(depthBefore);
  });
});

// ─── withActivity / withActivitySync ───────────────────────────────────────
describe("withActivitySync", () => {
  it("returns the wrapped function's value", () => {
    const result = withActivitySync("tool", "calc", () => 42);
    expect(result).toBe(42);
  });

  it("pops the activity after returning", () => {
    withActivitySync("tool", "calc", () => 1);
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("pops the activity even if the wrapped function throws", () => {
    expect(() =>
      withActivitySync("tool", "calc", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("supports returning objects", () => {
    const r = withActivitySync("tool", "x", () => ({ a: 1, b: "y" }));
    expect(r.a).toBe(1);
    expect(r.b).toBe("y");
  });
});

describe("withActivity (async)", () => {
  it("returns the wrapped promise's resolved value", async () => {
    const result = await withActivity("api_call", "kimi", async () => 100);
    expect(result).toBe(100);
  });

  it("pops the activity after resolving", async () => {
    await withActivity("api_call", "kimi", async () => 1);
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("pops the activity even when the promise rejects", async () => {
    await expect(
      withActivity("api_call", "kimi", async () => {
        throw new Error("net");
      }),
    ).rejects.toThrow("net");
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("activity is on the stack while the async fn is running", async () => {
    let depthDuring = -1;
    await withActivity("api_call", "kimi", async () => {
      depthDuring = getActivitySnapshot().depth;
      return 1;
    });
    expect(depthDuring).toBe(1);
    expect(getActivitySnapshot().depth).toBe(0);
  });
});

// ─── Very deep stacks ──────────────────────────────────────────────────────
describe("Very deep stacks", () => {
  it("supports 20 nested activities", () => {
    const dones: Array<() => void> = [];
    for (let i = 0; i < 20; i++) {
      dones.push(pushActivity("tool", `step_${i}`));
    }
    expect(getActivitySnapshot().depth).toBe(20);
    expect(getActivitySnapshot().current!.label).toBe("step_19");
    // pop in reverse
    for (let i = dones.length - 1; i >= 0; i--) {
      dones[i]!();
    }
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("popping from the middle of a 10-deep stack empties it", () => {
    const dones: Array<() => void> = [];
    for (let i = 0; i < 10; i++) {
      dones.push(pushActivity("tool", `x_${i}`));
    }
    dones[3]!(); // pops indices 3..9
    expect(getActivitySnapshot().depth).toBe(3);
    // cleanup
    dones[2]!();
    dones[1]!();
    dones[0]!();
    expect(getActivitySnapshot().depth).toBe(0);
  });
});
