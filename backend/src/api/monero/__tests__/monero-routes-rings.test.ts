import express from 'express';
import { createServer, request as httpRequest, Server } from 'http';
import { AddressInfo } from 'net';
import { MoneroApi } from '../monero-api';
import { MoneroRoutes } from '../monero.routes';
import { IMoneroApi } from '../monero-api.interface';

const TXID = 'd'.repeat(64);
const BLOCK_HASH = 'e'.repeat(64);

function makeServer(api: Partial<MoneroApi>): Promise<Server> {
  const app = express();
  new MoneroRoutes(api as MoneroApi).initRoutes(app);
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function getJson(server: Server, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function getText(server: Server, path: string): Promise<{ status: number; text: string; contentType: string }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
          contentType: String(res.headers['content-type'] ?? ''),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('MoneroRoutes ring-member enrichment', () => {
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

  it('resolves delta ring offsets to public output heights on the active tx endpoint', async () => {
    const parsed = {
      version: 2,
      unlock_time: 0,
      vin: [{ key: { amount: 0, key_offsets: [10, 2, 3], k_image: 'a'.repeat(64) } }],
      vout: [{ amount: 0, target: { tagged_key: { key: 'b'.repeat(64), view_tag: '7f' } } }],
      extra: [],
      rct_signatures: { type: 6, txnFee: 1234 },
    } as IMoneroApi.TransactionJson;

    const getOuts = jest.fn().mockResolvedValue([
      { height: 90, key: 'k0', mask: 'm0', txid: 'tx0', unlocked: true },
      { height: 95, key: 'k1', mask: 'm1', txid: 'tx1', unlocked: true },
      { height: 99, key: 'k2', mask: 'm2', txid: 'tx2', unlocked: true },
    ]);

    server = await makeServer({
      getTransactionPool: jest.fn().mockResolvedValue({ transactions: [], status: 'OK', untrusted: false }),
      getTransactionByHash: jest.fn().mockResolvedValue({
        tx_hash: TXID,
        as_hex: '00'.repeat(500),
        as_json: JSON.stringify(parsed),
        in_pool: false,
        double_spend_seen: false,
        block_height: 100,
        block_timestamp: 1_700_000_000,
        confirmations: 4,
      }),
      getBlockByHeight: jest.fn().mockResolvedValue({
        block_header: { hash: BLOCK_HASH },
      }),
      getOuts,
    });

    const response = await getJson(server, `/api/v1/tx/${TXID}`);
    const vin = (response.json.vin as Array<Record<string, unknown>>)[0];

    expect(response.status).toBe(200);
    expect(getOuts).toHaveBeenCalledWith([
      { amount: 0, index: 10 },
      { amount: 0, index: 12 },
      { amount: 0, index: 15 },
    ], true);
    expect(vin.ring_offsets).toEqual([10, 2, 3]);
    expect(vin.ring_members).toEqual([
      { amount: 0, global_index: 10, height: 90, txid: 'tx0', unlocked: true, age_blocks: 10 },
      { amount: 0, global_index: 12, height: 95, txid: 'tx1', unlocked: true, age_blocks: 5 },
      { amount: 0, global_index: 15, height: 99, txid: 'tx2', unlocked: true, age_blocks: 1 },
    ]);
    expect(response.json).toMatchObject({ has_view_tags: true, rct_type: 6 });
  });

  it('stubs batched outspends with one empty list per requested txid', async () => {
    server = await makeServer({});

    const response = await getJson(server, `/api/v1/txs/outspends?txids=${'a'.repeat(64)},${'b'.repeat(64)}`);

    expect(response.status).toBe(200);
    expect(response.json).toEqual([[], []]);
  });

  it('serves real tx blob hex instead of an empty compatibility response', async () => {
    const getTransactionByHash = jest.fn().mockResolvedValue({
      tx_hash: TXID,
      as_hex: '',
      pruned_as_hex: 'abcd1234',
      in_pool: false,
      double_spend_seen: false,
    });
    server = await makeServer({
      getTransactionPool: jest.fn().mockResolvedValue({
        transactions: [{ id_hash: TXID, tx_blob: 'feedbeef' }],
        status: 'OK',
        untrusted: false,
      }),
      getTransactionByHash,
    });

    const mempoolResponse = await getText(server, `/api/tx/${TXID}/hex`);

    expect(mempoolResponse.status).toBe(200);
    expect(mempoolResponse.text).toBe('feedbeef');
    expect(getTransactionByHash).not.toHaveBeenCalled();
  });

  it('falls back to confirmed pruned tx hex when the tx is not in the mempool', async () => {
    server = await makeServer({
      getTransactionPool: jest.fn().mockResolvedValue({ transactions: [], status: 'OK', untrusted: false }),
      getTransactionByHash: jest.fn().mockResolvedValue({
        tx_hash: TXID,
        as_hex: '',
        pruned_as_hex: 'abcd1234',
        in_pool: false,
        double_spend_seen: false,
      }),
    });

    const response = await getText(server, `/api/tx/${TXID}/hex`);

    expect(response.status).toBe(200);
    expect(response.text).toBe('abcd1234');
  });

  it('serves the Monero block blob for raw block links', async () => {
    server = await makeServer({
      getBlockByHash: jest.fn().mockResolvedValue({ blob: '0123456789abcdef' }),
    });

    const response = await getText(server, `/api/block/${BLOCK_HASH}/raw`);
    const headerAlias = await getText(server, `/api/block/${BLOCK_HASH}/header`);

    expect(response.status).toBe(200);
    expect(response.text).toBe('0123456789abcdef');
    expect(headerAlias.status).toBe(200);
    expect(headerAlias.text).toBe('0123456789abcdef');
  });

  it('serves a single stripped block transaction summary', async () => {
    const stripped = {
      txid: TXID,
      fee: 123,
      vsize: 456,
      value: 0,
      rate: 0.25,
      flags: 0,
      time: 1_700_000_000,
      acc: false,
    };
    server = await makeServer({
      getBlockByHash: jest.fn().mockResolvedValue({
        block_header: { hash: BLOCK_HASH, timestamp: 1_700_000_000 },
        tx_hashes: [TXID],
      }),
      getBlockStrippedTxs: jest.fn().mockResolvedValue([stripped]),
    });

    const response = await getJson(server, `/api/v1/block/${BLOCK_HASH}/tx/${TXID}/summary`);

    expect(response.status).toBe(200);
    expect(response.json).toEqual(stripped);
  });
});
