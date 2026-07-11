/**
 * bridge-endpoints.test.ts — endpoint tests for the bridge server.
 *
 * Tests cover the full request/response flow:
 *   - POST /v1/chat/completions queues a request
 *   - Server long-polls for RESP file
 *   - When RESP file appears, server returns it to client
 *   - When timeout expires without RESP, returns 504
 *   - GET /health returns queue stats
 *   - GET /queue/stats returns pending request count
 *   - RESP file must be valid OpenAI format
 *   - REQ and RESP files are cleaned up after response
 *   - Multiple parallel requests each get their own response
 *
 * These tests simulate the operator by writing RESP files directly to the
 * queue dir, then verifying the server picks them up.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SERVER_SCRIPT = path.resolve(__dirname, "../../bridge/server.mjs");
const TEST_QUEUE_DIR = `/tmp/ck-bridge-endpoint-test-${process.pid}-${Date.now()}`;

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("could not get port"));
      }
    });
  });
}

interface ServerHandle {
  proc: ChildProcess;
  port: number;
  token: string;
  queueDir: string;
}

async function startServer(opts: { timeoutMs?: number } = {}): Promise<ServerHandle> {
  const port = await findFreePort();
  const token = "test-token-" + crypto.randomBytes(8).toString("hex");
  const queueDir = `${TEST_QUEUE_DIR}-${port}`;
  fs.rmSync(queueDir, { recursive: true, force: true });
  fs.mkdirSync(queueDir, { recursive: true });
  const proc = spawn("node", [SERVER_SCRIPT], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_TOKEN: token,
      BRIDGE_MAX_RPM: "100",
      BRIDGE_QUEUE_DIR: queueDir,
      BRIDGE_RESPONSE_TIMEOUT_MS: String(opts.timeoutMs ?? 5000),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 40; i++) {
    try {
      const resp = await httpGet(port, "/health", {});
      if (resp.status === 200) break;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return { proc, port, token, queueDir };
}

async function stopServer(handle: ServerHandle) {
  if (handle.proc && handle.proc.exitCode === null) {
    handle.proc.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 200));
    if (handle.proc.exitCode === null) {
      handle.proc.kill("SIGKILL");
    }
  }
  fs.rmSync(handle.queueDir, { recursive: true, force: true });
}

function httpGet(port: number, url: string, headers: Record<string, string>): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: url,
      method: "GET",
      headers,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

function httpPost(port: number, url: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: url,
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Simulate the operator: write a RESP file for the given request ID. */
function writeResponse(queueDir: string, reqId: string, responseObj: any) {
  const respPath = path.join(queueDir, `RESP-${reqId}.json`);
  fs.writeFileSync(respPath, JSON.stringify(responseObj, null, 2));
}

/** Wait for a REQ file to appear in the queue, return its ID. */
async function waitForRequest(queueDir: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = fs.readdirSync(queueDir);
    const reqFile = files.find(f => f.startsWith("REQ-") && f.endsWith(".json"));
    if (reqFile) {
      return reqFile.replace(/^REQ-/, "").replace(/\.json$/, "");
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("No REQ file appeared in queue within timeout");
}

/** BH-BRIDGE-3 CRITICAL-1 fix: wait for N unique REQ files, return their IDs.
 *
 * Previously, the concurrent test called waitForRequest() 3× and got the same
 * ID 3 times (find() always returns the first match). This function collects
 * unique IDs via a Set, so each concurrent request gets its own response.
 */
async function waitForRequests(queueDir: string, count: number, timeoutMs = 5000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<string>();
  while (Date.now() < deadline && seen.size < count) {
    const files = fs.readdirSync(queueDir);
    for (const f of files) {
      if (f.startsWith("REQ-") && f.endsWith(".json")) {
        const id = f.replace(/^REQ-/, "").replace(/\.json$/, "");
        seen.add(id);
        if (seen.size >= count) break;
      }
    }
    if (seen.size < count) await new Promise(r => setTimeout(r, 50));
  }
  if (seen.size < count) {
    throw new Error(`Only ${seen.size}/${count} REQ files appeared in queue within timeout`);
  }
  return [...seen];
}

let server: ServerHandle | null = null;

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  if (server) await stopServer(server);
  server = null;
});

