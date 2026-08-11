#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$PROJECT_DIR/.storyboard-server.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "未找到由本项目启动的服务记录；不会按端口终止未知进程。"
  read -r -p "按回车退出..."
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -n "${PID:-}" ] && kill -0 "$PID" >/dev/null 2>&1; then
  kill "$PID" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do
    kill -0 "$PID" >/dev/null 2>&1 || break
    sleep 0.2
  done
  if kill -0 "$PID" >/dev/null 2>&1; then
    echo "服务未在等待时间内退出，请手动检查 PID $PID。"
    exit 1
  fi
  echo "已停止服务 (PID: $PID)"
else
  echo "服务进程不存在，已清理 PID 记录。"
fi
rm -f "$PID_FILE"
read -r -p "按回车退出..."
