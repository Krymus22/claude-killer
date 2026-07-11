#!/usr/bin/env bash
# start-tunnel.sh — Bring up the bridge server + Cloudflare tunnel.
#
# Usage:
#   BRIDGE_TOKEN=secret ./start-tunnel.sh
#   # or set BRIDGE_TOKEN in .env (this script will source it)
#
# Requires:
#   - cloudflared binary in PATH (or installed via Docker fallback)
#   - node 18+ (for server.mjs)
#
# What this script does:
#   1. Sources .env if present (to load BRIDGE_TOKEN, etc.)
#   2. Starts bridge/server.mjs in the background (setsid nohup)
#   3. Starts cloudflared tunnel pointing to localhost:3000
#   4. Prints the public URL you need to paste into the CLI's .env as BRIDGE_URL
#   5. Saves PID files to /tmp/ck-bridge-pids/ for stop-tunnel.sh
#
# Logs:
#   - server log: /tmp/ck-bridge-server.log
#   - tunnel log: /tmp/ck-bridge-tunnel.log (contains the URL)
#
# To stop: ./stop-tunnel.sh

set -euo pipefail

# --- Config -----------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_SCRIPT="$SCRIPT_DIR/server.mjs"
PID_DIR="/tmp/ck-bridge-pids"
LOG_DIR="/tmp"
SERVER_LOG="$LOG_DIR/ck-bridge-server.log"
TUNNEL_LOG="$LOG_DIR/ck-bridge-tunnel.log"
PORT="${BRIDGE_PORT:-3000}"

mkdir -p "$PID_DIR"

# --- Source .env if present -------------------------------------------------

if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

# --- Validate ---------------------------------------------------------------

if [[ -z "${BRIDGE_TOKEN:-}" ]]; then
  echo "ERROR: BRIDGE_TOKEN is not set."
  echo "  Create one with: openssl rand -hex 32"
  echo "  Then put it in $SCRIPT_DIR/.env or export it before running this script."
  exit 1
fi

if [[ ! -f "$SERVER_SCRIPT" ]]; then
  echo "ERROR: server.mjs not found at $SERVER_SCRIPT"
  exit 1
fi

# --- Stop any existing bridge ----------------------------------------------

if [[ -f "$PID_DIR/server.pid" ]] || [[ -f "$PID_DIR/tunnel.pid" ]]; then
  echo "Existing bridge found, stopping it first..."
  "$SCRIPT_DIR/stop-tunnel.sh" 2>/dev/null || true
  sleep 1
fi

# --- Start server -----------------------------------------------------------

echo "Starting bridge server on port $PORT..."
setsid nohup node "$SERVER_SCRIPT" > "$SERVER_LOG" 2>&1 < /dev/null &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_DIR/server.pid"
disown $SERVER_PID 2>/dev/null || true

# Wait for server to be ready
echo "Waiting for server to be ready..."
for i in {1..20}; do
  if curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
    echo "  server is ready (PID $SERVER_PID)"
    break
  fi
  sleep 0.5
done

if ! curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
  echo "ERROR: server did not start. Log:"
  cat "$SERVER_LOG" || true
  exit 1
fi

# --- Start tunnel -----------------------------------------------------------

# BH-BRIDGE-3 HIGH-7 fix: cloudflared and docker don't need BRIDGE_TOKEN.
# Use `env -u BRIDGE_TOKEN` to scrub it from their environment so it doesn't
# leak via `ps eaux` or /proc/<pid>/environ.
echo "Starting Cloudflare tunnel..."
if command -v cloudflared > /dev/null 2>&1; then
  # Native cloudflared
  env -u BRIDGE_TOKEN setsid nohup cloudflared tunnel --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 < /dev/null &
  TUNNEL_PID=$!
  echo "$TUNNEL_PID" > "$PID_DIR/tunnel.pid"
  disown $TUNNEL_PID 2>/dev/null || true
elif command -v docker > /dev/null 2>&1; then
  # Docker fallback — env -u also works here since docker inherits from shell
  env -u BRIDGE_TOKEN setsid nohup docker run --rm --name ck-bridge-tunnel \
    cloudflare/cloudflared:latest \
    tunnel --url "http://host.docker.internal:$PORT" > "$TUNNEL_LOG" 2>&1 < /dev/null &
  TUNNEL_PID=$!
  echo "$TUNNEL_PID" > "$PID_DIR/tunnel.pid"
  disown $TUNNEL_PID 2>/dev/null || true
else
  echo "ERROR: neither cloudflared nor docker is installed."
  echo "  Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  echo "  Server is running (PID $SERVER_PID) but no tunnel."
  echo "  You can still test locally with BRIDGE_URL=http://localhost:$PORT"
  exit 1
fi

# Wait for tunnel URL to appear in log
echo "Waiting for tunnel URL..."
TUNNEL_URL=""
for i in {1..30}; do
  if [[ -f "$TUNNEL_LOG" ]]; then
    TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)
    if [[ -n "$TUNNEL_URL" ]]; then
      break
    fi
  fi
  sleep 1
done

if [[ -z "$TUNNEL_URL" ]]; then
  echo "ERROR: tunnel URL not found in log after 30s. Tunnel log:"
  cat "$TUNNEL_LOG" || true
  echo ""
  echo "Server is still running (PID $SERVER_PID). You can stop it with:"
  echo "  kill $SERVER_PID"
  exit 1
fi

# --- Done -------------------------------------------------------------------

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Bridge is UP. Configure your claude-killer CLI .env with:"
echo ""
echo "    API_PROVIDER=bridge"
echo "    BRIDGE_URL=$TUNNEL_URL"
# BH-BRIDGE-3 HIGH-6 fix: mask the token in stdout (don't leak full value to
# CI logs, terminal recorders, or `tee` outputs). Show only first 4 + last 4 chars.
echo "    BRIDGE_TOKEN=${BRIDGE_TOKEN:0:4}...${BRIDGE_TOKEN: -4} (set full value in CLI .env)"
echo ""
echo "  Server PID: $SERVER_PID (log: $SERVER_LOG)"
echo "  Tunnel PID: $TUNNEL_PID (log: $TUNNEL_LOG)"
echo ""
echo "  To stop: $SCRIPT_DIR/stop-tunnel.sh"
echo "═══════════════════════════════════════════════════════════════"
