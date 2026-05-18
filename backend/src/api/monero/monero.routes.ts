import express, { Application, Request, Response } from 'express';
import { handleError } from '../../utils/api';
import logger from '../../logger';
import { MoneroApi } from './monero-api';
import { MoneroWs } from './monero-ws';
import { IMoneroApi } from './monero-api.interface';
import { getXmrPriceConversion } from './xmr-price';
import { MoneroWalletRpc } from './monero-wallet-rpc';
import { shapeXmrDifficultyAdjustment } from './xmr-difficulty';
import { attachResolvedRingMembers, buildRingLookupPlan, XmrRingMember } from './xmr-rings';
import { identifyXmrMinerPool } from './xmr-miner-fingerprint';

const HEX64 = /^[a-f0-9]{64}$/i;
const MONERO_MAINNET_ADDRESS = /^[48][0-9a-zA-Z]{94,105}$/;
const MAX_RECENT_BLOCKS = 25;
const MAX_RING_MEMBER_LOOKUPS = 512;
const PUBLIC_MONEROD_JSON_RPC_METHODS = new Set([
  'get_info',
  'get_version',
  'get_block_count',
  'get_block',
  'get_block_header_by_hash',
  'get_block_header_by_height',
  'get_block_headers_range',
  'get_last_block_header',
  'get_fee_estimate',
  'get_output_histogram',
  'get_output_distribution',
  'hard_fork_info',
  'sync_info',
]);
const PUBLIC_MONEROD_PATH_METHODS = new Set([
  'get_transactions',
  'gettransactions',
  'get_transaction_pool',
  'get_transaction_pool_hashes',
  'get_outs',
  'get_output_distribution',
  'is_key_image_spent',
]);
const PUBLIC_MONEROD_BINARY_METHODS = new Set([
  'get_blocks.bin',
  'getblocks.bin',
  'get_blocks_by_height.bin',
  'get_hashes.bin',
  'get_o_indexes.bin',
  'get_outs.bin',
]);
const FORBIDDEN_SECRET_BODY_KEYS = [
  'privateviewkey',
  'privviewkey',
  'viewsecretkey',
  'viewkey',
  'privatespendkey',
  'privspendkey',
  'spendsecretkey',
  'spendkey',
  'txsecretkey',
  'txkey',
  'secretkey',
  'privatekey',
  'walletseed',
  'mnemonicseed',
  'mnemonic',
  'seedphrase',
  'walletpassword',
  'password',
];

/**
 * REST surface for the Monero side of xmr-space. Mirrors mempool.space's
 * `/api/v1/*` URL shapes where the data is meaningfully comparable, and
 * deliberately omits routes that don't translate (address balance,
 * scripthash, UTXO endpoints, RBF, accelerator).
 *
 * All responses return ONLY public chain data — no amounts, no recipients.
 * Recipient/amount disclosure happens client-side in the frontend's reveal
 * flows; the server never sees keys.
 */
export class MoneroRoutes {
  // ws is optional — used for /api/v1/init-data which mirrors the
  // websocket's first-message snapshot. Passing null leaves init-data
  // returning a minimal stub (used in tests that don't mount the ws).
  constructor(
    private api: MoneroApi,
    private ws: MoneroWs | null = null,
    private walletRpc: MoneroWalletRpc | null = null,
    private prefix = '/api/v1/',
  ) {}

