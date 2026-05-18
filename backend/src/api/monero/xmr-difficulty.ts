export interface XmrDifficultySource {
  height: number;
  difficulty: number;
  timestamp: number;
}

export interface XmrDifficultyAdjustment {
  progressPercent: number;
  difficultyChange: number;
  estimatedRetargetDate: number;
  remainingBlocks: number;
  remainingTime: number;
  previousRetarget: number;
  previousTime: number;
  nextRetargetHeight: number;
  timeAvg: number;
  adjustedTimeAvg: number;
  timeOffset: number;
  expectedBlocks: number;
}

const MONERO_TARGET_MS = 120_000;

function pctChange(current?: number, previous?: number): number {
  if (!current || !previous || previous <= 0) {
    return 0;
  }
  return ((current - previous) / previous) * 100;
}

/**
 * Monero retargets every block, unlike Bitcoin's 2016-block epoch.
 * Keep the upstream field names so the Angular dashboard and ETA code
 * continue to work, but make the values describe Monero honestly.
 */
export function shapeXmrDifficultyAdjustment(
  tip?: XmrDifficultySource | null,
  previous?: XmrDifficultySource | null,
  previousPrevious?: XmrDifficultySource | null,
  now: number = Date.now(),
): XmrDifficultyAdjustment {
  return {
    progressPercent: 100,
    difficultyChange: pctChange(tip?.difficulty, previous?.difficulty),
    estimatedRetargetDate: now + MONERO_TARGET_MS,
    remainingBlocks: 1,
    remainingTime: MONERO_TARGET_MS,
    previousRetarget: pctChange(previous?.difficulty, previousPrevious?.difficulty),
    previousTime: previous?.timestamp ? previous.timestamp * 1000 : 0,
    nextRetargetHeight: (tip?.height ?? 0) + 1,
    timeAvg: MONERO_TARGET_MS,
    adjustedTimeAvg: MONERO_TARGET_MS,
    timeOffset: 0,
    expectedBlocks: 1,
  };
}
