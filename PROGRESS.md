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
- [ ] ZMQ subscriber for new blocks + new mempool txs. Push events into the existing event bus / websocket layer.
- [ ] REST API surface — keep upstream URL shapes (`/api/v1/*`), retarget data:
  - [ ] `/api/v1/info` — height, hashrate, difficulty, mempool count
  - [ ] `/api/v1/blocks` — recent block headers
  - [ ] `/api/v1/block/:hash` — block detail (tx hashes only, no amounts)
  - [ ] `/api/v1/tx/:hash` — public tx data only (size, fee, ring info, confs, ring members)
  - [ ] `/api/v1/mempool` — current mempool with fee + size per tx
  - [ ] `/api/v1/fees/recommended` — Monero 4-tier fee response
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
- [ ] Theme — dark + Monero orange. Update SCSS variables.

### Stretch (only after non-stretch goals checked)
- [ ] Atomic-swap ticker (Haveno / Serai / COMIT aggregators).
- [ ] Privacy-hygiene metrics (non-default ring sizes, view-tag adoption).
- [ ] Daemon health page (public Monero RPC nodes, latency / height-behind / version).

---

## Last iteration

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