describe("bridge server — endpoint flow", () => {
  describe("POST /v1/chat/completions", () => {
    it("queues request and returns response when operator writes RESP file", async () => {
      const body = JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hello" }],
      });

      // Fire request (will hang waiting for response)
      const requestPromise = httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);

      // Wait for REQ file to appear
      const reqId = await waitForRequest(server!.queueDir);

      // Verify REQ file contents
      const reqPath = path.join(server!.queueDir, `REQ-${reqId}.json`);
      const reqData = JSON.parse(fs.readFileSync(reqPath, "utf8"));
      expect(reqData.body.messages[0].content).toBe("Hello");
      expect(reqData.body.model).toBe("test-model");

      // Simulate operator writing response
      writeResponse(server!.queueDir, reqId, {
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "bridge-test",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "Hi there!" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });

      // Wait for response
      const resp = await requestPromise;
      expect(resp.status).toBe(200);
      const parsed = JSON.parse(resp.body);
      expect(parsed.choices[0].message.content).toBe("Hi there!");
      expect(parsed.choices[0].finish_reason).toBe("stop");
    });

    it("returns response with tool_calls when operator writes tool_calls", async () => {
      const body = JSON.stringify({
        messages: [{ role: "user", content: "read file foo.ts" }],
        tools: [{ type: "function", function: { name: "ler_arquivo", parameters: {} } }],
      });

      const requestPromise = httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);

      const reqId = await waitForRequest(server!.queueDir);

      writeResponse(server!.queueDir, reqId, {
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_001",
              type: "function",
              function: {
                name: "ler_arquivo",
                arguments: JSON.stringify({ path: "foo.ts" }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      const resp = await requestPromise;
      expect(resp.status).toBe(200);
      const parsed = JSON.parse(resp.body);
      expect(parsed.choices[0].finish_reason).toBe("tool_calls");
      expect(parsed.choices[0].message.tool_calls[0].function.name).toBe("ler_arquivo");
      expect(JSON.parse(parsed.choices[0].message.tool_calls[0].function.arguments).path).toBe("foo.ts");
    });

    it("returns 504 when operator doesn't respond in time", async () => {
      // Use a server with very short timeout
      await stopServer(server!);
      server = await startServer({ timeoutMs: 1000 });

      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      const resp = await httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      expect(resp.status).toBe(504);
      const parsed = JSON.parse(resp.body);
      expect(parsed.error.type).toBe("timeout_error");
    });

    it("cleans up REQ and RESP files after response", async () => {
      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      const requestPromise = httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      const reqId = await waitForRequest(server!.queueDir);
      writeResponse(server!.queueDir, reqId, {
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
      await requestPromise;
      // Wait a moment for cleanup
      await new Promise(r => setTimeout(r, 200));
      const files = fs.readdirSync(server!.queueDir);
      expect(files.length).toBe(0);
    });

    it("cleans up REQ file on timeout", async () => {
      await stopServer(server!);
      server = await startServer({ timeoutMs: 500 });
      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      await httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      // Wait for cleanup
      await new Promise(r => setTimeout(r, 300));
      const files = fs.readdirSync(server!.queueDir);
      expect(files.length).toBe(0);
    });

    it("returns 502 when operator writes invalid JSON to RESP file", async () => {
      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      const requestPromise = httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      const reqId = await waitForRequest(server!.queueDir);
      // Write invalid JSON to RESP file
      fs.writeFileSync(path.join(server!.queueDir, `RESP-${reqId}.json`), "not-json{");
      const resp = await requestPromise;
      expect(resp.status).toBe(502);
    });
  });

  describe("GET /health", () => {
    it("returns 200 with status info", async () => {
      const resp = await httpGet(server!.port, "/health", {});
      expect(resp.status).toBe(200);
      const parsed = JSON.parse(resp.body);
      expect(parsed.status).toBe("ok");
      expect(parsed.queue).toBeDefined();
      expect(parsed.uptime).toBeGreaterThanOrEqual(0);
      expect(parsed.maxRpm).toBe(100);
    });

    it("returns queue stats (pending count)", async () => {
      // Send a request that won't be responded to (will time out)
      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      const requestPromise = httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      await waitForRequest(server!.queueDir);
      // Check health
      const resp = await httpGet(server!.port, "/health", {});
      const parsed = JSON.parse(resp.body);
      expect(parsed.queue.pendingRequests).toBe(1);
      // Let request time out to clean up
      await requestPromise.catch(() => {});
    });
  });

  describe("GET /queue/stats", () => {
    it("requires auth", async () => {
      const resp = await httpGet(server!.port, "/queue/stats", {});
      expect(resp.status).toBe(401);
    });

    it("returns pending request IDs", async () => {
      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      const requestPromise = httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      const reqId = await waitForRequest(server!.queueDir);

      const resp = await httpGet(server!.port, "/queue/stats",
        { Authorization: `Bearer ${server!.token}` });
      expect(resp.status).toBe(200);
      const parsed = JSON.parse(resp.body);
      expect(parsed.pendingRequests).toBe(1);
      expect(parsed.pendingIds).toContain(reqId);

      // Cleanup
      writeResponse(server!.queueDir, reqId, {
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
      await requestPromise;
    });
  });

  describe("concurrent requests", () => {
    it("handles 3 concurrent requests independently", async () => {
      const bodies = ["msg1", "msg2", "msg3"].map(content =>
        JSON.stringify({ messages: [{ role: "user", content }] })
      );

      // Fire 3 requests in parallel
      const promises = bodies.map(body =>
        httpPost(server!.port, "/v1/chat/completions",
          { Authorization: `Bearer ${server!.token}` }, body)
      );

      // BH-BRIDGE-3 CRITICAL-1 fix: wait for 3 UNIQUE REQ files (was calling
      // waitForRequest 3× which returned the same first ID every time).
      const reqIds = await waitForRequests(server!.queueDir, 3);

      // Verify 3 distinct REQ files exist
      const files = fs.readdirSync(server!.queueDir).filter(f => f.startsWith("REQ-"));
      expect(files.length).toBe(3);

      // Respond to each with its own message
      for (let i = 0; i < 3; i++) {
        writeResponse(server!.queueDir, reqIds[i], {
          choices: [{
            message: { role: "assistant", content: `response-${i}` },
            finish_reason: "stop",
          }],
        });
      }

      // All 3 responses should come back correctly
      const responses = await Promise.all(promises);
      const contents = responses.map(r => JSON.parse(r.body).choices[0].message.content);
      expect(contents.sort()).toEqual(["response-0", "response-1", "response-2"]);
    });
  });

  describe("queue file format", () => {
    it("REQ file has id, receivedAt, body, headers", async () => {
      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      const requestPromise = httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      const reqId = await waitForRequest(server!.queueDir);
      const reqPath = path.join(server!.queueDir, `REQ-${reqId}.json`);
      const reqData = JSON.parse(fs.readFileSync(reqPath, "utf8"));

      expect(reqData.id).toBe(reqId);
      expect(reqData.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(reqData.body.messages[0].content).toBe("hi");
      expect(reqData.headers["content-type"]).toBe("application/json");
      expect(reqData.method).toBe("POST");

      // Cleanup
      writeResponse(server!.queueDir, reqId, {
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
      await requestPromise;
    });
  });
});
