import { Application, Request, Response } from 'express';
import { handleError } from '../../utils/api';
import { BlockSample, XmrChainIndexer } from './xmr-chain-indexer';
import { knownXmrMinerPools, unknownXmrMinerPool, XmrMinerPool } from './xmr-miner-fingerprint';
import { findStoredXmrPrice, XmrApiPrice } from './xmr-price';

/**
 * Mining/historical-graph REST surface, served from the in-memory
 * XmrChainIndexer. Mirrors the upstream mempool.space `/api/v1/mining/*`
 * URL shapes so the existing Angular graph components render without
 * retargeting their request signatures or response parsers.
 *
 * What's powered (what the Monero chain actually exposes):
 *   - blocks/fees           ← totalFees per block (xmrchain)
 *   - blocks/rewards        ← coinbase out per block (xmrchain)
 *   - blocks/fee-rates      ← per-tx fee/byte percentiles per block
 *   - blocks/sizes-weights  ← block size (weight == size on Monero)
 *   - hashrate              ← difficulty / 120
 *   - difficulty-adjustments→ rolling per-period difficulty deltas
 *
 * What's best-effort:
 *   - pools, hashrate/pools, pool/* — Monero has no canonical pool
 *     registry in blocks, but we can index visible miner-tx extra tags
 *     such as P2Pool merge-mining markers and clear-text pool labels.
 *     Anything unattributed is grouped into the Unknown bucket.
 *
 * Bitcoin block-health/prediction audit routes are not registered.
 * They require a Bitcoin template-selection audit model that has no
 * Monero equivalent and no active XMR frontend consumer.
 */

const PERIODS: Record<string, number> = {
  '24h':  1 * 24 * 60 * 60,
  '3d':   3 * 24 * 60 * 60,
  '1w':   7 * 24 * 60 * 60,
  '1m':  30 * 24 * 60 * 60,
  '3m':  90 * 24 * 60 * 60,
  '6m': 180 * 24 * 60 * 60,
  '1y': 365 * 24 * 60 * 60,
  '2y': 730 * 24 * 60 * 60,
  '3y':1095 * 24 * 60 * 60,
  'all': Number.MAX_SAFE_INTEGER,
};

// Target sample density per graph view. Aggregating to ~120 buckets
// keeps the chart readable without overwhelming echarts.
const TARGET_BUCKETS = 120;
const RECENT_POOL_FINGERPRINT_BLOCKS = 144;
const FIAT_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'CHF', 'AUD', 'JPY'] as const;
type FiatCurrency = typeof FIAT_CURRENCIES[number];
type FiatFields = Pick<XmrApiPrice, FiatCurrency>;

interface BlockFeeBucket {
  timestamp: number;
  avgHeight: number;
  value: {
    avgFees: number;
    avgRewards: number;
    avgSubsidy: number;
  };
}

interface PoolAccumulator {
  pool: XmrMinerPool;
  samples: BlockSample[];
}

interface MinerProofStats {
  verified: number;
  missing: number;
  unavailable: number;
  unknown: number;
  total: number;
}

export class XmrMiningRoutes {
  private poolRefreshInFlight: Promise<unknown> | null = null;

  constructor(
    private indexer: XmrChainIndexer,
    private prefix = '/api/v1/',
  ) {}

