import { Application, Request, Response } from 'express';
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
 * Without backfill, fresh boots show an empty chart that fills over the
 * first 2h. That's an honest UX — the explorer doesn't lie about how
 * much history it has. (If we wanted to backfill, we'd need to keep
 * mempool snapshots across restarts in MariaDB; deferred.)
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

export class MoneroStats {
  private samples: OptimizedMempoolStats[] = [];
  private lastSampleAt = 0;
  private lastByteWeight = 0;

  constructor(
    private api: MoneroApi,
    private bus: MoneroEventBus,
  ) {}

  public start(): void {
    // Record an immediate sample so /statistics/2h returns at least one
    // entry on first request even before the 1-minute interval fires.
    void this.recordSample().then(() => { this.lastSampleAt = Date.now(); });
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
      const vbps = Math.max(0, Math.floor(delta / (SAMPLE_INTERVAL_MS / 1000)));
      this.lastByteWeight = byteWeight;

      const sample: OptimizedMempoolStats = {
        added: Math.floor(Date.now() / 1000),
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
      // Notify the bus so the WebSocket adapter can push this sample
      // to clients via `live-2h-chart`. The dashboard's "Incoming
      // Transactions" graph reads this stream and prepends each
      // arriving sample into its rolling 2h window — without it, the
      // chart only shows whatever /api/v1/statistics/2h returned at
      // page load and never updates live.
      this.bus.emit('stats-sample', sample);
    } catch {
      // Daemon hiccup — skip this sample, recover next minute.
    }
  }
}
