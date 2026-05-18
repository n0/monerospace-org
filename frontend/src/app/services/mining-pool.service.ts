import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { PoolsStats, SinglePoolStats } from '@interfaces/node-api.interface';
import { StateService } from '@app/services/state.service';
import { StorageService } from '@app/services/storage.service';
import { MiningPoolStatsApiService } from '@app/services/mining-pool-stats-api.service';

export interface MiningUnits {
  hashrateDivider: number;
  hashrateUnit: string;
}

export interface MiningStats {
  lastEstimatedHashrate: number;
  lastEstimatedHashrate3d: number;
  lastEstimatedHashrate1w: number;
  blockCount: number;
  totalEmptyBlock: number;
  totalEmptyBlockRatio: string;
  pools: SinglePoolStats[];
  miningUnits: MiningUnits;
  totalBlockCount: number;
  minersLuck?: string;
}

@Injectable({
  providedIn: 'root'
})
export class MiningPoolService {
  cache: {
    [interval: string]: {
      lastUpdated: number;
      data: MiningStats;
    }
  } = {};
  poolsData: SinglePoolStats[] = [];

  constructor(
    private stateService: StateService,
    private miningPoolStatsApiService: MiningPoolStatsApiService,
    private storageService: StorageService,
  ) {
    this.stateService.networkChanged$.subscribe(() => {
      this.clearCache();
    });
  }

  public getMiningStats(interval: string): Observable<MiningStats> {
    if (this.cache[interval] && this.cache[interval].lastUpdated > (Date.now() - (5 * 60000))) {
      return of(this.cache[interval].data);
    } else {
      return this.miningPoolStatsApiService.listPools$(interval).pipe(
        map(response => this.generateMiningStats(response)),
        tap(stats => {
          this.cache[interval] = {
            lastUpdated: Date.now(),
            data: stats,
          };
        })
      );
    }
  }

  public getPools(): Observable<SinglePoolStats[]> {
    return this.poolsData.length ? of(this.poolsData) : this.miningPoolStatsApiService.listPools$(undefined).pipe(
      map(response => {
        this.poolsData = Array.isArray(response.body) ? response.body : [];
        return this.poolsData;
      })
    );
  }

  public getMiningUnits(hashrate: number = 0): MiningUnits {
    const units = [
      { threshold: 1_000_000_000_000, hashrateDivider: 1_000_000_000_000, hashrateUnit: 'TH/s' },
      { threshold: 1_000_000_000, hashrateDivider: 1_000_000_000, hashrateUnit: 'GH/s' },
      { threshold: 1_000_000, hashrateDivider: 1_000_000, hashrateUnit: 'MH/s' },
      { threshold: 1_000, hashrateDivider: 1_000, hashrateUnit: 'kH/s' },
    ];
    const absoluteHashrate = Math.abs(this.finite(hashrate));
    const unit = units.find(candidate => absoluteHashrate >= candidate.threshold);

    return unit ?? {
      hashrateDivider: 1,
      hashrateUnit: 'H/s',
    };
  }

  public getDefaultTimespan(min: string): string {
    const timespans = [
      '24h', '3d', '1w', '1m', '3m', '6m', '1y', '2y', '3y', 'all'
    ];
    const preference = this.storageService.getValue('miningWindowPreference') ?? '1w';
    if (timespans.indexOf(preference) < timespans.indexOf(min)) {
      return min;
    }
    return preference;
  }

  private generateMiningStats(response: { body: PoolsStats | null; headers: { get(name: string): string | null } }): MiningStats {
    const stats = response.body ?? {
      blockCount: 0,
      lastEstimatedHashrate: 0,
      lastEstimatedHashrate3d: 0,
      lastEstimatedHashrate1w: 0,
      pools: [],
    };
    const blockCount = this.finite(stats.blockCount);
    const lastEstimatedHashrate = this.finite(stats.lastEstimatedHashrate);
    const lastEstimatedHashrate3d = this.finite(stats.lastEstimatedHashrate3d);
    const lastEstimatedHashrate1w = this.finite(stats.lastEstimatedHashrate1w);
    const miningUnits = this.getMiningUnits(Math.max(lastEstimatedHashrate, lastEstimatedHashrate3d, lastEstimatedHashrate1w));
    const hashrateDivider = miningUnits.hashrateDivider;
    const pools = Array.isArray(stats.pools) ? stats.pools : [];

    const totalEmptyBlock = pools.reduce((prev, cur) => {
      return prev + this.finite(cur.emptyBlocks);
    }, 0);
    const totalEmptyBlockRatio = blockCount > 0 ? (totalEmptyBlock / blockCount * 100).toFixed(2) : '0.00';
    const poolsStats = pools.map((poolStat) => {
      const poolBlockCount = this.finite(poolStat.blockCount);
      const share = blockCount > 0 ? parseFloat((poolBlockCount / blockCount * 100).toFixed(2)) : 0;

      return {
        ...poolStat,
        share,
        lastEstimatedHashrate: blockCount > 0 ? poolBlockCount / blockCount * lastEstimatedHashrate / hashrateDivider : 0,
        lastEstimatedHashrate3d: blockCount > 0 ? poolBlockCount / blockCount * lastEstimatedHashrate3d / hashrateDivider : 0,
        lastEstimatedHashrate1w: blockCount > 0 ? poolBlockCount / blockCount * lastEstimatedHashrate1w / hashrateDivider : 0,
        emptyBlockRatio: poolBlockCount > 0 ? (this.finite(poolStat.emptyBlocks) / poolBlockCount * 100).toFixed(2) : '0.00',
        logo: '/resources/mining-pools/' + poolStat.slug + '.svg',
      };
    });
    const totalBlockCount = parseInt(response.headers.get('x-total-count') ?? '', 10);

    return {
      lastEstimatedHashrate: lastEstimatedHashrate / hashrateDivider,
      lastEstimatedHashrate3d: lastEstimatedHashrate3d / hashrateDivider,
      lastEstimatedHashrate1w: lastEstimatedHashrate1w / hashrateDivider,
      blockCount: blockCount,
      totalEmptyBlock: totalEmptyBlock,
      totalEmptyBlockRatio: totalEmptyBlockRatio,
      pools: poolsStats,
      miningUnits: miningUnits,
      totalBlockCount: Number.isFinite(totalBlockCount) ? totalBlockCount : blockCount,
    };
  }

  private clearCache(): void {
    this.cache = {};
    this.poolsData = [];
  }

  private finite(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
}
