// xmr-space: Monero's block weight limit is dynamic. The backend uses
// a 600 KB projection limit for mempool blocks, which is a better visual
// denominator than the upstream 4,000,000 weight-unit ceiling.
export const XMR_VISUAL_BLOCK_WEIGHT_LIMIT = 600_000;

export function getVisualBlockWeightPercent(weight: number | null | undefined): number {
  if (weight == null || !Number.isFinite(weight) || weight <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, (weight / XMR_VISUAL_BLOCK_WEIGHT_LIMIT) * 100));
}

export function getVisualBlockWeightPercentStyle(weight: number | null | undefined): string {
  return `${getVisualBlockWeightPercent(weight)}%`;
}
