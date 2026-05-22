import express from 'express';
import { createServer, request as httpRequest, Server } from 'http';
import { AddressInfo } from 'net';
import { XmrMiningRoutes } from '../xmr-mining.routes';
import { BlockSample, XmrChainIndexer } from '../xmr-chain-indexer';
import { setXmrPriceStoreForTests, XmrApiPrice, XmrPriceStore } from '../xmr-price';
import { XmrMinerProof } from '../xmr-miner-proof-registry';

function xmrPrice(time: number, usd: number): XmrApiPrice {
  return {
    time,
    USD: usd,
    EUR: usd * 0.9,
    GBP: usd * 0.8,
    CAD: usd * 1.35,
    CHF: usd * 0.88,
    AUD: usd * 1.5,
    JPY: usd * 150,
  };
}

class MemoryXmrPriceStore implements XmrPriceStore {
  constructor(private prices: XmrApiPrice[]) {}

  public describe(): string {
    return 'memory';
  }

  public async loadAll(): Promise<XmrApiPrice[]> {
    return this.prices;
  }

  public async findNearest(timestamp: number, toleranceSeconds: number): Promise<XmrApiPrice | null> {
    const best = this.prices.reduce<XmrApiPrice | null>((closest, candidate) => {
      if (!closest || Math.abs(candidate.time - timestamp) < Math.abs(closest.time - timestamp)) {
        return candidate;
      }
      return closest;
    }, null);
    return best && Math.abs(best.time - timestamp) <= toleranceSeconds ? best : null;
  }

  public async saveMany(): Promise<void> {}
}

function sample(
  height: number,
  timestamp: number,
  totalFees: number,
  reward: number,
  options: {
    numTxs?: number;
    pool?: {
      id: number;
      name: string;
      slug: string;
      minerNames?: string[];
    };
    minerProof?: XmrMinerProof;
  } = {},
): BlockSample {
  return {
    height,
    timestamp,
    hash: String(height).padStart(64, '0'),
    size: 120_000,
    numTxs: options.numTxs ?? 10,
    totalFees,
    reward,
    feeP0: 1,
    feeP10: 2,
    feeP25: 3,
    feeP50: 4,
    feeP75: 5,
    feeP90: 6,
    feeP100: 7,
    difficulty: 100,
    hashRate: 100 / 120,
    ...(options.pool ? {
      poolId: options.pool.id,
      poolName: options.pool.name,
      poolSlug: options.pool.slug,
      poolMinerNames: options.pool.minerNames ?? [options.pool.name],
      poolFingerprinted: true,
    } : {}),
    ...(options.minerProof ? {
      minerProof: options.minerProof,
    } : {}),
  };
}

