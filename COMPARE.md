# mempool.space vs xmr-space — gap analysis

Side-by-side captures at 1440×900, `iter-27-compare/{mempool,xmr}/` reference. Each row = one observed gap. Priority is "how far it pushes us off 1:1."

## Home dashboard

| # | Gap | Priority |
|---|---|---|
| H1 | **Block tile color palette is wrong.** mempool.space uses a green→yellow→orange→red ramp (low fee = green, high = red). xmr-space block tiles render magenta/pink. The fee-tier ramp variables I set in iter 6 (`--fee-tier-{slow,normal,fast,fastest}`) only feed my own components; the upstream `BlockOverviewGraph` uses hardcoded colors in `block-overview-graph/utils.ts` (`defaultColors`). Need to retarget those constants. | P0 |
| H2 | **Mempool tile uses magenta gradient.** Same root cause as H1. The mempool wall tile colors are coming from upstream's hardcoded `defaultColorFunction`. | P0 |
| H3 | **Memory Usage progress bar is brown/dark.** mempool.space uses a green bar with white track. Ours inherited the dashed-skeleton style. | P1 |
| H4 | **Network selector dropdown next to logo is missing.** mempool.space has a small Bitcoin "₿" dropdown for testnet/signet/etc. We stripped these networks (correctly), so this can stay missing — but the mainnet badge (just the "monero" or "ɱ" icon) might add visual parity. | P3 |
| H5 | **Nav icon row.** mempool.space has 7 icons (dashboard, mempool wing, pickaxe, lightning, charts, layers, info). We have 4 (dashboard, blocks, charts, info). Different icon shapes too. Largely correct since we stripped Lightning + accelerator + mining; just visual parity. | P3 |
| H6 | **Difficulty Adjustment progress bar.** mempool.space shows ~25% blue progress with "~9.8 minutes / 2.20% / In ~9 days." Ours shows a SOLID ORANGE bar with "~2 minutes / 0.00% / In ~60 seconds" because Monero retargets every block. The solid bar is technically correct but the "In ~60 seconds" framing is awkward. Could change UI to "Difficulty retargets every block — current 711B, change ±X% over last N." | P2 |
| H7 | **Pool logos under each block.** mempool.space shows pool name + branded logo (Foundry USA flame, F2Pool blue dot, AntPool green pyramid). Ours just says "↑ unknown." Acceptable as TODO but the icon-less label is visually weaker. | P2 |
| H8 | **Block tile fee-span band varies in size & color.** mempool.space's tile has a thin horizontal fee-span bar near the top whose color and width reflect the actual range. Ours is uniform pink because the underlying `feeRange` quantiles map onto the same hardcoded color. Same fix as H1. | P0 (subsumed by H1) |

## /blocks list

| # | Gap | Priority |
|---|---|---|
| L1 | **Pool column missing.** mempool.space has Height / Pool (with logo) / Timestamp / Health / Reward / Fees / TXs / Size. We have Height / Mined / TXs / Size / Reward / Difficulty / Hash. We need a Pool column even if every entry says "unknown." Difficulty / Hash columns are fine extras. | P2 |
| L2 | **Size column has no progress bar.** mempool.space shows a tiny horizontal blue bar with the byte count overlaid. Ours just shows raw bytes. Simple SCSS addition. | P2 |
| L3 | **Reward / Fees columns stylistically different.** mempool.space shows reward in BTC + fiat green; fees similar. Ours single-column XMR. | P3 |
| L4 | **Pager UX.** mempool.space uses ascending/descending icon toggles + Order. Ours has Latest / Newer / Older text buttons. Both work; mempool is cleaner. | P3 |
| L5 | **Health column.** Bitcoin-only (compares actual block to expected). Skip. | N/A |

## /block/:hash detail

| # | Gap | Priority |
|---|---|---|
| B1 | **No prev/next chevron navigation on the title.** mempool.space title is `Block ◀ 948090 ▶ ✕`. Ours is `Block #3,667,738`. Critical UX — clicking arrows lets you walk through blocks. | P0 |
| B2 | **No selection indicator on the block strip.** mempool.space draws a downward V/triangle pointing to the currently-viewed block. Easy WebGL/SCSS addition. | P1 |
| B3 | **Stat row uses 5 cards instead of a 2-col key-value table.** mempool.space has a clean two-column metadata table (Hash / Timestamp / Size / Weight / Health on left; Fee span / Median fee / Total fees / Subsidy + fees / Miner on right). Ours has 5 cards horizontally then a separate "Block" card below with the rest. Restructure the layout. | P1 |
| B4 | **No Hash truncation with copy button.** mempool.space shows `000000...f6a6b88 📋`. Ours shows the full hash. | P2 |
| B5 | **Below table layout — no "Expected Block" / "Actual Block" comparison.** Bitcoin-specific (mempool.space predicts what next block looks like vs actual). Doesn't apply to Monero — skip. | N/A |
| B6 | **WebGL graph color palette.** Same H1 issue — mempool shows green tiles, ours shows magenta. | P0 (H1) |

## /tx/:hash detail

| # | Gap | Priority |
|---|---|---|
| T1 | **No flow / bowtie diagram.** mempool.space has a "Flow" section showing input→output flow as a stylized bowtie. We can't show this on Monero (RingCT hides amounts) — but we could replace it with a **ring-members visualization** showing the 16 ring members per input as a list of decoy hashes/heights. Medium effort. | P2 |
| T2 | **Single-column metadata vs two-column.** mempool.space shows Timestamp / Confirmed / Features / Audit on left; Fee / Fee rate / Miner on right. Ours single-column rows. | P1 |
| T3 | **"Confirmed N confirmations" badge on the RIGHT of title.** Ours is below. | P2 |
| T4 | **Features badges.** mempool.space shows SegWit / Taproot / RBF tech-tag badges. We could surface analogous tags: `RingCT v6`, `Bulletproof+`, `View tags`, `Ring 16`. | P1 |
| T5 | **Hash format.** mempool shows full hash inline next to "Transaction" header; ours truncates. | P2 |
| T6 | **Reveal flows.** Monero-specific — these are our differentiator and don't exist on mempool.space. Keep as-is. | KEEP |

---

## Priority order for fixes

1. **iter 28 — color palette retarget** (P0). Patches `block-overview-graph/utils.ts` `defaultColors` so the WebGL fee-tier ramp matches mempool's green→yellow→orange→red shape. Single file, fixes H1+H2+H8+B6 in one shot.
2. **iter 29 — block-detail layout** (P0/P1). Restructure XmrBlockDetail to use the two-column key-value table + prev/next chevron nav + selection indicator on the strip. Drops the 5-card stat row.
3. **iter 30 — tx-detail layout** (P1). Two-column metadata + Features badges for Monero (RingCT v6, Bulletproof+, View tags, Ring 16) + confirmation badge top-right.
4. **iter 31 — /blocks polish** (P2). Add Pool column, Size progress bar.
5. **iter 32 — minor polish** (P2-P3). Memory Usage green bar, hash copy button, ring-members visualization on tx detail.
