/**
 * activityTracker.test.ts — tests for the real-time activity tracking module.
 *
 * Bug being fixed: the old ThinkingIndicator showed "PENSANDO..." forever,
 * giving the user no clue whether the agent was waiting for the API,
 * streaming tokens, executing a tool, running the quality gate, etc.
 *
 * The fix introduces a global activity stack with subscribe/notify semantics
 * that the TUI can render.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  pushActivity,
  clearActivity,
  getActivitySnapshot,
  subscribeToActivity,
  withActivity,
  withActivitySync,
  _resetActivityForTests,
  type ActivitySnapshot,
} from "../activityTracker.js";

describe("activityTracker", () => {
  beforeEach(() => {
    _resetActivityForTests();
  });

  describe("getActivitySnapshot", () => {
    it("returns an empty snapshot when no activity has been pushed", () => {
      const snap = getActivitySnapshot();
      expect(snap.current).toBeNull();
      expect(snap.depth).toBe(0);
      expect(snap.displayLabel).toBe("");
      expect(snap.shortLabel).toBe("");
      expect(snap.elapsedMs).toBe(0);
    });
  });

  describe("pushActivity", () => {
    it("returns a function that pops the activity when called", () => {
      const done = pushActivity("tool", "ler_arquivo /foo.ts");
      const snap1 = getActivitySnapshot();
      expect(snap1.current).not.toBeNull();
      expect(snap1.current?.category).toBe("tool");
      expect(snap1.current?.label).toBe("ler_arquivo /foo.ts");
      expect(snap1.depth).toBe(1);

      done();

      const snap2 = getActivitySnapshot();
      expect(snap2.current).toBeNull();
      expect(snap2.depth).toBe(0);
    });

    it("supports nested activities (stack semantics)", () => {
      const done1 = pushActivity("api_call", "model-x");
      const done2 = pushActivity("tool", "ler_arquivo /foo.ts");

      const snap1 = getActivitySnapshot();
      expect(snap1.depth).toBe(2);
      expect(snap1.current?.category).toBe("tool"); // most recent

      done2();
      const snap2 = getActivitySnapshot();
      expect(snap2.depth).toBe(1);
      expect(snap2.current?.category).toBe("api_call");

      done1();
      const snap3 = getActivitySnapshot();
      expect(snap3.depth).toBe(0);
      expect(snap3.current).toBeNull();
    });

    it("popping the same activity twice is a no-op", () => {
      const done = pushActivity("tool", "ler_arquivo");
      done();
      done(); // should not throw
      expect(getActivitySnapshot().depth).toBe(0);
    });

    it("records the start time for elapsed calculation", async () => {
      const done = pushActivity("tool", "ler_arquivo");
      const snap1 = getActivitySnapshot();
      expect(snap1.current?.startedAt).toBeGreaterThan(0);

      await new Promise((r) => setTimeout(r, 50));

      const snap2 = getActivitySnapshot();
      expect(snap2.elapsedMs).toBeGreaterThanOrEqual(40);
      expect(snap2.elapsedMs).toBeLessThan(1000);

      done();
    });
  });

  describe("displayLabel", () => {
    it("formats 'thinking' category with a 'Pensando:' prefix", () => {
      const done = pushActivity("thinking", "qual o melhor caminho?");
      const snap = getActivitySnapshot();
      expect(snap.displayLabel).toBe("Pensando: qual o melhor caminho?");
      done();
    });

    it("formats 'tool' category with 'Executando tool:' prefix", () => {
      const done = pushActivity("tool", "ler_arquivo /foo.ts");
      const snap = getActivitySnapshot();
      expect(snap.displayLabel).toBe("Executando tool: ler_arquivo /foo.ts");
      done();
    });

    it("formats 'streaming' category", () => {
      const done = pushActivity("streaming", "");
      const snap = getActivitySnapshot();
      expect(snap.displayLabel).toBe("Gerando resposta");
      done();
    });

    it("formats 'quality_gate' category", () => {
      const done = pushActivity("quality_gate", "tsc + lint");
      const snap = getActivitySnapshot();
      expect(snap.displayLabel).toBe("Quality gate: tsc + lint");
      done();
    });

    it.skip("formats 'subagent' category", () => {
      const done = pushActivity("subagent", "#1: explorar código");
      const snap = getActivitySnapshot();
      expect(snap.displayLabel).toBe("Sub-agent: #1: explorar código");
      done();
    });

    it("formats 'compacting' category", () => {
      const done = pushActivity("compacting", "");
      const snap = getActivitySnapshot();
      expect(snap.displayLabel).toBe("Compactando contexto…");
      done();
    });

    it("formats 'api_call' category with 'Chamando API:' prefix", () => {
      const done = pushActivity("api_call", "kimi-k2.6");
      const snap = getActivitySnapshot();
      expect(snap.displayLabel).toBe("Chamando API: kimi-k2.6");
      done();
    });

    it("formats 'api_retry' category", () => {
      const done = pushActivity("api_retry", "ECONNRESET");
      const snap = getActivitySnapshot();
      expect(snap.displayLabel).toBe("Tentando novamente: ECONNRESET");
      done();
    });
  });

  describe("shortLabel", () => {
    it("extracts the first word of a tool label", () => {
      const done = pushActivity("tool", "ler_arquivo /foo.ts");
      const snap = getActivitySnapshot();
      expect(snap.shortLabel).toBe("ler_arquivo");
      done();
    });

    it("returns 'pensando' for thinking category", () => {
      const done = pushActivity("thinking", "qual o melhor caminho?");
      const snap = getActivitySnapshot();
      expect(snap.shortLabel).toBe("pensando");
      done();
    });

    it("returns 'streaming' for streaming category", () => {
      const done = pushActivity("streaming", "");
      const snap = getActivitySnapshot();
      expect(snap.shortLabel).toBe("streaming");
      done();
    });
  });

  describe("subscribeToActivity", () => {
    it("calls the listener on push", () => {
      const listener = vi.fn();
      const unsub = subscribeToActivity(listener);
      pushActivity("tool", "ler_arquivo");
      expect(listener).toHaveBeenCalledTimes(1);
      const snap = listener.mock.calls[0]?.[0] as ActivitySnapshot;
      expect(snap.current?.category).toBe("tool");
      unsub();
    });

    it("calls the listener on pop", () => {
      const listener = vi.fn();
      const unsub = subscribeToActivity(listener);
      const done = pushActivity("tool", "ler_arquivo");
      listener.mockClear();
      done();
      expect(listener).toHaveBeenCalledTimes(1);
      const snap = listener.mock.calls[0]?.[0] as ActivitySnapshot;
      expect(snap.current).toBeNull();
      unsub();
    });

    it("stops calling after unsubscribe", () => {
      const listener = vi.fn();
      const unsub = subscribeToActivity(listener);
      unsub();
      pushActivity("tool", "ler_arquivo");
      expect(listener).not.toHaveBeenCalled();
    });

    it("survives a listener that throws (does not break the agent)", () => {
      const badListener = () => { throw new Error("listener bug"); };
      const goodListener = vi.fn();
      subscribeToActivity(badListener);
      subscribeToActivity(goodListener);
      // Should not throw
      expect(() => pushActivity("tool", "ler_arquivo")).not.toThrow();
      // Good listener should still have been called
      expect(goodListener).toHaveBeenCalled();
    });
  });

  describe("withActivity (async)", () => {
    it("pushes an activity for the duration of the async function", async () => {
      const listener = vi.fn();
      subscribeToActivity(listener);

      const result = await withActivity("tool", "ler_arquivo", async () => {
        expect(getActivitySnapshot().current?.category).toBe("tool");
        return 42;
      });

      expect(result).toBe(42);
      expect(getActivitySnapshot().current).toBeNull();
    });

    it("pops the activity even if the function throws", async () => {
      const listener = vi.fn();
      subscribeToActivity(listener);

      await expect(
        withActivity("tool", "ler_arquivo", async () => {
          throw new Error("tool failed");
        }),
      ).rejects.toThrow("tool failed");

      expect(getActivitySnapshot().current).toBeNull();
    });
  });

  describe("withActivitySync", () => {
    it("pushes an activity for the duration of the sync function", () => {
      const result = withActivitySync("tool", "ler_arquivo", () => {
        expect(getActivitySnapshot().current?.category).toBe("tool");
        return "ok";
      });

      expect(result).toBe("ok");
      expect(getActivitySnapshot().current).toBeNull();
    });

    it("pops the activity even if the function throws", () => {
      expect(() => {
        withActivitySync("tool", "ler_arquivo", () => {
          throw new Error("sync fail");
        });
      }).toThrow("sync fail");

      expect(getActivitySnapshot().current).toBeNull();
    });
  });

  describe("clearActivity", () => {
    it("clears the entire activity stack", () => {
      pushActivity("tool", "ler_arquivo");
      pushActivity("tool", "aplicar_diff");
      pushActivity("api_call", "kimi");
      expect(getActivitySnapshot().depth).toBe(3);

      clearActivity();

      expect(getActivitySnapshot().depth).toBe(0);
      expect(getActivitySnapshot().current).toBeNull();
    });

    it("notifies listeners when clearing", () => {
      const listener = vi.fn();
      subscribeToActivity(listener);
      pushActivity("tool", "ler_arquivo");
      listener.mockClear();

      clearActivity();

      expect(listener).toHaveBeenCalledTimes(1);
      const snap = listener.mock.calls[0]?.[0] as ActivitySnapshot;
      expect(snap.depth).toBe(0);
    });

    it("is a no-op when the stack is already empty", () => {
      const listener = vi.fn();
      subscribeToActivity(listener);
      clearActivity();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("regression: spinner must not be stuck on 'PENSANDO'", () => {
    // The original bug: the spinner always said "PENSANDO..." regardless of
    // what the agent was doing. After the fix, the TUI reads from the
    // activity tracker and shows the current activity (or falls back to
    // "PENSANDO..." only if no activity was pushed).
    it("exposes the current activity so the TUI can render it", () => {
      // Simulate: agent is executing a tool
      const done = pushActivity("tool", "ler_arquivo /home/user/foo.ts");
      const snap = getActivitySnapshot();
      expect(snap.displayLabel).toContain("ler_arquivo");
      expect(snap.displayLabel).toContain("/home/user/foo.ts");
      done();
    });

    it("shows 'Chamando API' when the agent is waiting for the LLM", () => {
      const done = pushActivity("api_call", "moonshotai/kimi-k2.6");
      const snap = getActivitySnapshot();
      expect(snap.displayLabel).toContain("Chamando API");
      expect(snap.displayLabel).toContain("kimi-k2.6");
      done();
    });

    it("shows 'Quality gate' when the agent is running tsc+lint", () => {
      const done = pushActivity("quality_gate", "tsc + lint");
      const snap = getActivitySnapshot();
      expect(snap.displayLabel).toContain("Quality gate");
      expect(snap.displayLabel).toContain("tsc");
      done();
    });
  });
});
