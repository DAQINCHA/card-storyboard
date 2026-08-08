#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$PROJECT_DIR/.storyboard-server.pid"
LOG_FILE="$PROJECT_DIR/storyboard-server.log"
PORT="${PORT:-5188}"
HEALTH_URL="http://127.0.0.1:$PORT/api/health"

cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装 Node.js 后重试。"
  echo "下载地址: https://nodejs.org/"
  read -r -p "按回车退出..."
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" >/dev/null 2>&1; then
    HEALTH_JSON="$(curl -fsS "$HEALTH_URL" 2>/dev/null || true)"
    if [[ "$HEALTH_JSON" == *"\"dbPath\":\"$PROJECT_DIR/data/storyboard.db\""* ]]; then
      echo "服务已在运行 (PID: $OLD_PID)。"
      open "http://localhost:$PORT"
      exit 0
    fi
    echo "检测到服务运行目录已变化，正在自动重启..."
    kill "$OLD_PID" >/dev/null 2>&1 || true
    sleep 0.5
    if kill -0 "$OLD_PID" >/dev/null 2>&1; then
      kill -9 "$OLD_PID" >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$PID_FILE"
fi

PORT_PID="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
if [ -n "${PORT_PID:-}" ]; then
  HEALTH_JSON="$(curl -fsS "$HEALTH_URL" 2>/dev/null || true)"
  if [[ "$HEALTH_JSON" == *"\"dbPath\":\"$PROJECT_DIR/data/storyboard.db\""* ]]; then
    echo "$PORT_PID" >"$PID_FILE"
    echo "服务已在运行 (PID: $PORT_PID)。"
    open "http://localhost:$PORT"
    exit 0
  fi
  echo "检测到端口 $PORT 被旧目录服务占用，正在自动替换..."
  kill "$PORT_PID" >/dev/null 2>&1 || true
  sleep 0.5
  if kill -0 "$PORT_PID" >/dev/null 2>&1; then
    kill -9 "$PORT_PID" >/dev/null 2>&1 || true
  fi
fi

echo "正在启动卡片分镜服务..."
nohup node server.js >"$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" >"$PID_FILE"

sleep 1
if kill -0 "$NEW_PID" >/dev/null 2>&1; then
  echo "启动成功，PID: $NEW_PID"
  echo "日志文件: $LOG_FILE"
  open "http://localhost:$PORT"
  exit 0
fi

echo "启动失败，请查看日志: $LOG_FILE"
rm -f "$PID_FILE"
read -r -p "按回车退出..."
exit 1
