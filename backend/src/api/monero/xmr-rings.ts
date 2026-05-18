import { IMoneroApi } from './monero-api.interface';

export interface XmrRingMember {
  amount: number;
  global_index: number;
  height: number | null;
  txid: string | null;
  unlocked: boolean | null;
  age_blocks: number | null;
}

interface InternalRingMember extends XmrRingMember {
  lookup_index: number | null;
}

export interface XmrRingLookupPlan {
  requests: IMoneroApi.GetOutsRequestOutput[];
  membersPerInput: InternalRingMember[][];
  truncated: boolean;
}

export function decodeRingMemberIndices(keyOffsets: Array<number | string>): number[] {
  const indices: number[] = [];
  let current = 0;

  for (const rawOffset of keyOffsets) {
    const offset = Number(rawOffset);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return [];
    }
    current += offset;
    if (!Number.isSafeInteger(current)) {
      return [];
    }
    indices.push(current);
  }

  return indices;
}

export function buildRingLookupPlan(
  parsed: IMoneroApi.TransactionJson | null,
  maxLookups: number,
): XmrRingLookupPlan {
  const requests: IMoneroApi.GetOutsRequestOutput[] = [];
  const membersPerInput: InternalRingMember[][] = [];
  let truncated = false;

  for (const vin of parsed?.vin ?? []) {
    const key = vin.key;
    if (!key?.key_offsets?.length) {
      membersPerInput.push([]);
      continue;
    }

    const amount = Number(key.amount ?? 0);
    const globalIndices = decodeRingMemberIndices(key.key_offsets);
    const members = globalIndices.map((globalIndex): InternalRingMember => {
      const member: InternalRingMember = {
        amount: Number.isFinite(amount) ? amount : 0,
        global_index: globalIndex,
        height: null,
        txid: null,
        unlocked: null,
        age_blocks: null,
        lookup_index: null,
      };

      if (requests.length < maxLookups) {
        member.lookup_index = requests.length;
        requests.push({ amount: member.amount, index: globalIndex });
      } else {
        truncated = true;
      }

      return member;
    });

    membersPerInput.push(members);
  }

  return { requests, membersPerInput, truncated };
}

export function attachResolvedRingMembers(
  plan: XmrRingLookupPlan,
  outs: IMoneroApi.GetOutsOutput[],
  referenceHeight?: number,
): { membersPerInput: XmrRingMember[][]; truncated: boolean } {
  const membersPerInput = plan.membersPerInput.map((members) => members.map((member) => {
    const out = member.lookup_index !== null ? outs[member.lookup_index] : undefined;
    const height = Number.isFinite(out?.height) ? Number(out?.height) : null;
    return {
      amount: member.amount,
      global_index: member.global_index,
      height,
      txid: typeof out?.txid === 'string' ? out.txid : null,
      unlocked: typeof out?.unlocked === 'boolean' ? out.unlocked : null,
      age_blocks: typeof referenceHeight === 'number' && height !== null
        ? Math.max(0, referenceHeight - height)
        : null,
    };
  }));

  return { membersPerInput, truncated: plan.truncated };
}
