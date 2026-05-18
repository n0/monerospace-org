import { Application, Request, Response } from 'express';
import { promises as fs } from 'fs';
import { RowDataPacket } from 'mysql2/typings/mysql';
import os from 'os';
import path from 'path';
import config from '../../config';
import database from '../../database';
import logger from '../../logger';
import { MoneroEventBus } from './monero-event-bus';
import { IMoneroApi } from './monero-api.interface';
import { MoneroApi } from './monero-api';

/**
 * Rolling mempool-stats time series for the Incoming Transactions chart.
 * Upstream's frontend hits `/api/v1/statistics/{2h,24h,1w}` and expects an
 * `OptimizedMempoolStats[]` (one entry per minute, cumulative).
 *
 * We sample every 5s from the event bus's polled state. 5s × 12 = 1
 * sample per minute aggregated → 60 samples/h → 120 samples for 2h,
 * 1440 for 24h, 10080 for 1w. We hold 1w of 1-minute samples (~80 KB)
 * and downsample on query for the longer windows.
 *
 * vbytes_per_second is computed from the running delta in mempool weight
 * since the previous sample (positive = inflow, clipped at 0).
 *
 * Samples persist to MySQL when the production database is enabled,
 * with a JSON-file fallback for development and DB outages. First boot
 * is still honest: it starts with one live sample and fills naturally
 * from there.
 */

export interface OptimizedMempoolStats {
  added: number;            // unix seconds
  count: number;
  vbytes_per_second: number;
  total_fee: number;
  mempool_byte_weight: number;
  vsizes: number[];         // 38-bucket histogram (matches upstream)
}

const MAX_SAMPLES = 60 * 24 * 7;            // 1w at 1 sample/min
const VSIZE_BUCKETS = 38;                   // upstream count
const SAMPLE_INTERVAL_MS = 60_000;          // 1 minute (matches upstream)
const DEFAULT_PERSIST_DIR = process.env.XMR_INDEX_DIR ?? path.join(os.homedir(), '.xmr-space');
const DEFAULT_PERSIST_FILE = process.env.XMR_STATS_FILE ?? path.join(DEFAULT_PERSIST_DIR, 'mempool-stats.json');
const DB_TABLE = 'xmr_mempool_stats';

/**
 * Fee-rate buckets matching the frontend `feeLevels` array
 * (app.constants.ts). Upstream's mempool-graph stacks vbytes by fee
 * rate so each band represents "how much byte weight is sitting at
 * roughly this fee rate". For Monero we use atomic/byte rates: slow
 * 20k → bucket 5, normal 80k → 12, fast 320k → 19, fastest 4M → 35.
 *
 * Must stay in lock-step with frontend/src/app/app.constants.ts:feeLevels.
 */
const FEE_LEVELS = [
  0, 1_000, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 40_000, 50_000,
  60_000, 70_000, 80_000, 90_000, 100_000, 120_000, 150_000, 200_000, 250_000, 300_000,
  350_000, 400_000, 500_000, 600_000, 700_000, 800_000, 900_000, 1_000_000, 1_200_000, 1_500_000,
  1_800_000, 2_000_000, 2_500_000, 3_000_000, 3_500_000, 4_000_000, 4_500_000, 5_000_000, 6_000_000,
];

function feeRateBucket(feePerByte: number): number {
  // Bucket = first index where feeLevels[i] > rate, minus 1.
  for (let i = FEE_LEVELS.length - 1; i >= 0; i--) {
    if (feePerByte >= FEE_LEVELS[i]) {
      return Math.min(VSIZE_BUCKETS - 1, i);
    }
  }
  return 0;
}

export interface MoneroStatsStore {
  describe(): string;
  load(cutoffSeconds: number, maxSamples: number): Promise<OptimizedMempoolStats[]>;
  save(sample: OptimizedMempoolStats, samples: OptimizedMempoolStats[], cutoffSeconds: number): Promise<void>;
}

class FileMoneroStatsStore implements MoneroStatsStore {
  constructor(private persistFile: string) {}

