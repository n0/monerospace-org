# xmr-space — a Monero mempool & block explorer

> **Forked from [mempool/mempool](https://github.com/mempool/mempool)** — used under **AGPLv3**, see [`LICENSE`](./LICENSE) and [`COPYING.md`](./COPYING.md).
>
> `xmr-space` retargets the upstream UX vocabulary (mempool wall, projected blocks, confirmed-block stream, fee-tier colors) onto Monero's data model: RingCT-hidden amounts, fixed ring size 16, the 4-tier `get_fee_estimate` model, and a tx-detail page that exposes public RingCT metadata plus payment verification. Public `tx_proof` verification can use backend wallet RPC; private view-key receive scanning and `tx_secret_key` checks run browser-local through `monero-ts` and must never send or persist wallet secrets.
>
> See [`PROGRESS.md`](./PROGRESS.md) for the convergence log and current goal checklist.
>
> Upstream README follows below, preserved for license compliance and historical context.

---

## xmr-space backend entrypoint

The active backend entrypoint is the standalone Monero server:

```sh
cd backend
npm install --no-install-links
npm run build
MONEROD_RPC_URL=https://xmr-node.cakewallet.com:18081 npm run start
```

`npm run start` and `npm run start-production` intentionally launch `dist/api/monero/xmr-server.js`, not the upstream Bitcoin bootstrap at `dist/index.js`. The upstream entrypoint is still available as `npm run start-upstream` for historical/debug work only.

Important runtime env:

- `MONEROD_RPC_URL`, `MONEROD_RPC_USER`, `MONEROD_RPC_PASSWORD`, `MONEROD_RPC_TIMEOUT_MS`
- `MONERO_WALLET_RPC_URL` plus optional wallet-RPC credentials for tx_proof verification
- `XMR_HOST`, `XMR_PORT`, `XMR_INDEX_DIR`
- `XMR_DATABASE_ENABLED=true` or `DATABASE_ENABLED=true` enables MySQL persistence for XMR mempool stats and price history, with JSON files under `XMR_INDEX_DIR` as fallback

Payment verification notes:

- `/tx/:hash` has three verification modes: `tx_proof`, `Received` with recipient address + private view key, and `tx_secret_key` with recipient address + transaction secret key.
- Private view keys and `tx_secret_key` values stay in browser memory only. They are not valid backend inputs, are not placed in URLs, and are not written to local/session storage.
- The browser scanner depends on the frontend `monero-ts` and `assert` packages. It talks only to same-origin public monerod proxy routes under `/api/v1/monerod`, which expose an allowlisted public daemon surface.
- Subaddress receive scanning from only a subaddress + private view key is reported as unsupported in the view-key flow; use `tx_secret_key` for subaddress payment checks.

Docker startup also runs the Monero entrypoint and checks `/healthz`.

---

# The Mempool Open Source Project® [![mempool](https://img.shields.io/endpoint?url=https://dashboard.cypress.io/badge/simple/ry4br7/master&style=flat-square)](https://dashboard.cypress.io/projects/ry4br7/runs)

https://user-images.githubusercontent.com/93150691/226236121-375ea64f-b4a1-4cc0-8fad-a6fb33226840.mp4

<br>

Mempool is the fully-featured mempool visualizer, explorer, and API service running at [mempool.space](https://mempool.space/). 

It is an open-source project developed and operated for the benefit of the Bitcoin community, with a focus on the emerging transaction fee market that is evolving Bitcoin into a multi-layer ecosystem.

# Installation Methods

Mempool can be self-hosted on a wide variety of your own hardware, ranging from a simple one-click installation on a Raspberry Pi full-node distro all the way to a robust production instance on a powerful FreeBSD server. 

Most people should use a <a href="#one-click-installation">one-click install method</a>.

Other install methods are meant for developers and others with experience managing servers. If you want support for your own production instance of Mempool, or if you'd like to have your own instance of Mempool run by the mempool.space team on their own global ISP infrastructure—check out <a href="https://mempool.space/enterprise" target="_blank">Mempool Enterprise®</a>.

<a id="one-click-installation"></a>
## One-Click Installation

Mempool can be conveniently installed on the following full-node distros: 
- [Umbrel](https://github.com/getumbrel/umbrel)
- [RaspiBlitz](https://github.com/rootzoll/raspiblitz)
- [RoninDojo](https://code.samourai.io/ronindojo/RoninDojo)
- [myNode](https://github.com/mynodebtc/mynode)
- [StartOS](https://github.com/Start9Labs/start-os)
- [nix-bitcoin](https://github.com/fort-nix/nix-bitcoin/blob/a1eacce6768ca4894f365af8f79be5bbd594e1c3/examples/configuration.nix#L129)

**We highly recommend you deploy your own Mempool instance this way.** No matter which option you pick, you'll be able to get your own fully-sovereign instance of Mempool up quickly without needing to fiddle with any settings.

## Advanced Installation Methods

Mempool can be installed in other ways too, but we only recommend doing so if you're a developer, have experience managing servers, or otherwise know what you're doing.

- See the [`docker/`](./docker/) directory for instructions on deploying Mempool with Docker.
- See the [`backend/`](./backend/) and [`frontend/`](./frontend/) directories for manual install instructions oriented for developers.
- See the [`production/`](./production/) directory for guidance on setting up a more serious Mempool instance designed for high performance at scale.