function makeServer(samples: BlockSample[]): Promise<Server> {
  const app = express();
  const indexer = {
    samplesBetween: jest.fn((from: number, to: number) => samples.filter((entry) => entry.timestamp >= from && entry.timestamp <= to)),
    allSamples: jest.fn(() => samples.slice().sort((a, b) => a.height - b.height)),
    recentSamples: jest.fn(async (count: number) => samples.slice().sort((a, b) => a.height - b.height).slice(-count)),
    hydrateMinerProofs: jest.fn(async () => undefined),
    stats: jest.fn(() => ({ currentHashRate: 0, currentDifficulty: 0 })),
  } as unknown as XmrChainIndexer;
  new XmrMiningRoutes(indexer).initRoutes(app);
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function getJson<T = unknown>(server: Server, path: string): Promise<{ status: number; json: T; headers: Record<string, string | string[] | undefined> }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          json: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T,
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function getRaw(server: Server, path: string): Promise<{ status: number; text: string }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('XmrMiningRoutes price enrichment', () => {
  let server: Server | null = null;

  afterEach((done) => {
    setXmrPriceStoreForTests(null);
    if (!server) {
      done();
      return;
    }
    server.close(() => {
      server = null;
      done();
    });
  });

  it('adds stored fiat prices, rewards, and derived subsidy to block fee buckets', async () => {
    server = await makeServer([
      sample(100, 1_000, 40_000_000_000, 640_000_000_000),
      sample(101, 4_600, 60_000_000_000, 660_000_000_000),
    ]);
    setXmrPriceStoreForTests(new MemoryXmrPriceStore([
      xmrPrice(1_030, 150),
      xmrPrice(4_630, 160),
    ]));

    const response = await getJson<Array<Record<string, number>>>(
      server,
      '/api/v1/mining/blocks/fees?from=900&to=4700',
    );

    expect(response.status).toBe(200);
    expect(response.headers['x-total-count']).toBe('2');
    expect(response.json).toHaveLength(2);
    expect(response.json[0]).toMatchObject({
      avgHeight: 100,
      avgFees: 40_000_000_000,
      avgRewards: 640_000_000_000,
      avgSubsidy: 600_000_000_000,
      USD: 150,
      EUR: 135,
    });
    expect(response.json[1]).toMatchObject({
      avgHeight: 101,
      avgFees: 60_000_000_000,
      avgRewards: 660_000_000_000,
      avgSubsidy: 600_000_000_000,
      USD: 160,
    });
  });

  it('adds stored fiat prices to block reward buckets', async () => {
    server = await makeServer([
      sample(100, 1_000, 40_000_000_000, 640_000_000_000),
    ]);
    setXmrPriceStoreForTests(new MemoryXmrPriceStore([
      xmrPrice(1_030, 150),
    ]));

    const response = await getJson<Array<Record<string, number>>>(
      server,
      '/api/v1/mining/blocks/rewards?from=900&to=1100',
    );

    expect(response.status).toBe(200);
    expect(response.headers['x-total-count']).toBe('1');
    expect(response.json).toEqual([expect.objectContaining({
      avgHeight: 100,
      avgRewards: 640_000_000_000,
      USD: 150,
      JPY: 22_500,
    })]);
  });

  it('does not expose the Bitcoin block-health prediction route', async () => {
    server = await makeServer([]);

    expect((await getRaw(server, '/api/v1/mining/blocks/predictions')).status).toBe(404);
    expect((await getRaw(server, '/api/v1/mining/blocks/predictions/1w')).status).toBe(404);
  });

  it('serves reward stats from the exact recent Monero block window', async () => {
    server = await makeServer([
      sample(100, 1_000, 40_000_000_000, 640_000_000_000),
      sample(101, 4_600, 60_000_000_000, 660_000_000_000),
      sample(102, 8_200, 70_000_000_000, 670_000_000_000),
    ]);

    const response = await getJson<Record<string, number>>(
      server,
      '/api/v1/mining/reward-stats/2',
    );

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      startBlock: 101,
      endBlock: 102,
      blockCount: 2,
      totalReward: 1_330_000_000_000,
      totalFee: 130_000_000_000,
      totalTx: 20,
    });
  });

  it('serves best-effort mining pool stats from indexed Monero samples', async () => {
    const now = Math.floor(Date.now() / 1000);
    const p2pool = { id: 1, name: 'P2Pool', slug: 'p2pool', minerNames: ['P2Pool'] };
    const verifiedProof: XmrMinerProof = {
      status: 'verified',
      type: 'viewkey',
      source: 'blocks.p2pool.observer',
      sourceName: 'blocks.p2pool.observer',
      sourceUrl: 'https://blocks.p2pool.observer/block/' + String(100).padStart(64, '0'),
      registryUrl: 'https://blocks.p2pool.observer/proofs',
      blockHash: String(100).padStart(64, '0'),
      height: 100,
      poolName: 'P2Pool',
      poolSlug: 'p2pool',
      poolId: 1,
    };
    const missingProof: XmrMinerProof = {
      status: 'missing',
      source: 'blocks.p2pool.observer',
      sourceName: 'blocks.p2pool.observer',
      sourceUrl: 'https://blocks.p2pool.observer/block/' + String(101).padStart(64, '0'),
      registryUrl: 'https://blocks.p2pool.observer/proofs',
      blockHash: String(101).padStart(64, '0'),
      height: 101,
      poolName: 'P2Pool',
      poolSlug: 'p2pool',
      poolId: 1,
    };
    server = await makeServer([
      sample(100, now - 300, 40_000_000_000, 640_000_000_000, { pool: p2pool, minerProof: verifiedProof }),
      sample(101, now - 200, 60_000_000_000, 660_000_000_000, { pool: p2pool, numTxs: 0, minerProof: missingProof }),
      sample(102, now - 100, 70_000_000_000, 670_000_000_000),
    ]);

    const response = await getJson<{
      blockCount: number;
      knownBlockCount: number;
      unknownBlockCount: number;
      lastEstimatedHashrate: number;
      pools: Array<Record<string, unknown>>;
    }>(server, '/api/v1/mining/pools/24h');

    expect(response.status).toBe(200);
    expect(response.headers['x-total-count']).toBe('3');
    expect(response.json.blockCount).toBe(3);
    expect(response.json.knownBlockCount).toBe(2);
    expect(response.json.unknownBlockCount).toBe(1);
    expect(response.json.lastEstimatedHashrate).toBeGreaterThan(0);
    expect(response.json.pools.find((pool) => pool.slug === 'p2pool')).toMatchObject({
      poolId: 1,
      poolUniqueId: 1,
      name: 'P2Pool',
      blockCount: 2,
      emptyBlocks: 1,
      rank: 1,
      share: 66.67,
      emptyBlockRatio: '50.00',
      proofVerifiedBlockCount: 1,
      proofMissingBlockCount: 1,
    });
    expect(response.json.pools.find((pool) => pool.slug === 'unknown')).toMatchObject({
      poolUniqueId: 0,
      name: 'Unknown',
      blockCount: 1,
    });

    const poolResponse = await getJson<any>(server, '/api/v1/mining/pool/p2pool');
    expect(poolResponse.status).toBe(200);
    expect(poolResponse.json.pool).toMatchObject({
      id: 1,
      unique_id: 1,
      name: 'P2Pool',
      slug: 'p2pool',
      regexes: ['P2Pool'],
    });
    expect(poolResponse.json.blockCount).toEqual({ all: 2, '24h': 2, '1w': 2 });
    expect(poolResponse.json.blockShare['24h']).toBeCloseTo(2 / 3);
    expect(poolResponse.json.estimatedHashrate).toBeGreaterThan(0);
    expect(poolResponse.json.totalReward).toBe(1_300_000_000_000);
    expect(poolResponse.json.proofStats).toEqual({
      verified: 1,
      missing: 1,
      unavailable: 0,
      unknown: 0,
      total: 2,
    });

    const poolHashrateResponse = await getJson<Array<Record<string, number | string>>>(
      server,
      '/api/v1/mining/pool/p2pool/hashrate',
    );
    expect(poolHashrateResponse.status).toBe(200);
    expect(poolHashrateResponse.headers['x-total-count']).toBe('3');
    expect(poolHashrateResponse.json).toEqual(expect.arrayContaining([
      expect.objectContaining({
        poolName: 'P2Pool',
        poolSlug: 'p2pool',
      }),
    ]));
    expect(poolHashrateResponse.json.some((row) => Number(row.avgHashrate) > 0)).toBe(true);

    const poolBlocksResponse = await getJson<any[]>(
      server,
      '/api/v1/mining/pool/p2pool/blocks',
    );
    expect(poolBlocksResponse.status).toBe(200);
    expect(poolBlocksResponse.headers['x-total-count']).toBe('2');
    expect(poolBlocksResponse.json.map((block) => block.height)).toEqual([101, 100]);
    expect(poolBlocksResponse.json[0]).toMatchObject({
      id: String(101).padStart(64, '0'),
      weight: 120_000,
      extras: {
        reward: 660_000_000_000,
        totalFees: 60_000_000_000,
        pool: {
          id: 1,
          name: 'P2Pool',
          slug: 'p2pool',
        },
        minerProof: missingProof,
      },
    });
    const pagedPoolBlocksResponse = await getJson<any[]>(
      server,
      '/api/v1/mining/pool/p2pool/blocks/101',
    );
    expect(pagedPoolBlocksResponse.status).toBe(200);
    expect(pagedPoolBlocksResponse.json.map((block) => block.height)).toEqual([100]);

    const unknownResponse = await getJson<any>(server, '/api/v1/mining/pool/unknown');
    expect(unknownResponse.status).toBe(200);
    expect(unknownResponse.json.pool).toMatchObject({
      unique_id: 0,
      name: 'Unknown',
      slug: 'unknown',
    });
    expect(unknownResponse.json.blockCount['24h']).toBe(1);

    const hashrateResponse = await getJson<Array<Record<string, number | string>>>(
      server,
      '/api/v1/mining/hashrate/pools/24h',
    );
    expect(hashrateResponse.status).toBe(200);
    expect(hashrateResponse.headers['x-total-count']).toBe('3');
    const p2poolHashrateRow = hashrateResponse.json.find((row) => row.poolSlug === 'p2pool');
    expect(p2poolHashrateRow).toMatchObject({ poolName: 'P2Pool' });
    expect(Number(p2poolHashrateRow?.share)).toBeGreaterThan(0);
    expect(Number(p2poolHashrateRow?.avgHashrate)).toBeGreaterThan(0);
  });
});