  public describe(): string {
    return this.persistFile;
  }

  public async load(): Promise<OptimizedMempoolStats[]> {
    const raw = await fs.readFile(this.persistFile, 'utf-8');
    const parsed = JSON.parse(raw) as { samples?: OptimizedMempoolStats[] };
    return parsed.samples ?? [];
  }

  public async save(_sample: OptimizedMempoolStats, samples: OptimizedMempoolStats[]): Promise<void> {
    await fs.mkdir(path.dirname(this.persistFile), { recursive: true });
    const tmp = this.persistFile + '.tmp';
    await fs.writeFile(tmp, JSON.stringify({
      version: 1,
      savedAt: Math.floor(Date.now() / 1000),
      samples,
    }));
    await fs.rename(tmp, this.persistFile);
  }
}

interface MoneroStatsRow extends RowDataPacket {
  added: number;
  tx_count: number;
  vbytes_per_second: number;
  total_fee: number;
  mempool_byte_weight: number;
  vsizes: string;
}

class MysqlMoneroStatsStore implements MoneroStatsStore {
  private initialized = false;

  public describe(): string {
    return `mysql:${DB_TABLE}`;
  }

  public async load(cutoffSeconds: number, maxSamples: number): Promise<OptimizedMempoolStats[]> {
    await this.ensureTable();
    const [rows] = await database.query<MoneroStatsRow[]>(`
      SELECT added, tx_count, vbytes_per_second, total_fee, mempool_byte_weight, vsizes
      FROM ${this.table()}
      WHERE added >= ?
      ORDER BY added ASC
      LIMIT ?
    `, [cutoffSeconds, maxSamples], 'warn');

    return rows.map((row) => ({
      added: Number(row.added),
      count: Number(row.tx_count),
      vbytes_per_second: Number(row.vbytes_per_second),
      total_fee: Number(row.total_fee),
      mempool_byte_weight: Number(row.mempool_byte_weight),
      vsizes: this.parseVsizes(row.vsizes),
    }));
  }

  public async save(sample: OptimizedMempoolStats, _samples: OptimizedMempoolStats[], cutoffSeconds: number): Promise<void> {
    await this.ensureTable();
    await database.query(`
      INSERT INTO ${this.table()} (added, tx_count, vbytes_per_second, total_fee, mempool_byte_weight, vsizes)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        tx_count = VALUES(tx_count),
        vbytes_per_second = VALUES(vbytes_per_second),
        total_fee = VALUES(total_fee),
        mempool_byte_weight = VALUES(mempool_byte_weight),
        vsizes = VALUES(vsizes)
    `, [
      sample.added,
      sample.count,
      sample.vbytes_per_second,
      sample.total_fee,
      sample.mempool_byte_weight,
      JSON.stringify(sample.vsizes),
    ], 'warn');
    await database.query(`DELETE FROM ${this.table()} WHERE added < ?`, [cutoffSeconds], 'warn');
  }

  private async ensureTable(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await database.query(`
      CREATE TABLE IF NOT EXISTS ${this.table()} (
        added INT UNSIGNED NOT NULL,
        tx_count INT UNSIGNED NOT NULL,
        vbytes_per_second INT UNSIGNED NOT NULL,
        total_fee BIGINT UNSIGNED NOT NULL,
        mempool_byte_weight BIGINT UNSIGNED NOT NULL,
        vsizes TEXT NOT NULL,
        PRIMARY KEY (added)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `, undefined, 'warn');
    this.initialized = true;
  }

  private parseVsizes(raw: string): number[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(Number) : [];
    } catch {
      return [];
    }
  }

  private table(): string {
    return `\`${DB_TABLE}\``;
  }
}

class FallbackMoneroStatsStore implements MoneroStatsStore {
  constructor(
    private primary: MoneroStatsStore,
    private fallback: MoneroStatsStore,
  ) {}

  public describe(): string {
    return `${this.primary.describe()} with ${this.fallback.describe()} fallback`;
  }

