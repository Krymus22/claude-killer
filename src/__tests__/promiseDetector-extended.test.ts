/**
 * promiseDetector-extended.test.ts — Extended tests for promiseDetector.ts
 *
 * Covers:
 *   - detectFalsePromise: empty message, refusal phrases, both PT and EN promise phrases
 *   - detectFalsePromise: when tools/files > 0, no detection
 *   - shouldBlockForFalsePromise: counter increment, max retries cap
 *   - resetFalsePromiseCounter / getFalsePromiseCount
 *   - buildFalsePromiseRejectionMessage returns a non-empty string
 *   - MAX_FALSE_PROMISE_RETRIES constant
 *   - PromiseDetectionResult type contract
 *   - Edge cases: word boundary matches, mixed-case, partial matches
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
}));

// Minimal i18n mock: t() returns a string containing its args
vi.mock("../i18n.js", () => ({
  t: vi.fn((key: string, ...args: any[]) => `[${key}] ${args.join(" ")}`),
  default: { t: vi.fn((key: string, ...args: any[]) => `[${key}] ${args.join(" ")}`) },
}));

import {
  detectFalsePromise,
  shouldBlockForFalsePromise,
  buildFalsePromiseRejectionMessage,
  resetFalsePromiseCounter,
  getFalsePromiseCount,
  MAX_FALSE_PROMISE_RETRIES,
  type PromiseDetectionResult,
} from "../promiseDetector.js";

describe("detectFalsePromise — basic states", () => {
  it("returns detected=false for an empty message", () => {
    const r = detectFalsePromise("", 0, 0);
    expect(r.detected).toBe(false);
    expect(r.matchedPhrase).toBeNull();
  });

  it("returns detected=false when tools were called", () => {
    const r = detectFalsePromise("vou verificar isso", 1, 0);
    expect(r.detected).toBe(false);
    expect(r.reason).toMatch(/actions were taken/);
  });

  it("returns detected=false when files were touched", () => {
    const r = detectFalsePromise("vou verificar isso", 0, 1);
    expect(r.detected).toBe(false);
    expect(r.reason).toMatch(/actions were taken/);
  });

  it("returns detected=false when both tools and files > 0", () => {
    const r = detectFalsePromise("let me check", 3, 2);
    expect(r.detected).toBe(false);
  });

  it("returns detected=false for messages with no promise phrase", () => {
    const r = detectFalsePromise("Here is the answer to your question.", 0, 0);
    expect(r.detected).toBe(false);
    expect(r.reason).toMatch(/no promise phrase detected/);
  });
});

describe("detectFalsePromise — refusal phrases (skip detection)", () => {
  it("returns detected=false for PT 'não posso'", () => {
    const r = detectFalsePromise("Desculpe, não posso fazer isso agora.", 0, 0);
    expect(r.detected).toBe(false);
    expect(r.reason).toMatch(/refusal phrase/);
  });

  it("returns detected=false for PT 'nao consegui'", () => {
    const r = detectFalsePromise("Nao consegui acessar o arquivo.", 0, 0);
    expect(r.detected).toBe(false);
  });

  it("returns detected=false for EN 'i can't'", () => {
    const r = detectFalsePromise("Sorry, I can't do that.", 0, 0);
    expect(r.detected).toBe(false);
  });

  it("returns detected=false for EN 'i cannot'", () => {
    const r = detectFalsePromise("I cannot complete this task.", 0, 0);
    expect(r.detected).toBe(false);
  });

  it("returns detected=false for EN 'unable to'", () => {
    const r = detectFalsePromise("Unable to read the file.", 0, 0);
    expect(r.detected).toBe(false);
  });

  it("returns detected=false for EN 'unfortunately'", () => {
    const r = detectFalsePromise("Unfortunately, the file does not exist.", 0, 0);
    expect(r.detected).toBe(false);
  });

  it("returns detected=false for PT 'infelizmente não'", () => {
    const r = detectFalsePromise("Infelizmente não foi possível concluir.", 0, 0);
    expect(r.detected).toBe(false);
  });
});

describe("detectFalsePromise — PT promise phrases", () => {
  it("detects 'vou investigar'", () => {
    const r = detectFalsePromise("Achei algo, vou investigar.", 0, 0);
    expect(r.detected).toBe(true);
    expect(r.matchedPhrase).toBe("vou investigar");
  });

  it("detects 'vou verificar'", () => {
    const r = detectFalsePromise("Vou verificar isso para você.", 0, 0);
    expect(r.detected).toBe(true);
    expect(r.matchedPhrase).toBe("vou verificar");
  });

  it("detects 'vou checar'", () => {
    const r = detectFalsePromise("Vou checar o arquivo.", 0, 0);
    expect(r.detected).toBe(true);
  });

  it("detects 'deixa eu ver'", () => {
    const r = detectFalsePromise("Deixa eu ver o que posso fazer.", 0, 0);
    expect(r.detected).toBe(true);
  });

  it("detects 'aguarde um momento'", () => {
    const r = detectFalsePromise("Aguarde um momento por favor.", 0, 0);
    expect(r.detected).toBe(true);
  });
});

describe("detectFalsePromise — EN promise phrases", () => {
  it("detects 'i'll check'", () => {
    const r = detectFalsePromise("I'll check that for you.", 0, 0);
    expect(r.detected).toBe(true);
    expect(r.matchedPhrase).toBe("i'll check");
  });

  it("detects 'let me look'", () => {
    const r = detectFalsePromise("Let me look into this.", 0, 0);
    expect(r.detected).toBe(true);
  });

  it("detects 'give me a moment'", () => {
    const r = detectFalsePromise("Give me a moment to think.", 0, 0);
    expect(r.detected).toBe(true);
  });

  it("detects 'hold on'", () => {
    const r = detectFalsePromise("Hold on, I'll get back to you.", 0, 0);
    expect(r.detected).toBe(true);
  });

  it("detects 'i will investigate'", () => {
    const r = detectFalsePromise("I will investigate this issue.", 0, 0);
    expect(r.detected).toBe(true);
  });
});

describe("detectFalsePromise — case-insensitivity", () => {
  it("matches uppercased PT promise", () => {
    const r = detectFalsePromise("VOU VERIFICAR AGORA", 0, 0);
    expect(r.detected).toBe(true);
  });

  it("matches mixed-case EN promise", () => {
    const r = detectFalsePromise("Let Me Look at this.", 0, 0);
    expect(r.detected).toBe(true);
  });
});

describe("detectFalsePromise — word boundaries", () => {
  it("does NOT match 'vou' alone as a promise (substring)", () => {
    // 'eu vou' alone is not in PROMISE_PHRASES — there's no false positive here
    const r = detectFalsePromise("eu vou explicar", 0, 0);
    // 'explicar' isn't a promise verb in the list, so no detection
    expect(r.detected).toBe(false);
  });

  it("matches a promise phrase embedded in a longer sentence", () => {
    const r = detectFalsePromise("Ok, vou verificar isso para você e retorno logo.", 0, 0);
    expect(r.detected).toBe(true);
  });
});

describe("detectFalsePromise — return type", () => {
  it("returns an object with detected, matchedPhrase, reason", () => {
    const r = detectFalsePromise("test", 0, 0);
    expect(r).toHaveProperty("detected");
    expect(r).toHaveProperty("matchedPhrase");
    expect(r).toHaveProperty("reason");
  });

  it("reason is always a non-empty string", () => {
    const r1 = detectFalsePromise("", 0, 0);
    const r2 = detectFalsePromise("no promises here", 0, 0);
    const r3 = detectFalsePromise("let me check", 0, 0);
    expect(r1.reason.length).toBeGreaterThan(0);
    expect(r2.reason.length).toBeGreaterThan(0);
    expect(r3.reason.length).toBeGreaterThan(0);
  });
});

describe("shouldBlockForFalsePromise — counter and blocking", () => {
  beforeEach(() => {
    resetFalsePromiseCounter();
  });

  it("returns block=false when no promise detected", () => {
    const r = shouldBlockForFalsePromise("nothing to see", 0, 0);
    expect(r.block).toBe(false);
  });

  it("returns block=true on first detection", () => {
    const r = shouldBlockForFalsePromise("let me check", 0, 0);
    expect(r.block).toBe(true);
    expect(r.rejectionMessage).toBeDefined();
    expect(typeof r.rejectionMessage).toBe("string");
    expect(r.rejectionMessage!.length).toBeGreaterThan(0);
  });

  it("increments counter on each detection", () => {
    expect(getFalsePromiseCount()).toBe(0);
    shouldBlockForFalsePromise("let me check", 0, 0);
    expect(getFalsePromiseCount()).toBe(1);
    shouldBlockForFalsePromise("i'll look", 0, 0);
    expect(getFalsePromiseCount()).toBe(2);
  });

  it("stops blocking after MAX_FALSE_PROMISE_RETRIES detections", () => {
    // First two: blocked
    expect(shouldBlockForFalsePromise("let me check", 0, 0).block).toBe(true);
    expect(shouldBlockForFalsePromise("i'll look", 0, 0).block).toBe(true);
    // Third: not blocked (cap reached)
    const r3 = shouldBlockForFalsePromise("i'll verify", 0, 0);
    expect(r3.block).toBe(false);
    expect(r3.reason).toMatch(/max false-promise retries/);
  });

  it("does not increment counter when no detection", () => {
    shouldBlockForFalsePromise("just a normal reply", 0, 0);
    expect(getFalsePromiseCount()).toBe(0);
  });

  it("does not block when tools were called (no detection)", () => {
    const r = shouldBlockForFalsePromise("let me check", 1, 0);
    expect(r.block).toBe(false);
  });
});

describe("resetFalsePromiseCounter / getFalsePromiseCount", () => {
  beforeEach(() => {
    resetFalsePromiseCounter();
  });

  it("resetFalsePromiseCounter sets counter to 0", () => {
    shouldBlockForFalsePromise("let me check", 0, 0);
    expect(getFalsePromiseCount()).toBeGreaterThan(0);
    resetFalsePromiseCounter();
    expect(getFalsePromiseCount()).toBe(0);
  });

  it("getFalsePromiseCount returns a number", () => {
    expect(typeof getFalsePromiseCount()).toBe("number");
  });

  it("resetFalsePromiseCounter does not throw", () => {
    expect(() => resetFalsePromiseCounter()).not.toThrow();
  });
});

describe("buildFalsePromiseRejectionMessage", () => {
  it("returns a non-empty string", () => {
    const msg = buildFalsePromiseRejectionMessage("let me check", 1);
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });

  it("includes the matched phrase", () => {
    const msg = buildFalsePromiseRejectionMessage("let me check", 1);
    expect(msg).toContain("let me check");
  });

  it("includes the attempt number", () => {
    const msg = buildFalsePromiseRejectionMessage("let me check", 2);
    expect(msg).toContain("2");
  });

  it("handles a '?' placeholder when phrase is unknown", () => {
    const msg = buildFalsePromiseRejectionMessage("?", 1);
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });
});

describe("MAX_FALSE_PROMISE_RETRIES constant", () => {
  it("is a number", () => {
    expect(typeof MAX_FALSE_PROMISE_RETRIES).toBe("number");
  });

  it("equals 2 (per source comment)", () => {
    expect(MAX_FALSE_PROMISE_RETRIES).toBe(2);
  });
});

describe("PromiseDetectionResult type contract", () => {
  it("has the documented shape", () => {
    const r: PromiseDetectionResult = {
      detected: false,
      matchedPhrase: null,
      reason: "test",
    };
    expect(r.detected).toBe(false);
    expect(r.matchedPhrase).toBeNull();
    expect(r.reason).toBe("test");
  });

  it("accepts detected=true with a matched phrase", () => {
    const r: PromiseDetectionResult = {
      detected: true,
      matchedPhrase: "let me check",
      reason: "promise detected",
    };
    expect(r.detected).toBe(true);
    expect(r.matchedPhrase).toBe("let me check");
  });
});
