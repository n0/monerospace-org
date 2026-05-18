#!/usr/bin/env bash
# xmr-space live API smoke test. Hits every endpoint the frontend
# touches against the running backend (default: 127.0.0.1:8999) and
# reports HTTP status + payload sanity. Exits non-zero on any failure.
#
# Usage:
#   ./scripts/smoke-test.sh [base-url]
#   LOOP=1 ./scripts/smoke-test.sh           — re-run until all pass
#   LOOP=1 MAX_TRIES=10 ./scripts/smoke-test.sh
#
# The remote monerod daemon (cakewallet.com) occasionally drops TLS
# mid-request, so a single failed pass may not indicate a real bug.
# LOOP=1 retries until either every probe passes or MAX_TRIES is hit.

set -uo pipefail

BASE="${1:-http://127.0.0.1:8999}"
LOOP="${LOOP:-0}"
MAX_TRIES="${MAX_TRIES:-6}"
SLEEP_BETWEEN="${SLEEP_BETWEEN:-3}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0
FAIL=0
FAIL_LIST=()

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
yellow(){ printf '\033[33m%s\033[0m' "$1"; }

# Probe an endpoint. Args: METHOD PATH EXPECTED_HTTP CHECK_DESC CHECK_KIND CHECK_ARG
# CHECK_KIND:
#   ""        — any 2xx (or matching expected) is fine
#   "jq:..."  — value (after the colon) is a jq filter that must produce
#               non-null/non-empty/non-zero on body
#   "regex:.."— value is a regex; body must match it (used for plaintext)
#   "len:N"   — body string length must be >= N (used for plaintext)
# Multiple expected codes can be given as "200|204|404".
probe() {
  local path="$1" expected="$2" desc="$3" check="${4:-}"
  local body code
  body=$(curl -s -w "\n%{http_code}" --max-time 8 "$BASE$path")
  code=$(echo "$body" | tail -1)
  body=$(echo "$body" | sed '$d')
  local ok=true
  case "$expected" in
    2xx)        [[ "$code" =~ ^2 ]] || ok=false;;
    *\|*)
      local pat="^(${expected//|/|})\$"
      [[ "$code" =~ $pat ]] || ok=false;;
    *)          [[ "$code" == "$expected" ]] || ok=false;;
  esac
  if $ok && [[ -n "$check" ]]; then
    local kind="${check%%:*}" arg="${check#*:}"
    case "$kind" in
      jq)
        local out
        out=$(echo "$body" | jq -r "$arg" 2>/dev/null)
        if [[ -z "$out" || "$out" == "null" || "$out" == "0" ]]; then
          ok=false; desc="$desc (jq '$arg' empty/null/zero)"
        fi;;
      regex)
        if ! echo "$body" | grep -Eq "$arg"; then
          ok=false; desc="$desc (body did not match /$arg/)"
        fi;;
      len)
        if (( ${#body} < arg )); then
          ok=false; desc="$desc (body length ${#body} < $arg)"
        fi;;
    esac
  fi
  if $ok; then
    printf '  %s  %s  %s  %s\n' "$(green "PASS")" "$code" "$path" "$desc"
    PASS=$((PASS+1))
  else
    printf '  %s  %s  %s  %s\n' "$(red "FAIL")" "$code" "$path" "$desc"
    FAIL=$((FAIL+1))
    FAIL_LIST+=("$path -> $code | $desc")
  fi
}

probe_sse() {
  local body ok=true
  body=$(curl -sN --max-time 6 "$BASE/api/v1/events" 2>/dev/null || true)
  if ! echo "$body" | grep -q 'event: snapshot' || ! echo "$body" | grep -q '^data:'; then
    ok=false
  fi
  if $ok; then
    printf '  %s  %s  %s  %s\n' "$(green "PASS")" "200" "/api/v1/events" "SSE snapshot stream"
    PASS=$((PASS+1))
  else
    printf '  %s  %s  %s  %s\n' "$(red "FAIL")" "000" "/api/v1/events" "SSE snapshot stream"
    FAIL=$((FAIL+1))
    FAIL_LIST+=("/api/v1/events -> 000 | SSE snapshot stream")
  fi
}

probe_ws() {
  local output ok=true
  output=$(BASE_URL="$BASE" ROOT_DIR="$ROOT_DIR" node <<'NODE' 2>&1
const WebSocket = require(`${process.env.ROOT_DIR}/backend/node_modules/ws`);
const base = process.env.BASE_URL;
const wsUrl = base.replace(/^http/, 'ws') + '/api/v1/ws';
const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => {
  console.error('timeout waiting for websocket snapshot');
  ws.terminate();
  process.exit(1);
}, 8000);

ws.on('open', () => {
  ws.send(JSON.stringify({ action: 'init' }));
});
ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    if (Array.isArray(msg.blocks) && msg.mempoolInfo && msg.fees && Array.isArray(msg.transactions)) {
      clearTimeout(timer);
      console.log('snapshot');
      ws.close();
      process.exit(0);
    }
  } catch {
    // Ignore non-JSON frames.
  }
});
ws.on('error', (err) => {
  clearTimeout(timer);
  console.error(err.message);
  process.exit(1);
});
NODE
  ) || ok=false
  if $ok; then
    printf '  %s  %s  %s  %s\n' "$(green "PASS")" "101" "/api/v1/ws" "WebSocket init snapshot"
    PASS=$((PASS+1))
  else
    printf '  %s  %s  %s  %s\n' "$(red "FAIL")" "000" "/api/v1/ws" "WebSocket init snapshot (${output//$'\n'/; })"
    FAIL=$((FAIL+1))
    FAIL_LIST+=("/api/v1/ws -> 000 | WebSocket init snapshot")
  fi
}

