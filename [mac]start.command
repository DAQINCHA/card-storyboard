#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$PROJECT_DIR/.storyboard-server.pid"
LOG_FILE="$PROJECT_DIR/storyboard-server.log"
PORT="${PORT:-5199}"
PUBLIC_ORIGIN="${STORYBOARD_PUBLIC_ORIGIN:-http://localhost:$PORT}"

cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装 Node.js 后重试。"
  read -r -p "按回车退出..."
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  RUNNING_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${RUNNING_PID:-}" ] && kill -0 "$RUNNING_PID" >/dev/null 2>&1; then
    echo "服务已在运行 (PID: $RUNNING_PID)。"
    open "$PUBLIC_ORIGIN"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

PORT_PID="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
if [ -n "${PORT_PID:-}" ]; then
  echo "端口 $PORT 已被进程 $PORT_PID 占用。为安全起见不会自动终止该进程。"
  read -r -p "按回车退出..."
  exit 1
fi

if ! node server.js verify-db >/dev/null 2>&1; then
  echo "数据库尚未完成账户初始化或版本不匹配。"
  echo "请在终端中执行："
  echo "  cd \"$PROJECT_DIR\""
  echo "  node server.js setup-admin --username admin"
  read -r -p "按回车退出..."
  exit 1
fi

export STORYBOARD_PUBLIC_ORIGIN="$PUBLIC_ORIGIN"
export STORYBOARD_ALLOWED_ORIGINS="${STORYBOARD_ALLOWED_ORIGINS:-$PUBLIC_ORIGIN}"
if [[ "$PUBLIC_ORIGIN" == http://* ]]; then
  export STORYBOARD_ALLOW_INSECURE_HTTP="${STORYBOARD_ALLOW_INSECURE_HTTP:-1}"
fi

echo "正在启动卡片分镜服务..."
nohup node server.js >"$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" >"$PID_FILE"

sleep 1
if kill -0 "$NEW_PID" >/dev/null 2>&1; then
  echo "启动成功，PID: $NEW_PID"
  echo "日志文件: $LOG_FILE"
  open "$PUBLIC_ORIGIN"
  exit 0
fi

echo "启动失败，请查看日志: $LOG_FILE"
rm -f "$PID_FILE"
read -r -p "按回车退出..."
exit 1
