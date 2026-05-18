import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { MoneroApi } from '../monero-api';
import { MoneroEventBus } from '../monero-event-bus';
import { MoneroStats, MoneroStatsStore, OptimizedMempoolStats } from '../monero-stats';

describe('MoneroStats persistence', () => {
  let tmpDir = '';
  let dateNow: jest.SpyInstance<number, []>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xmr-stats-'));
    dateNow = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });

  afterEach(async () => {
    dateNow.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeApi(): MoneroApi {
    return {
      getTransactionPool: jest.fn().mockResolvedValue({
        transactions: [
          { id_hash: 'a'.repeat(64), weight: 2000, fee: 160_000_000, receive_time: 1 },
          { id_hash: 'b'.repeat(64), weight: 1000, fee: 320_000_000, receive_time: 1 },
        ],
      }),
    } as unknown as MoneroApi;
  }

  function makeStats(persistFile: string): MoneroStats {
    const api = makeApi();
    return new MoneroStats(api, new EventEmitter() as MoneroEventBus, persistFile);
  }

  it('writes samples to disk and loads them on the next instance', async () => {
    const persistFile = path.join(tmpDir, 'mempool-stats.json');
    const stats = makeStats(persistFile);

    await (stats as unknown as { recordSample(): Promise<void> }).recordSample();

    const persisted = JSON.parse(await fs.readFile(persistFile, 'utf-8')) as { samples: OptimizedMempoolStats[] };
    expect(persisted.samples).toHaveLength(1);
    expect(persisted.samples[0]).toMatchObject({
      added: 1000,
      count: 2,
      vbytes_per_second: 50,
      total_fee: 480_000_000,
      mempool_byte_weight: 3000,
    });
    expect(persisted.samples[0].vsizes.reduce((sum, n) => sum + n, 0)).toBe(3000);

    const loaded = makeStats(persistFile);
    await (loaded as unknown as { loadFromDisk(): Promise<void> }).loadFromDisk();
    const window = (loaded as unknown as { window(samples: number): OptimizedMempoolStats[] }).window(120);
    expect(window).toHaveLength(1);
    expect(window[0].mempool_byte_weight).toBe(3000);
  });

  it('supports an injected production stats store', async () => {
    const loadedSample: OptimizedMempoolStats = {
      added: 900,
      count: 1,
      vbytes_per_second: 0,
      total_fee: 10,
      mempool_byte_weight: 20,
      vsizes: new Array(38).fill(0),
    };
    const store: MoneroStatsStore = {
      describe: () => 'test-store',
      load: jest.fn().mockResolvedValue([loadedSample]),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const storedStats = new MoneroStats(
      makeApi(),
      new EventEmitter() as MoneroEventBus,
      store,
    );

    await (storedStats as unknown as { loadFromDisk(): Promise<void> }).loadFromDisk();
    expect(store.load).toHaveBeenCalled();
    expect((storedStats as unknown as { window(samples: number): OptimizedMempoolStats[] }).window(120)).toEqual([loadedSample]);

    await (storedStats as unknown as { recordSample(): Promise<void> }).recordSample();
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2, mempool_byte_weight: 3000 }),
      expect.any(Array),
      expect.any(Number),
    );
  });
});