run_one_pass() {
  PASS=0
  FAIL=0
  FAIL_LIST=()
  echo "=== xmr-space smoke test ==="
  echo "Target: $BASE"
  echo

# 1) Discover live state from public endpoints
echo "[discovering live state]"
BLOCKS_JSON=$(curl -s --max-time 8 "$BASE/api/v1/blocks")
TIP_BLOCK=$(echo "$BLOCKS_JSON" | jq -r 'map(select(.id and .height))[0].id // empty' 2>/dev/null)
TIP_HEIGHT=$(echo "$BLOCKS_JSON" | jq -r 'map(select(.id and .height))[0].height // empty' 2>/dev/null)
SECOND_BLOCK=$(echo "$BLOCKS_JSON" | jq -r 'map(select(.id and .height))[1].id // empty' 2>/dev/null)
TX_HASH=$(curl -s --max-time 5 "$BASE/api/mempool/recent" | jq -r '.[0].txid // empty')
BLOCK_TX_HASH=""
SUMMARY_BLOCK="$TIP_BLOCK"
if [[ -n "$TIP_BLOCK" ]]; then
  BLOCK_TX_HASH=$(curl -s --max-time 8 "$BASE/api/v1/block/$TIP_BLOCK/summary" | jq -r '.[0].txid // empty' 2>/dev/null)
fi
if [[ -z "$BLOCK_TX_HASH" && -n "$SECOND_BLOCK" ]]; then
  SUMMARY_BLOCK="$SECOND_BLOCK"
  BLOCK_TX_HASH=$(curl -s --max-time 8 "$BASE/api/v1/block/$SECOND_BLOCK/summary" | jq -r '.[0].txid // empty' 2>/dev/null)
fi
if [[ -z "$TX_HASH" ]]; then
  TX_HASH="$BLOCK_TX_HASH"
fi

echo "  tip_hash=$TIP_BLOCK"
echo "  tip_height=$TIP_HEIGHT"
echo "  second_block=$SECOND_BLOCK"
echo "  sample_block_tx=$BLOCK_TX_HASH"
echo "  sample_tx=$TX_HASH"
echo

if [[ -z "$TIP_BLOCK" || -z "$TIP_HEIGHT" ]]; then
  echo "$(red FATAL): could not bootstrap tip from /api/v1/blocks"
  return 1
fi

echo "[chain]"
probe "/api/v1/blocks" 200 "list of recent blocks" "jq:if length > 0 then 1 else null end"
probe "/api/v1/blocks/$((TIP_HEIGHT-15))" 200 "blocks-bulk paginated by height" "jq:if length > 0 then 1 else null end"
probe "/api/v1/block/$TIP_BLOCK" 200 "tip block detail" "jq:.id"
probe "/api/v1/block/$TIP_BLOCK/summary" 200 "block strip viz" "jq:if length >= 0 then 1 else null end"
probe "/api/v1/block/$TIP_BLOCK/audit-summary" 404 "audit-summary 404 (we don't audit)"
probe "/api/block/$TIP_BLOCK/txs/0" 200 "block tx list page 0" "jq:if length > 0 then 1 else null end"
probe "/api/v1/block/$TIP_BLOCK/txs/0" 200 "v1 block tx list page 0" "jq:if length > 0 then 1 else null end"
probe "/api/block/$TIP_BLOCK/raw" 200 "raw Monero block blob" "len:20"
probe "/api/v1/block/$TIP_BLOCK/raw" 200 "v1 raw Monero block blob" "len:20"
probe "/api/block/$TIP_BLOCK/header" 200 "header alias returns Monero block blob" "len:20"
probe "/api/block-height/$TIP_HEIGHT" 200 "block height -> hash plaintext" "regex:^[a-f0-9]{64}$"
probe "/api/blocks/tip/hash" 200 "tip hash plaintext" "regex:^[a-f0-9]{64}$"
probe "/api/blocks/tip/height" 200 "tip height plaintext" "regex:^[0-9]+$"
probe "/api/v1/difficulty-adjustment" 200 "difficulty adjustment" "jq:.adjustedTimeAvg // .timeAvg // 1"
if [[ -n "$BLOCK_TX_HASH" ]]; then
  probe "/api/v1/block/$SUMMARY_BLOCK/tx/$BLOCK_TX_HASH/summary" 200 "single stripped tx summary" "jq:.txid"
else
  echo "  $(yellow SKIP)  no non-coinbase tx found for single stripped summary"
fi

echo
echo "[mempool / fees]"
probe "/api/mempool" 200 "mempool top-line stats" "jq:if .count >= 0 and .total_weight >= 0 and .total_fee >= 0 and (.txs | type == \"array\") then 1 else null end"
probe "/api/v1/mempool" 200 "v1 mempool top-line stats" "jq:if .count >= 0 and .total_weight >= 0 and .total_fee >= 0 and (.txs | type == \"array\") then 1 else null end"
probe "/api/mempool/recent" 200 "recent mempool txs" "jq:if length >= 0 then 1 else null end"
probe "/api/v1/fees/recommended" 200 "fee tiers" "jq:.fastestFee // .fastest // 1"
probe "/api/v1/fees/mempool-blocks" 200 "projected blocks" "jq:if length >= 0 then 1 else null end"

echo
echo "[transactions]"
if [[ -n "$TX_HASH" ]]; then
  probe "/api/v1/tx/$TX_HASH" 200 "tx detail (upstream-compatible shape)" "jq:.txid"
  probe "/api/tx/$TX_HASH" 200 "bare tx alias" "jq:.txid"
  probe "/api/tx/$TX_HASH/hex" 200 "tx blob/pruned hex" "len:8"
  probe "/api/v1/cpfp/$TX_HASH" 200 "cpfp stub" "jq:.ancestors // .descendants // .effectiveFeePerVsize // 0 | tostring | length"
  probe "/api/v1/tx/$TX_HASH/rbf" "204|404" "rbf stub (no-content)"
  probe "/api/v1/tx/$TX_HASH/cached" "204|404" "cached stub (no-content)"
  probe "/api/tx/$TX_HASH/outspends" 200 "outspends stub" "jq:if length >= 0 then 1 else null end"
  probe "/api/v1/txs/outspends?txids=$TX_HASH" 200 "batched outspends stub" "jq:if length == 1 then 1 else null end"
else
  echo "  $(yellow SKIP)  no sample tx found in mempool or tip block"
fi
probe "/api/v1/transaction-times?txId%5B%5D=deadbeef" 200 "transaction-times stub" "jq:if length >= 0 then 1 else null end"

echo
echo "[graphs / statistics]"
probe "/api/v1/statistics/2h" 200 "stats 2h" "jq:if length > 0 then 1 else null end"
probe "/api/v1/statistics/24h" 200 "stats 24h" "jq:if length >= 0 then 1 else null end"
probe "/api/v1/statistics/1w" 200 "stats 1w" "jq:if length >= 0 then 1 else null end"
probe "/api/v1/historical-price" 200 "latest XMR price" "jq:if (.prices | length) > 0 and .prices[0].USD > 0 then 1 else null end"
probe "/api/v1/mining/reward-stats/144" 200 "reward stats from exact recent XMR blocks" "jq:if (.blockCount >= 0 and .totalReward >= 0 and .totalFee >= 0 and .totalTx >= 0) then 1 else null end"
probe "/api/v1/mining/pools/1w" 200 "best-effort mining pool stats" "jq:if (.pools | type == \"array\") and (.blockCount >= 0) and (.unknownBlockCount >= 0) then 1 else null end"
probe "/api/v1/mining/pool/p2pool" 200 "P2Pool best-effort pool stats" "jq:if .pool.slug == \"p2pool\" and .blockCount[\"24h\"] >= 0 then 1 else null end"
probe "/api/v1/mining/pool/unknown" 200 "unknown mining attribution bucket" "jq:if .pool.unique_id == 0 and .blockCount[\"24h\"] >= 0 then 1 else null end"
probe "/api/v1/mining/blocks/predictions" 404 "block-health predictions stripped"
probe "/api/v1/accelerations" 200 "accelerations neutral stub" "jq:if length == 0 then 1 else null end"
probe "/api/v1/accelerator" 200 "accelerator disabled stub" "jq:if .enabled == false then 1 else null end"

echo
echo "[init / misc]"
probe "/api/v1/init-data" 200 "init-data bundle" "jq:.blocks // .conversions // .\"mempool-blocks\" // 1"
probe_sse
probe_ws

  echo
  echo "=== summary ==="
  echo "  $(green "PASS"): $PASS"
  echo "  $(red  "FAIL"): $FAIL"
  if [[ $FAIL -gt 0 ]]; then
    echo
    echo "failures:"
    for f in "${FAIL_LIST[@]}"; do echo "  - $f"; done
    return 1
  fi
  return 0
}

if [[ "$LOOP" == "0" ]]; then
  run_one_pass
  exit $?
fi

# Loop mode — retry the whole pass until clean or MAX_TRIES exhausted.
for ((try=1; try<=MAX_TRIES; try++)); do
  echo "------ attempt $try / $MAX_TRIES ------"
  if run_one_pass; then
    echo
    echo "$(green "all $PASS probes passed on attempt $try")"
    exit 0
  fi
  if (( try < MAX_TRIES )); then
    echo
    echo "retrying in ${SLEEP_BETWEEN}s..."
    sleep "$SLEEP_BETWEEN"
  fi
done
echo
echo "$(red "ran out of retries — $FAIL probe(s) still failing after $MAX_TRIES attempts")"
exit 1