  public initRoutes(app: Application): void {
    const p = this.prefix;

    // Hashrate + difficulty time series — graphs/mining/hashrate-difficulty.
    app.get(p + 'mining/hashrate/pools/:period', (req, res) => this.hashratePools(req, res));
    app.get(p + 'mining/hashrate/pools', (req, res) => this.hashratePools(req, res));
    app.get(p + 'mining/hashrate/:period', (req, res) => this.hashrate(req, res));
    app.get(p + 'mining/hashrate', (req, res) => this.hashrate(req, res));

    // Per-block aggregates — one entry per time bucket.
    app.get(p + 'mining/blocks/fees/:period', (req, res) => void this.blockFees(req, res));
    app.get(p + 'mining/blocks/fees', (req, res) => void this.blockFees(req, res));
    app.get(p + 'mining/blocks/rewards/:period', (req, res) => void this.blockRewards(req, res));
    app.get(p + 'mining/blocks/rewards', (req, res) => void this.blockRewards(req, res));
    app.get(p + 'mining/blocks/fee-rates/:period', (req, res) => this.blockFeeRates(req, res));
    app.get(p + 'mining/blocks/sizes-weights/:period', (req, res) => this.blockSizesWeights(req, res));

    // Difficulty-adjustments table on graphs/mining/hashrate-difficulty.
    app.get(p + 'mining/difficulty-adjustments', (req, res) => this.difficultyAdjustments(req, res));
    app.get(p + 'mining/difficulty-adjustments/:period', (req, res) => this.difficultyAdjustments(req, res));

    // Mining-pool surface — best-effort attribution from indexed block samples.
    app.get(p + 'mining/pools/:period', (req, res) => void this.pools(req, res));
    app.get(p + 'mining/pools', (_req, res) => this.listPools(_req, res));
    app.get(p + 'mining/pool/:slug', (req, res) => void this.pool(req, res));
    app.get(p + 'mining/pool/:slug/hashrate', (req, res) => this.poolHashrate(req, res));
    app.get(p + 'mining/pool/:slug/blocks/:fromHeight', (req, res) => this.poolBlocks(req, res));
    app.get(p + 'mining/pool/:slug/blocks', (req, res) => this.poolBlocks(req, res));
    // Reward stats — dashboard widget over the latest indexed Monero blocks.
    app.get(p + 'mining/reward-stats/:blockCount', (req, res) => void this.rewardStats(req, res));
  }

  // ---- handlers ----

  private hashrate(req: Request, res: Response): void {
    try {
      const samples = this.windowFor(req);
      const stats = this.indexer.stats();
      const series = this.bucketAvg(samples, (s) => s.hashRate, 'hashRate');
      const diff = this.bucketAvg(samples, (s) => s.difficulty, 'difficulty');

      res.json({
        oldestIndexedBlockTimestamp: samples[0]?.timestamp ?? 0,
        currentHashrate: stats.currentHashRate || (samples.at(-1)?.hashRate ?? 0),
        currentDifficulty: stats.currentDifficulty || (samples.at(-1)?.difficulty ?? 0),
        hashrates: series.map((b) => ({
          timestamp: b.timestamp,
          avgHashrate: b.value,
          avgHeight: b.avgHeight,
        })),
        difficulty: diff.map((b) => ({
          timestamp: b.timestamp,
          difficulty: b.value,
          height: b.avgHeight,
          adjustment: 0,           // Monero retargets every block — adjustment is per-block only
        })),
      });
    } catch (err) {
      handleError(req, res, 500, err instanceof Error ? err.message : 'hashrate failed');
    }
  }

  private hashratePools(req: Request, res: Response): void {
    try {
      const samples = this.windowFor(req);
      res.set('x-total-count', String(samples.length));
      res.json(this.poolHashrateRows(samples));
    } catch (err) {
      handleError(req, res, 500, err instanceof Error ? err.message : 'pool hashrate failed');
    }
  }

  private async blockFees(req: Request, res: Response): Promise<void> {
    try {
      const samples = this.windowFor(req);
      const buckets = this.blockFeeBuckets(samples);
      const rows = await Promise.all(buckets.map(async (b) => ({
        timestamp: b.timestamp,
        avgFees: b.value.avgFees,
        avgRewards: b.value.avgRewards,
        avgSubsidy: b.value.avgSubsidy,
        avgHeight: b.avgHeight,
        ...await this.fiatForTimestamp(b.timestamp),
      })));
      res.set('x-total-count', String(rows.length));
      res.json(rows);
    } catch (err) {
      handleError(req, res, 500, err instanceof Error ? err.message : 'block fees failed');
    }
  }

