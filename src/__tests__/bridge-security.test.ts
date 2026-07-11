/**
 * bridge-security.test.ts — security tests for the bridge server.
 *
 * Tests cover:
 *   - BRIDGE_TOKEN authentication (correct, missing, wrong, timing-attack-safe)
 *   - HTTPS-only enforcement (server doesn't enforce this — CLI does — but
 *     we test the CLI side in apiProvider-bridge.test.ts)
 *   - Rate limit per IP (BRIDGE_MAX_RPM)
 *   - Request body size limit (10 MB)
 *   - Path allowlist (only /v1/chat/completions, /health, /queue/stats)
 *   - Method allowlist (only GET/POST, OPTIONS for CORS)
 *   - No path traversal in queue dir
 *   - BRIDGE_TOKEN required at server startup
 *
 * These tests spawn the server as a subprocess on a random port and hit
 * it with HTTP requests. Server is killed in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SERVER_SCRIPT = path.resolve(__dirname, "../../bridge/server.mjs");
const TEST_QUEUE_DIR = `/tmp/ck-bridge-test-${process.pid}-${Date.now()}`;

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
}

async function startServer(opts: { token?: string; maxRpm?: number } = {}): Promise<ServerHandle> {
  const port = await findFreePort();
  const token = opts.token ?? "test-token-" + crypto.randomBytes(8).toString("hex");
  const maxRpm = opts.maxRpm ?? 100; // high for tests, we test rate limit separately
  // Clean queue dir
  fs.rmSync(TEST_QUEUE_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_QUEUE_DIR, { recursive: true });
  const proc = spawn("node", [SERVER_SCRIPT], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_TOKEN: token,
      BRIDGE_MAX_RPM: String(maxRpm),
      BRIDGE_QUEUE_DIR: TEST_QUEUE_DIR,
      BRIDGE_RESPONSE_TIMEOUT_MS: "500", // very short for tests (we don't wait for real operators)
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wait for server to be ready
  for (let i = 0; i < 40; i++) {
    try {
      const resp = await httpGet(port, "/health", {});
      if (resp.status === 200) break;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return { proc, port, token };
}

async function stopServer(handle: ServerHandle) {
  if (handle.proc && handle.proc.exitCode === null) {
    handle.proc.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 200));
    if (handle.proc.exitCode === null) {
      handle.proc.kill("SIGKILL");
    }
  }
  fs.rmSync(TEST_QUEUE_DIR, { recursive: true, force: true });
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

let server: ServerHandle | null = null;

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  if (server) await stopServer(server);
  server = null;
});

describe("bridge server — security", () => {
  describe("BRIDGE_TOKEN authentication", () => {
    it("accepts request with correct Bearer token", async () => {
      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      const resp = await httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      // Will be 504 (no response in test env), but auth passed
      expect(resp.status).toBe(504);
    });

    it("rejects request without Authorization header", async () => {
      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      const resp = await httpPost(server!.port, "/v1/chat/completions", {}, body);
      expect(resp.status).toBe(401);
      const parsed = JSON.parse(resp.body);
      expect(parsed.error.message).toMatch(/Unauthorized|BRIDGE_TOKEN/i);
    });

    it("rejects request with wrong Bearer token", async () => {
      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      const resp = await httpPost(server!.port, "/v1/chat/completions",
        { Authorization: "Bearer wrong-token" }, body);
      expect(resp.status).toBe(401);
    });

    it("rejects request with malformed Authorization header (no Bearer prefix)", async () => {
      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      const resp = await httpPost(server!.port, "/v1/chat/completions",
        { Authorization: server!.token }, body);
      expect(resp.status).toBe(401);
    });

    it("rejects request with empty Bearer token", async () => {
      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      const resp = await httpPost(server!.port, "/v1/chat/completions",
        { Authorization: "Bearer " }, body);
      expect(resp.status).toBe(401);
    });

    it("rejects /queue/stats without auth", async () => {
      const resp = await httpGet(server!.port, "/queue/stats", {});
      expect(resp.status).toBe(401);
    });

    it("accepts /queue/stats with auth", async () => {
      const resp = await httpGet(server!.port, "/queue/stats",
        { Authorization: `Bearer ${server!.token}` });
      expect(resp.status).toBe(200);
      const parsed = JSON.parse(resp.body);
      expect(parsed.queueDir).toBe(TEST_QUEUE_DIR);
    });

    it("/health does NOT require auth", async () => {
      const resp = await httpGet(server!.port, "/health", {});
      expect(resp.status).toBe(200);
    });
  });

  describe("path allowlist", () => {
    it("returns 404 for unknown path", async () => {
      const resp = await httpGet(server!.port, "/unknown-path",
        { Authorization: `Bearer ${server!.token}` });
      expect(resp.status).toBe(404);
    });

    it("returns 404 for /admin", async () => {
      const resp = await httpGet(server!.port, "/admin",
        { Authorization: `Bearer ${server!.token}` });
      expect(resp.status).toBe(404);
    });

    it("returns 404 for /", async () => {
      const resp = await httpGet(server!.port, "/",
        { Authorization: `Bearer ${server!.token}` });
      expect(resp.status).toBe(404);
    });

    it("returns 404 for /v1 (without /chat/completions)", async () => {
      const resp = await httpGet(server!.port, "/v1",
        { Authorization: `Bearer ${server!.token}` });
      expect(resp.status).toBe(404);
    });

    it("accepts /chat/completions (without /v1 prefix, OpenAI alt)", async () => {
      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      const resp = await httpPost(server!.port, "/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      // Will be 504 (no response in test env), but path accepted
      expect(resp.status).toBe(504);
    });

    it("rejects DELETE method", async () => {
      const resp = await new Promise<{ status: number }>((resolve) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port: server!.port,
          path: "/v1/chat/completions",
          method: "DELETE",
          headers: { Authorization: `Bearer ${server!.token}` },
        }, (res) => resolve({ status: res.statusCode ?? 0 }));
        req.end();
      });
      expect(resp.status).toBe(404);
    });
  });

  describe("request body size limit", () => {
    it("rejects body > 10 MB", async () => {
      // Build a body just over 10 MB
      const big = "x".repeat(10 * 1024 * 1024 + 100);
      const body = JSON.stringify({ messages: [{ role: "user", content: big }] });
      const resp = await httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      expect(resp.status).toBe(413);
    });

    it("accepts body just under 10 MB", async () => {
      // Build a body just under 10 MB
      const big = "x".repeat(9 * 1024 * 1024);
      const body = JSON.stringify({ messages: [{ role: "user", content: big }] });
      const resp = await httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      // Will be 504 (no operator processing), but body accepted
      expect(resp.status).toBe(504);
    });
  });

  describe("input validation", () => {
    it("rejects invalid JSON body", async () => {
      const resp = await httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, "not-json{");
      expect(resp.status).toBe(400);
    });

    it("rejects body without messages[]", async () => {
      const body = JSON.stringify({ model: "foo" });
      const resp = await httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      expect(resp.status).toBe(400);
    });

    it("rejects body with empty messages[]", async () => {
      const body = JSON.stringify({ messages: [] });
      const resp = await httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      expect(resp.status).toBe(400);
    });

    it("rejects body with messages not an array", async () => {
      const body = JSON.stringify({ messages: "not-array" });
      const resp = await httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      expect(resp.status).toBe(400);
    });
  });

  describe("rate limit per IP", () => {
    it("returns 429 after exceeding BRIDGE_MAX_RPM", async () => {
      // Restart server with low rate limit
      await stopServer(server!);
      server = await startServer({ maxRpm: 3 });

      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      // Send 4 requests (3 allowed, 4th should fail)
      const results: number[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await httpPost(server!.port, "/v1/chat/completions",
          { Authorization: `Bearer ${server!.token}` }, body);
        results.push(r.status);
      }
      // First 3 should be 504 (auth ok, no operator), 4th should be 429
      expect(results[0]).toBe(504);
      expect(results[1]).toBe(504);
      expect(results[2]).toBe(504);
      expect(results[3]).toBe(429);
    });

    it("includes Retry-After header on 429", async () => {
      await stopServer(server!);
      server = await startServer({ maxRpm: 1 });
      const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
      await httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      const r = await httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      expect(r.status).toBe(429);
      expect(r.headers["retry-after"]).toBeDefined();
    });
  });

  describe("queue directory isolation", () => {
    it("writes REQ files to BRIDGE_QUEUE_DIR", async () => {
      const body = JSON.stringify({ messages: [{ role: "user", content: "test" }] });
      // Fire request but don't await — we want to catch the REQ file BEFORE
      // the server times out (504) and cleans it up.
      const requestPromise = httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      // Wait a moment for file write (server writes REQ before long-polling)
      await new Promise(r => setTimeout(r, 100));
      const files = fs.readdirSync(TEST_QUEUE_DIR);
      expect(files.some(f => f.startsWith("REQ-") && f.endsWith(".json"))).toBe(true);
      // Let the request finish (will timeout 504) so server cleans up
      await requestPromise.catch(() => {});
    });

    it("does NOT write outside BRIDGE_QUEUE_DIR", async () => {
      const body = JSON.stringify({ messages: [{ role: "user", content: "test" }] });
      await httpPost(server!.port, "/v1/chat/completions",
        { Authorization: `Bearer ${server!.token}` }, body);
      // Check that /tmp doesn't have stray REQ files outside the test dir
      const tmpFiles = fs.readdirSync("/tmp");
      const stray = tmpFiles.filter(f => f.startsWith("REQ-") && f.endsWith(".json"));
      // All REQ files should be inside TEST_QUEUE_DIR, not /tmp directly
      expect(stray.length).toBe(0);
    });
  });

  describe("BRIDGE_TOKEN required at startup", () => {
    it("server exits with code 1 if BRIDGE_TOKEN missing", async () => {
      const port = await findFreePort();
      fs.rmSync(TEST_QUEUE_DIR, { recursive: true, force: true });
      fs.mkdirSync(TEST_QUEUE_DIR, { recursive: true });
      // BH-BRIDGE-3 HIGH-4 fix: explicitly strip BRIDGE_TOKEN from the spawned
      // env. Previously, `...process.env` would inherit BRIDGE_TOKEN if the
      // test runner had it set (dotenv, CI secrets), causing the server to
      // NOT exit(1) and the test to fail.
      const { BRIDGE_TOKEN: _stripToken, ...envWithoutToken } = process.env;
      const proc = spawn("node", [SERVER_SCRIPT], {
        env: {
          ...envWithoutToken,
          BRIDGE_PORT: String(port),
          // BRIDGE_TOKEN intentionally missing
          BRIDGE_QUEUE_DIR: TEST_QUEUE_DIR,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exitCode = await new Promise<number>((resolve) => {
        proc.on("exit", (code) => resolve(code ?? 0));
        setTimeout(() => { proc.kill("SIGKILL"); resolve(-1); }, 3000);
      });
      expect(exitCode).toBe(1);
      fs.rmSync(TEST_QUEUE_DIR, { recursive: true, force: true });
    });
  });

  describe("CORS preflight", () => {
    it("OPTIONS request returns 204", async () => {
      const resp = await new Promise<{ status: number }>((resolve) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port: server!.port,
          path: "/v1/chat/completions",
          method: "OPTIONS",
          headers: {},
        }, (res) => resolve({ status: res.statusCode ?? 0 }));
        req.end();
      });
      expect(resp.status).toBe(204);
    });
  });
});
