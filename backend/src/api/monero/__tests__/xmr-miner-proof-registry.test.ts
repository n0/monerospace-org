import { buildAttributionMap, xmrMinerPoolFromProofName } from '../xmr-miner-proof-registry';
import { PoolBlockRecord } from '../xmr-pool-blocks';

const HASH_P2POOL = 'a'.repeat(64);
const HASH_SUPPORT = 'b'.repeat(64);
const HASH_CONFLICT = 'c'.repeat(64);

describe('buildAttributionMap', () => {
  it('attributes P2Pool with a cryptographic proof and other pools without', () => {
    const records: PoolBlockRecord[] = [
      { hash: HASH_P2POOL, height: 3680658, poolName: 'P2Pool', source: 'p2pool.observer', hasProof: true },
      { hash: HASH_SUPPORT, height: 3680737, poolName: 'SupportXMR', source: 'supportxmr.com', hasProof: false },
    ];
    const map = buildAttributionMap(records);

    const p2pool = map.get(HASH_P2POOL)!;
    expect(p2pool.pool).toMatchObject({ id: 1, slug: 'p2pool' });
    expect(p2pool.source).toBe('p2pool.observer');
    expect(p2pool.proof).toMatchObject({
      status: 'verified',
      type: 'txproof',
      poolSlug: 'p2pool',
      poolId: 1,
      blockHash: HASH_P2POOL,
      sourceUrl: `https://p2pool.observer/block/${HASH_P2POOL}`,
    });

    const support = map.get(HASH_SUPPORT)!;
    expect(support.pool).toMatchObject({ id: 2, slug: 'supportxmr' });
    expect(support.source).toBe('supportxmr.com');
    expect(support.proof).toBeUndefined();
  });

  it('prefers the proof-carrying source when two pools claim the same hash', () => {
    const map = buildAttributionMap([
      { hash: HASH_CONFLICT, height: 1, poolName: 'SupportXMR', source: 'supportxmr.com', hasProof: false },
      { hash: HASH_CONFLICT, height: 1, poolName: 'P2Pool', source: 'p2pool.observer', hasProof: true },
    ]);
    expect(map.get(HASH_CONFLICT)!.pool.slug).toBe('p2pool');
    expect(map.get(HASH_CONFLICT)!.proof).toBeDefined();
  });
});

describe('xmrMinerPoolFromProofName', () => {
  it('resolves known pools to their canonical ids', () => {
    expect(xmrMinerPoolFromProofName('SupportXMR')).toMatchObject({ id: 2, slug: 'supportxmr' });
    expect(xmrMinerPoolFromProofName('HashVault')).toMatchObject({ id: 5, slug: 'hashvault' });
  });

  it('creates stable pool identities for unknown pool names', () => {
    const first = xmrMinerPoolFromProofName('Example Pool');
    const second = xmrMinerPoolFromProofName('Example Pool');
    expect(first).toEqual(second);
    expect(first.id).toBeGreaterThanOrEqual(10_000);
    expect(first.slug).toBe('example-pool');
  });
});
