/**
 * thinkTool-extended.test.ts — Extended tests for thinkTool.ts
 *
 * Covers:
 *   - THINK_CATEGORIES constant contents
 *   - THINK_TOOL_DEFINITION shape and required fields
 *   - think() return shape (ThinkResult: confirmed + message)
 *   - Category selection (categoria vs category vs default)
 *   - Message includes checklist and depth instructions
 *   - Length and char counting in message
 *   - Edge cases: empty pensamento, very long pensamento, missing category
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
}));

import { think, THINK_CATEGORIES, THINK_TOOL_DEFINITION, type ThinkArgs } from "../thinkTool.js";

describe("THINK_CATEGORIES", () => {
  it("is an array of strings", () => {
    expect(Array.isArray(THINK_CATEGORIES)).toBe(true);
    expect(THINK_CATEGORIES.length).toBeGreaterThan(0);
    expect(THINK_CATEGORIES.every((c) => typeof c === "string")).toBe(true);
  });

  it("includes the 'planning' category", () => {
    expect(THINK_CATEGORIES).toContain("planning");
  });

  it("includes the 'pre_edit' category", () => {
    expect(THINK_CATEGORIES).toContain("pre_edit");
  });

  it("includes the 'pre_research' category", () => {
    expect(THINK_CATEGORIES).toContain("pre_research");
  });

  it("includes the 'pre_response' category", () => {
    expect(THINK_CATEGORIES).toContain("pre_response");
  });

  it("includes the 'debugging' category", () => {
    expect(THINK_CATEGORIES).toContain("debugging");
  });

  it("includes the 'architecture' category", () => {
    expect(THINK_CATEGORIES).toContain("architecture");
  });

  it("includes the 'general' category", () => {
    expect(THINK_CATEGORIES).toContain("general");
  });

  it("has exactly 7 categories", () => {
    expect(THINK_CATEGORIES.length).toBe(7);
  });
});

describe("THINK_TOOL_DEFINITION", () => {
  it("has type 'function'", () => {
    expect(THINK_TOOL_DEFINITION.type).toBe("function");
  });

  it("has function.name 'pensar'", () => {
    expect(THINK_TOOL_DEFINITION.function.name).toBe("pensar");
  });

  it("has a non-empty description string", () => {
    expect(typeof THINK_TOOL_DEFINITION.function.description).toBe("string");
    expect(THINK_TOOL_DEFINITION.function.description.length).toBeGreaterThan(0);
  });

  it("declares parameters as type 'object'", () => {
    expect(THINK_TOOL_DEFINITION.function.parameters.type).toBe("object");
  });

  it("declares 'pensamento' property in parameters", () => {
    expect(THINK_TOOL_DEFINITION.function.parameters.properties.pensamento).toBeDefined();
    expect(THINK_TOOL_DEFINITION.function.parameters.properties.pensamento.type).toBe("string");
  });

  it("declares 'categoria' property in parameters", () => {
    expect(THINK_TOOL_DEFINITION.function.parameters.properties.categoria).toBeDefined();
  });

  it("requires 'pensamento'", () => {
    expect(THINK_TOOL_DEFINITION.function.parameters.required).toContain("pensamento");
  });

  it("lists an enum for categoria matching THINK_CATEGORIES", () => {
    const enumValues = THINK_TOOL_DEFINITION.function.parameters.properties.categoria.enum;
    expect(Array.isArray(enumValues)).toBe(true);
    for (const cat of THINK_CATEGORIES) {
      expect(enumValues).toContain(cat);
    }
  });
});

describe("think() — return shape", () => {
  it("returns an object with `confirmed` and `message` fields", async () => {
    const result = await think({ pensamento: "hello" });
    expect(result).toHaveProperty("confirmed");
    expect(result).toHaveProperty("message");
  });

  it("always returns confirmed=true", async () => {
    const result = await think({ pensamento: "x" });
    expect(result.confirmed).toBe(true);
  });

  it("returns message as a non-empty string", async () => {
    const result = await think({ pensamento: "x" });
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("message includes [THINK] marker", async () => {
    const result = await think({ pensamento: "x" });
    expect(result.message).toContain("[THINK]");
  });

  it("message includes the char count of pensamento", async () => {
    const long = "a".repeat(100);
    const result = await think({ pensamento: long });
    expect(result.message).toContain("100");
  });
});

describe("think() — category selection", () => {
  it("uses 'categoria' when provided", async () => {
    const result = await think({ pensamento: "x", categoria: "planning" });
    expect(result.message).toContain("planning");
  });

  it("uses 'category' when 'categoria' is not provided", async () => {
    const result = await think({ pensamento: "x", category: "debugging" });
    expect(result.message).toContain("debugging");
  });

  it("prefers 'categoria' over 'category' when both are provided", async () => {
    const result = await think({
      pensamento: "x",
      categoria: "planning",
      category: "debugging",
    });
    expect(result.message).toContain("planning");
    expect(result.message).not.toContain(", debugging,");
  });

  it("defaults to 'general' when no category is provided", async () => {
    const result = await think({ pensamento: "x" });
    expect(result.message).toContain("general");
  });
});

describe("think() — checklist injection by category", () => {
  it("planning: message includes checklist", async () => {
    const result = await think({ pensamento: "x", categoria: "planning" });
    expect(result.message.length).toBeGreaterThan(20);
    expect(result.message.toLowerCase()).toMatch(/checklist|plano/);
  });

  it("pre_edit: message includes checklist", async () => {
    const result = await think({ pensamento: "x", categoria: "pre_edit" });
    expect(result.message.length).toBeGreaterThan(20);
    expect(result.message.toLowerCase()).toMatch(/checklist|anti-bug/);
  });

  it("pre_research: message includes checklist", async () => {
    const result = await think({ pensamento: "x", categoria: "pre_research" });
    expect(result.message.length).toBeGreaterThan(20);
  });

  it("pre_response: message includes checklist", async () => {
    const result = await think({ pensamento: "x", categoria: "pre_response" });
    expect(result.message.length).toBeGreaterThan(20);
  });

  it("debugging: message includes checklist", async () => {
    const result = await think({ pensamento: "x", categoria: "debugging" });
    expect(result.message.length).toBeGreaterThan(20);
  });

  it("architecture: message includes checklist", async () => {
    const result = await think({ pensamento: "x", categoria: "architecture" });
    expect(result.message.length).toBeGreaterThan(20);
  });

  it("general: message includes checklist", async () => {
    const result = await think({ pensamento: "x", categoria: "general" });
    expect(result.message.length).toBeGreaterThan(20);
  });

  it("unknown category falls back to general checklist", async () => {
    const result = await think({ pensamento: "x", categoria: "totally-unknown" });
    expect(result.message).toContain("totally-unknown");
    // General checklist content is included
    expect(result.message.length).toBeGreaterThan(20);
  });
});

describe("think() — depth instruction", () => {
  it("message includes 'Próximo passo' instruction", async () => {
    const result = await think({ pensamento: "x" });
    expect(result.message).toMatch(/Próximo passo/i);
  });
});

describe("think() — edge cases", () => {
  it("handles empty pensamento", async () => {
    const result = await think({ pensamento: "" });
    expect(result.confirmed).toBe(true);
    expect(result.message).toContain("0 chars");
  });

  it("handles very long pensamento", async () => {
    const long = "x".repeat(10_000);
    const result = await think({ pensamento: long });
    expect(result.confirmed).toBe(true);
    expect(result.message).toContain("10000 chars");
  });

  it("handles pensamento with unicode characters", async () => {
    const unicode = "olá mundo 🚀 日本語";
    const result = await think({ pensamento: unicode });
    expect(result.confirmed).toBe(true);
    // message includes the character count (length)
    expect(result.message).toContain(String(unicode.length));
  });

  it("handles pensamento with newlines", async () => {
    const multiline = "line1\nline2\nline3";
    const result = await think({ pensamento: multiline });
    expect(result.confirmed).toBe(true);
    expect(result.message).toContain(String(multiline.length));
  });

  it("handles pensamento with only whitespace", async () => {
    const result = await think({ pensamento: "    " });
    expect(result.confirmed).toBe(true);
  });

  it("ThinkArgs accepts the documented shape", async () => {
    const args: ThinkArgs = { pensamento: "test", categoria: "planning" };
    const result = await think(args);
    expect(result.confirmed).toBe(true);
  });

  it("ThinkArgs accepts 'category' alias too", async () => {
    const args: ThinkArgs = { pensamento: "test", category: "debugging" };
    const result = await think(args);
    expect(result.confirmed).toBe(true);
  });

  it("ThinkArgs accepts both 'categoria' and 'category'", async () => {
    const args: ThinkArgs = {
      pensamento: "test",
      categoria: "planning",
      category: "debugging",
    };
    const result = await think(args);
    expect(result.confirmed).toBe(true);
  });
});

describe("think() — multiple invocations are independent", () => {
  it("two calls return separate result objects", async () => {
    const r1 = await think({ pensamento: "a" });
    const r2 = await think({ pensamento: "b" });
    expect(r1).not.toBe(r2);
    expect(r1.message).toContain("1 chars");
    expect(r2.message).toContain("1 chars");
  });
});
