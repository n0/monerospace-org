import { Injectable } from '@angular/core';
import { DifficultyAdjustment, MempoolPosition } from '@interfaces/node-api.interface';
import { StateService } from '@app/services/state.service';
import { MempoolBlock } from '@interfaces/websocket.interface';
import { Transaction } from '@interfaces/electrs.interface';

export interface ETA {
  now: number, // time at which calculation performed
  time: number, // absolute time expected (in unix epoch ms)
  wait: number, // expected wait time in ms
  blocks: number, // expected number of blocks (rounded up to next integer)
}

@Injectable({
  providedIn: 'root'
})
export class EtaService {
  constructor(
    private stateService: StateService,
  ) { }

  mempoolPositionFromFees(feerate: number, mempoolBlocks: MempoolBlock[]): MempoolPosition {
    for (let txInBlockIndex = 0; txInBlockIndex < mempoolBlocks.length; txInBlockIndex++) {
      const block = mempoolBlocks[txInBlockIndex];
      for (let i = 0; i < block.feeRange.length - 1; i++) {
        if (feerate < block.feeRange[i + 1] && feerate >= block.feeRange[i]) {
          const feeRangeIndex = i;
          const feeRangeChunkSize = 1 / (block.feeRange.length - 1);

          const txFee = feerate - block.feeRange[i];
          const max = block.feeRange[i + 1] - block.feeRange[i];
          const blockLocation = txFee / max;

          const chunkPositionOffset = blockLocation * feeRangeChunkSize;
          const feePosition = feeRangeChunkSize * feeRangeIndex + chunkPositionOffset;

          const blockedFilledPercentage = (block.blockVSize > this.stateService.blockVSize ? this.stateService.blockVSize : block.blockVSize) / this.stateService.blockVSize;

          return {
            block: txInBlockIndex,
            vsize: (1 - feePosition) * blockedFilledPercentage * this.stateService.blockVSize,
          };
        }
      }
      if (feerate >= block.feeRange[block.feeRange.length - 1]) {
        // at the very front of this block
        return {
          block: txInBlockIndex,
          vsize: 0,
        };
      }
    }
    // at the very back of the last block
    return {
      block: mempoolBlocks.length - 1,
      vsize: mempoolBlocks[mempoolBlocks.length - 1].blockVSize,
    };
  }

  calculateETA(
    tx: Transaction,
    mempoolBlocks: MempoolBlock[],
    position: { txid: string, position: MempoolPosition },
    da: DifficultyAdjustment,
  ): ETA | null {
    if (!tx || !mempoolBlocks) {
      return null;
    }
    const now = Date.now();

    // use known projected position, or fall back to feerate-based estimate
    const mempoolPosition = position?.position ?? this.mempoolPositionFromFees(tx.effectiveFeePerVsize || tx.feePerVsize, mempoolBlocks);
    if (!mempoolPosition) {
      return null;
    }

    // difficulty adjustment estimate is required to know the current XMR average block time
    if (!da) {
      return null;
    }

    const blocks = mempoolPosition.block + 1;
    const wait = da.adjustedTimeAvg * (mempoolPosition.block + 1);
    return {
      now,
      time: wait + now + da.timeOffset,
      wait,
      blocks,
    };
  }

}
