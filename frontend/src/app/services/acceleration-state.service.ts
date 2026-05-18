import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { map, scan } from 'rxjs/operators';
import { Acceleration } from '@interfaces/node-api.interface';

export interface AccelerationDelta {
  added: Acceleration[];
  removed: string[];
  reset?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class AccelerationStateService {
  accelerations$ = new Subject<AccelerationDelta>();
  liveAccelerations$: Observable<Acceleration[]>;

  constructor() {
    this.liveAccelerations$ = this.accelerations$.pipe(
      scan((accelerations: { [txid: string]: Acceleration }, delta: AccelerationDelta) => {
        if (delta.reset) {
          accelerations = {};
        } else {
          for (const txid of delta.removed) {
            delete accelerations[txid];
          }
        }
        for (const acc of delta.added) {
          accelerations[acc.txid] = acc;
        }
        return accelerations;
      }, {}),
      map((accMap) => Object.values(accMap).sort((a, b) => b.added - a.added))
    );
  }
}
