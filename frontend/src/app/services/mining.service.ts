import { Injectable } from '@angular/core';
import { StorageService } from '@app/services/storage.service';

export interface MiningUnits {
  hashrateDivider: number;
  hashrateUnit: string;
}

@Injectable({
  providedIn: 'root'
})
export class MiningService {
  constructor(
    private storageService: StorageService,
  ) {}

  public getMiningUnits(): MiningUnits {
    return {
      hashrateDivider: Math.pow(10, 18),
      hashrateUnit: 'EH/s',
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
}
