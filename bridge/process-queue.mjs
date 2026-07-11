#!/usr/bin/env node
/**
 * process-queue.mjs — Helper script for the bridge operator (the LLM acting
 * as the agent's brain, e.g., GLM 5.2 in a chat session).
 *
 * The operator runs this script (or just `cat`s the queue files manually)
 * to:
 *   1. List pending requests in the queue
 *   2. Show the contents of each request (with smart summarization to keep
 *      the operator's context manageable)
 *   3. After the operator generates a response, write it to the matching
 *      RESP-{id}.json file so the bridge server can return it to the CLI
 *
 * Usage:
 *   node process-queue.mjs list          # show pending requests
 *   node process-queue.mjs show <id>     # show full request (no truncation)
 *   node process-queue.mjs summary <id>  # show smart summary (default for list)
 *   node process-queue.mjs respond <id> <response-file>  # write response
 *   node process-queue.mjs respond-stdin <id>            # write response from stdin
 *
 * Response format (what the operator must produce):
 *   The response file must contain valid JSON in OpenAI chat completion
 *   format. Example:
 *
 *   {
 *     "id": "chatcmpl-bridge-<id>",
 *     "object": "chat.completion",
 *     "created": 1700000000,
 *     "model": "bridge-glm-5.2",
 *     "choices": [{
 *       "index": 0,
 *       "message": {
 *         "role": "assistant",
 *         "content": "Hello! How can I help?",
 *         "tool_calls": null
 *       },
 *       "finish_reason": "stop"
 *     }],
 *     "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
 *   }
 *
 *   If the assistant wants to call a tool, use:
 *
 *   "tool_calls": [{
 *     "id": "call_001",
 *     "type": "function",
 *     "function": { "name": "ler_arquivo", "arguments": "{\"path\":\"src/foo.ts\"}" }
 *   }],
 *   "finish_reason": "tool_calls"
 *
 * Smart summary (used by `list` and `summary <id>`):
 *   - System prompt: first 1500 chars + last 500 chars (with truncation marker)
 *   - Tool call index: 1 line per tool call (cumulative memory)
 *   - Last tool result: up to 5000 chars
 *   - Last 3 messages: full content
 *   - Current message to respond to: full content
 *
 * See bridge/README.md for the full architecture overview.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const QUEUE_DIR = process.env.BRIDGE_QUEUE_DIR ?? "/tmp/ck-queue";

function listPending() {
  if (!fs.existsSync(QUEUE_DIR)) {
    console.log(`Queue dir ${QUEUE_DIR} does not exist yet.`);
    return [];
  }
  const files = fs.readdirSync(QUEUE_DIR);
  const reqFiles = files.filter(f => f.startsWith("REQ-") && f.endsWith(".json"));
  const respFiles = new Set(files.filter(f => f.startsWith("RESP-") && f.endsWith(".json")).map(f => f.replace(/^RESP-/, "REQ-")));
  const pending = reqFiles.filter(f => !respFiles.has(f));
  return pending.map(f => ({
    id: f.replace(/^REQ-/, "").replace(/\.json$/, ""),
    path: path.join(QUEUE_DIR, f),
  }));
}

// BH-BRIDGE-2 CRITICAL-1 fix: validate request ID to prevent path traversal.
// An LLM operator reading queued messages (which include user input + tool
// results — prime prompt-injection territory) could be tricked into running
// `process-queue.mjs respond ../../../etc/cron.d/evil payload.json`.
// Without this check, `path.join` normalizes `..` and escapes the queue dir.
// Allowlist mirrors §17.8 rule 39 (isSafeFileName / isSafeModeName).
function isSafeId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id) && id.length > 0 && id.length < 128;
}

function assertSafeId(id) {
  if (!isSafeId(id)) {
    throw new Error(`Invalid request ID: "${id}". Only [A-Za-z0-9_-] allowed (max 128 chars).`);
  }
}

function readRequest(id) {
  assertSafeId(id);
  const reqPath = path.join(QUEUE_DIR, `REQ-${id}.json`);
  if (!fs.existsSync(reqPath)) {
    throw new Error(`Request ${id} not found at ${reqPath}`);
  }
  return JSON.parse(fs.readFileSync(reqPath, "utf8"));
}

function truncate(s, maxChars, where = "middle") {
  if (!s) return "";
  if (s.length <= maxChars) return s;
  // BH-BRIDGE-2 LOW-11 fix: guard against maxChars ≤ 50 (tailLen would be 0 or negative,
  // causing s.slice(-0) to return the entire string instead of truncating).
  if (maxChars < 50) return s.slice(0, maxChars);
  if (where === "end") {
    return s.slice(0, maxChars - 20) + "\n... [truncated]";
  }
  // middle
  const headLen = Math.floor(maxChars * 0.7);
  const tailLen = maxChars - headLen - 30;
  return s.slice(0, headLen) + `\n... [truncated ${s.length - maxChars} chars] ...\n` + s.slice(-tailLen);
}

function summarizeRequest(reqData) {
  const body = reqData.body;
  const messages = body.messages ?? [];
  const lines = [];

  lines.push(`=== REQUEST ${reqData.id} ===`);
  lines.push(`Received: ${reqData.receivedAt}`);
  lines.push(`Model: ${body.model ?? "(unspecified)"}`);
  lines.push(`Tools available: ${(body.tools ?? []).length}`);
  lines.push(`Messages: ${messages.length}`);
  lines.push("");

  // System prompt (first assistant/system message)
  const sysMsg = messages.find(m => m.role === "system" || m.role === "assistant");
  if (sysMsg) {
    const content = typeof sysMsg.content === "string" ? sysMsg.content : JSON.stringify(sysMsg.content);
    lines.push("=== SYSTEM PROMPT (resumido) ===");
    lines.push(truncate(content, 2000, "middle"));
    lines.push("");
  }

  // Tool call index (memory of what was done)
  const toolCalls = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const args = typeof tc.function?.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? {});
        toolCalls.push({ name: tc.function?.name, args: truncate(args, 100, "end") });
      }
    } else if (m.role === "tool") {
      // tool result — index it
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      toolCalls.push({ name: "(result)", args: truncate(content, 100, "end") });
    }
  }
  if (toolCalls.length > 0) {
    lines.push(`=== TOOL CALL HISTORY (${toolCalls.length} entries — memory) ===`);
    toolCalls.forEach((tc, i) => {
      lines.push(`${i + 1}. ${tc.name}: ${tc.args}`);
    });
    lines.push("");
  }

  // Last tool result (full, up to 5000 chars)
  const lastToolResult = [...messages].reverse().find(m => m.role === "tool");
  if (lastToolResult) {
    const content = typeof lastToolResult.content === "string"
      ? lastToolResult.content
      : JSON.stringify(lastToolResult.content);
    lines.push("=== LAST TOOL RESULT (até 5000 chars) ===");
    lines.push(truncate(content, 5000, "end"));
    lines.push("");
  }

  // Last 3 messages (full content)
  const last3 = messages.slice(-3);
  if (last3.length > 0) {
    lines.push("=== ÚLTIMAS 3 MENSAGENS (completas) ===");
    last3.forEach((m, i) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      lines.push(`--- msg[${messages.length - 3 + i}] role=${m.role} ---`);
      lines.push(truncate(content, 3000, "end"));
      if (m.tool_calls) {
        lines.push(`tool_calls: ${JSON.stringify(m.tool_calls).slice(0, 500)}`);
      }
    });
    lines.push("");
  }

  // Current message (last user/tool message that needs response)
  const current = messages[messages.length - 1];
  if (current) {
    lines.push("=== MENSAGEM ATUAL (preciso responder) ===");
    const content = typeof current.content === "string" ? current.content : JSON.stringify(current.content);
    lines.push(`role: ${current.role}`);
    lines.push(`content: ${truncate(content, 3000, "end")}`);
  }

  lines.push("");
  lines.push("=== END REQUEST ===");
  return lines.join("\n");
}

function showFullRequest(reqData) {
  return JSON.stringify(reqData, null, 2);
}

function writeResponse(id, responseJson) {
  // BH-BRIDGE-2 CRITICAL-1 fix: validate ID before any file operation.
  assertSafeId(id);
  const respPath = path.join(QUEUE_DIR, `RESP-${id}.json`);
  // Validate JSON
  let parsed;
  try {
    parsed = JSON.parse(responseJson);
  } catch (e) {
    throw new Error(`Invalid JSON in response: ${e.message}`);
  }
  // BH-BRIDGE-2 LOW-14 fix: stricter response validation (was only checking choices[]).
  // §17.4 rule 15: usage.total_tokens is required for context bar.
  if (!parsed.choices || !Array.isArray(parsed.choices) || parsed.choices.length === 0) {
    throw new Error("Response must have choices[] array (non-empty)");
  }
  const choice = parsed.choices[0];
  if (!choice.message || typeof choice.message !== "object") {
    throw new Error("Response choices[0] must have a message object");
  }
  if (choice.message.role !== "assistant") {
    throw new Error(`Response message.role must be "assistant" (got "${choice.message.role}")`);
  }
  const validFinishReasons = ["stop", "tool_calls", "length", "content_filter"];
  if (choice.finish_reason && !validFinishReasons.includes(choice.finish_reason)) {
    throw new Error(`Response finish_reason must be one of ${validFinishReasons.join(", ")} (got "${choice.finish_reason}")`);
  }
  // Validate usage object (default to zeros if missing, but warn)
  if (!parsed.usage) {
    parsed.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  // BH-BRIDGE-2 MEDIUM-5 fix: atomic write (temp + rename) to prevent server
  // from reading partial JSON during a multi-syscall writeFileSync on large responses.
  const tmpPath = respPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2));
  fs.renameSync(tmpPath, respPath);
  return respPath;
}

function cmdList() {
  const pending = listPending();
  if (pending.length === 0) {
    console.log("Queue is empty (no pending requests).");
    return;
  }
  console.log(`Pending requests: ${pending.length}\n`);
  for (const p of pending) {
    try {
      const data = readRequest(p.id);
      const summary = summarizeRequest(data);
      console.log(summary);
      console.log("\n" + "─".repeat(70) + "\n");
    } catch (e) {
      console.log(`[error reading ${p.id}] ${e.message}`);
    }
  }
}

function cmdShow(id) {
  const data = readRequest(id);
  console.log(showFullRequest(data));
}

function cmdSummary(id) {
  const data = readRequest(id);
  console.log(summarizeRequest(data));
}

function cmdRespond(id, responseFile) {
  if (!fs.existsSync(responseFile)) {
    console.error(`Response file not found: ${responseFile}`);
    process.exit(1);
  }
  const responseJson = fs.readFileSync(responseFile, "utf8");
  const respPath = writeResponse(id, responseJson);
  console.log(`Response written to ${respPath}`);
  console.log(`Bridge server will pick it up within 500ms and return to CLI.`);
}

function cmdRespondStdin(id) {
  const rl = readline.createInterface({ input: process.stdin });
  let data = "";
  rl.on("line", (line) => { data += line + "\n"; });
  rl.on("close", () => {
    try {
      const respPath = writeResponse(id, data);
      console.log(`Response written to ${respPath}`);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });
}

// --- CLI --------------------------------------------------------------------

const [cmd, ...args] = process.argv.slice(2);

try {
  switch (cmd) {
    case "list":
      cmdList();
      break;
    case "show":
      if (!args[0]) { console.error("Usage: process-queue.mjs show <id>"); process.exit(1); }
      cmdShow(args[0]);
      break;
    case "summary":
      if (!args[0]) { console.error("Usage: process-queue.mjs summary <id>"); process.exit(1); }
      cmdSummary(args[0]);
      break;
    case "respond":
      if (!args[0] || !args[1]) { console.error("Usage: process-queue.mjs respond <id> <response-file>"); process.exit(1); }
      cmdRespond(args[0], args[1]);
      break;
    case "respond-stdin":
      if (!args[0]) { console.error("Usage: process-queue.mjs respond-stdin <id>"); process.exit(1); }
      cmdRespondStdin(args[0]);
      break;
    case undefined:
    case "--help":
    case "-h":
    case "help":
      console.log(`Bridge queue processor.

Usage:
  process-queue.mjs list                     Show all pending requests (with smart summary)
  process-queue.mjs show <id>                Show full request JSON (no truncation)
  process-queue.mjs summary <id>             Show smart summary of one request
  process-queue.mjs respond <id> <file>      Write response from file
  process-queue.mjs respond-stdin <id>       Write response from stdin

Queue dir: ${QUEUE_DIR}

Response format: OpenAI chat completion JSON. See bridge/README.md.`);
      break;
    default:
      console.error(`Unknown command: ${cmd}. Try --help.`);
      process.exit(1);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
