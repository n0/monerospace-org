export interface Filter {
  key: string,
  label: string,
  flag: bigint,
  toggle?: string,
  group?: string,
  important?: boolean,
  tooltip?: boolean,
  txPage?: boolean,
}

export type FilterMode = 'and' | 'or' | 'nor';

export type GradientMode = 'fee' | 'age';

export interface ActiveFilter {
  mode: FilterMode,
  filters: string[],
  gradient: GradientMode,
}

// XMR public transaction-signal flags used by active block filters.
export const TransactionFlags = {
  // xmr-space: Monero-specific flags. We use bits 28/29/30 - within
  // 32-bit unsigned int range so they survive the
  // `tx.bigintFlags = BigInt(tx.flags)` round-trip in tx-view.ts
  // (where `tx.flags` is a Number, not a bigint).
  xmr_ring16:     0b00010000_00000000_00000000_00000000n, // bit 28
  xmr_view_tags:  0b00100000_00000000_00000000_00000000n, // bit 29
  xmr_rct_v6:     0b01000000_00000000_00000000_00000000n, // bit 30
};

export function toFlags(filters: string[]): bigint {
  let flag = 0n;
  for (const filter of filters) {
    flag |= TransactionFlags[filter];
  }
  return flag;
}

export function toFilters(flags: bigint): Filter[] {
  const filters = [];
  for (const filter of Object.values(TransactionFilters).filter(f => f !== undefined)) {
    if (flags & filter.flag) {
      filters.push(filter);
    }
  }
  return filters;
}

export const TransactionFilters: { [key: string]: Filter } = {
    xmr_ring16: { key: 'xmr_ring16', label: $localize`:@@xmr.goggle.ring16:Standard ring (16)`, flag: TransactionFlags.xmr_ring16, important: true, tooltip: true, txPage: true },
    xmr_view_tags: { key: 'xmr_view_tags', label: $localize`:@@xmr.goggle.view-tags:View tags`, flag: TransactionFlags.xmr_view_tags, important: true, tooltip: true, txPage: true },
    xmr_rct_v6: { key: 'xmr_rct_v6', label: $localize`:@@xmr.goggle.rct6:RCT v6 (latest)`, flag: TransactionFlags.xmr_rct_v6, important: true, tooltip: true, txPage: true },
};

export const FilterGroups: { label: string, filters: Filter[]}[] = [
  { label: $localize`:@@xmr.goggle.group-public-signals:Monero public signals`, filters: ['xmr_ring16', 'xmr_view_tags', 'xmr_rct_v6'] },
].map(group => ({ label: group.label, filters: group.filters.map(filter => TransactionFilters[filter] || null).filter(f => f != null) }));
