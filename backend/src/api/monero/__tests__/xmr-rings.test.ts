import { attachResolvedRingMembers, buildRingLookupPlan, decodeRingMemberIndices } from '../xmr-rings';
import { IMoneroApi } from '../monero-api.interface';

describe('xmr ring helpers', () => {
  it('decodes delta-encoded key offsets into cumulative global indices', () => {
    expect(decodeRingMemberIndices([10, 2, 3, 0])).toEqual([10, 12, 15, 15]);
  });

  it('builds /get_outs requests and maps resolved output heights back per input', () => {
    const parsed = {
      version: 2,
      unlock_time: 0,
      vin: [
        { key: { amount: 0, key_offsets: [10, 2, 3], k_image: 'a'.repeat(64) } },
        { key: { amount: 0, key_offsets: [4, 5], k_image: 'b'.repeat(64) } },
      ],
      vout: [],
      extra: [],
      rct_signatures: { type: 6 },
    } as IMoneroApi.TransactionJson;

    const plan = buildRingLookupPlan(parsed, 4);

    expect(plan.requests).toEqual([
      { amount: 0, index: 10 },
      { amount: 0, index: 12 },
      { amount: 0, index: 15 },
      { amount: 0, index: 4 },
    ]);
    expect(plan.truncated).toBe(true);

    const result = attachResolvedRingMembers(plan, [
      { height: 90, key: 'k0', mask: 'm0', txid: 'tx0', unlocked: true },
      { height: 95, key: 'k1', mask: 'm1', txid: 'tx1', unlocked: true },
      { height: 99, key: 'k2', mask: 'm2', txid: 'tx2', unlocked: false },
      { height: 80, key: 'k3', mask: 'm3', txid: 'tx3', unlocked: true },
    ], 100);

    expect(result.membersPerInput[0]).toEqual([
      { amount: 0, global_index: 10, height: 90, txid: 'tx0', unlocked: true, age_blocks: 10 },
      { amount: 0, global_index: 12, height: 95, txid: 'tx1', unlocked: true, age_blocks: 5 },
      { amount: 0, global_index: 15, height: 99, txid: 'tx2', unlocked: false, age_blocks: 1 },
    ]);
    expect(result.membersPerInput[1][0]).toMatchObject({ global_index: 4, height: 80, age_blocks: 20 });
    expect(result.membersPerInput[1][1]).toMatchObject({ global_index: 9, height: null, txid: null, age_blocks: null });
  });
});
