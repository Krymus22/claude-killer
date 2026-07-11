# Bridge — Remote LLM provider for claude-killer

> **Status:** Experimental feature (July 2026)
> **Section:** BUSINESS_RULES.md §17.11

The bridge provider lets you use **any LLM accessible via HTTP** as the brain of claude-killer, by exposing it through an OpenAI-compatible HTTP server that the CLI can call.

The most common use case is to use a **chat-based LLM** (like GLM 5.2 accessed via a chat session) as the agent's brain: the chat-based LLM acts as an "operator" who reads requests from a queue and writes responses back, while the claude-killer CLI sees a normal OpenAI-compatible endpoint.

---

## 📐 Architecture

```
┌────────────────────────┐         ┌────────────────────────┐
│  claude-killer CLI     │         │  Bridge server         │
│  (your PC)             │         │  (remote environment)  │
│                        │         │                        │
│  API_PROVIDER=bridge   │         │  server.mjs            │
│  BRIDGE_URL=<tunnel>   │         │  ↳ POST /v1/chat/...   │
│  BRIDGE_TOKEN=<secret> │         │  ↳ saves REQ-<id>.json │
│                        │         │  ↳ long-polls RESP-<id>│
└──────────┬─────────────┘         └──────────┬─────────────┘
           │                                  │
           │  HTTPS via Cloudflare tunnel     │
           │  Authorization: Bearer <token>   │
           │                                  │
           └──────────────────────────────────┘
                                              │
                                              │ writes REQ-<id>.json
                                              ↓
                          ┌────────────────────────────────────┐
                          │  Queue dir (/tmp/ck-queue)         │
                          │  REQ-<uuid>.json  ← requests       │
                          │  RESP-<uuid>.json ← responses      │
                          └──────────────┬─────────────────────┘
                                         │
                          Operator (chat-based LLM, e.g. GLM 5.2)
                          reads queue via process-queue.mjs,
                          generates response, writes RESP-<id>.json
```

### Components

| Component | Location | Role |
|-----------|----------|------|
| CLI side | `src/apiProvider.ts` + `src/config.ts` | Detects `API_PROVIDER=bridge`, sends requests to `BRIDGE_URL` with `BRIDGE_TOKEN` |
| Bridge server | `bridge/server.mjs` | HTTP server (OpenAI-compatible), queues requests, long-polls for responses |
| Tunnel | `bridge/start-tunnel.sh` | Cloudflare tunnel exposing the server publicly over HTTPS |
| Queue processor | `bridge/process-queue.mjs` | Helper script for the operator (LLM) to read/write the queue |
| Queue dir | `/tmp/ck-queue/` (configurable) | REQ-*.json + RESP-*.json files |

---

## 🚀 Quick start

### Step 1: Configure the bridge server (remote side)

```bash
cd claude-killer/bridge
cp .env.example .env
# Edit .env and set BRIDGE_TOKEN
$EDITOR .env
```

### Step 2: Start the bridge

```bash
./start-tunnel.sh
```

This prints a URL like `https://random-words.trycloudflare.com`. Save it — you'll paste it into the CLI's `.env`.

### Step 3: Configure the CLI (your PC)

In your claude-killer `.env`:

```bash
API_PROVIDER=bridge
BRIDGE_URL=https://random-words.trycloudflare.com
BRIDGE_TOKEN=<same-token-as-bridge-server>
```

### Step 4: Start the CLI

```bash
claude-killer
```

The CLI will now send all requests through the bridge. When a request comes in, the bridge server queues it. The operator (you + the chat-based LLM) must process the queue.

### Step 5: Process the queue (operator side)

```bash
node bridge/process-queue.mjs list
```

This shows all pending requests with a smart summary (system prompt truncated, tool call index, last 3 messages, current message to respond to).

To write a response:

```bash
# Write response to a file (OpenAI chat completion format)
node bridge/process-queue.mjs respond <request-id> response.json
```

Or via stdin:

```bash
echo '{"choices":[{"message":{"role":"assistant","content":"Hello!"},"finish_reason":"stop"}]}' | \
  node bridge/process-queue.mjs respond-stdin <request-id>
```

The bridge server picks up the response file within 500ms and returns it to the CLI.

---

## 🔒 Security

- **BRIDGE_TOKEN** (required, §17.11 rule 82): shared secret between CLI and server. Compared with `crypto.timingSafeEqual` to prevent timing attacks.
- **HTTPS only** (§17.11 rule 81): `BRIDGE_URL` must start with `https://`. The CLI rejects plaintext URLs because tokens are sent in `Authorization` headers.
- **Rate limit per IP** (default 12 RPM): defense in depth against DoS, even with valid token.
- **Request body limit**: 10 MB max (prevents memory exhaustion).
- **Endpoints**: only `POST /v1/chat/completions`, `GET /health`, `GET /queue/stats` exist. Everything else returns 404.
- **No file writes outside queue dir**: the server only reads/writes files in `BRIDGE_QUEUE_DIR`.

