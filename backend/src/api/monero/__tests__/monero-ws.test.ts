import { EventEmitter } from 'events';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { MoneroApi } from '../monero-api';
import { MoneroEventBus } from '../monero-event-bus';
import { IMoneroApi } from '../monero-api.interface';
import { MoneroWs, shapeXmrRecommendedFees } from '../monero-ws';

function header(height: number, hash = height.toString(16).padStart(64, '0')): IMoneroApi.BlockHeader {
  return {
    hash,
    height,
    depth: 0,
    timestamp: 1_700_000_000 + height,
    nonce: height,
    orphan_status: false,
    prev_hash: Math.max(0, height - 1).toString(16).padStart(64, '0'),
    reward: 600_000_000_000,
    block_size: 120_000,
    block_weight: 120_000,
    num_txes: 3,
    major_version: 16,
    minor_version: 0,
    cumulative_difficulty: height * 1000,
    difficulty: 360_000_000,
    miner_tx_hash: 'f'.repeat(64),
    long_term_weight: 120_000,
  };
}

function blockFor(blockHeader: IMoneroApi.BlockHeader, txHashes: string[] = [], json = '{}'): IMoneroApi.Block {
  return {
    blob: '',
    block_header: blockHeader,
    json,
    miner_tx_hash: blockHeader.miner_tx_hash,
    tx_hashes: txHashes,
    status: 'OK',
  };
}

