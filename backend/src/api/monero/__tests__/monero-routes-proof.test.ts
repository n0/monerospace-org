import express from 'express';
import { createServer, request as httpRequest, Server } from 'http';
import { AddressInfo } from 'net';
import { MoneroApi } from '../monero-api';
import { MoneroRoutes } from '../monero.routes';
import { MoneroWalletRpc } from '../monero-wallet-rpc';

const TXID = 'c'.repeat(64);
const ADDRESS = `4${'A'.repeat(94)}`;
const SIGNATURE = 'OutProofV1'.padEnd(90, 'x');

function makeServer(walletRpc: MoneroWalletRpc | null, api: Partial<MoneroApi> = {}): Promise<Server> {
  const app = express();
  app.use(express.json());
  new MoneroRoutes(api as MoneroApi, null, walletRpc).initRoutes(app);
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function postJson(server: Server, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('MoneroRoutes tx proof verification', () => {
  let server: Server | null = null;

  afterEach((done) => {
    if (!server) {
      done();
      return;
    }
    server.close(() => {
      server = null;
      done();
    });
  });

  it('returns 503 instead of fake verification when wallet RPC is not configured', async () => {
    server = await makeServer(null);

    const response = await postJson(server, `/api/v1/tx/${TXID}/verify-proof`, {
      address: ADDRESS,
      signature: SIGNATURE,
    });

    expect(response.status).toBe(503);
    expect(response.json).toEqual({
      ok: false,
      message: 'tx_proof verification requires monero-wallet-rpc; set MONERO_WALLET_RPC_URL on the backend',
    });
  });

  it('maps wallet-rpc check_tx_proof responses into the public API shape', async () => {
    const checkTxProof = jest.fn().mockResolvedValue({
      confirmations: 4,
      good: true,
      in_pool: false,
      received: 42,
    });
    server = await makeServer({ checkTxProof } as unknown as MoneroWalletRpc);

    const response = await postJson(server, `/api/v1/tx/${TXID}/verify-proof`, {
      address: ADDRESS,
      signature: SIGNATURE,
      message: 'receipt',
    });

    expect(checkTxProof).toHaveBeenCalledWith({
      txid: TXID,
      address: ADDRESS,
      signature: SIGNATURE,
      message: 'receipt',
    });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      ok: true,
      amount: 42,
      received: 42,
      confirmations: 4,
      in_pool: false,
    });
  });
});

describe('MoneroRoutes public monerod proxy privacy guard', () => {
  let server: Server | null = null;

  afterEach((done) => {
    if (!server) {
      done();
      return;
    }
    server.close(() => {
      server = null;
      done();
    });
  });

  it('wraps whitelisted JSON-RPC daemon methods without wallet secrets', async () => {
    const proxyPublicJsonRpc = jest.fn().mockResolvedValue({ height: 123 });
    server = await makeServer(null, { proxyPublicJsonRpc });

    const response = await postJson(server, '/api/v1/monerod/json_rpc', {
      id: 'scan',
      jsonrpc: '2.0',
      method: 'get_info',
      params: {},
    });

    expect(proxyPublicJsonRpc).toHaveBeenCalledWith('get_info', {});
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      id: 'scan',
      jsonrpc: '2.0',
      result: { height: 123 },
    });
  });

  it('rejects wallet RPC methods on the public daemon bridge', async () => {
    const proxyPublicJsonRpc = jest.fn();
    server = await makeServer(null, { proxyPublicJsonRpc });

    const response = await postJson(server, '/api/v1/monerod/json_rpc', {
      id: 'scan',
      jsonrpc: '2.0',
      method: 'check_tx_key',
      params: {
        txid: TXID,
        address: ADDRESS,
        tx_key: 'a'.repeat(64),
      },
    });

    expect(proxyPublicJsonRpc).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it('rejects secret-shaped fields before proxying public daemon calls', async () => {
    const proxyPublicRaw = jest.fn();
    server = await makeServer(null, { proxyPublicRaw });

    const response = await postJson(server, '/api/v1/monerod/get_transactions', {
      txs_hashes: [TXID],
      private_view_key: 'a'.repeat(64),
    });

    expect(proxyPublicRaw).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({
      error: 'wallet secrets must stay in the browser',
    });
  });
});