---

## 📡 Endpoints

### `POST /v1/chat/completions` (auth required)

OpenAI-compatible chat completion endpoint. Request body must include `messages[]` (other fields like `model`, `tools`, `temperature` are accepted but currently ignored by the bridge server — the operator decides what to do with them).

Returns:
- `200 OK` with OpenAI-format response JSON (when operator processes in time)
- `401 Unauthorized` (missing/wrong token)
- `413 Payload Too Large` (>10 MB body)
- `429 Too Many Requests` (rate limit exceeded)
- `504 Gateway Timeout` (operator didn't respond within `BRIDGE_RESPONSE_TIMEOUT_MS`)

### `GET /health` (no auth)

Returns server status, queue stats, uptime. Useful for monitoring.

### `GET /queue/stats` (auth required)

Returns pending request count and IDs. Useful for operators to see if work is piling up.

---

## 📝 Response format

The operator must write `RESP-<id>.json` in OpenAI chat completion format. Minimal example:

```json
{
  "id": "chatcmpl-bridge-<id>",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "bridge-glm-5.2",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help?"
    },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

### With tool calls

If the assistant wants to call a tool:

```json
{
  "id": "chatcmpl-bridge-<id>",
  "object": "chat.completion",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_001",
        "type": "function",
        "function": {
          "name": "ler_arquivo",
          "arguments": "{\"path\":\"src/foo.ts\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

The CLI executes the tool locally, then sends a follow-up request with `role: "tool"` message containing the result. The operator sees this and decides the next step.

---

## 🧠 Smart context summarization

When the operator runs `process-queue.mjs list`, each request is shown with a smart summary to keep the operator's context manageable:

1. **System prompt**: first 1500 chars + last 500 chars (with `[truncated]` marker in the middle)
2. **Tool call history**: 1 line per tool call/result (cumulative memory — prevents re-reading files)
3. **Last tool result**: up to 5000 chars (full content of the most recent tool output)
4. **Last 3 messages**: full content (so the operator sees recent context)
5. **Current message**: the message the operator needs to respond to

This keeps each request around 3-8k tokens, even if the CLI's full messages array is 50k+.

To see the full untruncated request: `process-queue.mjs show <id>`.

---

## ⏱️ Lifecycle & timeouts

| Timeout | Default | Env var | Notes |
|---------|---------|---------|-------|
| Operator response | 9 min | `BRIDGE_RESPONSE_TIMEOUT_MS` | If operator doesn't process, CLI gets 504 |
| Long-poll interval | 500ms | (hardcoded) | How often server checks for RESP file |
| Tunnel URL appearance | 30s | (hardcoded) | How long start-tunnel.sh waits for URL |
| Server startup | 10s | (hardcoded) | How long start-tunnel.sh waits for /health |

The 9-minute operator timeout matches a typical 10-minute chat session window — if the operator's session is about to die, they have 1 minute to wrap up before the CLI gets 504.

---

## 🛑 Stopping the bridge

```bash
./stop-tunnel.sh
```

This kills both the server and the tunnel. Queue files in `/tmp/ck-queue/` are NOT deleted (so you can inspect them after).

---

## 🐛 Troubleshooting

### "BRIDGE_URL must be HTTPS"

You set `BRIDGE_URL=http://...`. Change to HTTPS. Cloudflare tunnels are HTTPS by default — if you're not using a tunnel, use any HTTPS reverse proxy.

### "BRIDGE_TOKEN is not set"

You forgot to set the token. Both the CLI and the server need the same `BRIDGE_TOKEN`.

### 504 Gateway Timeout

The operator didn't process the request within 9 minutes. Either:
- Process the queue more often
- Increase `BRIDGE_RESPONSE_TIMEOUT_MS`
- Run multiple operators (each processing different request IDs)

### 429 Too Many Requests

You're hitting the rate limit. Increase `BRIDGE_MAX_RPM` (but make sure the operator can keep up).

### Queue dir is empty

Either:
- No requests have come in (check CLI is running with `API_PROVIDER=bridge`)
- Server died (check `/health` endpoint)
- Wrong queue dir (check `BRIDGE_QUEUE_DIR` env var on both sides)

### Tunnel URL not appearing in log

`cloudflared` might be slow to start. Check `/tmp/ck-bridge-tunnel.log` for errors. If it's a Docker container, check `docker logs ck-bridge-tunnel`.

---

## 📚 See also

- `BUSINESS_RULES.md` §17.11 — Bridge Mode immutable rules
- `src/apiProvider.ts` — Provider detection and config
- `src/__tests__/apiProvider-bridge.test.ts` — Provider unit tests
- `src/__tests__/bridge-security.test.ts` — Server security tests
- `src/__tests__/bridge-endpoints.test.ts` — Server endpoint tests
