import { Injectable } from '@angular/core';
import { ElectrsApiService } from '@app/services/electrs-api.service';
import { Subject, debounceTime, switchMap } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class PreloadService {
  block$ = new Subject<string>;
  debounceTime = 250;

  constructor(
    private electrsApiService: ElectrsApiService,
  ) {
    this.block$
      .pipe(
        debounceTime(this.debounceTime),
        switchMap((blockHash) => this.electrsApiService.getBlockTransactions$(blockHash))
      )
      .subscribe();
  }

}
