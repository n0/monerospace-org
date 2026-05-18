import { MoneroEventBus } from '../monero-event-bus';
import { IMoneroApi } from '../monero-api.interface';
import { MoneroApi } from '../monero-api';
import { XmrChainIndexer } from '../xmr-chain-indexer';

function header(height: number): IMoneroApi.BlockHeader {
  return {
    hash: `${height}`.padStart(64, '0'),
    height,
    depth: 0,
    timestamp: height * 120,
    nonce: height,
    orphan_status: false,
    prev_hash: `${height - 1}`.padStart(64, '0'),
    reward: 600_000_000_000 + height,
    block_size: 100_000 + height,
    block_weight: 100_000 + height,
    num_txes: 2,
    major_version: 16,
    minor_version: 16,
    cumulative_difficulty: height * 1_000,
    difficulty: height * 1_000,
    miner_tx_hash: `${height}`.padEnd(64, 'f'),
    long_term_weight: 100_000 + height,
  };
}

function xmrchainBlock(height: number) {
  return {
    data: {
      block_height: height,
      hash: `${height}`.padStart(64, '0'),
      size: 100_000 + height,
      timestamp: height * 120,
      txs: [
        {
          coinbase: true,
          tx_fee: 0,
          tx_size: 1_000,
          xmr_outputs: 600_000_000_000 + height,
        },
        {
          coinbase: false,
          tx_fee: 10_000 + height,
          tx_size: 500,
          xmr_outputs: 0,
        },
        {
          coinbase: false,
          tx_fee: 20_000 + height,
          tx_size: 1_000,
          xmr_outputs: 0,
        },
      ],
    },
  };
}

function daemonBlock(height: number, extra: number[]): IMoneroApi.Block {
  return {
    blob: '',
    block_header: header(height),
    json: JSON.stringify({
      major_version: 16,
      minor_version: 16,
      timestamp: height * 120,
      prev_id: `${height - 1}`.padStart(64, '0'),
      nonce: height,
      miner_tx: {
        version: 2,
        unlock_time: height + 60,
        vin: [{ gen: { height } }],
        vout: [],
        extra,
        rct_signatures: { type: 0 },
      },
      tx_hashes: [],
    }),
    miner_tx_hash: `${height}`.padEnd(64, 'f'),
    status: 'OK',
  };
}

describe('XmrChainIndexer recentSamples', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('hydrates an exact contiguous recent block window', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const match = String(input).match(/\/api\/block\/(\d+)$/);
      const height = Number(match?.[1]);
      return {
        ok: true,
        json: async () => xmrchainBlock(height),
      } as Response;
    });

    const api = {
      getBlockCount: jest.fn(async () => 105),
      getBlockHeadersRange: jest.fn(async (from: number, to: number) => {
        const headers: IMoneroApi.BlockHeader[] = [];
        for (let height = from; height <= to; height++) {
          headers.push(header(height));
        }
        return headers;
      }),
      getBlockByHeight: jest.fn(),
    } as unknown as MoneroApi;
    const indexer = new XmrChainIndexer(api, {} as MoneroEventBus);
    jest.spyOn(indexer as unknown as { persist: () => Promise<void> }, 'persist').mockResolvedValue(undefined);

    const samples = await indexer.recentSamples(3);

    expect(api.getBlockHeadersRange).toHaveBeenCalledWith(102, 104);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(samples.map((sample) => sample.height)).toEqual([102, 103, 104]);
    expect(samples.map((sample) => sample.totalFees)).toEqual([30_204, 30_206, 30_208]);
    expect(samples.map((sample) => sample.reward)).toEqual([
      600_000_000_102,
      600_000_000_103,
      600_000_000_104,
    ]);
    expect(samples.map((sample) => sample.numTxs)).toEqual([2, 2, 2]);
  });

  it('can hydrate pool fingerprints for the exact recent block window', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const match = String(input).match(/\/api\/block\/(\d+)$/);
      const height = Number(match?.[1]);
      return {
        ok: true,
        json: async () => xmrchainBlock(height),
      } as Response;
    });

    const p2poolExtra = [
      1, ...Array(32).fill(1),
      3, 0, ...Array(32).fill(2),
    ];
    const api = {
      getBlockCount: jest.fn(async () => 105),
      getBlockHeadersRange: jest.fn(async (from: number, to: number) => {
        const headers: IMoneroApi.BlockHeader[] = [];
        for (let height = from; height <= to; height++) {
          headers.push(header(height));
        }
        return headers;
      }),
      getBlockByHeight: jest.fn(async (height: number) => daemonBlock(height, p2poolExtra)),
    } as unknown as MoneroApi;
    const indexer = new XmrChainIndexer(api, {} as MoneroEventBus);
    jest.spyOn(indexer as unknown as { persist: () => Promise<void> }, 'persist').mockResolvedValue(undefined);

    const samples = await indexer.recentSamples(1, { includePool: true });

    expect(api.getBlockByHeight).toHaveBeenCalledWith(104);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      height: 104,
      poolId: 1,
      poolName: 'P2Pool',
      poolSlug: 'p2pool',
      poolFingerprinted: true,
    });
  });
});