  private async blockRewards(req: Request, res: Response): Promise<void> {
    try {
      const samples = this.windowFor(req);
      const buckets = this.bucketAvg(samples, (s) => s.reward, 'rewards');
      const rows = await Promise.all(buckets.map(async (b) => ({
        timestamp: b.timestamp,
        avgRewards: b.value,
        avgHeight: b.avgHeight,
        ...await this.fiatForTimestamp(b.timestamp),
      })));
      res.set('x-total-count', String(rows.length));
      res.json(rows);
    } catch (err) {
      handleError(req, res, 500, err instanceof Error ? err.message : 'block rewards failed');
    }
  }

  private blockFeeRates(req: Request, res: Response): void {
    const samples = this.windowFor(req);
    // Aggregate fee percentiles by averaging each percentile across
    // the bucket. Pre-computed percentiles per block are good enough —
    // we don't need to re-percentile across all txs in the window.
    const buckets = this.bucketGrouped(samples, (group) => ({
      avgFee_0:   avg(group.map((s) => s.feeP0)),
      avgFee_10:  avg(group.map((s) => s.feeP10)),
      avgFee_25:  avg(group.map((s) => s.feeP25)),
      avgFee_50:  avg(group.map((s) => s.feeP50)),
      avgFee_75:  avg(group.map((s) => s.feeP75)),
      avgFee_90:  avg(group.map((s) => s.feeP90)),
      avgFee_100: avg(group.map((s) => s.feeP100)),
    }));
    res.json(buckets.map((b) => ({
      timestamp: b.timestamp,
      avgHeight: b.avgHeight,
      ...b.value,
    })));
  }

  private blockSizesWeights(req: Request, res: Response): void {
    const samples = this.windowFor(req);
    // weight == size on Monero (no segwit). Upstream chart subtracts
    // weight/4 from size to plot a "discount" line — that line will be
    // flat at size*0.75 here, which is the honest reading.
    const sizes = this.bucketAvg(samples, (s) => s.size, 'size');
    res.json({
      sizes: sizes.map((b) => ({
        timestamp: b.timestamp,
        avgSize: b.value,
        avgHeight: b.avgHeight,
      })),
      weights: sizes.map((b) => ({
        timestamp: b.timestamp,
        avgWeight: b.value,
        avgHeight: b.avgHeight,
      })),
    });
  }

  private difficultyAdjustments(req: Request, res: Response): void {
    const samples = this.windowFor(req);
    // Each entry: [timestamp, height, difficulty, adjustment%].
    // Monero retargets every block, so each sample IS an adjustment.
    let prev: BlockSample | undefined;
    const out: [number, number, number, number][] = [];
    for (const s of samples) {
      const adj = prev && prev.difficulty > 0
        ? (s.difficulty - prev.difficulty) / prev.difficulty
        : 0;
      out.push([s.timestamp, s.height, s.difficulty, adj]);
      prev = s;
    }
    res.json(out);
  }

  private listPools(_req: Request, res: Response): void {
    const pools = this.catalogPools().map((pool) => this.poolTag(pool));
    res.set('x-total-count', String(pools.length));
    res.json(pools);
  }

