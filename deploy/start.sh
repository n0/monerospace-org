#!/usr/bin/env bash
set -euo pipefail

export XMR_HOST="${XMR_HOST:-127.0.0.1}"
export XMR_PORT="${XMR_PORT:-8999}"
export XMR_INDEX_DIR="${XMR_INDEX_DIR:-/data/xmr}"
export MEMPOOL_CONFIG_FILE="${MEMPOOL_CONFIG_FILE:-/app/backend/mempool-config.json}"
export XMR_DATABASE_ENABLED="${XMR_DATABASE_ENABLED:-false}"
export DATABASE_ENABLED="${DATABASE_ENABLED:-false}"
export NODE_MAX_OLD_SPACE_SIZE="${NODE_MAX_OLD_SPACE_SIZE:-2048}"

mkdir -p "${XMR_INDEX_DIR}"

node --max-old-space-size="${NODE_MAX_OLD_SPACE_SIZE}" /app/backend/dist/api/monero/xmr-server.js &
api_pid=$!

nginx -g 'daemon off;' &
nginx_pid=$!

shutdown() {
  kill -TERM "${api_pid}" "${nginx_pid}" 2>/dev/null || true
  wait "${api_pid}" 2>/dev/null || true
  wait "${nginx_pid}" 2>/dev/null || true
}

trap shutdown INT TERM

wait -n "${api_pid}" "${nginx_pid}"
status=$?
shutdown
exit "${status}"

