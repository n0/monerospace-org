import {
  parseP2poolFoundBlocks,
  parseCryptonotePoolBlocks,
  parseNanopoolBlocks,
  parseHerominersBlocks,
} from '../xmr-pool-blocks';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

describe('xmr-pool-blocks parsers', () => {
  it('parses P2Pool observer found_blocks (main_block.id -> hash) and marks proof', () => {
    const body = JSON.stringify([
      { main_block: { id: HASH_A, height: 3680658, reward: 616238580000 }, side_height: 14286737 },
      { main_block: { id: HASH_B, height: 3680657 } },
      { side_height: 1 }, // no main_block -> skipped
    ]);
    const out = parseP2poolFoundBlocks(body, 'P2Pool', 'p2pool.observer');
    expect(out).toEqual([
      { hash: HASH_A, height: 3680658, poolName: 'P2Pool', source: 'p2pool.observer', hasProof: true },
      { hash: HASH_B, height: 3680657, poolName: 'P2Pool', source: 'p2pool.observer', hasProof: true },
    ]);
  });

  it('parses cryptonote-pool block shape (SupportXMR/HashVault/MoneroOcean) and drops invalid', () => {
    const body = JSON.stringify([
      { ts: '1779590504002', hash: HASH_A, height: 3680737, valid: true, value: '600344420000' },
      { ts: 1779589291000, hash: HASH_B, height: 3680726, valid: false }, // invalid -> dropped
      { ts: 1779588751328, hash: HASH_C, height: 3680721 }, // valid omitted -> kept
    ]);
    const out = parseCryptonotePoolBlocks(body, 'SupportXMR', 'supportxmr.com');
    expect(out.map((r) => r.hash)).toEqual([HASH_A, HASH_C]);
    expect(out[0]).toMatchObject({ height: 3680737, poolName: 'SupportXMR', source: 'supportxmr.com', hasProof: false });
  });

  it('parses Nanopool {data:[{hash, block_number}]}', () => {
    const body = JSON.stringify({
      status: true,
      data: [
        { block_number: 3680731, hash: HASH_A, date: 1779589909 },
        { block_number: 3680727, hash: HASH_B, date: 1779589516 },
      ],
    });
    const out = parseNanopoolBlocks(body, 'Nanopool', 'nanopool.org');
    expect(out).toEqual([
      { hash: HASH_A, height: 3680731, poolName: 'Nanopool', source: 'nanopool.org', hasProof: false },
      { hash: HASH_B, height: 3680727, poolName: 'Nanopool', source: 'nanopool.org', hasProof: false },
    ]);
  });

  it('parses HeroMiners flat [blockString, height, ...] dump and skips orphans', () => {
    const body = JSON.stringify([
      `${HASH_A}:1779580284:687711053802:472587460153:472298585989:abfb8300:unlocked:602150000000:8Bo6addr:eu-de:prop`,
      '3680635',
      `${HASH_B}:1779570072:702471125998:1:1:c3150c49:orphaned:600000000000:84gaddr:eu-de:prop`,
      '3680600',
      `${HASH_C}:1779560000:700000000000:1:1:deadbeef:unlocked:600000000000:84gaddr:eu-de:prop`,
      '3680500',
    ]);
    const out = parseHerominersBlocks(body, 'HeroMiners', 'herominers.com');
    expect(out.map((r) => r.hash)).toEqual([HASH_A, HASH_C]);
    expect(out[0]).toMatchObject({ height: 3680635, poolName: 'HeroMiners', source: 'herominers.com', hasProof: false });
  });

  it('returns [] for malformed/empty bodies', () => {
    expect(parseP2poolFoundBlocks('not json', 'P2Pool', 's')).toEqual([]);
    expect(parseCryptonotePoolBlocks('{}', 'SupportXMR', 's')).toEqual([]);
    expect(parseNanopoolBlocks('[]', 'Nanopool', 's')).toEqual([]);
    expect(parseHerominersBlocks('null', 'HeroMiners', 's')).toEqual([]);
  });

  it('rejects non-hex64 hashes', () => {
    const body = JSON.stringify([{ hash: 'tooshort', height: 1, valid: true }]);
    expect(parseCryptonotePoolBlocks(body, 'SupportXMR', 's')).toEqual([]);
  });
});
