#!/usr/bin/env bash
# stop-tunnel.sh — Stop the bridge server + Cloudflare tunnel.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_DIR="/tmp/ck-bridge-pids"

stopped_anything=0

# Stop server
if [[ -f "$PID_DIR/server.pid" ]]; then
  PID=$(cat "$PID_DIR/server.pid")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping bridge server (PID $PID)..."
    kill "$PID" 2>/dev/null || true
    sleep 1
    if kill -0 "$PID" 2>/dev/null; then
      echo "  force killing..."
      kill -9 "$PID" 2>/dev/null || true
    fi
    stopped_anything=1
  fi
  rm -f "$PID_DIR/server.pid"
fi

# Stop tunnel
if [[ -f "$PID_DIR/tunnel.pid" ]]; then
  PID=$(cat "$PID_DIR/tunnel.pid")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping tunnel (PID $PID)..."
    kill "$PID" 2>/dev/null || true
    sleep 1
    if kill -0 "$PID" 2>/dev/null; then
      echo "  force killing..."
      kill -9 "$PID" 2>/dev/null || true
    fi
    stopped_anything=1
  fi
  rm -f "$PID_DIR/tunnel.pid"
fi

# Also stop any docker container we may have started
if command -v docker > /dev/null 2>&1; then
  if docker ps --format '{{.Names}}' | grep -q '^ck-bridge-tunnel$'; then
    echo "Stopping docker container ck-bridge-tunnel..."
    docker stop ck-bridge-tunnel > /dev/null 2>&1 || true
    stopped_anything=1
  fi
fi

if [[ $stopped_anything -eq 0 ]]; then
  echo "Nothing to stop (no PID files found)."
else
  echo "Bridge stopped."
fi
