# xmr-space Progress Report

Date: 2026-05-16

## Docs Reviewed

I reviewed the repo docs that define current scope and history: `README.md`,
`PROGRESS.md`, `AUDIT.md`, `COMPARE.md`, `backend/README.md`,
`frontend/README.md`, `docker/README.md`, `production/README.md`,
`rust/gbt/README.md`, `COPYING.md`, and `CONTRIBUTING.md`.

## Current State

The fork is well past the early iteration-24 baseline. The active app now uses
a standalone Monero backend, XMR-shaped REST/WebSocket/SSE payloads, Monero
fee units, RingCT-safe transaction rendering, tx_proof verification via
optional wallet RPC, XMR price/history persistence, best-effort miner/pool
fingerprinting, and an XMR route contract that strips Bitcoin/Liquid/Lightning,
RBF, accelerator, address, wallet, and UTXO surfaces from the routed app.

The docs record recent verification as strong: live smoke coverage was expanded
to 41/41 API probes, and the built frontend route-contract Cypress spec reached
45/45 green after re-enabling the aggregate mining-pool graph. I did not rerun
the full build/Cypress suite in this pass; I did run `git diff --check`, which
is clean.

## Work Completed In This Pass

The main doc gap I found was orientation: `frontend/README.md` and
`production/README.md` still opened as upstream Bitcoin/mempool.space guidance.
I added xmr-space-specific front matter to both so a reader lands on the active
Monero backend/frontend/deployment path before the preserved upstream material.

## Remaining Work

Two items are still not product-complete:

- client-side recipient/view-key and tx_secret_key verification remains
  deferred until a browser Monero scanner is bundled;
- preserved upstream source still exists outside active XMR routes, so the
  broader stale-code sweep is not finished even though active production chunks
  are heavily guarded by tests.

The project looks close for active routed behavior. Before calling it fully
done, I would rerun backend Jest, frontend production build, missing-translation
scan, built Cypress route contract, and live API smoke against a fresh backend,
then update `AUDIT.md` / `PROGRESS.md` with the new evidence.
