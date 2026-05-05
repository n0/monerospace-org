# xmr-space convergence log

A Monero-themed fork of [mempool/mempool](https://github.com/mempool/mempool). This file is the working memory for the iterative retargeting loop. Read it at the start of every iteration; update it at the end.

---

## Architectural decisions (locked in iteration 1)

- **Fork strategy:** keep upstream Angular frontend; strip Bitcoin-only modules (Lightning, accelerator, RBF, mining-pool fee-share); replace data bindings, not layouts.
- **Backend:** parallel `backend/src/api/monero/` next to the existing `backend/src/api/bitcoin/`. Reuse upstream caching, websocket, SSE plumbing.
- **DB:** keep MariaDB. Rename Bitcoin-specific tables only where ambiguous; drop tables for stripped features. No Postgres migration in iteration 1.
- **Daemon:** `https://xmr-node.cakewallet.com:18081` for dev. Configured via `MONEROD_RPC_URL` env var.
- **Theme:** dark + Monero orange `#FF6600`, green confirmations. Update upstream SCSS variables; do not rewrite styling.
- **Migrations location:** schema lives in `backend/src/api/database-migration.ts` (not `backend/src/sql/` as originally referenced — adjusted to match actual upstream layout).
- **Reveal flows:** keys NEVER touch the server. `monero-ts` WebAssembly in the browser. Server-side verification only for `tx_proof` (which is non-secret).

---

## Goals

### Backend retarget
- [x] Replace bitcoind RPC client with monerod RPC client. Implement `getInfo`, `getBlockCount`, `getBlock`, `getTransactionPool`, `getFeeEstimate` against the daemon's JSON-RPC. Cache 5–10s server-side. _(iteration 2; live-verified against `https://xmr-node.cakewallet.com:18081` — height 3,667,656, fees `[20000, 80000, 320000, 4000000]`.)_
- [x] ~~ZMQ subscriber~~ → polling-based event bus + SSE. _(iteration 5; cake daemon doesn't expose ZMQ. `MoneroEventBus` polls `get_info` + `/get_transaction_pool` every 3s, emits `block` / `mempool-delta`; `/api/v1/events` exposes them as SSE with snapshot-on-connect and 25s heartbeats. Live-verified: snapshot + mempool-delta both fired in a 20s window.)_
- [~] REST API surface — keep upstream URL shapes (`/api/v1/*`), retarget data:
  - [x] `/api/v1/info` — height, hashrate, difficulty, mempool count
  - [x] `/api/v1/blocks` — recent block headers
  - [x] `/api/v1/block/:hash` — block detail (tx hashes only, no amounts)
  - [x] `/api/v1/tx/:hash` — both mempool and confirmed paths. Confirmed shape: `{status, hash, block_height, confirmations, num_inputs, num_outputs, ring_size, ring_size_consistent, ring_offsets_per_input, key_images, has_view_tags, rct_type, fee}`. NEVER includes amounts or recipients.
  - [x] `/api/v1/mempool` — current mempool with fee + size per tx
  - [x] `/api/v1/fees/recommended` — Monero 4-tier fee response
- [x] `MoneroApi.getTransactionByHash(hash)` — wraps `/get_transactions` (the non-JSON-RPC endpoint), decodes `as_json` to surface ring offsets, vin/vout counts, ring size. _(iteration 4)_
- [ ] `MoneroApi.getOuts(indices[])` → resolve global output indices to block heights, so the frontend can show "ring decoy ages" (oldest decoy / median age / newest). Currently `ring_offsets_per_input` returns the raw delta-encoded indices — frontend can lay them out without resolution but ages need this call.
- [ ] `[~]` Mark the parent REST goal `[x]` once these sub-goals are checked. (Currently 6/6 routes work; ring-age resolution is the only remaining gap.)
- [ ] Strip endpoints that don't apply: address balance / tx history (private), UTXO endpoints, Lightning, accelerator, mining-pool stats (keep simple miner-pool fingerprint only if easy).

### Frontend retarget
- [ ] Top bar — height + hashrate + difficulty + time-since-last-block (2-min target).
- [ ] Mempool wall — txs as fee-tiered squares, 4 colors for the 4 fee tiers, weight = area.
- [ ] Projected blocks — 1–2 blocks on the left at current fee pressure.
- [ ] Confirmed blocks stream — blocks scrolling left, height + miner + tx count + size + age.
- [ ] Block detail page — height, hash, miner-if-identifiable, fee total, tx list (hashes + sizes only).
- [ ] Tx detail page — public-only by default (hash, size, weight, fee, ring size 16, ring member ages, in/out counts, confs). Three reveal flows:
  - [ ] "I received this tx" — view-key + sub-address, decrypt client-side via `monero-ts`.
  - [ ] "I sent this tx — verify payment" — `tx_proof_signature` server-side verify (no secrets).
  - [ ] "I have the tx_secret_key" — sender-side decryption, client-side.
- [~] Theme — dark + Monero orange. Update SCSS variables. _(iteration 6: SCSS variables retargeted in `frontend/src/styles.scss` — `$primary: #ff6600`, `$title-fg: #ff6600`, `--orange: #ff6600`, `--green: #0eaa2e`, $bg darkened to `#0d0f17`, four `--fee-tier-*` vars added for the mempool-wall tile ramp. Sass compile clean. Per-component visual verification deferred until those components render against the new theme.)_

### Stretch (only after non-stretch goals checked)
- [ ] Atomic-swap ticker (Haveno / Serai / COMIT aggregators).
- [ ] Privacy-hygiene metrics (non-default ring sizes, view-tag adoption).
- [ ] Daemon health page (public Monero RPC nodes, latency / height-behind / version).

---

## Last iteration

**Iteration 4 (2026-05-05):** Confirmed-tx detail. Added `MoneroApi.getTransactionsByHashes(hashes)` (and single-hash convenience wrapper) hitting `/get_transactions` with `decode_as_json=true&prune=true`, 30s cache. Wired into `/api/v1/tx/:hash` after the mempool check. Live-verified: tx `544f6fb7...` returned `ring_size: 16, ring_size_consistent: true, num_inputs: 1, num_outputs: 2, has_view_tags: true, rct_type: 6 (CLSAG+BP+), fee: 491520000`, plus the 16-element delta-encoded ring offsets.

**Privacy invariant audit:** the confirmed-tx shape includes `key_images` (public), `ring_offsets_per_input` (public), `rct_type` (public), `has_view_tags` (public). It does NOT include `vout[].target.tagged_key.key` (one-time output keys — public on chain but unhelpful and potentially confusing if exposed without context), `extra` (could carry payment IDs in legacy txs), or `amount` (always 0 in RingCT but we still don't surface it). If a future iteration wants to surface output one-time keys for ring-member overlap visualisations, that's an explicit decision.

---

**Iteration 3 (2026-05-05):** REST surface live. Added `monero.routes.ts` (6 endpoints, mirrors upstream URL shapes) + `xmr-server.ts` (standalone Express entry that doesn't disrupt upstream's bootstrap). Verified end-to-end against the public daemon:

- `/healthz` ✓
- `/api/v1/info` → `{height, difficulty, mempool_size, hashrate_hs, ...}` (synthesised hashrate from `difficulty / 120s`).
- `/api/v1/blocks?count=N` (capped at 25) → array of recent block headers, age computed.
- `/api/v1/block/:hash` → header + tx_hashes (validated 64-hex; 400 on bad input; 404 on not-found).
- `/api/v1/tx/:hash` → mempool path returns shape `{hash, weight, fee, fee_per_byte, receive_time, ...}`. Confirmed-tx path returns 404 with explicit message — deferred sub-goal added.
- `/api/v1/mempool` → `{count, total_weight, total_fee, txs[]}` sorted by fee desc.
- `/api/v1/fees/recommended` → `{slow, normal, fast, fastest, quantization_mask}` from monerod's 4-tier model.

Caching verified: 179ms cold → 5ms warm on `/api/v1/info`. CORS open in dev so the frontend's ng dev server can hit us without a proxy.

**Why standalone server:** the upstream `backend/src/index.ts` boots bitcoind RPC, RBF cache, mining-pool indexer, audit pipeline — all UTXO-shaped. Retargeting them is multiple iterations of work; meanwhile the standalone entry gives the frontend something to talk to.

**What's left for backend:** confirmed-tx detail (`getTransactionByHash`), then either ZMQ (if we self-host monerod) or polling-based event bus to push new blocks / new mempool txs over websocket/SSE.

---

**Iteration 2 (2026-05-05):** monerod RPC client. Added `backend/src/api/monero/` (parallel to `backend/src/api/bitcoin/`):

- `monero-api.interface.ts` — `IMoneroApi` namespace with `Info`, `BlockHeader`, `Block`, `MempoolEntry`, `TransactionPool`, `FeeEstimate`, `TransactionEntry` types matching real daemon shape.
- `monero-rpc.ts` — axios-based transport: `jsonRpc(method, params)` for `/json_rpc` and `raw(path, body)` for non-JSON-RPC endpoints (`/get_transaction_pool`, `/get_transactions`).
- `monero-api.ts` — `MoneroApi` class with per-call caching via the existing `memoryCache`. Windows: `getInfo` 5s, `getBlockCount` 5s, `getBlockByHash`/`getBlockByHeight` 60s, `getTransactionPool` 5s, `getFeeEstimate` 10s. Factory `moneroApiFromEnv` reads `MONEROD_RPC_URL`/`MONEROD_RPC_USER`/`MONEROD_RPC_PASSWORD`/`MONEROD_RPC_TIMEOUT_MS`.
- `__tests__/monero-api.smoke.ts` — runnable smoke probe; printed live values for height, fees, mempool, head block.
- `.env.sample` at repo root documenting the Monero env vars.

`tsc --noEmit -p backend/tsconfig.json` clean (0 errors). Smoke test verified against live daemon.

**What's left:** wire these calls into the existing websocket/SSE event bus and surface them via `/api/v1/*` Express routes. ZMQ subscriber comes after — many public daemons don't expose ZMQ, so the route layer needs to work standalone first (poll-driven) before we add push.

---

## Open issues

_none yet — no functional code has been written._

---

## Convergence

- **Iteration 1 (2026-05-05):** scaffolded. Fork ✓ clone ✓ upstream remote ✓ `xmr` branch ✓ PROGRESS.md ✓ README attribution ✓. No goals checked.
- **Iteration 2 (2026-05-05):** monerod RPC client + smoke. Checked: 1 backend goal (RPC client). Remaining: ZMQ, REST routes, frontend retarget, theme, tx-detail reveals.
- **Iteration 3 (2026-05-05):** REST surface. Checked: 5/6 sub-bullets of the REST goal (info, blocks, block/:hash, mempool, fees/recommended) plus mempool-resolution path of tx/:hash. Confirmed-tx detail moved to its own sub-goal. Standalone xmr-server.ts boots & serves live data on :8999.
- **Iteration 4 (2026-05-05):** Confirmed-tx detail. Checked: `getTransactionByHash` sub-goal + the confirmed-tx path of `/api/v1/tx/:hash`. Tx `544f6fb7…` shows ring size 16, view tags, CLSAG+BP+ live. All 6/6 REST routes now functionally complete; ring-age resolution (`get_outs`) deferred as a separate sub-goal.
- **Iteration 5 (2026-05-05):** SSE push. Checked: ZMQ goal (replaced by polling-based bus). Backend is now functionally complete enough to drive a live-updating frontend.
- **Iteration 6 (2026-05-05):** Theme retarget. Checked: `[~]` theme partially (variables done; per-component visual verification deferred until components render). Frontend `npm install` completed (one-time, ~150MB). Decision locked: in-place retarget.