  private async pools(req: Request, res: Response): Promise<void> {
    try {
      this.refreshRecentPoolFingerprints();
      const samples = this.windowFor(req);
      await this.indexer.hydrateMinerProofs(samples);
      const rows = this.poolSummaryRows(samples);
      const knownBlockCount = rows
        .filter((row) => row.poolUniqueId !== 0)
        .reduce((sum, row) => sum + Number(row.blockCount), 0);

      res.header('Pragma', 'public');
      res.header('Cache-control', 'public');
      res.header('X-total-count', String(samples.length));
      res.setHeader('Expires', new Date(Date.now() + 1000 * 60).toUTCString());
      res.json({
        blockCount: samples.length,
        knownBlockCount,
        unknownBlockCount: Math.max(0, samples.length - knownBlockCount),
        oldestIndexedBlockTimestamp: samples[0]?.timestamp ?? 0,
        lastEstimatedHashrate: this.networkHashrateForPeriod('24h'),
        lastEstimatedHashrate3d: this.networkHashrateForPeriod('3d'),
        lastEstimatedHashrate1w: this.networkHashrateForPeriod('1w'),
        proofStats: this.proofStats(samples),
        pools: rows,
      });
    } catch (err) {
      handleError(req, res, 500, err instanceof Error ? err.message : 'mining pools failed');
    }
  }

  private async pool(req: Request, res: Response): Promise<void> {
    try {
      this.refreshRecentPoolFingerprints();
      const slug = String(req.params['slug'] ?? '').toLowerCase();
      await this.indexer.hydrateMinerProofs(this.indexer.allSamples().slice(-RECENT_POOL_FINGERPRINT_BLOCKS));
      const pool = this.poolBySlug(slug);
      if (!pool) {
        handleError(req, res, 404, 'This mining pool does not exist');
        return;
      }

      const allSamples = this.indexer.allSamples();
      const daySamples = this.samplesForPeriod('24h');
      const weekSamples = this.samplesForPeriod('1w');
      const poolAll = this.samplesForPool(allSamples, slug);
      const poolDay = this.samplesForPool(daySamples, slug);
      const poolWeek = this.samplesForPool(weekSamples, slug);
      const dayShare = ratio(poolDay.length, daySamples.length);

      res.header('Pragma', 'public');
      res.header('Cache-control', 'public');
      res.setHeader('Expires', new Date(Date.now() + 1000 * 60).toUTCString());
      res.json({
        pool: this.poolTag(pool, poolAll.filter((sample) => sample.numTxs === 0).length),
        blockCount: {
          all: poolAll.length,
          '24h': poolDay.length,
          '1w': poolWeek.length,
        },
        blockShare: {
          all: ratio(poolAll.length, allSamples.length),
          '24h': dayShare,
          '1w': ratio(poolWeek.length, weekSamples.length),
        },
        estimatedHashrate: this.networkHashrateForPeriod('24h') * dayShare,
        reportedHashrate: null,
        avgBlockHealth: null,
        totalReward: poolAll.reduce((sum, sample) => sum + sample.reward, 0),
        proofStats: this.proofStats(poolAll),
      });
    } catch (err) {
      handleError(req, res, 500, err instanceof Error ? err.message : 'mining pool failed');
    }
  }

  private poolHashrate(req: Request, res: Response): void {
    try {
      this.refreshRecentPoolFingerprints();
      const slug = String(req.params['slug'] ?? '').toLowerCase();
      const pool = this.poolBySlug(slug);
      if (!pool) {
        handleError(req, res, 404, 'This mining pool does not exist');
        return;
      }

      const samples = this.indexer.allSamples();
      const rows = this.bucketGrouped(samples, (group) => {
        const poolSamples = this.samplesForPool(group, slug);
        const share = ratio(poolSamples.length, group.length);
        return {
          avgHashRate: avg(group.map((sample) => sample.hashRate)) * share,
          avgHashrate: avg(group.map((sample) => sample.hashRate)) * share,
          share,
        };
      });

      res.header('Pragma', 'public');
      res.header('Cache-control', 'public');
      res.header('X-total-count', String(samples.length));
      res.setHeader('Expires', new Date(Date.now() + 1000 * 60).toUTCString());
      res.json(rows.map((row) => ({
        timestamp: row.timestamp,
        avgHeight: row.avgHeight,
        poolName: this.poolDisplayName(pool),
        poolSlug: pool.slug,
        ...row.value,
      })));
    } catch (err) {
      handleError(req, res, 500, err instanceof Error ? err.message : 'mining pool hashrate failed');
    }
  }

