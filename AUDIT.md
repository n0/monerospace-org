# xmr-space feature audit

**Status as of commit `164364b02` (iter 15)** — written iter 16 in response to the user's correct observation that I declared "done" too early.

This file is the source of truth for what's *implemented*, what's *feasible-but-not-yet-done*, and what's *impossible on Monero* (and therefore needs to be stripped from routing). Each row points at the upstream route or component so subsequent iterations have a target list.

Legend:
- ✅ done
- 🚧 partial / has known bugs
- 🟡 feasible, not done — has effort estimate
- ❌ impossible on Monero — strip the route, leave the file

---

## Routes inventory

### App-level (`frontend/src/app/app-routing.module.ts`)

| Route | Status | Notes |
|---|---|---|
| `/` (mainnet) | ✅ | XmrDashboard via upstream master-page module + retargeted dashboard |
| `/testnet` | ❌ | Bitcoin testnet3 — strip |
| `/testnet4` | ❌ | Bitcoin testnet4 — strip |
| `/signet` | ❌ | Bitcoin signet — strip |
| `/regtest` | ❌ | Bitcoin regtest — strip |
| `/clock`, `/clock/:mode`, `/clock/:mode/:index` | 🟡 | Visual clock for mempool/mined blocks; reusable for XMR (~1 iter) |
| `/view/block/:id`, `/view/mempool-block/:index`, `/view/blocks` | 🟡 | Embedded views; low priority |
| `/widget/wallet` | ❌ | Wallet tracking — impossible on XMR (sub-addr scanning needs view key, can't be in URL) |
| `/preview` (and `preview/testnet*`) | ❌ | Sharable Bitcoin tx previews — UTXO-shaped; strip |
| `/status` | 🟡 | Generic server health page; could repurpose as daemon health |

### Master-page children (`frontend/src/app/master-page.module.ts`)

| Route | Status | Notes |
|---|---|---|
| `/about` | 🚧 | Renders, but content is mempool/Bitcoin marketing; rewrite (iter 21) |
| `/api` | 🚧 | Renders Bitcoin API docs; rewrite for `/api/v1/*` Monero endpoints (iter 21) |
| `/docs` (incl `docs/faq`) | 🚧 | Renders, content is Bitcoin/mempool FAQ; rewrite (iter 21) |
| `/blocks` | 🚧 | Routes to upstream `BlocksList` which expects Bitcoin extras (pool, fees-range); needs XmrBlocksListModule (iter 23) |
| `/blocks/stale` | ❌ | Bitcoin stale-block tracking; XMR's orphan model is different — strip |
| `/blocks/:page` | 🚧 | Same as `/blocks`, paginated; will inherit fix |
| `/block/:hash` | ✅ | XmrBlockDetailModule (iter 13) |
| `/tx/:hash` | ✅ | XmrTxDetailModule with reveal flows (iter 12) |
| `/tx/push` | ❌ | Broadcasts a raw tx via Bitcoin's `sendrawtransaction`. Monero has the same RPC (`/sendrawtransaction`) but the form input is a Bitcoin-specific hex string and the UX validates Bitcoin tx structure. Strip; a Monero broadcast tool is a follow-up. |
| `/pushtx` | ❌ | alias of `/tx/push` — strip |
| `/tx/test` | ❌ | Bitcoin `testmempoolaccept` — strip |
| `/txs` | 🚧 | Recent transactions full-page list; depends on widget data which works |
| `/rbf` | ❌ | RBF replacements — impossible on XMR — strip |
| `/stratum` | ❌ | Bitcoin Stratum mining pool dashboard — strip |
| `/lightning` | ❌ | Lightning Network — impossible on XMR — strip |
| `/mining/blocks` | ❌ | Mining-pool block list — relies on per-pool fingerprinting we don't have; strip for now |
| `/terms-of-service`, `/privacy-policy`, `/trademark-policy` | 🚧 | Renders; content references mempool's trademark; rewrite (iter 21) |

### Graphs module (`frontend/src/app/graphs/graphs.routing.module.ts`)

| Route | Status | Notes |
|---|---|---|
| `/tools/calculator` | 🟡 | Fee calculator; reusable for XMR atomic-units math (~1 iter) |
| `/mining` (incl `/mining/pool/:slug`) | ❌ | Pool fingerprinting incomplete; strip |
| `/acceleration`, `/acceleration/list*` | ❌ | Mempool's commercial accelerator; impossible — strip |
| `/mempool-block/:id` | 🚧 | Detailed view of one projected block; works because mempool-blocks data flows through |
| `/address/:id` | ❌ | Address tracking — impossible on Monero — strip |
| `/wallet/:wallet` | ❌ | Wallet tracking — impossible — strip |
| `/graphs/mempool` | 🟡 | Historical mempool size chart; needs backfill (iter 19) |
| `/graphs/mining/*` | ❌ | Mining-pool charts (hashrate, pool dominance, block-fees, subsidy) — depends on indexer + pool data we don't have; strip |

### Lightning (`frontend/src/app/lightning/`)

All ❌ — Lightning is a Bitcoin L2; doesn't apply.

### Liquid (`frontend/src/app/liquid/`)

All ❌ — Liquid is a Bitcoin sidechain; doesn't apply.

---

## Dashboard tiles

| Tile | Status | Notes |
|---|---|---|
| Top blockchain strip (projected + confirmed blocks) | 🚧 | Confirmed blocks render but in **wrong order** (iter 17 fix) |
| Transaction Fees (4-tier) | ✅ | |
| Difficulty Adjustment | ✅ | Monero retargets every block — rendered as "~2 minutes / In ~60 seconds" |
| Mempool wall (mempool-block-overview) | ✅ | Live tiles, area = weight, color = fee tier |
| Memory Usage | ✅ | |
| Unconfirmed count | ✅ | |
| Minimum fee | ✅ | (iter 15 unit fix) |
| Incoming Transactions chart | 🚧 | Empty — needs `mempoolStats.weightPerSecond` time-series; backfill (iter 19) |
| Recent Blocks table | 🚧 | Renders but order broken (iter 17) |
| Recent Transactions table | ✅ | TXID + Size + Fee (no amount column — RingCT) |
| ~~Mempool Goggles filters~~ | ❌-stripped | Bitcoin tx-flag filters (consolidation, coinjoin, data) don't translate |
| ~~Recent Replacements (RBF)~~ | ❌-stripped | No RBF on Monero |

---

## Tx-detail flows

| Element | Status | Notes |
|---|---|---|
| Public-only fields card | ✅ | hash, size, fee, ring size 16, in/out counts, RCT type, view tags, key images, ring offsets |
| Blur card with messaging | ✅ | "Amounts and recipients are mathematically hidden by Monero's RingCT — that's the point" |
| Reveal: I received this tx | 🚧 UI | Modal collects view-key + sub-address; `monero-ts` WASM decryption deferred |
| Reveal: I sent this tx (tx_proof) | 🚧 UI | Modal collects address + signature; server endpoint stub returns iter-13 message — **need backend impl** |
| Reveal: I have the tx_secret_key | 🚧 UI | Modal collects key; client decryption deferred |
| Confirmed-tx detail | ✅ | live-verified |
| Mempool-tx detail | ✅ | live-verified |
| Mempool→confirmed transition | ❓ | Untested; should refetch when WS broadcasts a `block` containing this tx |

---

## Backend feature inventory

| Feature | Status | Notes |
|---|---|---|
| `/api/v1/info` | ✅ | |
| `/api/v1/blocks` | ✅ | |
| `/api/v1/block/:hash` | ✅ | |
| `/api/v1/tx/:hash` | ✅ | mempool + confirmed paths |
| `/api/v1/mempool` | ✅ | |
| `/api/v1/fees/recommended` | ✅ | |
| `/api/v1/events` (SSE) | ✅ | |
| `/api/v1/ws` (WebSocket) | 🚧 | Speaks upstream protocol; **block-broadcast race** suspected (iter 17/18) |
| `/api/v1/tx/:hash/verify-proof` | 🟡 | Endpoint stub only; real impl needs daemon's `check_tx_proof` (~1 iter) |
| `/api/v1/blocks/:height` (height resolution) | 🟡 | Not implemented; XmrBlockDetail can't deep-link by height |
| `/api/v1/search/:query` | 🟡 | Not implemented; search box hits dead routes (iter 22) |
| Live updates / SSE | ❓ | Unverified end-to-end (iter 18) |

---

## Brand / theme

| Element | Status |
|---|---|
| SCSS theme retarget (Monero orange) | ✅ |
| Logo (xmr.space wordmark) | ✅ |
| Search placeholder | ✅ |
| Unit replacements (XMR/atomic, ɱ/B) | ✅ |
| Footer rewrite | ✅ |
| Nav cleanup | ✅ |
| Theme alt files (`theme-bukele.scss`, etc.) | 🚧 | Still Bitcoin-themed; low priority — they're alternate themes, not default |

---

## What's left, in priority order

1. **iter 17** — fix Recent Blocks ordering (visible bug)
2. **iter 18** — verify live updates end-to-end (5+ min observation)
3. **iter 19** — Incoming Transactions chart: backfill or strip
4. **iter 20** — strip impossible routes (16+ routes)
5. **iter 21** — rewrite docs/about/api pages for Monero
6. **iter 22** — wire search box
7. **iter 23** — XmrBlocksListModule for `/blocks`
8. **iter 24** — final polish + push to `n0/xmr-space`

Stretch (post-push):
- `monero-ts` WASM for actual reveal-flow decryption
- Real XMR/USD price feed (CoinGecko / Kraken)
- Pool fingerprinting from coinbase `extra` field
- Ring decoy age resolution via `/get_outs`
- Atomic-swap ticker
- Privacy-hygiene metrics chart
- Daemon health page (multiple-public-node aggregator)