  public async load(cutoffSeconds: number, maxSamples: number): Promise<OptimizedMempoolStats[]> {
    try {
      const samples = await this.primary.load(cutoffSeconds, maxSamples);
      if (samples.length > 0) {
        return samples;
      }
    } catch (err) {
      logger.warn(`xmr-stats: primary load failed (${err instanceof Error ? err.message : err}); trying fallback`);
    }
    return this.fallback.load(cutoffSeconds, maxSamples);
  }

  public async save(sample: OptimizedMempoolStats, samples: OptimizedMempoolStats[], cutoffSeconds: number): Promise<void> {
    try {
      await this.primary.save(sample, samples, cutoffSeconds);
    } catch (err) {
      logger.warn(`xmr-stats: primary persist failed (${err instanceof Error ? err.message : err}); writing fallback`);
      await this.fallback.save(sample, samples, cutoffSeconds);
    }
  }
}

function createDefaultStore(): MoneroStatsStore {
  const fileStore = new FileMoneroStatsStore(DEFAULT_PERSIST_FILE);
  if (isDatabaseEnabled()) {
    return new FallbackMoneroStatsStore(new MysqlMoneroStatsStore(), fileStore);
  }
  return fileStore;
}

function isDatabaseEnabled(): boolean {
  const override = process.env.XMR_DATABASE_ENABLED ?? process.env.DATABASE_ENABLED;
  if (override != null) {
    return override === 'true' || override === '1';
  }
  return config.DATABASE.ENABLED === true;
}

export class MoneroStats {
  private samples: OptimizedMempoolStats[] = [];
  private lastSampleAt = 0;
  private lastByteWeight = 0;
  private dirty = false;
  private store: MoneroStatsStore;

  constructor(
    private api: MoneroApi,
    private bus: MoneroEventBus,
    store: string | MoneroStatsStore = createDefaultStore(),
  ) {
    this.store = typeof store === 'string'
      ? new FileMoneroStatsStore(store)
      : store;
  }

  public start(): void {
    void this.loadFromDisk().then(() => {
      // Record an immediate sample so /statistics/2h returns at least one
      // entry on first request even before the 1-minute interval fires.
      void this.recordSample().then(() => { this.lastSampleAt = Date.now(); });
    });
    // Subscribe to the event bus for fast updates and periodically drop
    // a 1-minute roll-up sample. Listening to mempool-delta gives us a
    // free trigger; we still gate on SAMPLE_INTERVAL_MS so we don't
    // record more than 1 sample per minute.
    this.bus.on('mempool-delta', () => {
      const now = Date.now();
      if (now - this.lastSampleAt >= SAMPLE_INTERVAL_MS) {
        this.lastSampleAt = now;
        void this.recordSample();
      }
    });
    // Independent timer too — covers idle mempool periods where the bus
    // wouldn't emit deltas but the chart should still sample (count=0).
    setInterval(() => {
      const now = Date.now();
      if (now - this.lastSampleAt >= SAMPLE_INTERVAL_MS) {
        this.lastSampleAt = now;
        void this.recordSample();
      }
    }, SAMPLE_INTERVAL_MS).unref();
  }

  public initRoutes(app: Application, prefix = '/api/v1/'): void {
    app.get(prefix + 'statistics/2h',  (_, res) => res.json(this.window(60 * 2)));
    app.get(prefix + 'statistics/24h', (_, res) => res.json(this.window(60 * 24)));
    app.get(prefix + 'statistics/1w',  (_, res) => res.json(this.window(60 * 24 * 7)));
    app.get(prefix + 'statistics/3d',  (_, res) => res.json(this.window(60 * 24 * 3)));
    app.get(prefix + 'statistics/1m',  (_, res) => res.json(this.window(60 * 24 * 30)));
  }

  private window(samples: number): OptimizedMempoolStats[] {
    return this.samples.slice(-samples);
  }

