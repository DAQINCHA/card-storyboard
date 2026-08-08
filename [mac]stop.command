#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$PROJECT_DIR/.storyboard-server.pid"
PORT="${PORT:-5188}"

if [ ! -f "$PID_FILE" ]; then
  PORT_PIDS="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "${PORT_PIDS:-}" ]; then
    echo "$PORT_PIDS" | xargs kill >/dev/null 2>&1 || true
    sleep 0.5
    echo "$PORT_PIDS" | xargs -I{} sh -c 'kill -0 {} >/dev/null 2>&1 && kill -9 {} >/dev/null 2>&1 || true'
    echo "已按端口 $PORT 停止服务进程。"
    read -r -p "按回车退出..."
    exit 0
  fi
  echo "未找到运行中的服务记录。"
  read -r -p "按回车退出..."
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -z "${PID:-}" ]; then
  rm -f "$PID_FILE"
  echo "PID 记录为空，已清理。"
  read -r -p "按回车退出..."
  exit 0
fi

if kill -0 "$PID" >/dev/null 2>&1; then
  kill "$PID" >/dev/null 2>&1 || true
  sleep 0.5
  if kill -0 "$PID" >/dev/null 2>&1; then
    kill -9 "$PID" >/dev/null 2>&1 || true
  fi
  echo "已停止服务 (PID: $PID)"
else
  echo "服务进程不存在，已清理 PID 记录。"
fi

rm -f "$PID_FILE"
read -r -p "按回车退出..."
