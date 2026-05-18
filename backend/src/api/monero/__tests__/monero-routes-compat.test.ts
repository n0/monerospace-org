import express from 'express';
import { createServer, request as httpRequest, Server } from 'http';
import { AddressInfo } from 'net';
import { MoneroApi } from '../monero-api';
import { MoneroRoutes } from '../monero.routes';

const TXID = 'a'.repeat(64);
const OTHER_TXID = 'b'.repeat(64);
const BLOCK_HASH = 'c'.repeat(64);
const PREVIOUS_BLOCK_HASH = 'd'.repeat(64);

function makeServer(api: Partial<MoneroApi>): Promise<Server> {
  const app = express();
  new MoneroRoutes(api as MoneroApi).initRoutes(app);
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function getRaw(server: Server, path: string): Promise<{ status: number; text: string; contentType: string }> {
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

async function getJson<T = unknown>(server: Server, path: string): Promise<{ status: number; json: T }> {
  const response = await getRaw(server, path);
  return { status: response.status, json: JSON.parse(response.text) as T };
}

describe('MoneroRoutes compatibility contracts', () => {
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

  it('documents Bitcoin-only helper endpoints as neutral no-data responses', async () => {
    server = await makeServer({});

    await expect(getJson(server, `/api/v1/cpfp/${TXID}`)).resolves.toEqual({
      status: 200,
      json: {
        ancestors: [],
        descendants: [],
        bestDescendant: null,
        sigops: 0,
        adjustedVsize: 0,
        effectiveFeePerVsize: 0,
      },
    });
    expect((await getRaw(server, `/api/v1/tx/${TXID}/rbf`)).status).toBe(204);
    expect((await getRaw(server, `/api/v1/tx/${TXID}/cached`)).status).toBe(204);
    expect((await getRaw(server, `/api/tx/${TXID}/outspend/0`)).status).toBe(204);
    await expect(getJson(server, `/api/tx/${TXID}/outspends`)).resolves.toEqual({ status: 200, json: [] });
    await expect(getJson(server, `/api/v1/txs/outspends?txids=${TXID},${OTHER_TXID}`)).resolves.toEqual({
      status: 200,
      json: [[], []],
    });

    expect((await getRaw(server, `/api/v1/block/${BLOCK_HASH}/audit-summary`)).status).toBe(404);
    expect((await getRaw(server, '/api/v1/mining/pools/1w')).status).toBe(404);
    expect((await getRaw(server, '/api/v1/mining/pool/unknown')).status).toBe(404);
    await expect(getJson(server, '/api/v1/accelerations')).resolves.toEqual({ status: 200, json: [] });
    await expect(getJson(server, '/api/v1/accelerator')).resolves.toEqual({ status: 200, json: { enabled: false } });
  });

  it('serves daemon health fields through the Monero info endpoint', async () => {
    const startTime = Math.floor(Date.now() / 1000) - 3600;
    server = await makeServer({
      getInfo: jest.fn().mockResolvedValue({
        height: 101,
        target_height: 105,
        difficulty: 240_000_000,
        tx_pool_size: 7,
        tx_count: 123_456,
        nettype: 'mainnet',
        top_block_hash: BLOCK_HASH,
        block_size_limit: 600_000,
        version: '0.18.4.2-release',
        status: 'OK',
        offline: false,
        untrusted: false,
        outgoing_connections_count: 8,
        incoming_connections_count: 12,
        rpc_connections_count: 3,
        white_peerlist_size: 900,
        grey_peerlist_size: 1200,
        start_time: startTime,
        database_size: 10_000_000_000,
        free_space: 20_000_000_000,
        height_without_bootstrap: 101,
        bootstrap_daemon_address: '',
        was_bootstrap_ever_used: false,
        update_available: false,
      }),
    });

    const response = await getJson<Record<string, unknown>>(server, '/api/v1/info');

    expect(response.status).toBe(200);
    expect(response.json).toEqual(expect.objectContaining({
      height: 101,
      target_height: 105,
      synced: false,
      difficulty: 240_000_000,
      hashrate_hs: 2_000_000,
      mempool_size: 7,
      tx_count: 123_456,
      nettype: 'mainnet',
      top_block_hash: BLOCK_HASH,
      daemon_status: 'OK',
      offline: false,
      untrusted: false,
      outgoing_connections_count: 8,
      incoming_connections_count: 12,
      rpc_connections_count: 3,
      white_peerlist_size: 900,
      grey_peerlist_size: 1200,
      start_time: startTime,
      database_size: 10_000_000_000,
      free_space: 20_000_000_000,
      height_without_bootstrap: 101,
      bootstrap_daemon_address: '',
      was_bootstrap_ever_used: false,
      update_available: false,
    }));
    expect(response.json.uptime_s).toEqual(expect.any(Number));
  });

  it('serves electrs convenience endpoints from Monero state without exposing hidden amounts', async () => {
    server = await makeServer({
      getInfo: jest.fn().mockResolvedValue({
        height: 101,
        top_block_hash: BLOCK_HASH,
      }),
      getTransactionPool: jest.fn().mockResolvedValue({
        transactions: [
          { id_hash: TXID, fee: 123, weight: 456, receive_time: 1_700_000_000 },
        ],
        status: 'OK',
        untrusted: false,
      }),
    });

    const tipHash = await getRaw(server, '/api/blocks/tip/hash');
    const tipHeight = await getRaw(server, '/api/blocks/tip/height');
    const recent = await getJson<Array<Record<string, unknown>>>(server, '/api/mempool/recent');
    const v1Mempool = await getJson<Record<string, unknown>>(server, '/api/v1/mempool');
    const times = await getJson<number[]>(
      server,
      `/api/v1/transaction-times?txId%5B%5D=${TXID}&txId%5B%5D=${OTHER_TXID}`,
    );

    expect(tipHash.status).toBe(200);
    expect(tipHash.text).toBe(BLOCK_HASH);
    expect(tipHeight.status).toBe(200);
    expect(tipHeight.text).toBe('100');
    expect(recent).toEqual({
      status: 200,
      json: [{ txid: TXID, fee: 123, vsize: 456, value: 0 }],
    });
    expect(v1Mempool).toEqual({
      status: 200,
      json: {
        count: 1,
        total_weight: 456,
        total_fee: 123,
        txs: [
          expect.objectContaining({
            hash: TXID,
            fee: 123,
            weight: 456,
            fee_per_byte: 0,
          }),
        ],
      },
    });
    expect(times).toEqual({ status: 200, json: [1_700_000_000, 0] });
  });

  it('serves raw block/header aliases as the same Monero block blob', async () => {
    server = await makeServer({
      getBlockByHash: jest.fn().mockResolvedValue({ blob: '0123456789abcdef' }),
    });

    for (const path of [
      `/api/block/${BLOCK_HASH}/raw`,
      `/api/v1/block/${BLOCK_HASH}/raw`,
      `/api/block/${BLOCK_HASH}/header`,
      `/api/v1/block/${BLOCK_HASH}/header`,
    ]) {
      const response = await getRaw(server, path);
      expect(response.status).toBe(200);
      expect(response.text).toBe('0123456789abcdef');
      expect(response.contentType).toContain('text/plain');
    }
  });

  it('surfaces P2Pool miner identity when a block carries a merge-mining tx-extra tag', async () => {
    server = await makeServer({
      getBlockByHash: jest.fn().mockResolvedValue({
        blob: '',
        block_header: {
          hash: BLOCK_HASH,
          height: 123,
          depth: 0,
          timestamp: 1_700_000_000,
          nonce: 1,
          orphan_status: false,
          prev_hash: PREVIOUS_BLOCK_HASH,
          reward: 600_000_000_000,
          block_size: 120_000,
          block_weight: 120_000,
          num_txes: 0,
          major_version: 16,
          minor_version: 0,
          cumulative_difficulty: 1_000_000,
          difficulty: 360_000_000,
          miner_tx_hash: TXID,
          long_term_weight: 120_000,
        },
        json: JSON.stringify({
          miner_tx: {
            extra: [
              0x01, ...Array.from({ length: 32 }, (_, i) => i + 1),
              0x03, 0x00, ...Array.from({ length: 32 }, (_, i) => 255 - i),
            ],
          },
          tx_hashes: [],
        }),
        miner_tx_hash: TXID,
        tx_hashes: [],
        status: 'OK',
      }),
    });

    const response = await getJson<Record<string, unknown>>(server, `/api/v1/block/${BLOCK_HASH}`);

    expect(response.status).toBe(200);
    expect(response.json).toEqual(expect.objectContaining({
      extras: expect.objectContaining({
        pool: {
          id: 1,
          name: 'P2Pool',
          slug: 'p2pool',
          minerNames: ['P2Pool', 'P2Pool merge-mined sidechain'],
        },
      }),
    }));
  });
});