  public initRoutes(app: Application): void {
    app
      .get(this.prefix + 'info', (req, res) => this.getInfo(req, res))
      .get(this.prefix + 'blocks', (req, res) => this.getRecentBlocks(req, res))
      // /api/v1/blocks/:height — N blocks ending at :height (newest
      // first). Mirrors mempool.space's pagination style. Used by the
      // /blocks list page.
      .get(this.prefix + 'blocks/:height', (req, res) => this.getBlocksFromHeight(req, res))
      .get(this.prefix + 'block/:hash', (req, res) => this.getBlock(req, res))
      // /api/v1/block/:hash/summary — per-tx stripped data for the
      // upstream BlockComponent's WebGL tile visualization. Returns
      // the same TransactionStripped[] shape upstream expects:
      //   [{ txid, fee, vsize, value, rate, flags, time, acc }, …]
      .get(this.prefix + 'block/:hash/summary', (req, res) => this.getBlockSummary(req, res))
      .get(this.prefix + 'block/:hash/tx/:txid/summary', (req, res) => this.getStrippedBlockTransaction(req, res))
      // Audit endpoint always 404 — Bitcoin-only feature; the upstream
      // BlockComponent is OK with a missing audit and just hides the
      // 'Expected vs Actual' comparison.
      .get(this.prefix + 'block/:hash/audit-summary', (_req, res) => res.status(404).json({ error: 'audit not available on Monero' }))
      // /api/v1/tx/:hash returns the upstream Bitcoin-shape Transaction
      // (txid + vin + vout + status). The dev-server proxy rewrites
      // /api/tx/* to /api/v1/tx/* so this single route serves both
      // electrsApiService.getTransaction$ (which hits /api/tx/) and
      // direct /api/v1/tx/ consumers. The old Monero-shape response
      // was used by our deprecated XmrTxDetail; that module now lives
      // on disk only, no live consumer reads it.
      .get(this.prefix + 'tx/:hash', (req, res) => this.getTxBitcoinShape(req, res))
      .post(this.prefix + 'tx/:hash/verify-proof', (req, res) => this.verifyTxProof(req, res))
      .post(this.prefix + 'monerod/json_rpc', (req, res) => this.proxyPublicMonerodJsonRpc(req, res))
      .get(this.prefix + 'mempool', (req, res) => this.getMempool(req, res))
      .get(this.prefix + 'fees/recommended', (req, res) => this.getFeesRecommended(req, res))
      // /api/v1/fees/mempool-blocks — projected mempool blocks. Same
      // shape the websocket pushes via 'mempool-blocks' (used by the
      // dashboard's next-blocks tile row when called over REST instead
      // of subscribing to ws). Built by `MoneroWs.projectedMempoolBlocks`
      // — exposed via buildSnapshot() and lifted out here.
      .get(this.prefix + 'fees/mempool-blocks', async (req, res) => {
        try {
          if (!this.ws) { res.json([]); return; }
          const snap = await this.ws.buildSnapshot();
          res.json(snap['mempool-blocks'] ?? []);
        } catch (err) {
          logger.err(`xmr fees/mempool-blocks failed: ${err instanceof Error ? err.message : String(err)}`);
          handleError(req, res, 502, 'monerod unreachable');
        }
      });

    // /api/mempool — bare-prefix alias for /api/v1/mempool. The
    // upstream electrs convention serves this without a v1 prefix; we
    // mirror it so any caller that hits the legacy URL still works.
    app.get('/api/mempool', (req, res) => this.getMempool(req, res));

    // Upstream's electrs-style endpoint — used by BlockComponent to
    // resolve a height-based deep-link to a block hash. Plain-text
    // response; the upstream client requests it via responseType: 'text'.
    app.get('/api/block-height/:height', (req, res) => this.getBlockHashByHeight(req, res));
    // Paginated tx list for a block. Upstream TransactionsList expects
    // Bitcoin-shape Transaction[] (txid + vin + vout + status). We
    // populate what we can publicly: txid, fee, size, weight, status,
    // and synthetic vin/vout entries that flag RingCT-hidden values
    // so upstream's vin/vout decoder doesn't crash on empty arrays.
    app.get('/api/block/:hash/txs/:index', (req, res) => this.getBlockTxsByPage(req, res, false));
    app.get('/api/block/:hash/txs', (req, res) => this.getBlockTxsByPage(req, res, false));
    // Raw block blob. Monero does not expose Bitcoin's 80-byte header
    // hex shape; the daemon's canonical downloadable binary form is the
    // full block blob returned by get_block.
    app.get('/api/block/:hash/raw', (req, res) => this.getBlockRaw(req, res));
    app.get(this.prefix + 'block/:hash/raw', (req, res) => this.getBlockRaw(req, res));
    // Compatibility alias for upstream docs/old links. It returns the
    // same Monero block blob rather than pretending there is a
    // Bitcoin-style standalone header.
    app.get('/api/block/:hash/header', (req, res) => this.getBlockRaw(req, res));
    app.get(this.prefix + 'block/:hash/header', (req, res) => this.getBlockRaw(req, res));
    // Also handle the v1 prefix the master-page-preview uses.
    app.get(this.prefix + 'block/:hash/txs/:index', (req, res) => this.getBlockTxsByPage(req, res, false));
    app.get(this.prefix + 'block/:hash/txs', (req, res) => this.getBlockTxsByPage(req, res, false));

    // /api/tx/:txid is rewritten by the dev-server proxy to
    // /api/v1/tx/:txid, so the route above serves both. Keeping a
    // direct registration as a no-op safety net for any deployment
    // that doesn't use that proxy rewrite (production nginx may
    // forward unrewritten).
    app.get('/api/tx/:txid', (req, res) => this.getTxBitcoinShape(req, res));
    app.post('/api/tx/:txid/verify-proof', (req, res) => this.verifyTxProof(req, res));
    app.post('/api/monerod/json_rpc', (req, res) => this.proxyPublicMonerodJsonRpc(req, res));
    app.post(this.prefix + 'monerod/:method', express.raw({ type: 'application/octet-stream', limit: '8mb' }), (req, res) => this.proxyPublicMonerodPath(req, res));
    app.post('/api/monerod/:method', express.raw({ type: 'application/octet-stream', limit: '8mb' }), (req, res) => this.proxyPublicMonerodPath(req, res));
    // Hex blob. For mempool txs this is the full tx_blob from
    // /get_transaction_pool; for confirmed txs monerod's pruned
    // /get_transactions response gives the pruned tx hex, which is the
    // honest public blob available without fetching rangeproof data.
    app.get('/api/tx/:txid/hex', (req, res) => this.getTxHex(req, res));
    app.get(this.prefix + 'tx/:hash/hex', (req, res) => this.getTxHex(req, res));
    // /api/v1/transaction-times — array of receive_time per txid request.
    app.get(this.prefix + 'transaction-times', (req, res) => this.getTransactionTimes(req, res));
    // CPFP info — Bitcoin-only (child-pays-for-parent fee strategy).
    // Return an empty struct so upstream's CPFP panel hides itself.
    app.get(this.prefix + 'cpfp/:txid', (_req, res) => res.json({ ancestors: [], descendants: [], bestDescendant: null, sigops: 0, adjustedVsize: 0, effectiveFeePerVsize: 0 }));
    // RBF history endpoints — Bitcoin-only. Return null so the upstream
    // RBF panel doesn't render any timeline.
    app.get(this.prefix + 'tx/:txid/rbf', (_req, res) => res.status(204).end());
    app.get(this.prefix + 'tx/:txid/cached', (_req, res) => res.status(204).end());
    // Outspends — was this output spent? On Monero we can't tell without
    // wallet keys; always return null entries so upstream's "spent / unspent"
    // labels don't render misleading state.
    app.get(this.prefix + 'txs/outspends', (req, res) => this.getBatchedOutspends(req, res));
    app.get('/api/txs/outspends', (req, res) => this.getBatchedOutspends(req, res));
    app.get('/api/tx/:txid/outspends', (_req, res) => res.json([]));
    app.get('/api/tx/:txid/outspend/:vout', (_req, res) => res.status(204).end());
    // Stubs for upstream endpoints we haven't built and probably won't:
    // accelerator endpoints. Mining-pool endpoints are owned by
    // XmrMiningRoutes because they aggregate indexed block samples.
    // Returning 200 with empty / null payloads keeps the upstream
    // component subscriptions alive without spamming console errors.
    app.get(this.prefix + 'historical-price', async (req, res) => {
      const timestamp = Number(req.query.timestamp);
      res.json(await getXmrPriceConversion(Number.isFinite(timestamp) ? timestamp : undefined));
    });
    app.get(this.prefix + 'difficulty-adjustment', (req, res) => this.getDifficultyAdjustment(req, res));
    app.get(this.prefix + 'accelerations', (_req, res) => res.json([]));
    app.get(this.prefix + 'accelerator', (_req, res) => res.json({ enabled: false }));

    // /api/v1/init-data — initial snapshot used by SSR and as a
    // bootstrap when the WebSocket isn't connected yet. Returns the
    // same WebsocketResponse shape the ws sends as its first message,
    // so the frontend's handleResponse() works identically against
    // both. If ws isn't wired (test mode), fall back to an empty bundle.
    app.get(this.prefix + 'init-data', async (req, res) => {
      try {
        if (!this.ws) { res.json({}); return; }
        res.json(await this.ws.buildSnapshot());
      } catch (err) {
        logger.err(`xmr init-data failed: ${err instanceof Error ? err.message : String(err)}`);
        handleError(req, res, 502, 'monerod unreachable');
      }
    });

    // /api/mempool/recent — last few mempool txs in the upstream
    // electrs `Recent[]` shape ({txid, fee, vsize, value}). Used by
    // the dashboard's "Latest transactions" widget when it hits
    // electrs (we proxy through the same handler).
    app.get('/api/mempool/recent', async (req, res) => {
      try {
        const pool = await this.api.getTransactionPool();
        const txs = (pool.transactions ?? [])
          .slice()
          .sort((a, b) => (b.receive_time ?? 0) - (a.receive_time ?? 0))
          .slice(0, 10)
          .map((t) => ({
            txid: t.id_hash,
            fee: t.fee,
            vsize: t.weight,
            // Monero amounts are RingCT-hidden — we cannot publish a value.
            // The upstream consumer treats `value === 0` as "no info" and
            // displays the blurred-amount placeholder we render in the
            // amount component, so 0 is the honest signal here.
            value: 0,
          }));
        res.json(txs);
      } catch (err) {
        logger.err(`xmr mempool/recent failed: ${err instanceof Error ? err.message : String(err)}`);
        handleError(req, res, 502, 'monerod unreachable');
      }
    });

    // /api/blocks/tip/{hash,height} — upstream electrs convenience
    // endpoints. Plain-text response, no JSON envelope. The frontend
    // doesn't currently rely on them but they're documented in the
    // public API surface and cheap to support.
    app.get('/api/blocks/tip/hash', async (req, res) => {
      try {
        const info = await this.api.getInfo();
        res.type('text/plain').send(info.top_block_hash);
      } catch (err) {
        logger.err(`xmr blocks/tip/hash failed: ${err instanceof Error ? err.message : String(err)}`);
        handleError(req, res, 502, 'monerod unreachable');
      }
    });
    app.get('/api/blocks/tip/height', async (req, res) => {
      try {
        const info = await this.api.getInfo();
        res.type('text/plain').send(String(info.height - 1));
      } catch (err) {
        logger.err(`xmr blocks/tip/height failed: ${err instanceof Error ? err.message : String(err)}`);
        handleError(req, res, 502, 'monerod unreachable');
      }
    });
  }

