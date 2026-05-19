/**
 * Standalone xmr-space backend entry. Mounts the Monero REST surface
 * without booting upstream's full bitcoind/MariaDB/indexer stack.
 *
 * Run with:
 *   MONEROD_RPC_URL=https://xmr-node.cakewallet.com:18081 \
 *     npx ts-node src/api/monero/xmr-server.ts
 *
 * Why standalone? The upstream bootstrap (backend/src/index.ts) wires
 * bitcoind RPC, the audit pipeline, RBF cache, mining-pool indexer, and
 * the websocket handler — all of which currently assume a UTXO chain.
 * Running them against monerod is a multi-iteration job. Until those
 * paths are retargeted (or stripped, for the ones that don't apply),
 * this file gives the frontend something to talk to.
 */
import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { MoneroApi, moneroDaemonConfigFromEnv } from './monero-api';
import { MoneroRoutes } from './monero.routes';
import { MoneroEventBus } from './monero-event-bus';
import { MoneroSseRoutes } from './monero-sse.routes';
import { MoneroWs } from './monero-ws';
import { MoneroStats } from './monero-stats';
import { XmrChainIndexer } from './xmr-chain-indexer';
import { XmrMiningRoutes } from './xmr-mining.routes';
import { moneroWalletRpcFromEnv } from './monero-wallet-rpc';

function main(): void {
  const app = express();
  const port = Number(process.env.XMR_PORT ?? 8999);
  const host = process.env.XMR_HOST ?? '127.0.0.1';

  // CORS: dev-mode permissive so the frontend ng dev server can hit us
  // without a proxy. Production deploys terminate at nginx and don't need
  // this — we'd remove the middleware behind a NODE_ENV gate.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'xmr-space-backend' });
  });

  const daemonConfig = moneroDaemonConfigFromEnv();
  const api = new MoneroApi(daemonConfig);
  const walletRpc = moneroWalletRpcFromEnv();

  const bus = new MoneroEventBus(
    daemonConfig,
    Number(process.env.XMR_POLL_MS ?? 3000),
  );
  bus.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[xmr-space] event bus error:', err instanceof Error ? err.message : err);
  });
  bus.start();
  new MoneroSseRoutes(bus).initRoutes(app);

  // Rolling 1-minute mempool-stats samples for the Incoming
  // Transactions chart. Persists recent samples under XMR_INDEX_DIR so
  // restarts keep the chart history; first boot fills naturally.
  const stats = new MoneroStats(api, bus);
  stats.start();
  stats.initRoutes(app);

  // Historical chain indexer — hydrates per-block size/fees/reward
  // from xmrchain.net and difficulty from monerod, then exposes the
  // upstream-shape /api/v1/mining/* endpoints. Kicks off backfill
  // in the background; mining graphs populate progressively over
  // the first minute or two of boot. Persists to ~/.xmr-space/
  // blocks-index.json so subsequent boots are instant.
  const indexer = new XmrChainIndexer(api, bus);
  void indexer.start();
  new XmrMiningRoutes(indexer).initRoutes(app);

  // WebSocket adapter at /api/v1/ws speaking the upstream mempool/mempool
  // protocol so the existing Angular frontend renders without retargeting
  // its WebsocketService / StateService.
  const httpServer = createServer(app);
  const ws = new MoneroWs(api, bus);
  ws.attach(httpServer, '/api/v1/ws');

  // REST routes after ws so /api/v1/init-data can mirror the ws
  // first-message snapshot without duplicating the shaping logic.
  new MoneroRoutes(api, ws, walletRpc).initRoutes(app);

  httpServer.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`[xmr-space] listening on http://${host}:${port}`);
    // eslint-disable-next-line no-console
    console.log(`[xmr-space] daemon: ${daemonConfig.rpcUrl}`);
    if (daemonConfig.fallbackRpcUrls?.length) {
      // eslint-disable-next-line no-console
      console.log(`[xmr-space] daemon fallback: ${daemonConfig.fallbackRpcUrls.join(', ')}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[xmr-space] wallet-rpc proofs: ${walletRpc ? 'enabled' : 'disabled (set MONERO_WALLET_RPC_URL)'}`);
  });
}

main();