function mempoolTx(id: string, weight: number, rate: number, receiveTime = 1_700_000_000): IMoneroApi.MempoolEntry {
  return {
    id_hash: id.padStart(64, '0'),
    tx_json: '{}',
    blob_size: weight,
    weight,
    fee: weight * rate,
    receive_time: receiveTime,
    relayed: true,
    last_relayed_time: receiveTime,
    do_not_relay: false,
    double_spend_seen: false,
    kept_by_block: false,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeApi(
  firstHeader: IMoneroApi.BlockHeader,
  secondHeader: IMoneroApi.BlockHeader,
  txHashesByBlock: Record<string, string[]> = {},
  blockJsonByHash: Record<string, string> = {},
): MoneroApi {
  return {
    getInfo: jest.fn().mockResolvedValue({
      height: secondHeader.height + 1,
      target_height: secondHeader.height + 1,
      difficulty: secondHeader.difficulty,
      tx_pool_size: 0,
      tx_count: 0,
      nettype: 'mainnet',
      top_block_hash: secondHeader.hash,
      block_size_limit: 600_000,
      status: 'OK',
      untrusted: false,
    }),
    getFeeEstimate: jest.fn().mockResolvedValue({
      fee: 20_000,
      fees: [20_000, 80_000, 320_000, 4_000_000],
      quantization_mask: 10_000,
      status: 'OK',
      untrusted: false,
    }),
    getTransactionPool: jest.fn().mockResolvedValue({
      transactions: [],
      status: 'OK',
      untrusted: false,
    }),
    getBlockCount: jest.fn().mockResolvedValue(secondHeader.height + 1),
    getBlockByHeight: jest.fn((height: number) => Promise.resolve(blockFor(header(height)))),
    getBlockFeeStats: jest.fn().mockResolvedValue({
      totalFees: 0,
      medianFee: 0,
      minFee: 0,
      maxFee: 0,
      feeRange: [0, 0, 0, 0, 0, 0, 0],
      nTx: 0,
    }),
    getBlockByHash: jest.fn(async (hash: string) => {
      if (hash === firstHeader.hash) {
        await delay(40);
        return blockFor(firstHeader, txHashesByBlock[firstHeader.hash] ?? [], blockJsonByHash[firstHeader.hash]);
      }
      if (hash === secondHeader.hash) {
        return blockFor(secondHeader, txHashesByBlock[secondHeader.hash] ?? [], blockJsonByHash[secondHeader.hash]);
      }
      throw new Error(`unexpected block hash ${hash}`);
    }),
  } as unknown as MoneroApi;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function waitForBlockHeights(ws: WebSocket, count: number): Promise<number[]> {
  const heights: number[] = [];
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${count} block broadcasts`)), 1000);
    ws.on('message', (raw) => {
      const payload = JSON.parse(raw.toString()) as { block?: { height: number } };
      if (!payload.block) {
        return;
      }
      heights.push(payload.block.height);
      if (heights.length === count) {
        clearTimeout(timeout);
        resolve(heights);
      }
    });
  });
}

function waitForBlockPayload(ws: WebSocket): Promise<{ block: { height: number; extras?: Record<string, unknown> }; txConfirmed?: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for block broadcast')), 1000);
    ws.on('message', (raw) => {
      const payload = JSON.parse(raw.toString()) as { block?: { height: number; extras?: Record<string, unknown> }; txConfirmed?: string };
      if (!payload.block) {
        return;
      }
      clearTimeout(timeout);
      resolve(payload as { block: { height: number; extras?: Record<string, unknown> }; txConfirmed?: string });
    });
  });
}

describe('MoneroWs', () => {
  it('projects a sub-block Monero mempool as one next-block candidate', () => {
    const adapter = new MoneroWs({} as MoneroApi, new EventEmitter() as unknown as MoneroEventBus);
    const projector = adapter as unknown as {
      projectedMempoolBlocks(pool: IMoneroApi.TransactionPool): Array<{
        blockVSize: number;
        nTx: number;
        medianFee: number;
        feeRange: number[];
      }>;
    };

    const blocks = projector.projectedMempoolBlocks({
      transactions: [
        mempoolTx('1', 1_000, 20_000),
        mempoolTx('2', 1_500, 320_000),
        mempoolTx('3', 2_000, 80_000),
      ],
      status: 'OK',
      untrusted: false,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      blockVSize: 4_500,
      nTx: 3,
      medianFee: 80_000,
    });
    expect(blocks[0].feeRange[0]).toBe(20_000);
    expect(blocks[0].feeRange[blocks[0].feeRange.length - 1]).toBe(320_000);
  });

  it('only creates additional projected blocks when the pool exceeds one block weight', () => {
    const adapter = new MoneroWs({} as MoneroApi, new EventEmitter() as unknown as MoneroEventBus);
    const projector = adapter as unknown as {
      projectedMempoolBlocks(pool: IMoneroApi.TransactionPool): Array<{
        blockVSize: number;
        nTx: number;
      }>;
    };

    const blocks = projector.projectedMempoolBlocks({
      transactions: [
        mempoolTx('1', 400_000, 320_000),
        mempoolTx('2', 350_000, 80_000),
        mempoolTx('3', 100_000, 20_000),
      ],
      status: 'OK',
      untrusted: false,
    });

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ blockVSize: 400_000, nTx: 1 });
    expect(blocks[1]).toMatchObject({ blockVSize: 450_000, nTx: 2 });
  });

  it('derives recommended fees from live Monero mempool rates', () => {
    const recommendations = shapeXmrRecommendedFees({
      transactions: [
        mempoolTx('1', 1_000, 20_000),
        mempoolTx('2', 1_500, 80_000),
        mempoolTx('3', 2_000, 320_000),
      ],
      status: 'OK',
      untrusted: false,
    }, {
      fee: 20_000,
      fees: [20_000, 80_000, 320_000, 4_000_000],
      quantization_mask: 10_000,
      status: 'OK',
      untrusted: false,
    });

    expect(recommendations).toEqual({
      minimumFee: 20_000,
      economyFee: 20_000,
      hourFee: 80_000,
      halfHourFee: 320_000,
      fastestFee: 320_000,
    });
  });

  it('uses the daemon slow tier as the floor when the Monero mempool is empty', () => {
    const recommendations = shapeXmrRecommendedFees({
      transactions: [],
      status: 'OK',
      untrusted: false,
    }, {
      fee: 20_000,
      fees: [20_000, 80_000, 320_000, 4_000_000],
      quantization_mask: 10_000,
      status: 'OK',
      untrusted: false,
    });

    expect(recommendations).toEqual({
      minimumFee: 20_000,
      economyFee: 20_000,
      hourFee: 20_000,
      halfHourFee: 20_000,
      fastestFee: 20_000,
    });
  });

  it('serializes block broadcasts so slow RPC fetches cannot reorder tips', async () => {
    const firstHeader = header(101, 'a'.repeat(64));
    const secondHeader = header(102, 'b'.repeat(64));
    const api = makeApi(firstHeader, secondHeader);
    const bus = new EventEmitter() as unknown as MoneroEventBus;
    const server = createServer();
    const adapter = new MoneroWs(api, bus);
    adapter.attach(server);
    await listen(server);

    const { port } = server.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);

    try {
      await waitForOpen(client);
      const blocks = waitForBlockHeights(client, 2);

      bus.emit('block', firstHeader);
      bus.emit('block', secondHeader);

      await expect(blocks).resolves.toEqual([101, 102]);
    } finally {
      client.close();
      await new Promise<void>((resolve) => {
        (adapter as unknown as { wss?: WebSocketServer }).wss?.close(() => resolve());
        if (!(adapter as unknown as { wss?: WebSocketServer }).wss) resolve();
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('marks a tracked mempool transaction confirmed when a new block includes it', async () => {
    const txid = 'c'.repeat(64);
    const blockHeader = header(201, 'd'.repeat(64));
    const api = makeApi(
      blockHeader,
      blockHeader,
      { [blockHeader.hash]: [txid] },
      {
        [blockHeader.hash]: JSON.stringify({
          miner_tx: {
            extra: [
              0x01, ...Array.from({ length: 32 }, (_, i) => i + 1),
              0x03, 0x00, ...Array.from({ length: 32 }, (_, i) => 255 - i),
            ],
          },
          tx_hashes: [txid],
        }),
      },
    );
    const bus = new EventEmitter() as unknown as MoneroEventBus;
    const server = createServer();
    const adapter = new MoneroWs(api, bus);
    adapter.attach(server);
    await listen(server);

    const { port } = server.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);

    try {
      await waitForOpen(client);
      client.send(JSON.stringify({ 'track-tx': txid }));
      const block = waitForBlockPayload(client);

      bus.emit('block', blockHeader);

      await expect(block).resolves.toMatchObject({
        block: {
          height: 201,
          extras: {
            pool: {
              name: 'P2Pool',
              slug: 'p2pool',
            },
          },
        },
        txConfirmed: txid,
      });
    } finally {
      client.close();
      await new Promise<void>((resolve) => {
        (adapter as unknown as { wss?: WebSocketServer }).wss?.close(() => resolve());
        if (!(adapter as unknown as { wss?: WebSocketServer }).wss) resolve();
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