  private async poolBlocks(req: Request, res: Response): Promise<void> {
    try {
      this.refreshRecentPoolFingerprints();
      const slug = String(req.params['slug'] ?? '').toLowerCase();
      await this.indexer.hydrateMinerProofs(this.indexer.allSamples().slice(-RECENT_POOL_FINGERPRINT_BLOCKS));
      const pool = this.poolBySlug(slug);
      if (!pool) {
        handleError(req, res, 404, 'This mining pool does not exist');
        return;
      }

      const fromHeight = Number(req.params['fromHeight']);
      const poolSamples = this.samplesForPool(this.indexer.allSamples(), slug)
        .sort((a, b) => b.height - a.height);
      const page = poolSamples
        .filter((sample) => !Number.isFinite(fromHeight) || sample.height < fromHeight)
        .slice(0, 15);

      res.header('Pragma', 'public');
      res.header('Cache-control', 'public');
      res.header('X-total-count', String(poolSamples.length));
      res.setHeader('Expires', new Date(Date.now() + 1000 * 60).toUTCString());
      res.json(page.map((sample) => this.poolBlockRow(sample)));
    } catch (err) {
      handleError(req, res, 500, err instanceof Error ? err.message : 'mining pool blocks failed');
    }
  }

  private async rewardStats(req: Request, res: Response): Promise<void> {
    try {
      const requested = Number(req.params['blockCount']);
      const blockCount = Number.isFinite(requested)
        ? Math.max(1, Math.min(1_000, Math.floor(requested)))
        : 144;
      const samples = await this.indexer.recentSamples(blockCount);

      if (!samples.length) {
        res.json({
          startBlock: 0,
          endBlock: 0,
          blockCount: 0,
          totalReward: 0,
          totalFee: 0,
          totalTx: 0,
        });
        return;
      }

      res.json({
        startBlock: samples[0].height,
        endBlock: samples[samples.length - 1].height,
        blockCount: samples.length,
        totalReward: samples.reduce((sum, sample) => sum + sample.reward, 0),
        totalFee: samples.reduce((sum, sample) => sum + sample.totalFees, 0),
        totalTx: samples.reduce((sum, sample) => sum + sample.numTxs, 0),
      });
    } catch (err) {
      handleError(req, res, 500, err instanceof Error ? err.message : 'reward stats failed');
    }
  }

  // ---- helpers ----

  private windowFor(req: Request): BlockSample[] {
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (Number.isFinite(from) && Number.isFinite(to) && from > 0 && to >= from) {
      return this.indexer.samplesBetween(from, to);
    }
    const period = req.params['period'] ?? '24h';
    const seconds = PERIODS[period] ?? PERIODS['24h'];
    const now = Math.floor(Date.now() / 1000);
    return this.indexer.samplesBetween(now - seconds, now);
  }

  private samplesForPeriod(period: string): BlockSample[] {
    if (period === 'all') {
      return this.indexer.allSamples();
    }
    const seconds = PERIODS[period] ?? PERIODS['24h'];
    const now = Math.floor(Date.now() / 1000);
    return this.indexer.samplesBetween(now - seconds, now);
  }

  private refreshRecentPoolFingerprints(): void {
    if (this.poolRefreshInFlight) return;
    this.poolRefreshInFlight = this.indexer
      .recentSamples(RECENT_POOL_FINGERPRINT_BLOCKS, { includePool: true })
      .catch(() => [])
      .finally(() => {
        this.poolRefreshInFlight = null;
      });
  }