  private async recordSample(): Promise<void> {
    try {
      const pool = await this.api.getTransactionPool();
      const txs: IMoneroApi.MempoolEntry[] = pool.transactions ?? [];
      const byteWeight = txs.reduce((acc, t) => acc + t.weight, 0);
      const totalFee = txs.reduce((acc, t) => acc + t.fee, 0);
      const nowSec = Math.floor(Date.now() / 1000);
      const previousSample = this.samples.at(-1);

      // Histogram of byte weight bucketed by fee rate (atomic/byte).
      // The frontend mempool-graph formats this with vbytesPipe → MvB
      // on the y-axis, so values must be raw byte counts and bucketed
      // by fee rate to match upstream's "Mempool by vBytes (sat/vByte)"
      // semantics — each band shows how much weight sits at roughly
      // that fee rate.
      const vsizes = new Array<number>(VSIZE_BUCKETS).fill(0);
      for (const t of txs) {
        const rate = t.weight > 0 ? t.fee / t.weight : 0;
        vsizes[feeRateBucket(rate)] += t.weight;
      }

      // vbytes_per_second: positive delta in total mempool weight since
      // the last sample, divided by the sample interval. Negative
      // deltas (block confirmation drained the pool) are clipped to 0
      // since the chart represents *arrival* rate.
      const delta = byteWeight - this.lastByteWeight;
      const elapsedSeconds = previousSample ? Math.max(1, nowSec - previousSample.added) : SAMPLE_INTERVAL_MS / 1000;
      const vbps = Math.max(0, Math.floor(delta / elapsedSeconds));
      this.lastByteWeight = byteWeight;

      const sample: OptimizedMempoolStats = {
        added: nowSec,
        count: txs.length,
        vbytes_per_second: vbps,
        total_fee: totalFee,
        mempool_byte_weight: byteWeight,
        vsizes,
      };
      this.samples.push(sample);
      while (this.samples.length > MAX_SAMPLES) {
        this.samples.shift();
      }
      this.dirty = true;
      await this.persist(sample);
      // Notify the bus so the WebSocket adapter can push this sample
      // to clients via `live-2h-chart`. The dashboard's "Incoming
      // Transactions" graph reads this stream and prepends each
      // arriving sample into its rolling 2h window — without it, the
      // chart only shows whatever /api/v1/statistics/2h returned at
      // page load and never updates live.
      this.bus.emit('stats-sample', sample);
    } catch (err) {
      logger.warn(`xmr-stats: sample failed: ${err instanceof Error ? err.message : err}`);
      // Daemon hiccup — skip this sample, recover next minute.
    }
  }

  // ---- persistence ----

  private async loadFromDisk(): Promise<void> {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - (MAX_SAMPLES * 60);
      const loaded = await this.store.load(cutoff, MAX_SAMPLES);
      this.samples = loaded
        .filter((s) => this.isValidSample(s) && s.added >= cutoff)
        .slice(-MAX_SAMPLES);
      this.lastByteWeight = this.samples.at(-1)?.mempool_byte_weight ?? 0;
      this.lastSampleAt = (this.samples.at(-1)?.added ?? 0) * 1000;
      logger.notice(`xmr-stats: loaded ${this.samples.length} samples from ${this.store.describe()}`);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code !== 'ENOENT') {
        logger.warn(`xmr-stats: load failed from ${this.store.describe()} (${e?.code ?? e?.message}); starting fresh`);
      }
    }
  }

  private async persist(sample: OptimizedMempoolStats): Promise<void> {
    if (!this.dirty) return;
    try {
      const cutoff = Math.floor(Date.now() / 1000) - (MAX_SAMPLES * 60);
      await this.store.save(sample, this.samples, cutoff);
      this.dirty = false;
    } catch (err) {
      logger.warn(`xmr-stats: persist failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private isValidSample(sample: OptimizedMempoolStats): boolean {
    return Number.isFinite(sample?.added)
      && Number.isFinite(sample?.count)
      && Number.isFinite(sample?.vbytes_per_second)
      && Number.isFinite(sample?.total_fee)
      && Number.isFinite(sample?.mempool_byte_weight)
      && Array.isArray(sample?.vsizes)
      && sample.vsizes.length === VSIZE_BUCKETS
      && sample.vsizes.every(Number.isFinite);
  }
}
