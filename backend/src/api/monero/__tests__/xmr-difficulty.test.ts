import { shapeXmrDifficultyAdjustment } from '../xmr-difficulty';

describe('shapeXmrDifficultyAdjustment', () => {
  it('describes Monero per-block retargets using upstream-compatible fields', () => {
    const result = shapeXmrDifficultyAdjustment(
      { height: 100, difficulty: 1200, timestamp: 10 },
      { height: 99, difficulty: 1000, timestamp: 8 },
      { height: 98, difficulty: 800, timestamp: 6 },
      1_000_000,
    );

    expect(result).toMatchObject({
      progressPercent: 100,
      difficultyChange: 20,
      estimatedRetargetDate: 1_120_000,
      remainingBlocks: 1,
      remainingTime: 120_000,
      previousRetarget: 25,
      previousTime: 8000,
      nextRetargetHeight: 101,
      timeAvg: 120_000,
      adjustedTimeAvg: 120_000,
      timeOffset: 0,
      expectedBlocks: 1,
    });
  });

  it('falls back to neutral deltas when prior difficulty is missing', () => {
    const result = shapeXmrDifficultyAdjustment(
      { height: 100, difficulty: 1200, timestamp: 10 },
      null,
      null,
      1_000_000,
    );

    expect(result.difficultyChange).toBe(0);
    expect(result.previousRetarget).toBe(0);
    expect(result.nextRetargetHeight).toBe(101);
  });
});