  private poolSummaryRows(samples: BlockSample[]): Array<Record<string, unknown>> {
    const total = samples.length;
    return this.poolAccumulators(samples).map((acc, index) => {
      const emptyBlocks = acc.samples.filter((sample) => sample.numTxs === 0).length;
      const proofStats = this.proofStats(acc.samples);
      return {
        poolId: acc.pool.id,
        name: this.poolDisplayName(acc.pool),
        link: '',
        blockCount: acc.samples.length,
        rank: index + 1,
        emptyBlocks,
        slug: acc.pool.slug,
        avgMatchRate: null,
        avgFeeDelta: null,
        poolUniqueId: acc.pool.id,
        unique_id: acc.pool.id,
        share: Number((ratio(acc.samples.length, total) * 100).toFixed(2)),
        emptyBlockRatio: (ratio(emptyBlocks, acc.samples.length) * 100).toFixed(2),
        proofStats,
        proofVerifiedBlockCount: proofStats.verified,
        proofMissingBlockCount: proofStats.missing,
        proofUnavailableBlockCount: proofStats.unavailable,
        proofUnknownBlockCount: proofStats.unknown,
      };
    });
  }

  private poolHashrateRows(samples: BlockSample[]): Array<Record<string, number | string>> {
    return this.bucketGrouped(samples, (group) => group).flatMap((bucket) => {
      const networkHashrate = avg(bucket.value.map((sample) => sample.hashRate));
      return this.poolAccumulators(bucket.value).map((acc) => {
        const share = ratio(acc.samples.length, bucket.value.length);
        const poolHashrate = networkHashrate * share;
        return {
          timestamp: bucket.timestamp,
          avgHashRate: poolHashrate,
          avgHashrate: poolHashrate,
          share,
          poolName: this.poolDisplayName(acc.pool),
          poolSlug: acc.pool.slug,
        };
      });
    });
  }

  private poolAccumulators(samples: BlockSample[]): PoolAccumulator[] {
    const grouped = new Map<string, PoolAccumulator>();
    for (const sample of samples) {
      const pool = this.poolFromSample(sample);
      const acc = grouped.get(pool.slug) ?? { pool, samples: [] };
      acc.samples.push(sample);
      grouped.set(pool.slug, acc);
    }
    return [...grouped.values()].sort((a, b) => {
      const byBlocks = b.samples.length - a.samples.length;
      return byBlocks || this.poolDisplayName(a.pool).localeCompare(this.poolDisplayName(b.pool));
    });
  }

  private samplesForPool(samples: BlockSample[], slug: string): BlockSample[] {
    return samples.filter((sample) => this.poolFromSample(sample).slug === slug);
  }

  private networkHashrateForPeriod(period: string): number {
    const samples = this.samplesForPeriod(period);
    return avg(samples.map((sample) => sample.hashRate)) || this.indexer.stats().currentHashRate || 0;
  }

  private poolFromSample(sample: BlockSample): XmrMinerPool {
    if (sample.poolSlug && typeof sample.poolId === 'number') {
      return {
        id: sample.poolId,
        name: sample.poolName ?? sample.poolSlug,
        slug: sample.poolSlug,
        minerNames: sample.poolMinerNames ?? [],
      };
    }
    return unknownXmrMinerPool();
  }

  private catalogPools(): XmrMinerPool[] {
    const pools = new Map<string, XmrMinerPool>();
    for (const pool of [unknownXmrMinerPool(), ...knownXmrMinerPools()]) {
      pools.set(pool.slug, pool);
    }
    for (const sample of this.indexer.allSamples()) {
      const pool = this.poolFromSample(sample);
      pools.set(pool.slug, pool);
    }
    return [...pools.values()].sort((a, b) => a.id - b.id);
  }

  private poolBySlug(slug: string): XmrMinerPool | null {
    return this.catalogPools().find((pool) => pool.slug === slug) ?? null;
  }

  private poolTag(pool: XmrMinerPool, emptyBlocks = 0): Record<string, number | string | string[]> {
    return {
      id: pool.id,
      poolId: pool.id,
      unique_id: pool.id,
      uniqueId: pool.id,
      poolUniqueId: pool.id,
      name: this.poolDisplayName(pool),
      link: '',
      regexes: pool.minerNames,
      addresses: [],
      emptyBlocks,
      slug: pool.slug,
    };
  }

