#!/usr/bin/env node
/**
 * server.mjs — Bridge server (OpenAI-compatible) for claude-killer.
 *
 * Receives POST /v1/chat/completions from the claude-killer CLI, saves the
 * request to /tmp/ck-queue/REQ-{uuid}.json, then long-polls for the
 * matching RESP-{uuid}.json (written by an external "processor" — typically
 * a chat-based LLM operator like GLM 5.2 reading the queue via the
 * companion process-queue.mjs script).
 *
 * Endpoints:
 *   POST /v1/chat/completions  — OpenAI-compatible (auth: Bearer BRIDGE_TOKEN)
 *   GET  /health               — liveness check (no auth)
 *   GET  /queue/stats          — queue stats (auth: Bearer BRIDGE_TOKEN)
 *
 * Security:
 *   - BRIDGE_TOKEN required on /v1/chat/completions and /queue/stats
 *   - BRIDGE_TOKEN read from env (matches BRIDGE_TOKEN on CLI side)
 *   - Rate limit per IP: BRIDGE_MAX_RPM (default 12) — defense in depth
 *   - Request body size limit: 10 MB (chat messages can be large)
 *
 * Lifecycle:
 *   - Server runs forever (until killed or tunnel dies)
 *   - If RESP file doesn't arrive within RESPONSE_TIMEOUT_MS (default 9 min),
 *     return 504 Gateway Timeout. Operator must process within this window.
 *   - Queue dir: BRIDGE_QUEUE_DIR env var (default /tmp/ck-queue)
 *
 * Usage:
 *   BRIDGE_TOKEN=secret node server.mjs
 *   # or via start-tunnel.sh which also brings up cloudflared
 *
 * See README.md for architecture overview.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// --- Config from env --------------------------------------------------------

const PORT = parseInt(process.env.BRIDGE_PORT ?? "3000", 10);
const TOKEN = process.env.BRIDGE_TOKEN?.trim();
const MAX_RPM = Math.max(1, parseInt(process.env.BRIDGE_MAX_RPM ?? "12", 10) || 12);
const QUEUE_DIR = process.env.BRIDGE_QUEUE_DIR ?? "/tmp/ck-queue";
// BH-BRIDGE-3 CRITICAL-2 fix: removed Math.max(30_000, ...) clamp that prevented
// tests from using short timeouts (tests set 500ms, server forced 30s → 60x slower).
// For production, default remains 9 min. Use Math.max(500, ...) to prevent 0/negative.
const RESPONSE_TIMEOUT_MS = Math.max(
  500,
  parseInt(process.env.BRIDGE_RESPONSE_TIMEOUT_MS ?? String(9 * 60 * 1000), 10) || 9 * 60 * 1000
);
const POLL_INTERVAL_MS = 500;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

if (!TOKEN) {
  console.error("[bridge] FATAL: BRIDGE_TOKEN env var is required.");
  console.error("[bridge] Generate one with: openssl rand -hex 32");
  process.exit(1);
}

// Ensure queue dir exists
try {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
} catch (e) {
  console.error(`[bridge] FATAL: cannot create queue dir ${QUEUE_DIR}: ${e.message}`);
  process.exit(1);
}

// --- Rate limiter (per-IP sliding window) -----------------------------------

const ipRequestLog = new Map(); // ip → array of timestamps
const MAX_TRACKED_IPS = 10_000; // BH-BRIDGE-2 MEDIUM-4 fix: cap to prevent unbounded growth

function purgeOldRequests(ip, now) {
  const log = ipRequestLog.get(ip);
  if (!log) return;
  while (log.length > 0 && now - log[0] >= 60_000) log.shift();
  if (log.length === 0) ipRequestLog.delete(ip);
}

// BH-BRIDGE-2 MEDIUM-4 fix: periodic global sweep to purge stale IPs.
// Without this, an IP that sends one request and never sends again stays
// in the Map forever (the per-IP purge only fires when that same IP sends again).
setInterval(() => {
  const now = Date.now();
  for (const [ip, _log] of ipRequestLog) {
    purgeOldRequests(ip, now);
  }
  // Hard cap: if Map is still too large, evict oldest entries
  if (ipRequestLog.size > MAX_TRACKED_IPS) {
    const sorted = [...ipRequestLog.entries()].sort((a, b) => a[1][0] - b[1][0]);
    const toEvict = sorted.slice(0, ipRequestLog.size - MAX_TRACKED_IPS);
    for (const [ip, _] of toEvict) ipRequestLog.delete(ip);
  }
}, 60_000).unref();

function rateLimitCheck(ip) {
  const now = Date.now();
  purgeOldRequests(ip, now);
  const log = ipRequestLog.get(ip) ?? [];
  if (log.length >= MAX_RPM) {
    const waitMs = log[0] + 60_000 - now + 100;
    return { allowed: false, retryAfterMs: waitMs };
  }
  log.push(now);
  ipRequestLog.set(ip, log);
  return { allowed: true };
}

// BH-BRIDGE-2 HIGH-3 fix: hash both sides before comparing to prevent token
// length leak. Previously, `if (token.length !== TOKEN.length) return false`
// leaked the token length via measurable timing (3.3x slower for right-length
// wrong-content tokens). Now we SHA-256 both sides (always 32 bytes) and
// compare digests with timingSafeEqual.
const TOKEN_HASH = crypto.createHash("sha256").update(TOKEN).digest();

function authenticate(req) {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7).trim();
  const tokenHash = crypto.createHash("sha256").update(token).digest();
  // Both hashes are 32 bytes, so no length check needed.
  try {
    return crypto.timingSafeEqual(tokenHash, TOKEN_HASH);
  } catch {
    return false;
  }
}

// --- Helpers ----------------------------------------------------------------

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function waitForResponseFile(respPath, deadline) {
  return new Promise((resolve) => {
    function check() {
      if (Date.now() > deadline) {
        resolve(null);
        return;
      }
      try {
        const content = fs.readFileSync(respPath, "utf8");
        // File exists and has content — read it
        resolve(content);
        return;
      } catch {
        // File doesn't exist yet, keep polling
      }
      setTimeout(check, POLL_INTERVAL_MS);
    }
    check();
  });
}

function cleanupRequestFile(reqPath, respPath) {
  try { fs.unlinkSync(reqPath); } catch {}
  try { fs.unlinkSync(respPath); } catch {}
}

function getQueueStats() {
  const reqFiles = fs.readdirSync(QUEUE_DIR).filter(f => f.startsWith("REQ-") && f.endsWith(".json"));
  const respFiles = fs.readdirSync(QUEUE_DIR).filter(f => f.startsWith("RESP-") && f.endsWith(".json"));
  const pending = reqFiles.filter(f => {
    const respName = f.replace(/^REQ-/, "RESP-");
    return !respFiles.includes(respName);
  });
  return {
    queueDir: QUEUE_DIR,
    totalRequests: reqFiles.length,
    totalResponses: respFiles.length,
    pendingRequests: pending.length,
    pendingIds: pending.map(f => f.replace(/^REQ-/, "").replace(/\.json$/, "")),
  };
}

// --- HTTP handlers ----------------------------------------------------------

async function handleChatCompletions(req, res, body) {
  // Parse OpenAI-compatible request
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: { message: "Invalid JSON body", type: "invalid_request_error" } });
  }

  // Validate required fields (OpenAI format)
  if (!parsed.messages || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    return sendJson(res, 400, { error: { message: "messages[] is required and must be non-empty", type: "invalid_request_error" } });
  }

  // Generate request ID
  const id = crypto.randomUUID();
  const reqPath = path.join(QUEUE_DIR, `REQ-${id}.json`);
  const respPath = path.join(QUEUE_DIR, `RESP-${id}.json`);

  // Save request to queue (with metadata)
  const queueEntry = {
    id,
    receivedAt: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: {
      "content-type": req.headers["content-type"],
      "user-agent": req.headers["user-agent"],
    },
    body: parsed, // OpenAI request body (model, messages, tools, etc.)
  };
  // BH-BRIDGE-2 MEDIUM-6 fix: atomic write (temp + rename) to prevent partial
  // REQ files if the server crashes mid-write. On startup, sweep orphans.
  const reqTmpPath = reqPath + ".tmp";
  fs.writeFileSync(reqTmpPath, JSON.stringify(queueEntry, null, 2));
  fs.renameSync(reqTmpPath, reqPath);

  console.log(`[bridge] queued request ${id} (${parsed.messages.length} messages)`);

  // Long-poll for response
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  const responseContent = await waitForResponseFile(respPath, deadline);

  if (responseContent === null) {
    // Timeout — operator didn't process in time
    cleanupRequestFile(reqPath, respPath);
    console.log(`[bridge] timeout for request ${id}`);
    return sendJson(res, 504, {
      error: {
        message: `Bridge response timeout after ${RESPONSE_TIMEOUT_MS / 1000}s. Operator must process queue faster or increase BRIDGE_RESPONSE_TIMEOUT_MS.`,
        type: "timeout_error",
      }
    });
  }

  // Parse response from operator
  let responseObj;
  try {
    responseObj = JSON.parse(responseContent);
  } catch {
    cleanupRequestFile(reqPath, respPath);
    console.error(`[bridge] invalid JSON in response file ${respPath}`);
    return sendJson(res, 502, { error: { message: "Bridge operator returned invalid JSON", type: "bridge_error" } });
  }

  // Cleanup queue files
  cleanupRequestFile(reqPath, respPath);

  // Return the response (operator must format it OpenAI-compatible)
  console.log(`[bridge] responding to request ${id}`);
  return sendJson(res, 200, responseObj);
}

function handleHealth(req, res) {
  sendJson(res, 200, {
    status: "ok",
    queue: getQueueStats(),
    uptime: process.uptime(),
    maxRpm: MAX_RPM,
  });
}

function handleQueueStats(req, res) {
  sendJson(res, 200, getQueueStats());
}

// BH-BRIDGE-2 MEDIUM-6 fix: startup orphan sweep — clean up partial REQ files
// and stale REQ files without matching RESP from previous crashed runs.
function sweepOrphanedQueueFiles() {
  try {
    const files = fs.readdirSync(QUEUE_DIR);
    for (const f of files) {
      // Remove .tmp files (partial writes from crashed server)
      if (f.endsWith(".tmp")) {
        try { fs.unlinkSync(path.join(QUEUE_DIR, f)); } catch {}
        console.log(`[bridge] startup sweep: removed partial file ${f}`);
        continue;
      }
      // Validate REQ files — if JSON parse fails, rename to .corrupt
      if (f.startsWith("REQ-") && f.endsWith(".json")) {
        const reqPath = path.join(QUEUE_DIR, f);
        try {
          JSON.parse(fs.readFileSync(reqPath, "utf8"));
        } catch {
          const corruptPath = reqPath.replace(/\.json$/, ".corrupt");
          try { fs.renameSync(reqPath, corruptPath); } catch {}
          console.log(`[bridge] startup sweep: moved corrupt ${f} → ${path.basename(corruptPath)}`);
        }
      }
    }
  } catch (e) {
    console.error(`[bridge] startup sweep error: ${e.message}`);
  }
}
sweepOrphanedQueueFiles();

// --- HTTP server ------------------------------------------------------------

// BH-BRIDGE-2 MEDIUM-8 fix: removed wildcard CORS — CLI uses Node http (not browser),
// so CORS headers serve no legitimate purpose and expand attack surface.
// If a browser-based client is added in the future, add a configurable allowlist
// via BRIDGE_CORS_ORIGIN env var.
const server = http.createServer(async (req, res) => {
  // Handle OPTIONS preflight WITHOUT CORS headers (returns 204 for any OPTIONS)
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // BH-BRIDGE-2 LOW-12 fix: strip query string from URL before matching routes.
  // Previously, POST /v1/chat/completions?stream=true returned 404.
  const urlPath = (req.url ?? "").split("?")[0];
  const method = req.method ?? "GET";

  // Public endpoint: /health
  if (method === "GET" && urlPath === "/health") {
    return handleHealth(req, res);
  }

  // All other endpoints require auth
  if (!authenticate(req)) {
    return sendJson(res, 401, { error: { message: "Unauthorized — BRIDGE_TOKEN required", type: "authentication_error" } });
  }

  // BH-BRIDGE-2 HIGH-2 fix: client IP extraction — prefer CF-Connecting-IP
  // (set by Cloudflare, NOT client-controllable) over X-Forwarded-For first entry
  // (which is attacker-controllable). Fall back to LAST XFF entry (closest trusted
  // proxy) if CF-Connecting-IP is not present.
  const clientIp =
    req.headers["cf-connecting-ip"]?.toString().trim() ||
    (req.headers["x-forwarded-for"]?.toString().split(",").pop().trim()) ||
    req.socket.remoteAddress ||
    "unknown";
  const rl = rateLimitCheck(clientIp);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    return sendJson(res, 429, { error: { message: `Rate limit exceeded for ${clientIp}. Max ${MAX_RPM} RPM.`, type: "rate_limit_error" } });
  }

  // Routes
  if (method === "POST" && (urlPath === "/v1/chat/completions" || urlPath === "/chat/completions")) {
    // BH-BRIDGE-2 LOW-10 fix: use Buffer.concat instead of string += to avoid
    // O(n²) allocation on large bodies. Also preserves raw bytes (no UTF-8
    // replacement char corruption before JSON.parse).
    const chunks = [];
    let bodyBytes = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return; // discard further chunks
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        tooLarge = true;
        // Send 413 immediately and stop reading. We don't call req.destroy()
        // because that also kills the response socket — instead, let the
        // client finish sending (or detect the closed response) naturally.
        // The 'end' handler will not fire (we set tooLarge=true), so we
        // must respond here.
        if (!res.headersSent) {
          sendJson(res, 413, { error: { message: `Request body exceeds ${MAX_BODY_BYTES} bytes`, type: "invalid_request_error" } });
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      if (tooLarge) return; // already responded
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        await handleChatCompletions(req, res, body);
      } catch (e) {
        console.error(`[bridge] error handling request:`, e);
        if (!res.headersSent) {
          sendJson(res, 500, { error: { message: `Internal bridge error: ${e.message}`, type: "server_error" } });
        }
      }
    });
    req.on("error", (e) => {
      console.error(`[bridge] request stream error:`, e);
      if (!res.headersSent) {
        sendJson(res, 400, { error: { message: `Request stream error: ${e.message}`, type: "invalid_request_error" } });
      }
    });
    return;
  }

  if (method === "GET" && (urlPath === "/queue/stats" || urlPath === "/stats")) {
    return handleQueueStats(req, res);
  }

  // Unknown route
  return sendJson(res, 404, { error: { message: `Not found: ${method} ${urlPath}`, type: "invalid_request_error" } });
});

server.listen(PORT, () => {
  console.log(`[bridge] server listening on port ${PORT}`);
  console.log(`[bridge] queue dir: ${QUEUE_DIR}`);
  console.log(`[bridge] max RPM per IP: ${MAX_RPM}`);
  console.log(`[bridge] response timeout: ${RESPONSE_TIMEOUT_MS / 1000}s`);
  console.log(`[bridge] auth: Bearer token (${TOKEN.length} chars)`);
  console.log(`[bridge] ready for requests at /v1/chat/completions`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`[bridge] received ${signal}, shutting down...`);
  server.close(() => {
    console.log("[bridge] server closed");
    process.exit(0);
  });
  // Force exit after 5s if server.close hangs
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

// BH-BRIDGE-2 MEDIUM-9 fix: uncaughtException must shutdown, not continue.
// Violates §17.8 rule 34 if we just log — server continues in corrupted state.
// Node docs: "the correct use of 'uncaughtException' is to perform synchronous
// cleanup before crashing."
process.on("uncaughtException", (e) => {
  console.error("[bridge] uncaughtException (shutting down):", e);
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (e) => {
  console.error("[bridge] unhandledRejection (shutting down):", e);
  shutdown("unhandledRejection");
});
