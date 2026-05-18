import type { TransactionStripped } from '@interfaces/node-api.interface';

export interface FeeRateTransaction {
  fee: number;
  weight: number;
  effectiveFeePerVsize?: number;
  ancestors?: { weight: number; fee: number }[];
}

export function getUnacceleratedFeeRate(tx: FeeRateTransaction, accelerated: boolean): number {
  if (accelerated) {
    let ancestorVsize = tx.weight / 4;
    let ancestorFee = tx.fee;
    for (const ancestor of tx.ancestors || []) {
      ancestorVsize += (ancestor.weight / 4);
      ancestorFee += ancestor.fee;
    }
    return Math.min(tx.fee / (tx.weight / 4), ancestorFee / ancestorVsize);
  }
  return tx.effectiveFeePerVsize;
}

export function formatCompactFeeRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) {
    return '-';
  }

  const absoluteRate = Math.abs(rate);
  const sign = rate < 0 ? '-' : '';
  const units = [
    { divider: 1e12, suffix: 'T' },
    { divider: 1e9, suffix: 'B' },
    { divider: 1e6, suffix: 'M' },
    { divider: 1e3, suffix: 'k' },
  ];
  const selected = units.find(unit => absoluteRate >= unit.divider);

  if (!selected) {
    return Math.round(rate).toString();
  }

  const scaled = absoluteRate / selected.divider;
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${sign}${scaled.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')}${selected.suffix}`;
}

export function formatCompactFeeRateRange(minRate: number | null | undefined, maxRate: number | null | undefined): string {
  if (minRate == null && maxRate == null) {
    return '-';
  }

  if (minRate == null || minRate === maxRate) {
    return formatCompactFeeRate(maxRate);
  }

  if (maxRate == null) {
    return formatCompactFeeRate(minRate);
  }

  return `${formatCompactFeeRate(minRate)} - ${formatCompactFeeRate(maxRate)}`;
}

export function identifyPrioritizedTransactions(transactions: TransactionStripped[]): { prioritized: string[], deprioritized: string[] } {
  // Find the longest increasing subsequence of transactions.
  // Adapted from https://en.wikipedia.org/wiki/Longest_increasing_subsequence#Efficient_algorithms
  const X = transactions.slice(1).reverse();
  if (X.length < 2) {
    return { prioritized: [], deprioritized: [] };
  }
  const N = X.length;
  const P: number[] = new Array(N);
  const M: number[] = new Array(N + 1);
  M[0] = -1;

  let L = 0;
  for (let i = 0; i < N; i++) {
    let lo = 1;
    let hi = L + 1;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (X[M[mid]].rate > X[i].rate) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }

    const newL = lo;
    P[i] = M[newL - 1];
    M[newL] = i;

    if (newL > L) {
      L = newL;
    }
  }

  const LIS: TransactionStripped[] = new Array(L);
  let k = M[L];
  for (let j = L - 1; j >= 0; j--) {
    LIS[j] = X[k];
    k = P[k];
  }

  const lisMap = new Map<string, number>();
  LIS.forEach((tx, index) => lisMap.set(tx.txid, index));

  const prioritized: string[] = [];
  const deprioritized: string[] = [];

  let lastRate = 0;

  for (const tx of X) {
    if (lisMap.has(tx.txid)) {
      lastRate = tx.rate;
    } else if (Math.abs(tx.rate - lastRate) >= 0.1) {
      if (tx.rate <= lastRate) {
        prioritized.push(tx.txid);
      } else {
        deprioritized.push(tx.txid);
      }
    }
  }

  return { prioritized, deprioritized };
}