  /**
   * POST /api/v1/tx/:hash/verify-proof
   *
   * Real tx_proof verification uses monero-wallet-rpc's `check_tx_proof`.
   * The public daemon cannot perform this check. When wallet RPC is not
   * configured we return a clear 503 instead of a fake verification result.
   */
  private async verifyTxProof(req: Request, res: Response): Promise<void> {
    const txid = req.params.txid ?? req.params.hash;
    if (!txid || !HEX64.test(txid)) {
      handleError(req, res, 400, 'invalid tx hash');
      return;
    }

    const body = (req.body ?? {}) as { address?: unknown; signature?: unknown; message?: unknown };
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';

    if (!MONERO_MAINNET_ADDRESS.test(address)) {
      handleError(req, res, 400, 'invalid Monero recipient address');
      return;
    }
    if (signature.length < 80 || signature.length > 4096) {
      handleError(req, res, 400, 'invalid tx_proof signature');
      return;
    }
    if (message.length > 1024) {
      handleError(req, res, 400, 'tx_proof message is too long');
      return;
    }
    if (!this.walletRpc) {
      res.status(503).json({
        ok: false,
        message: 'tx_proof verification requires monero-wallet-rpc; set MONERO_WALLET_RPC_URL on the backend',
      });
      return;
    }

    try {
      const result = await this.walletRpc.checkTxProof({
        txid,
        address,
        signature,
        ...(message ? { message } : {}),
      });
      const received = Number(result.received ?? 0);
      res.json({
        ok: !!result.good,
        amount: received,
        received,
        confirmations: Number(result.confirmations ?? 0),
        in_pool: !!result.in_pool,
        message: result.good
          ? `verified tx_proof; received ${received} atomic units`
          : 'invalid tx_proof',
      });
    } catch (err) {
      logger.err(`xmr verifyTxProof failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monero-wallet-rpc unreachable');
    }
  }

  /**
   * POST /api/v1/monerod/json_rpc
   *
   * Same-origin bridge for browser-local Monero wallet scanning. This
   * exposes only public daemon methods and rejects secret-shaped JSON
   * fields before proxying. Wallet RPC methods and private key material
   * never belong here.
   */
  private async proxyPublicMonerodJsonRpc(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as { id?: unknown; method?: unknown; params?: unknown };
    const method = typeof body.method === 'string' ? body.method.trim() : '';

    if (!PUBLIC_MONEROD_JSON_RPC_METHODS.has(method)) {
      handleError(req, res, 403, 'monerod method is not exposed by xmr-space');
      return;
    }
    if (this.containsForbiddenSecretBodyKey(body)) {
      handleError(req, res, 400, 'wallet secrets must stay in the browser');
      return;
    }

    const params = this.plainObjectOrEmpty(body.params);
    try {
      const result = await this.api.proxyPublicJsonRpc(method, params);
      res.json({
        id: body.id ?? '0',
        jsonrpc: '2.0',
        result,
      });
    } catch (err) {
      logger.err(`xmr monerod json_rpc proxy failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /**
   * POST /api/v1/monerod/:method
   *
   * Public path/binary daemon proxy used by monero-ts wallet2. JSON
   * requests remain inspectable and secret-guarded; binary requests are
   * limited to the daemon's public .bin scan endpoints.
   */
  private async proxyPublicMonerodPath(req: Request, res: Response): Promise<void> {
    const method = typeof req.params.method === 'string' ? req.params.method.trim() : '';
    const isBinaryBody = Buffer.isBuffer(req.body);

    if (isBinaryBody) {
      if (!PUBLIC_MONEROD_BINARY_METHODS.has(method)) {
        handleError(req, res, 403, 'binary monerod method is not exposed by xmr-space');
        return;
      }
      try {
        const result = await this.api.proxyPublicRawBytes(`/${method}`, req.body);
        res.type(result.contentType).send(result.data);
      } catch (err) {
        logger.err(`xmr monerod binary proxy failed: ${err instanceof Error ? err.message : String(err)}`);
        handleError(req, res, 502, 'monerod unreachable');
      }
      return;
    }

    if (!PUBLIC_MONEROD_PATH_METHODS.has(method)) {
      handleError(req, res, 403, 'monerod path is not exposed by xmr-space');
      return;
    }
    if (this.containsForbiddenSecretBodyKey(req.body ?? {})) {
      handleError(req, res, 400, 'wallet secrets must stay in the browser');
      return;
    }

    const body = this.plainObjectOrEmpty(req.body);
    try {
      res.json(await this.api.proxyPublicRaw(`/${method}`, body));
    } catch (err) {
      logger.err(`xmr monerod path proxy failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  private containsForbiddenSecretBodyKey(value: unknown): boolean {
    if (!value || typeof value !== 'object') {
      return false;
    }
    if (Array.isArray(value)) {
      return value.some((item) => this.containsForbiddenSecretBodyKey(item));
    }

    return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      return FORBIDDEN_SECRET_BODY_KEYS.some((forbidden) => normalized.includes(forbidden))
        || this.containsForbiddenSecretBodyKey(child);
    });
  }

  private plainObjectOrEmpty(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  /** GET /api/v1/difficulty-adjustment — Monero retargets every block. */
  private async getDifficultyAdjustment(req: Request, res: Response): Promise<void> {
    try {
      const count = await this.api.getBlockCount();
      const tipHeight = count - 1;
      const [tip, previous, previousPrevious] = await Promise.all([
        tipHeight >= 0 ? this.api.getBlockByHeight(tipHeight).catch(() => null) : Promise.resolve(null),
        tipHeight > 0 ? this.api.getBlockByHeight(tipHeight - 1).catch(() => null) : Promise.resolve(null),
        tipHeight > 1 ? this.api.getBlockByHeight(tipHeight - 2).catch(() => null) : Promise.resolve(null),
      ]);
      res.json(shapeXmrDifficultyAdjustment(
        tip?.block_header ?? null,
        previous?.block_header ?? null,
        previousPrevious?.block_header ?? null,
      ));
    } catch (err) {
      logger.err(`xmr getDifficultyAdjustment failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /** GET /api/v1/transaction-times — first-seen timestamps for the given txids. */
  private async getTransactionTimes(req: Request, res: Response): Promise<void> {
    const raw = req.query['txId[]'] ?? req.query.txId;
    const arr: unknown[] = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
    const list: string[] = arr.filter((x): x is string => typeof x === 'string');
    if (list.length === 0) {
      res.json([]);
      return;
    }
    try {
      const pool = await this.api.getTransactionPool();
      const lookup = new Map((pool.transactions ?? []).map((t) => [t.id_hash, t.receive_time || 0]));
      // For confirmed txs we don't track first-seen separately; return 0
      // (frontend treats 0 as "unknown" and falls back to block time).
      res.json(list.map((id) => lookup.get(id) ?? 0));
    } catch {
      res.json(list.map(() => 0));
    }
  }

  private getBatchedOutspends(req: Request, res: Response): void {
    const txidsCsv = typeof req.query.txids === 'string' ? req.query.txids : '';
    const txids = txidsCsv ? txidsCsv.split(',').filter(Boolean) : [];
    res.json(txids.map(() => []));
  }

  /** GET /api/tx/:txid — single tx in upstream Bitcoin-shape. */
  private async getTxBitcoinShape(req: Request, res: Response): Promise<void> {
    // Both route patterns hit this handler: /api/v1/tx/:hash uses :hash,
    // /api/tx/:txid uses :txid. Accept either param name.
    const txid = req.params.txid ?? req.params.hash;
    if (!txid || !HEX64.test(txid)) {
      handleError(req, res, 400, 'invalid tx hash');
      return;
    }
    try {
      // Mempool first.
      const pool = await this.api.getTransactionPool();
      const inMempool = pool.transactions?.find((t) => t.id_hash === txid);
      if (inMempool) {
        const parsed = this.parseTransactionJson(inMempool.tx_json);
        const info = await this.api.getInfo().catch(() => null);
        const ringResolution = await this.resolveRingMembers(parsed, info?.height);
        const numInputs = parsed?.vin?.length ?? 1;
        const numOutputs = parsed?.vout?.length ?? 1;
        res.json({
          txid,
          version: parsed?.version ?? 2,
          locktime: parsed?.unlock_time ?? 0,
          size: inMempool.blob_size || inMempool.weight,
          weight: inMempool.weight,
          fee: inMempool.fee,
          vin: Array.from({ length: numInputs }, (_, i) => ({
            is_coinbase: false,
            ringct: true,
            ring_size: parsed?.vin?.[i]?.key?.key_offsets?.length ?? null,
            key_image: parsed?.vin?.[i]?.key?.k_image ?? '',
            ring_offsets: parsed?.vin?.[i]?.key?.key_offsets ?? [],
            ring_members: ringResolution.membersPerInput[i] ?? [],
            ring_members_truncated: ringResolution.truncated,
            prevout: null,
            scriptsig: '',
            scriptsig_asm: '',
            sequence: 0,
            witness: [],
          })),
          vout: Array.from({ length: numOutputs }, () => ({
            ringct: true,
            value: 0,
            scriptpubkey: '',
            scriptpubkey_asm: '',
            scriptpubkey_address: '',
            scriptpubkey_type: 'ringct',
          })),
          status: { confirmed: false },
          firstSeen: inMempool.receive_time || 0,
          rct_type: parsed?.rct_signatures?.type ?? null,
          has_view_tags: this.hasViewTags(parsed),
        });
        return;
      }
      // Confirmed via /get_transactions.
      const confirmed = await this.api.getTransactionByHash(txid);
      if (!confirmed) {
        handleError(req, res, 404, 'tx not found');
        return;
      }
      // Parse the as_json payload to grab vin/vout counts + fee.
      let parsed: IMoneroApi.TransactionJson | null = null;
      parsed = this.parseTransactionJson(confirmed.as_json);
      const fee = parsed?.rct_signatures?.txnFee ?? 0;
      const blobBytes = confirmed.pruned_as_hex
        ? Math.floor(confirmed.pruned_as_hex.length / 2)
        : confirmed.as_hex
          ? Math.floor(confirmed.as_hex.length / 2)
          : 0;
      const numInputs = parsed?.vin?.length ?? 1;
      const numOutputs = parsed?.vout?.length ?? 1;
      const blockHeight = confirmed.block_height ?? 0;
      const blockTimestamp = confirmed.block_timestamp ?? 0;
      // Resolve block hash for status.
      let blockHash = '';
      if (blockHeight > 0) {
        const b = await this.api.getBlockByHeight(blockHeight).catch(() => null);
        blockHash = b?.block_header.hash ?? '';
      }
      const ringResolution = await this.resolveRingMembers(parsed, blockHeight || undefined);
      res.json({
        txid,
        version: parsed?.version ?? 2,
        locktime: parsed?.unlock_time ?? 0,
        size: blobBytes,
        weight: blobBytes,
        fee,
        // One vin per Monero input — helps the upstream input decoder
        // render a row per ring rather than a single placeholder.
        vin: Array.from({ length: numInputs }, (_, i) => ({
          is_coinbase: false,
          ringct: true,
          ring_size: parsed?.vin?.[i]?.key?.key_offsets?.length ?? null,
          key_image: parsed?.vin?.[i]?.key?.k_image ?? '',
          ring_offsets: parsed?.vin?.[i]?.key?.key_offsets ?? [],
          ring_members: ringResolution.membersPerInput[i] ?? [],
          ring_members_truncated: ringResolution.truncated,
          prevout: null,
          scriptsig: '',
          scriptsig_asm: '',
          sequence: 0,
          witness: [],
        })),
        vout: Array.from({ length: numOutputs }, () => ({
          ringct: true,
          value: 0,
          scriptpubkey: '',
          scriptpubkey_asm: '',
          scriptpubkey_address: '',
          scriptpubkey_type: 'ringct',
        })),
        status: {
          confirmed: true,
          block_height: blockHeight,
          block_hash: blockHash,
          block_time: blockTimestamp,
        },
        // Monero-only extras the upstream component will ignore but
        // our reveal-flow shim can read.
        rct_type: parsed?.rct_signatures?.type ?? null,
        has_view_tags: this.hasViewTags(parsed),
      });
    } catch (err) {
      logger.err(`xmr getTxBitcoinShape failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /** GET /api/tx/:txid/hex — mempool full blob or confirmed pruned tx hex. */
  private async getTxHex(req: Request, res: Response): Promise<void> {
    const txid = req.params.txid ?? req.params.hash;
    if (!txid || !HEX64.test(txid)) {
      handleError(req, res, 400, 'invalid tx hash');
      return;
    }
    try {
      const pool = await this.api.getTransactionPool().catch(() => null);
      const inMempool = pool?.transactions?.find((t) => t.id_hash === txid);
      if (inMempool?.tx_blob) {
        res.type('text/plain').send(inMempool.tx_blob);
        return;
      }

      const confirmed = await this.api.getTransactionByHash(txid);
      const hex = confirmed?.as_hex || confirmed?.pruned_as_hex || '';
      if (!hex) {
        handleError(req, res, 404, 'tx hex not found');
        return;
      }
      res.type('text/plain').send(hex);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|invalid|hash/i.test(msg)) {
        handleError(req, res, 404, 'tx not found');
        return;
      }
      logger.err(`xmr getTxHex failed: ${msg}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  private parseTransactionJson(raw?: string): IMoneroApi.TransactionJson | null {
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as IMoneroApi.TransactionJson;
    } catch {
      return null;
    }
  }

  private hasViewTags(parsed: IMoneroApi.TransactionJson | null): boolean {
    return (parsed?.vout ?? []).some((v) => v.target?.tagged_key?.view_tag !== undefined);
  }

  private async resolveRingMembers(
    parsed: IMoneroApi.TransactionJson | null,
    referenceHeight?: number,
  ): Promise<{ membersPerInput: XmrRingMember[][]; truncated: boolean }> {
    const plan = buildRingLookupPlan(parsed, MAX_RING_MEMBER_LOOKUPS);
    if (!plan.requests.length) {
      return attachResolvedRingMembers(plan, [], referenceHeight);
    }

    try {
      const outs = await this.api.getOuts(plan.requests, true);
      return attachResolvedRingMembers(plan, outs, referenceHeight);
    } catch (err) {
      logger.warn(`xmr ring member resolution failed: ${err instanceof Error ? err.message : String(err)}`);
      return attachResolvedRingMembers(plan, [], referenceHeight);
    }
  }

  /**
   * GET /api/block/:hash/txs/:index — page of transactions in this
   * block. Upstream's electrs-style pagination: 25 per page, index 0
   * is the first 25, index 25 the next, and so on.
   *
   * Response shape mirrors Bitcoin's Transaction interface enough that
   * the upstream TransactionsList renders cleanly:
   *   { txid, version, locktime, fee, size, weight, vin[], vout[], status }
   * vin/vout are populated with synthetic single-entry placeholders
   * tagged 'ringct' so consumers can't decode amounts but don't crash
   * on empty arrays either.
   */
  private async getBlockTxsByPage(req: Request, res: Response, _useV1: boolean): Promise<void> {
    const hash = req.params.hash;
    if (!HEX64.test(hash)) {
      handleError(req, res, 400, 'invalid block hash');
      return;
    }
    const index = Math.max(0, Number(req.params.index ?? 0));
    if (!Number.isFinite(index)) {
      handleError(req, res, 400, 'invalid index');
      return;
    }
    try {
      const block = await this.api.getBlockByHash(hash);
      const blockTime = block.block_header.timestamp;
      const blockHeight = block.block_header.height;
      const tipCount = await this.api.getBlockCount();
      const confirmations = tipCount - blockHeight;
      // Tx list including coinbase first (matches upstream).
      const allHashes = [block.miner_tx_hash, ...(block.tx_hashes ?? [])];
      const PAGE = 25;
      const sliceHashes = allHashes.slice(index, index + PAGE);
      const stripped = sliceHashes.length
        ? await this.api.getBlockStrippedTxs(block.block_header.hash, sliceHashes, blockTime)
            .catch(() => [] as Awaited<ReturnType<typeof this.api.getBlockStrippedTxs>>)
        : [];
      // Build txs in upstream Transaction shape. ALWAYS include at
      // least one vin and one vout entry; upstream's transactions-list
      // template dereferences `tx.vin[0].is_coinbase` (line 515)
      // unconditionally — empty vin arrays throw "can't access
      // is_coinbase of undefined" and the error spams the console
      // every render cycle.
      const out = sliceHashes.map((h, i) => {
        const isCoinbase = i === 0 && index === 0;
        const stat = stripped.find((s) => s.txid === h);
        const fee = isCoinbase ? 0 : stat?.fee ?? 0;
        const size = stat?.vsize ?? 0;
        return {
          txid: h,
          version: 2,
          locktime: 0,
          size,
          weight: size,
          fee,
          // Synthetic vin/vout — we don't know the real input ring or
          // output addresses without keys. Each entry is a placeholder
          // tagged with `ringct: true` (or `is_coinbase: true` for the
          // miner tx) so consumers know to render 'hidden' rather than
          // '0' but the upstream template's `vin[0].is_coinbase` and
          // `vout[0].ringct` dereferences both succeed.
          vin: [{
            is_coinbase: isCoinbase,
            ringct: !isCoinbase,
            prevout: null,
            scriptsig: '',
            scriptsig_asm: '',
            sequence: 0,
            witness: [],
          }],
          vout: [{
            ringct: !isCoinbase,
            value: 0,
            scriptpubkey: '',
            scriptpubkey_asm: '',
            scriptpubkey_address: '',
            scriptpubkey_type: isCoinbase ? 'coinbase' : 'ringct',
          }],
          status: {
            confirmed: true,
            block_height: blockHeight,
            block_hash: block.block_header.hash,
            block_time: blockTime,
          },
          confirmations,
        };
      });
      res.json(out);
    } catch (err) {
      logger.err(`xmr getBlockTxsByPage failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /** GET /api/v1/block/:hash/summary — stripped txs for WebGL viz. */
  private async getBlockSummary(req: Request, res: Response): Promise<void> {
    const hash = req.params.hash;
    if (!HEX64.test(hash)) {
      handleError(req, res, 400, 'invalid block hash');
      return;
    }
    try {
      const block = await this.api.getBlockByHash(hash);
      const txHashes = [block.miner_tx_hash, ...(block.tx_hashes ?? [])];
      const stripped = txHashes.length
        ? await this.api.getBlockStrippedTxs(block.block_header.hash, txHashes, block.block_header.timestamp)
        : [];
      res.json(stripped);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|invalid|hash/i.test(msg)) {
        handleError(req, res, 404, 'block not found');
        return;
      }
      logger.err(`xmr getBlockSummary failed: ${msg}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /** GET /api/v1/block/:hash/tx/:txid/summary — one stripped tx for graph/detail consumers. */
  private async getStrippedBlockTransaction(req: Request, res: Response): Promise<void> {
    const hash = req.params.hash;
    const txid = req.params.txid;
    if (!HEX64.test(hash)) {
      handleError(req, res, 400, 'invalid block hash');
      return;
    }
    if (!HEX64.test(txid)) {
      handleError(req, res, 400, 'invalid tx hash');
      return;
    }
    try {
      const block = await this.api.getBlockByHash(hash);
      const txHashes = [block.miner_tx_hash, ...(block.tx_hashes ?? [])];
      if (!txHashes.includes(txid)) {
        handleError(req, res, 404, 'tx not found in block');
        return;
      }
      const stripped = await this.api.getBlockStrippedTxs(block.block_header.hash, txHashes, block.block_header.timestamp);
      const tx = stripped.find((candidate) => candidate.txid === txid);
      if (!tx) {
        handleError(req, res, 404, 'tx not found');
        return;
      }
      res.json(tx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|invalid|hash/i.test(msg)) {
        handleError(req, res, 404, 'block not found');
        return;
      }
      logger.err(`xmr getStrippedBlockTransaction failed: ${msg}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /** GET /api/block/:hash/raw — Monero block blob as daemon hex. */
  private async getBlockRaw(req: Request, res: Response): Promise<void> {
    const hash = req.params.hash;
    if (!HEX64.test(hash)) {
      handleError(req, res, 400, 'invalid block hash');
      return;
    }
    try {
      const block = await this.api.getBlockByHash(hash);
      if (!block.blob) {
        handleError(req, res, 404, 'block blob not found');
        return;
      }
      res.type('text/plain').send(block.blob);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|invalid|hash/i.test(msg)) {
        handleError(req, res, 404, 'block not found');
        return;
      }
      logger.err(`xmr getBlockRaw failed: ${msg}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /** GET /api/block-height/:height — text response, just the hash. */
  private async getBlockHashByHeight(req: Request, res: Response): Promise<void> {
    const requested = Number(req.params.height);
    if (!Number.isFinite(requested) || requested < 0) {
      handleError(req, res, 400, 'invalid height');
      return;
    }
    try {
      const block = await this.api.getBlockByHeight(requested);
      res.type('text/plain').send(block.block_header.hash);
    } catch (err) {
      logger.err(`xmr getBlockHashByHeight failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /**
   * GET /api/v1/blocks/:height — return up to 25 block headers ending at
   * (and including) the requested height, newest first. If the height
   * exceeds the chain tip we clamp to the tip. Used by the /blocks list
   * page for pagination.
   */
  private async getBlocksFromHeight(req: Request, res: Response): Promise<void> {
    const requested = Number(req.params.height);
    if (!Number.isFinite(requested) || requested < 0) {
      handleError(req, res, 400, 'invalid height');
      return;
    }
    try {
      const tipCount = await this.api.getBlockCount();
      const tipHeight = tipCount - 1;
      const startHeight = Math.min(requested, tipHeight);
      const heights: number[] = [];
      for (let i = 0; i < MAX_RECENT_BLOCKS; i++) {
        const h = startHeight - i;
        if (h < 0) break;
        heights.push(h);
      }
      // Promise.allSettled instead of Promise.all — the cakewallet
      // remote daemon occasionally drops a TLS handshake mid-batch and
      // we don't want one stale connection to nuke the whole 25-block
      // page. We just drop the rejected entries and serve the rest;
      // the user sees a slightly shorter list, not an error.
      const results = await Promise.allSettled(heights.map((h) => this.api.getBlockByHeight(h)));
      const blocks = results
        .filter((r): r is PromiseFulfilledResult<IMoneroApi.Block> => r.status === 'fulfilled')
        .map((r) => r.value);
      const failed = results.length - blocks.length;
      if (failed > 0) {
        logger.warn(`xmr getBlocksFromHeight: ${failed}/${results.length} block fetches failed (transient daemon hiccup)`);
      }
      const shaped = await Promise.all(blocks.map(async (b) => {
        const fees = b.tx_hashes?.length
          ? await this.api.getBlockFeeStats(b.block_header.hash, b.tx_hashes).catch(() => null)
          : null;
        return {
          ...this.shapeBlockHeader(b.block_header, b.tx_hashes?.length),
          extras: {
            reward: b.block_header.reward,
            totalFees: fees?.totalFees ?? 0,
            medianFee: fees?.medianFee ?? 0,
            minFee: fees?.minFee ?? 0,
            maxFee: fees?.maxFee ?? 0,
            feeRange: fees?.feeRange ?? [0, 0, 0, 0, 0, 0, 0],
            pool: identifyXmrMinerPool(b),
          },
        };
      }));
      res.json(shaped);
    } catch (err) {
      logger.err(`xmr getBlocksFromHeight failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /** GET /api/v1/info — daemon status, height, difficulty, mempool count, nettype. */
  private async getInfo(req: Request, res: Response): Promise<void> {
    try {
      const info = await this.api.getInfo();
      // Hashrate isn't a daemon field — derive from difficulty / target_blocktime (120s).
      const hashrateHs = info.difficulty / 120;
      res.json({
        height: info.height,
        target_height: info.target_height,
        difficulty: info.difficulty,
        hashrate_hs: hashrateHs,
        mempool_size: info.tx_pool_size,
        tx_count: info.tx_count,
        nettype: info.nettype,
        top_block_hash: info.top_block_hash,
        block_size_limit: info.block_size_limit,
        version: info.version,
        daemon_status: info.status,
        synced: info.height === info.target_height || info.target_height === 0,
        offline: Boolean(info.offline),
        untrusted: info.untrusted,
        outgoing_connections_count: info.outgoing_connections_count,
        incoming_connections_count: info.incoming_connections_count,
        rpc_connections_count: info.rpc_connections_count,
        white_peerlist_size: info.white_peerlist_size,
        grey_peerlist_size: info.grey_peerlist_size,
        start_time: info.start_time,
        uptime_s: info.start_time ? Math.max(0, Math.floor(Date.now() / 1000) - info.start_time) : null,
        database_size: info.database_size,
        free_space: info.free_space,
        height_without_bootstrap: info.height_without_bootstrap,
        bootstrap_daemon_address: info.bootstrap_daemon_address,
        was_bootstrap_ever_used: info.was_bootstrap_ever_used,
        update_available: info.update_available,
      });
    } catch (err) {
      logger.err(`xmr getInfo failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /**
   * GET /api/v1/blocks — last N block headers (default 10, max 25).
   * Tail of the chain only; for deep history clients should request by hash.
   */
  private async getRecentBlocks(req: Request, res: Response): Promise<void> {
    const requested = Number(req.query.count ?? 10);
    const count = Math.max(1, Math.min(MAX_RECENT_BLOCKS, Number.isFinite(requested) ? requested : 10));
    try {
      const tipCount = await this.api.getBlockCount();
      const tipHeight = tipCount - 1;
      const heights: number[] = [];
      for (let i = 0; i < count; i++) {
        if (tipHeight - i < 0) {
          break;
        }
        heights.push(tipHeight - i);
      }
      const blocks = await Promise.all(heights.map((h) => this.api.getBlockByHeight(h)));
      // Resolve fee stats per block (cached after first lookup) so the
      // /blocks list page renders fee-tier color spans, total fees,
      // and median ɱ/B columns. Without this every row reads zeros.
      const shaped = await Promise.all(blocks.map(async (b) => {
        const fees = b.tx_hashes?.length
          ? await this.api.getBlockFeeStats(b.block_header.hash, b.tx_hashes).catch(() => null)
          : null;
        return {
          ...this.shapeBlockHeader(b.block_header, b.tx_hashes?.length),
          extras: {
            reward: b.block_header.reward,
            totalFees: fees?.totalFees ?? 0,
            medianFee: fees?.medianFee ?? 0,
            minFee: fees?.minFee ?? 0,
            maxFee: fees?.maxFee ?? 0,
            feeRange: fees?.feeRange ?? [0, 0, 0, 0, 0, 0, 0],
            pool: identifyXmrMinerPool(b),
          },
        };
      }));
      res.json(shaped);
    } catch (err) {
      logger.err(`xmr getRecentBlocks failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /**
   * GET /api/v1/block/:hash — single block detail.
   * Returns header + tx hashes only (no amounts, no decoded txs).
   */
  private async getBlock(req: Request, res: Response): Promise<void> {
    const hash = req.params.hash;
    if (!HEX64.test(hash)) {
      handleError(req, res, 400, 'invalid block hash');
      return;
    }
    try {
      const block = await this.api.getBlockByHash(hash);
      const txHashes = block.tx_hashes ?? [];
      const includeTxs = req.query.include_txs === '1' || req.query.include_txs === 'true';
      // Always resolve fees (cheap thanks to caching). Optionally also
      // resolve stripped per-tx data if the client asked for it — used
      // by the block-detail page's tile visualization.
      const [fees, stripped] = await Promise.all([
        txHashes.length ? this.api.getBlockFeeStats(block.block_header.hash, txHashes).catch(() => null) : Promise.resolve(null),
        includeTxs && txHashes.length
          ? this.api.getBlockStrippedTxs(block.block_header.hash, txHashes, block.block_header.timestamp).catch(() => null)
          : Promise.resolve(null),
      ]);
      const payload: Record<string, unknown> = {
        ...this.shapeBlockHeader(block.block_header, txHashes.length),
        miner_tx_hash: block.miner_tx_hash,
        tx_hashes: txHashes,
        // Snake-case fields kept for backwards compat with our
        // XmrBlockDetail; upstream BlockExtended reads from extras.
        total_fees: fees?.totalFees ?? 0,
        median_fee: fees?.medianFee ?? 0,
        min_fee: fees?.minFee ?? 0,
        max_fee: fees?.maxFee ?? 0,
        fee_range: fees?.feeRange ?? [0, 0, 0, 0, 0, 0, 0],
        // The `extras` envelope is what mempool.space's BlockComponent
        // reads — block.extras.totalFees / medianFee / feeRange / pool.
        extras: {
          reward: block.block_header.reward,
          totalFees: fees?.totalFees ?? 0,
          medianFee: fees?.medianFee ?? 0,
          minFee: fees?.minFee ?? 0,
          maxFee: fees?.maxFee ?? 0,
          feeRange: fees?.feeRange ?? [0, 0, 0, 0, 0, 0, 0],
          pool: identifyXmrMinerPool(block),
        },
      };
      if (includeTxs) {
        payload.stripped_txs = stripped ?? [];
      }
      res.json(payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|invalid|hash/i.test(msg)) {
        handleError(req, res, 404, 'block not found');
        return;
      }
      logger.err(`xmr getBlock failed: ${msg}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /**
   * GET /api/v1/tx/:hash — public-only tx data.
   *
   * Returns size, weight, fee, ring info, in/out counts, confirmations.
   * NEVER returns amounts or recipients — those are RingCT-hidden by design.
   * The frontend's blur+reveal UI surfaces those client-side via monero-ts.
   *
   * Looks up the tx in two places:
   *   1. mempool — exposes weight/fee/receive_time
   *   2. confirmed (via /get_transactions) — exposes block_height/timestamp/confirmations
   *
   * If neither matches we 404. Note: monerod's /get_transactions returns a
   * pruned-friendly hex blob plus a JSON decode of the unprunable bits
   * (vin/vout shapes, ring offsets) — exactly what we need to surface ring
   * info publicly.
   */
  private async getTx(req: Request, res: Response): Promise<void> {
    const hash = req.params.hash;
    if (!HEX64.test(hash)) {
      handleError(req, res, 400, 'invalid tx hash');
      return;
    }
    try {
      const pool = await this.api.getTransactionPool();
      const inMempool = pool.transactions?.find((t) => t.id_hash === hash);
      if (inMempool) {
        res.json({ status: 'mempool', ...this.shapeMempoolTx(inMempool) });
        return;
      }
      const confirmed = await this.api.getTransactionByHash(hash);
      if (confirmed) {
        res.json({ status: 'confirmed', ...this.shapeConfirmedTx(confirmed) });
        return;
      }
      handleError(req, res, 404, 'tx not found');
    } catch (err) {
      logger.err(`xmr getTx failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /**
   * GET /api/v1/mempool — full current mempool, public fields only.
   * Sorted by fee descending so the frontend's tile layout has a deterministic
   * top-of-list. The mempool wall does its own sizing/binning client-side.
   */
  private async getMempool(req: Request, res: Response): Promise<void> {
    try {
      const pool = await this.api.getTransactionPool();
      const txs = (pool.transactions ?? [])
        .map((t) => this.shapeMempoolTx(t))
        .sort((a, b) => b.fee - a.fee);
      res.json({
        count: txs.length,
        total_weight: txs.reduce((acc, t) => acc + t.weight, 0),
        total_fee: txs.reduce((acc, t) => acc + t.fee, 0),
        txs,
      });
    } catch (err) {
      logger.err(`xmr getMempool failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  /**
   * GET /api/v1/fees/recommended — Monero's 4-tier fee model.
   *
   * Returns `{ slow, normal, fast, fastest }` in atomic units per byte.
   * Frontend uses these directly for the fee-tier color buckets.
   */
  private async getFeesRecommended(req: Request, res: Response): Promise<void> {
    try {
      const fees = await this.api.getFeeEstimate();
      const tiers = fees.fees ?? [fees.fee, fees.fee, fees.fee, fees.fee];
      res.json({
        slow: tiers[0],
        normal: tiers[1],
        fast: tiers[2],
        fastest: tiers[3],
        quantization_mask: fees.quantization_mask,
      });
    } catch (err) {
      logger.err(`xmr getFeesRecommended failed: ${err instanceof Error ? err.message : String(err)}`);
      handleError(req, res, 502, 'monerod unreachable');
    }
  }

  // ---- shaping helpers ----

  private shapeBlockHeader(h: IMoneroApi.BlockHeader, numTxes?: number) {
    return {
      // upstream's BlockExtended interface uses `id` for the hash. Keep
      // both keys: id is the upstream-canonical name (used by the
      // mempool.space frontend's BlockComponent), hash is the
      // Monero-canonical name (used by our XmrBlockDetail and tests).
      // Pointing them at the same string costs ~64 bytes per response
      // and removes a whole class of "field not found" bugs.
      id: h.hash,
      hash: h.hash,
      height: h.height,
      timestamp: h.timestamp,
      age_s: Math.floor(Date.now() / 1000) - h.timestamp,
      depth: h.depth,
      // Both naming conventions for the prev hash, same reason as id/hash.
      prev_hash: h.prev_hash,
      previousblockhash: h.prev_hash,
      reward: h.reward,
      block_size: h.block_size,
      block_weight: h.block_weight,
      // upstream Block interface uses `size` and `weight`; Monero's
      // wire fields are `block_size` and `block_weight`. Map both.
      size: h.block_size,
      weight: h.block_weight,
      // tx_count includes the coinbase per upstream convention. num_txes
      // excludes it (Monero daemon convention). Keep both.
      tx_count: (numTxes ?? h.num_txes) + 1,
      num_txes: numTxes ?? h.num_txes,
      difficulty: h.difficulty,
      cumulative_difficulty: h.cumulative_difficulty,
      major_version: h.major_version,
      minor_version: h.minor_version,
      // upstream BlockExtended.version is generic; map to major_version.
      version: h.major_version,
      nonce: h.nonce,
      orphan_status: h.orphan_status,
      // Monero has no Merkle root of all txs; the miner_tx_hash is the
      // closest analogue and is what our WS adapter has been using.
      merkle_root: h.miner_tx_hash,
      bits: 0,
      miner_tx_hash: h.miner_tx_hash,
    };
  }

  /**
   * Shape a confirmed tx into public-only fields. Crucially, this includes:
   *   - ring_size: length of vin[0].key.key_offsets (16 in modern Monero)
   *   - num_inputs / num_outputs: counts only, never amounts
   *   - ring_offsets_per_input: delta-encoded global output indices for
   *     each input. The active Bitcoin-shape tx endpoint resolves these
   *     into public ring-member heights via `/get_outs`.
   *   - has_view_tags: derived from any vout with `target.tagged_key.view_tag`
   *     set — a privacy/scanning-speed signal.
   *   - rct_type: ringct version (0=none, 1=full, 2=simple, 3=bulletproof, 4=clsag, 5=bulletproof+, 6=clsag-bp+)
   *
   * NEVER includes amounts (vout[].amount is always 0 in RingCT post-v4
   * anyway, but we don't even forward that field) or recipient addresses.
   */
  private shapeConfirmedTx(t: IMoneroApi.TransactionEntry) {
    let parsed: IMoneroApi.TransactionJson | null = null;
    if (t.as_json) {
      try {
        parsed = JSON.parse(t.as_json) as IMoneroApi.TransactionJson;
      } catch (e) {
        // Daemon should always return valid JSON; if not, surface what we can.
      }
    }
    const numInputs = parsed?.vin?.length ?? 0;
    const numOutputs = parsed?.vout?.length ?? 0;
    const ringSizes = (parsed?.vin ?? [])
      .map((v) => v.key?.key_offsets?.length ?? 0)
      .filter((n) => n > 0);
    const ringSize = ringSizes.length ? ringSizes[0] : null;
    const allRingsConsistent = ringSizes.every((n) => n === ringSize);
    const hasViewTags = (parsed?.vout ?? []).some(
      (v) => v.target?.tagged_key?.view_tag !== undefined,
    );
    // Tx blob size = pruned_as_hex bytes (or as_hex if not pruned). The
    // daemon doesn't return tx_weight directly on /get_transactions, but
    // the wire blob length is what the wallet/daemon use as "weight" for
    // fee-per-byte calculations. /2 because hex is 2 chars per byte.
    const blobBytes = t.pruned_as_hex
      ? Math.floor(t.pruned_as_hex.length / 2)
      : t.as_hex
        ? Math.floor(t.as_hex.length / 2)
        : 0;
    const fee = parsed?.rct_signatures?.txnFee ?? null;
    const feePerByte = fee && blobBytes > 0 ? Math.floor(fee / blobBytes) : 0;
    return {
      hash: t.tx_hash,
      block_height: t.block_height,
      block_timestamp: t.block_timestamp,
      age_s: t.block_timestamp ? Math.floor(Date.now() / 1000) - t.block_timestamp : null,
      confirmations: t.confirmations,
      double_spend_seen: t.double_spend_seen,
      version: parsed?.version,
      unlock_time: parsed?.unlock_time,
      num_inputs: numInputs,
      num_outputs: numOutputs,
      ring_size: ringSize,
      ring_size_consistent: allRingsConsistent,
      ring_offsets_per_input: (parsed?.vin ?? [])
        .map((v) => v.key?.key_offsets ?? [])
        .filter((arr) => arr.length > 0),
      key_images: (parsed?.vin ?? [])
        .map((v) => v.key?.k_image)
        .filter((k): k is string => typeof k === 'string'),
      has_view_tags: hasViewTags,
      rct_type: parsed?.rct_signatures?.type ?? null,
      weight: blobBytes,
      blob_size: blobBytes,
      fee,
      fee_per_byte: feePerByte,
    };
  }

  private shapeMempoolTx(t: IMoneroApi.MempoolEntry) {
    return {
      hash: t.id_hash,
      weight: t.weight,
      blob_size: t.blob_size,
      fee: t.fee,
      // fee_per_byte is the bucket the frontend will color-code against.
      fee_per_byte: t.weight > 0 ? Math.floor(t.fee / t.weight) : 0,
      receive_time: t.receive_time || null,
      relayed: t.relayed,
      double_spend_seen: t.double_spend_seen,
    };
  }
}
