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
 * Bucket a tx weight into one of 38 size buckets — same approximate
 * binning as upstream's mempool stats: log-spaced from ~1 KB up to
 * 2 MB. We don't need to match exactly because the chart just shows a
 * stack of relative bands.
 */
function vsizeBucket(weight: number): number {
  // Upstream uses fee-rate buckets (sat/vB) for vsizes; for Monero we
  // bucket by raw byte size since fees are atomic-per-byte and weight
  // is comparable across txs. Linear bins from 0 to 4096+ in 100 steps.
  const idx = Math.min(VSIZE_BUCKETS - 1, Math.floor(weight / 100));
  return idx;
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

      // Histogram of weights in 38 buckets.
      const vsizes = new Array<number>(VSIZE_BUCKETS).fill(0);
      for (const t of txs) {
        vsizes[vsizeBucket(t.weight)] += 1;
      }

      // vbytes_per_second: positive delta in total mempool weight since
      // the last sample, divided by the sample interval. Negative
      // deltas (block confirmation drained the pool) are clipped to 0
      // since the chart represents *arrival* rate.
      const delta = byteWeight - this.lastByteWeight;
      const vbps = Math.max(0, Math.floor(delta / (SAMPLE_INTERVAL_MS / 1000)));
      this.lastByteWeight = byteWeight;

      this.samples.push({
        added: Math.floor(Date.now() / 1000),
        count: txs.length,
        vbytes_per_second: vbps,
        total_fee: totalFee,
        mempool_byte_weight: byteWeight,
        vsizes,
      });
      while (this.samples.length > MAX_SAMPLES) {
        this.samples.shift();
      }
    } catch {
      // Daemon hiccup — skip this sample, recover next minute.
    }
  }
}
