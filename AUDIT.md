# xmr-space feature audit

**Updated beyond iter 24 status.** Originally written iter 16 in response to the user's correct observation that I declared "done" too early. The current active-route audit is newer than the historical table below; some old row labels are preserved for context.

## Post-iter 24 live audit

- Active browser routes audited green via Cypress against the running XMR backend: `/`, `/blocks`, `/txs`, `/block/:hash`, `/tx/:hash`, `/graphs/mempool`, `/graphs/price`, `/graphs/mining/hashrate-difficulty`, `/graphs/mining/pools`, `/graphs/mining/block-fees`, `/graphs/mining/block-fees-subsidy`, `/graphs/mining/block-rewards`, `/graphs/mining/block-fee-rates`, `/graphs/mining/block-sizes-weights`, `/mempool-block/0`, `/tools/calculator`, `/docs`, `/docs/api/rest`.
- The root StartComponent now includes a live Monero network summary band above the chain strip: latest height, derived hashrate from difficulty, difficulty, and last-block age with the 2-minute target. Cypress locks the summary plus the projected/confirmed block strip on `/`.
- The audit treated browser console errors and failed `/api/**` responses as failures. Mining graph endpoints rendered with the current `XmrChainIndexer` shapes.
- Fixes from the audit: recent transactions no longer render permanent skeleton rows when the mempool has fewer rows than the selected limit; mempool-block overview resumes cached projected-block state or forces one tracking request after the graph child is ready.
- Active calculator audit fixed BTC-specific math and copy: it now uses XMR and 12-decimal atomic units, with no 21M fixed-supply cap.
- Active detail controls now resolve to real Monero blobs instead of empty compatibility responses: tx blob/pruned hex, block raw blob, and single stripped tx summary.
- Compatibility helper endpoints are now explicitly audited: CPFP/RBF/accelerator routes return neutral Monero-safe payloads, mining-pool stats return best-effort indexed Monero attribution, outspends never claim public spent/unspent state, electrs aliases return real Monero tip/mempool data, and the expanded live smoke script probes these contracts plus SSE/WebSocket snapshots (43/43 green against a fresh backend).
- Mempool-stat history now has a production persistence path: when the upstream MySQL database is enabled, XMR samples are stored in `xmr_mempool_stats` with the JSON file retained as development/outage fallback.
- XMR price history now has the same durable production path: latest websocket/init-data samples are persisted into `xmr_price_history` when MySQL is enabled, with `XMR_INDEX_DIR/xmr-price-history.json` as the development/outage fallback. `/graphs/price` is routed again and reads the local XMR series instead of Bitcoin price assumptions.
- Active mining fee/reward graph endpoints now enrich XmrChainIndexer buckets with stored historical fiat prices. The fees-vs-subsidy graph consumes backend `avgRewards` / `avgSubsidy` and 1e12 atomic-unit math instead of Bitcoin halving-era subsidy logic.
- Top-level and transaction-child stale route sweep stripped default-XMR access to upstream tracker, wallet widget, preview, `/tx/preview`, `/tx/push`, `/tx/test`, clock/embed, Bitcoin/Liquid status/monitoring/nodes pages, faucet, SimpleProof service-widget pages (`/sp/verified`, `/sp/cubo`), env-gated Bitcoin testnet/signet/regtest/Liquid route trees, and the upstream custom-dashboard widget swap. This also fixes the mobile `/tx/:hash` route precedence bug where the Bitcoin tracker could load before the retargeted transaction page and keeps the upstream Bitcoin raw-tx decoder out of the active transaction module.
- Permanent Cypress regression `cypress/e2e/mainnet/xmr-routing.spec.ts` covers the stripped-route redirects, verifies mobile `/tx/:hash?mode=status` still loads the XMR transaction detail, and locks the search box to Monero primitives. XMR typeahead no longer calls upstream Bitcoin address-prefix, Lightning, or mining-pool suggestion APIs.
- Active SEO copy for `/txs`, `/block/:hash`, and `/tx/:hash` is retargeted to Monero public-chain semantics instead of Bitcoin addresses/scripts/audit copy.
- Footer/legal pass retargeted `/terms-of-service`, `/privacy-policy`, and `/trademark-policy` away from upstream Bitcoin-only, Mempool Accelerator, and mempool.space policy copy. The footer no longer instantiates the BTC/sats-era amount selector, upstream mempool social links, or official mempool.space backend/version branch in the active XMR UI, and the regression spec locks those surfaces.
- The active about page now uses an XMR-specific SEO description and no longer carries the upstream sponsor/video/contributor runtime wiring or stylesheet surface.
- The active master-page shell no longer contains the Bitcoin/Liquid network selector, official mempool.space logo branch, or services/accelerator account menu plumbing; the header keeps only XMR navigation, live search, connection status, and optional enterprise logo. The icon-only nav now has explicit accessible labels/titles and active-route `aria-current` metadata.
- The top search control now exposes a proper `role="search"` region, explicit input and submit-button labels, combobox metadata pointing at the suggestions listbox, and `aria-selected` state for keyboard-highlighted suggestions.
- The active payment-verification surface now has three modes on `/tx/:hash`: backend wallet-RPC `tx_proof` for public proof signatures, browser-local "Received" scanning with recipient address + private view key, and browser-local `tx_secret_key` verification. Private view keys and tx secret keys stay in component/service memory only, are cleared on transaction reset/destroy, and are covered by Cypress checks that validation failures make no `/api/**` POST and do not write the secrets into localStorage/sessionStorage.
- The browser-local scanner is backed by lazy `monero-ts` loading plus a same-origin public monerod bridge at `/api/v1/monerod`. The bridge allowlists public daemon JSON-RPC/raw/binary scan endpoints, rejects wallet/private RPC methods, and rejects secret-shaped JSON body keys before proxying. Subaddress receive scanning from only a subaddress + private view key is explicitly reported unsupported; `tx_secret_key` remains the supported subaddress proof path.
- Active dashboard/runtime cleanup removed the dormant Liquid federation dashboard and RBF subscription paths from the XMR dashboard, and `GraphsModule` now declares only the routed XMR dashboard/statistics/mempool/mining graph components. The Bitcoin accelerator checkout/chart/timeline/sparkle widgets were also removed from active transaction/mempool templates and from `SharedModule`, and the unrouted RBF list declaration plus a dead SimpleProof component type import were detached from the active compilation graph.
- The active `/docs/api/rest` page now documents the real XMR REST/live-update surface: init-data, difficulty, price history, block summaries, projected mempool blocks, persisted mempool stats, and mining graph series. Cypress asserts it renders `app-xmr-docs`, not the upstream Bitcoin API docs, and blocks Electrum/scripthash/sat-vB/accelerator docs from reappearing.
- Active transaction and block detail pages now use Monero byte-weight semantics end to end: RingCT fee rates are computed as atomic-per-byte, displayed weights use bytes instead of Bitcoin WU/vbytes, CPFP/RBF/accelerator/audit paths stay disabled even if upstream env flags are set, and the block median-fee row no longer carries a segwit 140-vbyte fiat hint.
- Visible mempool graph and fee surfaces now use Monero units: `/graphs/mempool` labels bytes/MB and B/s instead of vbytes/MvB/vB/s, the dashboard and fee box no longer expose native-SegWit 140-vbyte estimate copy, `/mempool-block/:id` keeps median fees on `ɱ/B`, and the stripped clock route is no longer linked from the graph page. Locale catalogs and built `en-US` JS are clean for the stale strings covered by this pass, and the built-app route-contract Cypress spec is 37/37 green.
- The active transaction chunk was audited after rebuild: `/tx/:hash` now compiles without the upstream bowtie/CPFP/cluster modules, RBF replacement/cache subscriptions, accelerator checkout state, block-audit rows, BIP-30 duplicate handling, flow diagram controls, sigops/adjusted-vsize rows, or transaction-page goggles. The rebuilt transaction route chunk is clean for `RBF Timeline`, `CPFP`, `Related Transactions`, `Flow`, `Show diagram`, `BIP-30`, `Accelerate`, `Expected in Block`, `Mempool Accelerator`, `Virtual size`, `Sigops`, and related component selectors. Remaining CPFP/accelerator strings are outside the transaction route chunk, primarily docs/neutral compatibility surfaces.
- Follow-up active-bundle audit removed the remaining Bitcoin feature helpers from the transaction feature row: `TxFeaturesComponent` no longer imports `bitcoin.utils` or computes SegWit/Taproot/RBF state, and the transaction route no longer carries Liquid unblinding or Liquid SEO/ETA branches. The rebuilt transaction implementation chunk is clean for `Liquid`, `Taproot`, `SegWit`, `RBF`, `CPFP`, accelerator strings, `LiquidUnblinding`, `calcSegwitFeeGains`, and `isFeatureActive`. The active `/blocks` page metadata was also retargeted from upstream Bitcoin/Liquid copy to Monero block metadata, with Cypress coverage added for `/blocks/1`.
- The active `TransactionsListComponent` renderer was pruned to Monero semantics. It now renders RingCT inputs/outputs, key images, ring size, `/get_outs` ring-member chips, hidden amount treatment, confirmations, and block-price conversion without UTXO outspends, Lightning channel labels, Liquid asset/peg/unblinding branches, Ordinals, address-poisoning matching, witness/tapscript/script rows, signature/sighash parsing, address-balance badges, or accelerator controls. The rebuilt transaction-list chunk and transaction-detail chunk are clean for the removed Bitcoin/Liquid labels, and Cypress now asserts the RingCT renderer plus the absence of script/witness/Ordinals/Liquid/accelerator/RBF text on `/tx/:hash`.
- The root/shared compilation graph was pruned after the transaction renderer cleanup: `SharedModule` no longer imports, declares, exports, or registers the stale ASM/scriptpubkey/address-label/address-text/address-type/Ord/RBF helper declarations or their FontAwesome-only icons, and `AppModule` no longer explicitly provides `OrdApiService`. These helpers still exist on disk for a broader stale-code sweep, but the active XMR root/shared graph and production transaction/search chunks are clean for the removed signatures. `npm run tsc`, `npm run build`, and the built-app route-contract Cypress spec are green at 38/38 for this pass.
- Active block-detail metadata now uses Monero header semantics: the details table shows major/minor version, miner tx hash, decimal nonce, and the Monero block blob link instead of Bitcoin version-bit/Taproot, compact `bits`, Merkle-root, or header-hex copy. Cypress asserts the visible Monero fields and absence of Taproot/Bits/Merkle-root labels on `/block/:hash`, and the rebuilt block-detail chunk is clean for the removed labels.
- Production backend entrypoints now boot the standalone XMR server instead of upstream's Bitcoin bootstrap: `backend/package.json` starts `dist/api/monero/xmr-server.js`, Docker exports XMR/monerod env vars and runs the packaged `api/monero/xmr-server.js`, and the compose healthcheck probes `/healthz`. `XMR_DATABASE_ENABLED` / `DATABASE_ENABLED` env overrides now control the XMR stats and price persistence stores, so local non-DB starts do not accidentally open MySQL from `mempool-config.json`.
- Frontend container/runtime defaults no longer point at upstream mempool.space service hosts: `SERVICES_API` is same-origin, the onion-host override no longer rewrites services to mempool.space's onion, and `MEMPOOL_WEBSITE_URL` / `LIQUID_WEBSITE_URL` are empty by default. The dead accelerator env knobs are no longer shipped through the XMR client config path.
- The production HTML shell is now XMR-specific before Angular boots: active `index.mempool.html`, generated `src/index.html`, and localized build outputs use xmr.space title/description/canonical/social image metadata, Monero-themed tile/manifest colors, and a new XMR social preview image. The stale `meta.description.about` translation unit was also retargeted across locale catalogs so localized About chunks no longer ship the upstream Bitcoin/mempool marketing SEO description.
- The localized production build is now warning-clean for active XMR strings. `messages.xlf` was regenerated from the current Angular source, the transaction blob label was given a stable custom id, and locale catalogs now include English fallback targets for current XMR transaction, block metadata, search, recent-transaction, price, graph, and dashboard-goggle strings. `npm run build` was verified with a log scan for `No translation found` / missing-translation warnings, followed by the built-app route-contract Cypress spec at 38/38.
- Active block overview tooltip/filter controls now use Monero semantics: hidden RingCT amount copy, fee rates in atomic-per-byte units, byte size instead of virtual-size/WU rows, and no accelerator/effective-rate/CPFP/RBF/sigop audit labels. The block filter menu now exposes only Monero public signals (`Standard ring (16)`, `View tags`, `RCT v6 (latest)`), and Cypress locks those labels plus the absence of the removed Bitcoin filter/audit strings. `npm run tsc`, `npm run build`, missing-translation log scan, scoped source grep, `git diff --check`, and the built-app route-contract spec are green. A compiled `OP_RETURN` string still exists through preserved shared Bitcoin script utilities, so that belongs to the broader stale-code sweep rather than this active tooltip/filter surface.
- Active block/filter bundle hygiene was tightened after the tooltip pass. The block page now imports small fee-order helpers from `fee-rate.utils.ts` instead of the Bitcoin transaction parser, active `filters.utils.ts` only defines Monero public-signal bits, and Bitcoin-era flag constants moved to `legacy-transaction-flags.utils.ts` for stripped/raw upstream helpers. Active block detail no longer initializes accelerator lists, out-of-band fee subscriptions, accelerator fee deltas, or accelerated audit statuses. The rebuilt active graph/block chunks are clean for OP_RETURN, sighash, script-parser, Mempool Goggles, RBF, and accelerator-fee markers. `npm run tsc`, `npm run build`, missing-translation scan, scoped source/bundle checks, `git diff --check`, and the built-app route-contract Cypress spec are green at 38/38.
- The startup special-block timeline is now Monero-specific. `specialBlocks` no longer ships Bitcoin halving, Taproot, or Liquid Simplicity events in the initial bundle; it carries Monero genesis, RingCT activation, RandomX activation, and tail emission milestones instead. The production `main` bundle was verified clean for the removed Bitcoin milestone strings, and `cypress/e2e/mainnet/xmr-routing.spec.ts` now includes a bundle-level regression for these constants. `npm run tsc`, `npm run build`, missing-translation scan, `git diff --check`, and the built-app route-contract spec are green at 39/39.
- The active graph shell has been renamed from the upstream `BitcoinGraphsModule` wrapper to `XmrGraphsShellModule`, so the production lazy chunk no longer carries Bitcoin graph-shell identifiers. The shared goggles icon title used by the XMR filter menu now reads `Monero public signal filters`, and the rebuilt JS is clean for `BitcoinGraphsModule`, `bitcoin-graphs.module`, and `Mempool Goggles`. Cypress now requests the actual loaded dashboard/graph JS resources and locks that bundle contract; `npm run tsc`, `npm run build`, missing-translation scan, and the built-app route-contract spec are green at 40/40.
- The active search bundle now matches the Monero-only search contract instead of merely hiding upstream results at runtime. `SearchFormComponent` no longer imports the Bitcoin address regex/network-switch helpers, address-prefix service, Lightning search, Liquid asset lookup, or mining-pool search paths; `SearchResultsComponent` now compiles only Monero block-height and block/transaction-hash suggestions. The XMR search chunk is clean for `Lightning Nodes`, `Lightning Channels`, `Mining Pools`, `Liquid Asset`, `Other Network Address`, `bech32`, and `Mempool Accelerator`, and Cypress locks those absences by requesting the loaded JS resource that contains `Monero Block / Transaction`. `npm run tsc`, `npm run build`, missing-translation scan, and the built-app route-contract spec are green at 40/40.
- The root SEO fallback no longer carries upstream mempool.space/Bitcoin defaults. `SeoService` now defaults to `xmr.space - Monero Explorer`, a Monero-specific description, and `xmr.space` canonical domain fallback. The latest production `main` bundle was verified clean for `Explore the full Bitcoin ecosystem`, `Bitcoin Testnet3`, `Bitcoin Testnet4`, `Bitcoin Signet`, `Liquid Network`, and `Bitcoin Explorer`, and the startup bundle regression now locks the old Bitcoin ecosystem/Testnet fallback out.
- The active graph navigation no longer compiles unreachable upstream Lightning, accelerator, or block-health menu branches. The production graph chunk is clean for `Lightning Nodes`, `Lightning Network Capacity`, `Acceleration Fees`, `Block Health`, `See hashrate and difficulty for the Bitcoin`, and `See Bitcoin feerates`; the loaded-resource Cypress regression now locks those absences.
- The root app injector no longer eagerly provides `ElectrsApiService`, `ServicesApiServices`, or `PreloadService`; those `providedIn: 'root'` services now load only when a routed feature injects them. The latest startup `main` bundle dropped by about 17 kB and is clean for `address-prefix`, `scripthash`, `BTCPay`, `payments/bitcoin`, and `accelerator/invoice`, with the startup bundle regression covering the old strings. `npm run tsc`, `npm run build`, missing-translation scan, and the built-app route-contract spec are green at 40/40.
- The root network state now matches the stripped XMR route table. `StateService` no longer parses Bitcoin testnet/signet/regtest or Lightning URL state, `RelativeUrlPipe` no longer prefixes non-XMR network segments, and `seoDescriptionNetwork()` no longer emits Bitcoin subnetwork suffixes. Preserved Liquid reserves/assets endpoints were moved out of active `ApiService` into `LiquidApiService`, preserved Liquid components were rewired to that service, and the no-op root `isLiquid()` branch was removed from active startup/block code. The XMR websocket/init-data byte-rate field is now `bytesPerSecond` instead of the upstream `vBytesPerSecond` name. The latest startup `main` bundle is clean for lowercase `testnet`, `signet`, `regtest`, `Liquid`, Liquid route/API labels, and `vBytes`. The built-app route-contract spec remains green at 40/40.
- The active Electrs API surface was split so preserved Bitcoin address/scripthash helpers no longer ride along with active block/transaction consumers. `AddressApiService` now owns address, pubkey, scripthash, wallet-address history, UTXO, and address-prefix helpers; preserved address/wallet/custom-dashboard widgets inject it directly. Active transaction chunks are clean for `address-prefix`, `scripthash`, and address-history endpoint strings, and the transaction route regression requests loaded JS resources to guard that bundle boundary.
- Preserved Lightning-only helper methods were moved out of the active root `ApiService` and into lazy `LightningApiService`; preserved Lightning components now inject that service directly. Focused active-chunk greps are clean for `/api/v1/lightning`, Lightning route labels, and Lightning node/channel API strings, and the built-app route-contract spec is green at 42/42.
- The active block module no longer compiles impossible Liquid/testnet/signet block SEO or audit-start branches. `BlockComponent`, `BlockPreviewComponent`, and `BlockViewComponent` now use the Monero block description directly, and the production block chunk is clean for `Liquid`, `Bitcoin`, `testnet`, `signet`, `regtest`, `Block Health`, `address-prefix`, and `scripthash`. The block route regression now requests the loaded block-module script and locks that bundle boundary.
- The shared SVG/icon component no longer ships preserved upstream Bitcoin/Liquid network logo cases into the active XMR shell. `SvgImagesComponent` keeps the XMR wordmark, nav icons, clippy, goggles, and block art used by active routes, while removed Bitcoin/testnet/signet/regtest/Liquid logo cases and their templates no longer appear in the XMR graph/search shell chunk. The loaded-resource regression now asserts the `Monero Block / Transaction` shell script is present and clean for `testnet`, `signet`, and `regtest`.
- The active master-page/blockchain-strip chunk was pruned of upstream network color and ETA branches. Confirmed/projected block components now use the XMR color pair and current difficulty-adjustment timing directly, `MiningService` no longer carries Bitcoin testnet display units, and the production master-page chunk is clean for `Liquid`, `Bitcoin`, `testnet`, `signet`, and `regtest`. The loaded-resource regression now locks the script containing `app-blockchain-blocks`.
- The active graph chunk no longer carries upstream Signet/testnet/Liquid formatting branches. Shared `app-btc` / `app-sats` now render XMR/atomic units without subnetwork prefixes, mempool fee tier labels no longer branch on Liquid units, and hashrate/difficulty widgets use the Monero formatting path only. The graph regression now locks the script containing `app-hashrate-chart` clean for `testnet`, `signet`, `regtest`, `Liquid`, and `Bitcoin`.
- The active block/mempool WebGL transaction-wall path was tightened to XMR semantics. `TxView`, `BlockScene`, the graph color functions, projected-block deltas, and `StateService.liveMempoolBlockTransactions$` no longer carry accelerator bits or Bitcoin-only RBF/CPFP-fresh/sigop statuses; block previews no longer fetch acceleration history. The production block and graph chunks are clean for `freshcpfp`, `fullrbf`, `sigop`, `"rbf"`, the removed acceleration color, and `/api/v1/accelerations/block`, and Cypress now locks those absences on `/block/:hash`.
- Root WebSocket/RBF startup hygiene was tightened after the transaction-wall cleanup. `WebsocketService` no longer sends, reconnects, or handles upstream `track-rbf`, `track-rbf-summary`, `track-accelerations`, `rbfLatest`, `rbfTransaction`, or `txReplaced` payloads; preserved RBF REST helpers moved out of root `ApiService` into `RbfApiService`; dead root RBF state subjects were detached. The production startup `main` bundle is clean for those WebSocket markers plus `fullrbf/`, `replacements/`, `/rbf`, and `/cached`, and the built-app route-contract spec is green at 42/42.
- The preserved backend accelerator REST helpers were split out of root `ApiService` into `AccelerationApiService`, with preserved pool and checkout components rewired to use it directly. The startup `main` bundle is now clean for `/api/v1/accelerations/block`, `/api/v1/accelerations/interval`, `/api/v1/accelerations/total`, `/api/v1/accelerations/pool`, and `/api/v1/acceleration/request`; Cypress locks those absences in the startup bundle regression. Accelerator service-host checkout APIs remain isolated in `ServicesApiServices` for preserved accelerator components.
- Preserved live-acceleration state was moved out of root `StateService` into `AccelerationStateService`, and the unused RBF/acceleration tracking no-op methods were removed from `WebsocketService`. Preserved address/UTXO/accelerator components now inject the isolated state service directly. The production startup `main` bundle is clean for `liveAccelerations`, `accelerations$`, `startTrackAccelerations`, `ensureTrackAccelerations`, `stopTrackAccelerations`, and the old RBF tracking method names; the startup bundle regression locks those absences.
- Preserved CPFP/raw-transaction helper endpoints were split out of root `ApiService` into `TransactionToolsApiService`, with tracker/preview/raw/push/test transaction components rewired to use that service directly. The startup `main` bundle is clean for `/api/v1/cpfp`, `/api/v1/prevouts`, `/api/txs/test`, `/api/v1/txs/package`, and the old helper method names; Cypress locks those absences in the startup bundle regression.
- Preserved address/wallet/stale-chain helper endpoints were split out of root `ApiService`: `validateAddress`, wallet, and treasury helpers now live in `AddressApiService`, stale chain-tip helpers live in `ChainTipsApiService`, and unused about/donation/translator/contributor helpers were removed. The startup `main` bundle is clean for `/api/v1/validate-address`, `/api/v1/chain-tips`, `/api/v1/stale-tips`, `/api/v1/treasuries`, `/api/v1/wallet`, `/api/v1/services/sponsors`, `/api/v1/donations`, `/api/v1/translators`, `/api/v1/contributors`, `validateAddress`, `getWallet`, `getTreasuries`, and `getStaleTips`; Cypress locks those absences in the startup bundle regression.
- Upstream enterprise/analytics wiring was pruned from startup. `EnterpriseService` now only consumes local `customize.branding`, no longer fetches mempool.space enterprise metadata, no longer redirects to mempool.space, and its tracking hooks are local no-ops. The old Twitter-widget host default was removed from `StateService`. The startup `main` bundle is clean for `/api/v1/services/enterprise/info`, `services/enterprise/images`, `stats.mempool.space`, `stats.liquid.network`, `mempool.ninja`, `liquid.network`, `.mempool.space`, `https://mempool.space`, `getEnterpriseInfo`, `Matomo`, and `TWIDGET_API`; Cypress locks those absences in the startup bundle regression.
- Root Lightning state residue was removed from the XMR shell. `StateService` no longer carries the dead `LIGHTNING` env flag, Lightning URL-state updater, or Lightning support helper; the unused preview subscription was detached, and demo redirect cycling now uses XMR routes only. The startup `main` bundle is clean for `lightning`, `Lightning`, `LIGHTNING`, `/lightning`, `/acceleration`, `setLightningBasedonUrl`, `networkSupportsLightning`, and `lightningChanged`; Cypress locks those absences in the startup bundle regression.
- Active chain-strip cube selectors were retargeted from `bitcoin-block` to `xmr-block` across the confirmed-block strip, projected mempool strip, stale-tip comparison cards, and RTL global style hook. The production master-page chunk and global stylesheet are clean for `bitcoin` / `bitcoin-block`, and Cypress locks the loaded `app-blockchain-blocks` chunk to include `xmr-block` while excluding the old names.
- Active graph/calculator chunk selector residue was cleaned up. Dashboard color helper styles now use `xmr-color`, the XMR calculator display class is `xmr-atomic-text`, and a dead `.sats` rule was removed. The production graph/calculator chunk containing `app-price-chart` and `app-calculator` is clean for `bitcoin`, `bitcoin-color`, `bitcoin-satoshis-text`, and `sats`; Cypress locks those absences while requiring the XMR selector names.
- The XMR docs compatibility copy now describes upstream UTXO semantics without carrying the stripped upstream brand term into the lazy docs chunk. Loaded-resource regressions cover the active graph/search/shell chunks; a broad JS grep is still noisy because preserved legal/docs compatibility copy and uncalled ApiService helpers remain in production chunks for the broader stale-code sweep.
- The production resource pipeline now ships an explicit XMR allowlist instead of copying preserved upstream assets into `dist`: config/customize files, favicons, active XMR OpenGraph images, sounds, and default/unknown mining-pool placeholders. Active blocks/legal OpenGraph image filenames were corrected to existing XMR assets, the mempool.space preview fallback was removed, and Cypress now asserts kept resources return 200 while upstream Bitcoin/Liquid/Lightning/payment/profile/promo assets return 404.
- The active shared SVG shell no longer carries the unused accelerator artwork branch. The rebuilt `app-xmr-graphs-shell-module` script containing `Monero Block / Transaction` is clean for lowercase `accelerator`, and the loaded-resource Cypress contract locks that absence. Remaining broad `accelerator` hits are in preserved docs/legal/transaction compatibility chunks outside this active shell.
- Active transaction lazy chunks no longer carry the old BTC/sats amount-mode keys or dead accelerator-toggle styling. The global view amount mode is now `xmr` / `atomic` / `fiat`, the amount selector renders XMR/atomic labels if mounted, and the rebuilt `app-transaction` plus `app-transactions-list` scripts are clean for lowercase `accelerator` and `sats`. Cypress locks both loaded transaction scripts.
- Public docs/legal copy no longer carries the stripped upstream feature names as user-facing labels. The docs FAQ and compatibility table now use Monero-specific payment-channel/replacement/fee-priority wording, terms describe the same limitations without naming dead upstream products, and the unused about-sponsors component was removed from the About module/source. The latest broad `en-US` JS scan is clean for `Lightning`, `accelerator`, `RBF`, `CPFP`, and `sats`; remaining `mempool.space` hits are nominative upstream attribution in docs/about/trademark pages.
- Localized production chunks were included in the stale-marker work. Stale graph/price/transaction-list translation targets that injected upstream Bitcoin labels into non-English lazy chunks now fall back to XMR-safe copy; the rebuilt all-locale strict visible-marker scan is clean for Lightning, accelerator, RBF, CPFP, sat/vB, vBytes, standalone sats/mSats, and upstream service labels. Broad marker scans are still treated as investigation input rather than completion proof until preserved upstream helpers are fully split.
- The XMR route-contract spec no longer injects removed accelerator env keys while testing active transaction/block surfaces. The remaining accelerator source hits are preserved upstream components, locale note ids, or the unrouted upstream API docs dataset, not active client config toggles.
- The old upstream docs module source was removed after reachability checks. `frontend/src/app/docs/**` no longer contains the tabbed Bitcoin FAQ/REST/WebSocket/Electrum docs or the large upstream API dataset; `/docs` and `/api` stay on the focused XMR docs module, and preserved Liquid docs routes redirect instead of importing the removed module. The built route contract still verifies `/docs/api/rest` renders the active XMR API surface.
- The unreachable accelerator/tracker UI source was removed after import/reachability checks. The stripped Bitcoin transaction tracker, accelerator checkout, acceleration dashboard/list/stats/timeline/sparkle components, and unused Bitcoin invoice component are no longer present, and `ServicesApiServices` no longer carries accelerator or Bitcoin-payment invoice methods.
- The shared `MempoolErrorComponent` no longer contains the old account top-up template, accelerator/payment/whitelist error strings, HTML sanitization bypass, or `innerHTML` rendering. Its obsolete `accelerator.low-balance` XLF unit was removed from every locale catalog that carried it. The remaining source-level accelerator strings are now comments, preserved acceleration API/state/interface helpers, compatibility docs, or preserved unreachable views queued for later cleanup.
- Active projected-block ETA/rendering no longer contains the old accelerator path. `MempoolBlocksComponent` removed acceleration sparkles/blink state, Transaction/TransactionDetails styles dropped dead accelerated selectors, and `EtaService` was reduced to the Monero projected-position ETA calculation actually called by the transaction page. The route-contract spec now asserts the loaded `app-mempool-blocks` script excludes `accelerated`, `app-acceleration-sparkles`, and `bitcoin-block` while retaining `xmr-block`.
- The active `/txs` recent-transactions route no longer renders upstream virtual-byte units for Monero rows. `RecentTransactionsList` formats the Size column with the byte pipe, and the route-contract spec now covers live websocket inserts while asserting visible `B` / `ɱ/B` units and excluding `vB`, `vBytes`, `sat/vB`, and `sats`.
- Active root websocket runtime no longer carries stripped address/wallet/asset/stratum tracking. The old action senders and address/wallet response handlers were moved behind `LegacyWebsocketTrackingService` for preserved unreachable components, while `WebsocketService` remains focused on XMR routed live updates. The production `main` bundle is now clean for `track-address`, `track-wallet`, `track-asset`, `track-stratum`, and related response keys.
- Active root state no longer carries the stripped stratum dashboard stream. `StateService` dropped `stratumJobs$` / `stratumJobUpdate$`, `WebsocketService` ignores the obsolete `stratumJob` / `stratumJobs` response keys, and the frontend `STRATUM_ENABLED` config path was removed. The legacy stratum/pool components still compile through a preserved shim, while production startup JS and config resources are locked clean by Cypress.
- Preserved address/wallet/UTXO live state was removed from the active root services. The old `utxoSpent$`, `mempoolRemovedTransactions$`, `multiAddressTransactions$`, and `walletTransactions$` subjects now sit behind `LegacyWebsocketTrackingService` for preserved unreachable components, and the active websocket response interface no longer accepts the UTXO-spent compatibility payload. The production startup bundle is locked clean for those subject markers.
- Active root websocket/state no longer carries the unused BSQ price path. The `bsq-price` response branch and `bsqPrice$` subject were removed, and the stale Bisq transaction-title translation id was renamed to XMR-specific metadata. Production startup JS is locked clean for those markers.
- Active dashboard CSS no longer ships the preserved Liquid card/indexing selectors. The dashboard chunk is now locked clean for `liquid`/`Liquid` plus the old Liquid selector names, and the production frontend build is warning-clean after the stylesheet pruning.
- Root Angular routing no longer depends on duplicate empty-path lazy routes for the graph shell. A single `canMatch` route now owns the dashboard/graphs/mempool-block/tools surface, while `MasterPageModule` continues to own about/status/blocks/tx/block/docs/API routes; Cypress explicitly verifies the calculator path through this route boundary.
- Active root `ApiService` / `MiningService` no longer ship preserved mining-pool endpoints or pool-ranking cache logic. Those helpers are isolated behind `MiningPoolApiService` / `MiningPoolService` for preserved unreachable pool/stratum components; active mining graphs keep only the shared timespan helper dependency, and the startup/loaded-graph bundle contract blocks the old pool endpoint/helper markers.
- The active block route no longer carries the old Bitcoin block-audit fetch/preload/cache path. `ApiService` dropped `audit-summary`, per-tx audit, and audit-score helpers; `PreloadService` no longer warms block audits; `CacheService` no longer resets block-audit cache state; `StateService` and sample frontend config dropped the audit start-height/preference runtime keys. `BlockComponent` now renders only Monero block metadata plus stale-vs-winning block comparison when stale data exists.
- The leftover client `AUDIT` env flag and block-health table branches are gone from active latest-blocks/blocks-list and preserved pool components. This removes the old Health/Avg Health/Avg Block Fees/fee-delta UI path and its config keys from the XMR client; production scripts scan clean for those markers.
- The unreachable upstream block-health graph implementation is now removed instead of merely unrouted. `BlockHealthGraphComponent`, its template/style files, the `/api/v1/mining/blocks/predictions` client helper, and unused frontend audit payload fields are gone; the startup bundle regression blocks the component selector and helper from reappearing.
- The backend no longer keeps a fake block-health predictions endpoint alive. `XmrMiningRoutes` does not register `/api/v1/mining/blocks/predictions*`; focused Jest coverage and the live API smoke script assert 404 for that Bitcoin-only route while real XMR mining graph endpoints continue to serve indexed data.
- The routed dashboard now mounts the reward-stats widget against exact recent XMR samples. `XmrChainIndexer` warms the last 144 full blocks before sparse graph backfill and `/api/v1/mining/reward-stats/:blockCount` reports summed Monero reward, fee, and tx counts from that contiguous recent window. The UI renders XMR/block and XMR/tx units, the active API docs list the endpoint, and Cypress blocks BTC/block or sats/tx from returning.
- The active REST docs contract now covers the documented v1 mempool alias directly. Jest asserts `/api/v1/mempool` serves the full public mempool shape, Cypress requires it in `/docs/api/rest`, and live smoke probes both `/api/v1/mempool` and `/api/v1/block/:hash/txs/:index`.
- Active block miner labels are now backed by real public Monero data instead of an unconditional unknown stub. REST and websocket block shapes parse coinbase `extra`, detect P2Pool from valid merge-mining tags, match clear-text pool tags where available, and retain `unknown` when no reliable fingerprint exists. The recent blocks table has a Pool column again, dashboard block tiles show identified miner badges only, and the XMR resource allowlist includes the P2Pool logo.
- Mining-pool stats endpoints are no longer empty/null stubs. `XmrMiningRoutes` now serves `/api/v1/mining/pools/:period`, `/api/v1/mining/pools`, `/api/v1/mining/pool/:slug`, and `/api/v1/mining/hashrate/pools*` from indexed samples, including identified pools plus an explicit `Unknown` bucket for unattributed blocks.
- The aggregate `/graphs/mining/pools` route and `/mining/pool/:slug` detail route are active again and consume those best-effort stats with Monero-scale hashrate units. They keep `Unknown` as a first-class attribution bucket and document that attribution is public-marker best effort, not a canonical pool registry.
- Final verification pass on 2026-05-16: backend `npm run tsc -- --noEmit` passed; backend `npm run build` passed; full backend Jest `npm test -- --runInBand --forceExit` passed 20 suites / 160 tests, including the Monero suite at 12 suites / 39 tests; frontend `npm run tsc -- -p tsconfig.app.json --noEmit` passed; localized production `npm run build` passed and `/tmp/xmr-frontend-build.log` scanned clean for missing-translation warnings; built static Cypress route contract passed 47/47; live smoke against `MONEROD_RPC_URL=https://xmr-node.cakewallet.com:18081` passed 43/43 probes on attempt 1; `git diff --check` passed.
- Remaining limitation: browser-local cryptographic scanner runtime was build/type/privacy-path verified, but no real recipient key / tx_secret_key vector was available in this pass to prove a positive received-amount result against a known transaction.

