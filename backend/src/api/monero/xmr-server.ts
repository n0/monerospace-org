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
import { moneroApiFromEnv } from './monero-api';
import { MoneroRoutes } from './monero.routes';

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

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'xmr-space-backend' });
  });

  const api = moneroApiFromEnv();
  new MoneroRoutes(api).initRoutes(app);

  app.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`[xmr-space] listening on http://${host}:${port}`);
    // eslint-disable-next-line no-console
    console.log(`[xmr-space] daemon: ${process.env.MONEROD_RPC_URL ?? 'https://xmr-node.cakewallet.com:18081'}`);
  });
}

main();
