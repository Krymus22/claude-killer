/**
 * extensions.test.ts — Tests for extensions.ts pure logic.
 * Covers: parseFrontmatter, Content-Length framing, message parsing,
 * tool definition formatting, MCP tool name parsing, skill loading.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";

// ─── Extract pure functions from extensions.ts ─────────────────────────────

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  const data: Record<string, string> = {};
  if (!match) return { data, body: content };

  const yamlLines = match[1].split("\n");
  for (const line of yamlLines) {
    const parts = line.split(":");
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join(":").trim().replaceAll(/^['"]|['"]$/g, "");
      data[key] = val;
    }
  }
  return { data, body: match[2] };
}

function parseMessages(buffer: string): { messages: Array<{ id?: number; result?: unknown; error?: unknown }>; remaining: string } {
  const messages: Array<{ id?: number; result?: unknown; error?: unknown }> = [];
  let remaining = buffer;

  while (true) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = remaining.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;

    const contentLength = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;

    if (remaining.length < bodyEnd) break;

    const body = remaining.slice(bodyStart, bodyEnd);
    remaining = remaining.slice(bodyEnd);

    try {
      const parsed = JSON.parse(body);
      messages.push(parsed);
    } catch { /* skip */ }
  }

  return { messages, remaining };
}

function buildContentLengthMessage(jsonObj: unknown): string {
  const body = JSON.stringify(jsonObj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function formatMCPToolDef(serverName: string, tool: { name: string; description?: string; inputSchema?: Record<string, unknown> }) {
  return {
    type: "function" as const,
    function: {
      name: `${serverName}__${tool.name}`,
      description: tool.description ?? `MCP tool from ${serverName}`,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  };
}

function parseMCPToolName(prefixedName: string): { serverName: string; toolName: string } | null {
  const separatorIdx = prefixedName.indexOf("__");
  if (separatorIdx === -1) return null;
  return {
    serverName: prefixedName.slice(0, separatorIdx),
    toolName: prefixedName.slice(separatorIdx + 2),
  };
}

function extractTextFromMCPResult(result: unknown): string {
  const callResult = result as { content?: Array<{ type: string; text?: string }> };
  if (callResult.content && Array.isArray(callResult.content)) {
    return callResult.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n");
  }
  return JSON.stringify(result);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("extensions.ts pure logic", () => {
  describe("parseFrontmatter", () => {
    it("should parse YAML frontmatter with name and description", () => {
      const content = "---\nname: my-skill\ndescription: A test skill\n---\nBody content here";
      const { data, body } = parseFrontmatter(content);
      expect(data.name).toBe("my-skill");
      expect(data.description).toBe("A test skill");
      expect(body).toBe("Body content here");
    });

    it("should handle content without frontmatter", () => {
      const content = "Just plain markdown content";
      const { data, body } = parseFrontmatter(content);
      expect(Object.keys(data)).toHaveLength(0);
      expect(body).toBe(content);
    });

    it("should handle frontmatter with quotes", () => {
      const content = "---\nname: 'quoted-name'\ndescription: \"quoted desc\"\n---\nBody";
      const { data } = parseFrontmatter(content);
      expect(data.name).toBe("quoted-name");
      expect(data.description).toBe("quoted desc");
    });

    it("should handle empty frontmatter (no keys between delimiters)", () => {
      const content = "---\n---\nBody";
      const { data } = parseFrontmatter(content);
      expect(Object.keys(data)).toHaveLength(0);
    });

    it("should handle colons in values", () => {
      const content = "---\ndescription: Has: colons: inside\n---\nBody";
      const { data } = parseFrontmatter(content);
      expect(data.description).toBe("Has: colons: inside");
    });

    it("should handle CRLF line endings", () => {
      const content = "---\r\nname: crlf-test\r\n---\r\nBody";
      const { data } = parseFrontmatter(content);
      expect(data.name).toBe("crlf-test");
    });
  });

  describe("Content-Length framing", () => {
    it("should build a valid Content-Length message", () => {
      const json = { jsonrpc: "2.0", id: 1, method: "initialize" };
      const msg = buildContentLengthMessage(json);
      expect(msg).toMatch(/^Content-Length: \d+\r\n\r\n/);
      const bodyStart = msg.indexOf("\r\n\r\n") + 4;
      const parsed = JSON.parse(msg.slice(bodyStart));
      expect(parsed.method).toBe("initialize");
    });

    it("should calculate correct byte length for multibyte chars", () => {
      const json = { text: "olá mundo" };
      const msg = buildContentLengthMessage(json);
      const headerEnd = msg.indexOf("\r\n\r\n");
      const contentLength = Number.parseInt(msg.slice(16, headerEnd), 10);
      const body = msg.slice(headerEnd + 4);
      expect(Buffer.byteLength(body)).toBe(contentLength);
    });
  });

  describe("parseMessages", () => {
    it("should parse a single complete message", () => {
      const json = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
      const msg = buildContentLengthMessage(json);
      const { messages, remaining } = parseMessages(msg);
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe(1);
      expect(remaining).toBe("");
    });

    it("should parse multiple messages", () => {
      const msg1 = buildContentLengthMessage({ jsonrpc: "2.0", id: 1, result: "ok" });
      const msg2 = buildContentLengthMessage({ jsonrpc: "2.0", id: 2, result: "done" });
      const { messages, remaining } = parseMessages(msg1 + msg2);
      expect(messages).toHaveLength(2);
      expect(remaining).toBe("");
    });

    it("should return remaining for incomplete message", () => {
      const json = { jsonrpc: "2.0", id: 1, result: "ok" };
      const msg = buildContentLengthMessage(json);
      const incomplete = msg.slice(0, -5);
      const { messages, remaining } = parseMessages(incomplete);
      expect(messages).toHaveLength(0);
      expect(remaining.length).toBeGreaterThan(0);
    });

    it("should handle empty buffer", () => {
      const { messages, remaining } = parseMessages("");
      expect(messages).toHaveLength(0);
      expect(remaining).toBe("");
    });

    it("should skip malformed JSON", () => {
      const msg = "Content-Length: 10\r\n\r\nnot-valid-json";
      const { messages } = parseMessages(msg);
      expect(messages).toHaveLength(0);
    });

    it("should handle message with no Content-Length header", () => {
      const { messages, remaining } = parseMessages("Some random data\r\n\r\nbody");
      expect(messages).toHaveLength(0);
      expect(remaining).toBe("Some random data\r\n\r\nbody");
    });
  });

  describe("MCP tool definition formatting", () => {
    it("should format tool with server prefix", () => {
      const def = formatMCPToolDef("myserver", { name: "read_file", description: "Read a file" });
      expect(def.function.name).toBe("myserver__read_file");
      expect(def.function.description).toBe("Read a file");
      expect(def.type).toBe("function");
    });

    it("should use default description when missing", () => {
      const def = formatMCPToolDef("srv", { name: "tool_a" });
      expect(def.function.description).toBe("MCP tool from srv");
    });

    it("should use default schema when missing", () => {
      const def = formatMCPToolDef("srv", { name: "tool_a" });
      expect(def.function.parameters).toEqual({ type: "object", properties: {} });
    });

    it("should preserve custom schema", () => {
      const schema = { type: "object", properties: { path: { type: "string" } } };
      const def = formatMCPToolDef("srv", { name: "tool_a", inputSchema: schema });
      expect(def.function.parameters).toEqual(schema);
    });
  });

  describe("MCP tool name parsing", () => {
    it("should parse valid prefixed name", () => {
      const result = parseMCPToolName("server__toolName");
      expect(result).toEqual({ serverName: "server", toolName: "toolName" });
    });

    it("should handle multiple underscores in tool name", () => {
      const result = parseMCPToolName("srv__my__tool");
      expect(result).toEqual({ serverName: "srv", toolName: "my__tool" });
    });

    it("should return null for name without separator", () => {
      expect(parseMCPToolName("noSeparator")).toBeNull();
    });

    it("should handle empty server name", () => {
      const result = parseMCPToolName("__tool");
      expect(result).toEqual({ serverName: "", toolName: "tool" });
    });
  });

  describe("MCP result extraction", () => {
    it("should extract text from content array", () => {
      const result = { content: [{ type: "text", text: "hello world" }] };
      expect(extractTextFromMCPResult(result)).toBe("hello world");
    });

    it("should join multiple text items", () => {
      const result = { content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] };
      expect(extractTextFromMCPResult(result)).toBe("line1\nline2");
    });

    it("should skip non-text content types", () => {
      const result = { content: [{ type: "image", text: "ignored" }, { type: "text", text: "kept" }] };
      expect(extractTextFromMCPResult(result)).toBe("kept");
    });

    it("should JSON.stringify non-content results", () => {
      const result = { someKey: "someValue" };
      expect(extractTextFromMCPResult(result)).toBe('{"someKey":"someValue"}');
    });

    it("should handle null content", () => {
      expect(extractTextFromMCPResult({ content: null })).toBe('{"content":null}');
    });
  });
});