## Iter 16-24 fixes summary

- **iter 17:** Recent Blocks ordering fix — WS adapter now sends oldest-first, broadcasts serialized behind a single Promise chain, lastBroadcastHeight gates stale events, `refresh-blocks` request handled. A focused `monero-ws.test.ts` regression now recreates slow first-block RPC fetches and locks broadcasts in tip order.
- **iter 18:** Live updates verified end-to-end — 8-min observation produced 5 sequential new blocks pushed correctly, 88 mempool deltas.
- **iter 19:** Incoming Transactions chart wired — `MoneroStats` records 1-minute rolling samples; `/api/v1/statistics/{2h,3d,24h,1w,1m}` serve windows.
- **iter 20:** Stripped 16+ impossible Bitcoin-only routes (master-page + graphs).
- **iter 21:** Rewrote `/about`, replaced upstream's 13k-line FAQ docs module with focused `XmrDocsModule`.
- **iter 22:** Search bar now resolves Monero hashes (probe-block-then-fall-through-to-tx) and heights.
- **iter 23:** New `XmrBlocksListModule` for `/blocks` with pagination via `/api/v1/blocks/:height`.
- **iter 24:** Final polish + push.

---

**Status as of commit `164364b02` (iter 15)** — original audit text follows.

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
| `/clock`, `/clock/:mode`, `/clock/:mode/:index` | ❌-stripped | Legacy Bitcoin embed/clock surface; stripped from default XMR routing until explicitly retargeted |
| `/view/block/:id`, `/view/mempool-block/:index`, `/view/blocks` | ❌-stripped | Legacy embed views; stripped from default XMR routing until explicitly retargeted |
| `/widget/wallet` | ❌-stripped | Wallet tracking — impossible on XMR (sub-addr scanning needs view key, can't be in URL) |
| `/preview` (and `preview/testnet*`) | ❌-stripped | Sharable Bitcoin tx/address/wallet/pool/Lightning previews — UTXO-shaped |
| `/status` | ✅ | XMR-native daemon status page backed by `/healthz` + expanded `/api/v1/info`; upstream Bitcoin/Liquid monitoring components remain unrouted |

### Master-page children (`frontend/src/app/master-page.module.ts`)

| Route | Status | Notes |
|---|---|---|
| `/about` | ✅ | XMR-specific about page with upstream AGPL attribution and no sponsor/video runtime wiring |
| `/status` | ✅ | Monero daemon/backend health, sync state, version, peers, and storage; no upstream tomahawk/official-instance status UI |
| `/api` | ✅ | Routes to XMR docs/API surface for the active REST/live endpoints |
| `/docs` (incl `docs/faq`) | ✅ | Focused XMR docs covering FAQ, REST, WebSocket, SSE, and privacy limitations |
| `/blocks` | ✅ | Paginated recent Monero blocks list with XMR metadata and SEO copy |
| `/blocks/stale` | ❌ | Bitcoin stale-block tracking; XMR's orphan model is different — strip |
| `/blocks/:page` | ✅ | Same active paginated Monero blocks list |
| `/block/:hash` | ✅ | Active BlockModule retargeted to Monero header/detail semantics; no audit/accelerator/SegWit branches |
| `/tx/:hash` | ✅ | Active TransactionModule with Monero-shaped public data and tx_proof verification; old placeholder XmrTxDetailModule has been removed |
| `/tx/preview` | ❌-stripped | Upstream raw tx/PSBT preview decodes Bitcoin transaction structure and is no longer declared in the active transaction module |
| `/tx/push` | ❌-stripped | Broadcasts a raw tx through Bitcoin-shaped preview/broadcast UX. A Monero broadcast tool needs a dedicated implementation. |
| `/pushtx` | ❌-stripped | alias of `/tx/push` — stripped from the XMR route table |
| `/tx/test` | ❌-stripped | Bitcoin `testmempoolaccept` — stripped from the XMR transaction child routes |
| `/txs` | ✅ | Recent mempool transaction list with live pause/resume controls, Monero size/fee columns, and RingCT-safe no-amount rendering |
| `/rbf` | ❌ | RBF replacements — impossible on XMR — strip |
| `/stratum` | ❌ | Bitcoin Stratum mining pool dashboard — strip |
| `/lightning` | ❌ | Lightning Network — impossible on XMR — strip |
| `/mining/blocks` | ❌ | Mining-pool block list — best-effort pool attribution exists, but the upstream per-pool block-list page is still stripped |
| `/terms-of-service`, `/privacy-policy`, `/trademark-policy` | ✅ | Retargeted to concise xmr-space terms, privacy, and attribution pages; no upstream Bitcoin-only or accelerator policy copy in active UI. |

### Graphs module (`frontend/src/app/graphs/graphs.routing.module.ts`)

| Route | Status | Notes |
|---|---|---|
| `/tools/calculator` | ✅ | Retargeted to XMR + 12-decimal atomic units; no BTC fixed-supply cap. |
| `/mining/pool/:slug` | ✅/best-effort | Retargeted Monero pool detail page backed by indexed public miner fingerprints, pool hashrate rows, and recent pool blocks; attribution remains best-effort |
| `/acceleration`, `/acceleration/list*` | ❌ | Mempool's commercial accelerator; impossible — strip |
| `/mempool-block/:id` | ✅ | Detailed projected-block view with Monero fee units and no SegWit/vbyte estimate copy |
| `/address/:id` | ❌ | Address tracking — impossible on Monero — strip |
| `/wallet/:wallet` | ❌ | Wallet tracking — impossible — strip |
| `/graphs/mempool` | ✅ | Uses persisted rolling XMR mempool stats with JSON fallback |
| `/graphs/mining/*` | ✅/stripped | Hashrate/difficulty, non-pool block mining series, aggregate pool attribution, and `/mining/pool/:slug` detail pages are active via `XmrChainIndexer`; pool dominance and block-health remain stripped |

### Lightning (`frontend/src/app/lightning/`)

All ❌ — Lightning is a Bitcoin L2; doesn't apply.

### Liquid (`frontend/src/app/liquid/`)

All ❌ — Liquid is a Bitcoin sidechain; doesn't apply.

---

## Dashboard tiles

| Tile | Status | Notes |
|---|---|---|
| Network summary band | ✅ | Height, derived hashrate, difficulty, and last-block age with 2-minute target above the chain strip |
| Top blockchain strip (projected + confirmed blocks) | ✅ | Live projected + confirmed blocks render in correct order; backend regression covers the old slow-RPC race |
| Transaction Fees (4-tier) | ✅ | |
| Difficulty Adjustment | ✅ | Monero retargets every block — rendered as "~2 minutes / In ~60 seconds" |
| Mempool wall (mempool-block-overview) | ✅ | Live tiles, area = weight, color = fee tier |
| Memory Usage | ✅ | |
| Unconfirmed count | ✅ | |
| Minimum fee | ✅ | (iter 15 unit fix) |
| Incoming Transactions chart | ✅ | Backed by rolling/persisted XMR mempool stats and live `bytesPerSecond` updates |
| Recent Blocks table | ✅ | Correct newest-first order with XMR byte/fee metadata |
| Recent Transactions table | ✅ | TXID + Size + Fee (no amount column — RingCT) |
| ~~Mempool Goggles filters~~ | ❌-stripped | Bitcoin tx-flag filters (consolidation, coinjoin, data) don't translate |
| ~~Recent Replacements (RBF)~~ | ❌-stripped | No RBF on Monero |

---

## Tx-detail flows

| Element | Status | Notes |
|---|---|---|
| Public-only fields card | ✅ | active upstream tx page shows hash, size, fee, RingCT badges, key image, ring size, and `/get_outs`-resolved ring-member heights/ages; Bitcoin flow diagram is hidden for RingCT |
| Blur card with messaging | ✅ | "Amounts and recipients are mathematically hidden by Monero's RingCT — that's the point" |
| Reveal: I received this tx | ✅/browser-local | Active `Received` mode collects recipient address + private view key in component memory, lazy-loads `monero-ts`, scans the single tx through the public monerod bridge, clears state on reset/destroy, and explicitly rejects unsupported subaddress receive scans from only subaddress + view key |
| Reveal: I sent this tx (tx_proof) | ✅ Backend + active UI | Active upstream tx page includes a payment-proof form. `POST /api/v1/tx/:hash/verify-proof` calls monero-wallet-rpc `check_tx_proof` when configured; default dev returns 503 if `MONERO_WALLET_RPC_URL` is absent. |
| Reveal: I have the tx_secret_key | ✅/browser-local | Active `tx_secret_key` mode validates recipient address + hex tx secret key, lazy-loads `monero-ts`, checks locally, and never sends the secret to backend or storage |
| Confirmed-tx detail | ✅ | live-verified |
| Mempool-tx detail | ✅ | live-verified |
| Mempool→confirmed transition | ✅ | `/api/v1/ws` now tracks `track-tx` per connection and includes `txConfirmed` on the confirming block; Cypress verifies `/tx/:hash` flips from Unconfirmed to 1 confirmation |

---

## Backend feature inventory

| Feature | Status | Notes |
|---|---|---|
| `/api/v1/info` | ✅ | Expanded with daemon status, sync target, peers, version, uptime, storage, bootstrap metadata |
| `/api/v1/blocks` | ✅ | |
| `/api/v1/block/:hash` | ✅ | |
| `/api/v1/tx/:hash` | ✅ | mempool + confirmed paths |
| `/api/v1/mempool` | ✅ | |
| `/api/v1/fees/recommended` | ✅ | |
| `/api/v1/events` (SSE) | ✅ | |
| `/api/v1/ws` (WebSocket) | ✅ | Speaks upstream protocol; block broadcasts are serialized/gated and covered by a regression for slow first-block RPC fetches |
| `/api/v1/tx/:hash/verify-proof` | ✅ | Real wallet-RPC adapter implemented and used by active tx page. Requires `MONERO_WALLET_RPC_URL`; returns 503 instead of fake verification when not configured. |
| `/api/v1/blocks/:height` (height resolution) | ✅ | Implemented for `/blocks` pagination and live-smoke covered |
| `/api/v1/mining/pools/:period`, `/api/v1/mining/pool/:slug` | ✅/best-effort | Aggregates indexed miner fingerprints into identified pool buckets plus `Unknown`; not a canonical Monero pool registry |
| `/api/v1/search/:query` | ✅ | Search bar now probes Monero block hashes, tx hashes, and numeric heights client-side. Typeahead is likewise scoped to height/hash quick matches in XMR mode; no address, Lightning, date/timestamp, or mining-pool suggestions are exposed. |
| Live updates / SSE | ✅ | Verified end-to-end in iter 18; route audit later confirmed active pages consume live REST/WS shapes |

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

## Historical next-step list

1. **iter 17** — fix Recent Blocks ordering (visible bug)
2. **iter 18** — verify live updates end-to-end (5+ min observation)
3. **iter 19** — Incoming Transactions chart: backfill or strip
4. **iter 20** — strip impossible routes (16+ routes)
5. **iter 21** — rewrite docs/about/api pages for Monero
6. **iter 22** — wire search box
7. **iter 23** — XmrBlocksListModule for `/blocks`
8. **iter 24** — final polish + push to `n0/xmr-space`

Stretch (post-push):
- Positive browser-local scanner test vectors for known recipient view-key / tx_secret_key payments
- Broader maintained mining-pool tag table beyond public P2Pool/clear-text markers
- Atomic-swap ticker
- Privacy-hygiene metrics chart
- Multi-node daemon comparison page (public RPC latency / height-behind matrix)