  private poolDisplayName(pool: XmrMinerPool): string {
    return pool.id === 0 ? 'Unknown' : pool.name;
  }

  private poolBlockRow(sample: BlockSample): Record<string, unknown> {
    const pool = this.poolFromSample(sample);
    const extras: Record<string, unknown> = {
      reward: sample.reward,
      totalFees: sample.totalFees,
      pool: {
        id: pool.id,
        name: this.poolDisplayName(pool),
        slug: pool.slug,
        minerNames: pool.minerNames,
        logo: `/resources/mining-pools/${pool.slug}.svg`,
      },
    };
    if (sample.minerProof) {
      extras.minerProof = sample.minerProof;
    }
    return {
      id: sample.hash,
      height: sample.height,
      version: 0,
      timestamp: sample.timestamp,
      bits: 0,
      nonce: 0,
      difficulty: sample.difficulty,
      merkle_root: '',
      tx_count: sample.numTxs,
      size: sample.size,
      weight: sample.size,
      previousblockhash: '',
      extras,
    };
  }

  private proofStats(samples: BlockSample[]): MinerProofStats {
    return samples.reduce<MinerProofStats>((stats, sample) => {
      const status = sample.minerProof?.status ?? 'unknown';
      stats[status] += 1;
      stats.total += 1;
      return stats;
    }, { verified: 0, missing: 0, unavailable: 0, unknown: 0, total: 0 });
  }

  /** Bucket samples into ~TARGET_BUCKETS time bins and average a single field. */
  private bucketAvg(samples: BlockSample[], pick: (s: BlockSample) => number, _field: string): { timestamp: number; value: number; avgHeight: number }[] {
    return this.bucketGrouped(samples, (group) => avg(group.map(pick))).map((b) => ({
      timestamp: b.timestamp,
      value: b.value as number,
      avgHeight: b.avgHeight,
    }));
  }

  private blockFeeBuckets(samples: BlockSample[]): BlockFeeBucket[] {
    return this.bucketGrouped(samples, (group) => {
      const avgFees = avg(group.map((s) => s.totalFees));
      const avgRewards = avg(group.map((s) => s.reward));
      return {
        avgFees,
        avgRewards,
        avgSubsidy: Math.max(0, avgRewards - avgFees),
      };
    });
  }

  private async fiatForTimestamp(timestamp: number): Promise<FiatFields> {
    const price = await findStoredXmrPrice(timestamp);
    return FIAT_CURRENCIES.reduce((fields, currency) => ({
      ...fields,
      [currency]: price?.[currency] && price[currency] > 0 ? price[currency] : 0,
    }), {} as FiatFields);
  }

  /** Same as bucketAvg but the reducer can produce an arbitrary object. */
  private bucketGrouped<T>(samples: BlockSample[], reduce: (group: BlockSample[]) => T): { timestamp: number; avgHeight: number; value: T }[] {
    if (!samples.length) return [];
    const tFrom = samples[0].timestamp;
    const tTo = samples[samples.length - 1].timestamp;
    const span = Math.max(1, tTo - tFrom);
    const bucketSize = Math.max(60, Math.ceil(span / TARGET_BUCKETS));

    const buckets = new Map<number, BlockSample[]>();
    for (const s of samples) {
      const key = Math.floor((s.timestamp - tFrom) / bucketSize);
      const arr = buckets.get(key) ?? [];
      arr.push(s);
      buckets.set(key, arr);
    }
    const out: { timestamp: number; avgHeight: number; value: T }[] = [];
    for (const [key, group] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      out.push({
        timestamp: tFrom + key * bucketSize + Math.floor(bucketSize / 2),
        avgHeight: Math.round(avg(group.map((g) => g.height))),
        value: reduce(group),
      });
    }
    return out;
  }
}

function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ratio(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}
