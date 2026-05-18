import { Component, OnInit, OnDestroy, Input } from '@angular/core';
import { StateService } from '@app/services/state.service';
import { Observable, merge, of, Subscription } from 'rxjs';
import { EnterpriseService } from '@app/services/enterprise.service';

@Component({
  selector: 'app-master-page',
  templateUrl: './master-page.component.html',
  styleUrls: ['./master-page.component.scss'],
  standalone: false,
})
export class MasterPageComponent implements OnInit, OnDestroy {
  @Input() headerVisible = true;
  @Input() footerVisibleOverride: boolean | null = null;

  network$: Observable<string>;
  connectionState$: Observable<number>;
  navCollapsed = false;
  footerVisible = true;

  enterpriseInfo: any;
  enterpriseInfo$: Subscription;

  constructor(
    public stateService: StateService,
    private enterpriseService: EnterpriseService,
  ) { }

  ngOnInit(): void {
    this.connectionState$ = this.stateService.connectionState$;
    this.network$ = merge(of(''), this.stateService.networkChanged$);
    this.footerVisible = this.footerVisibleOverride ?? true;
    this.enterpriseInfo$ = this.enterpriseService.info$.subscribe(info => {
      this.enterpriseInfo = info;
    });
  }

  collapse(): void {
    this.navCollapsed = !this.navCollapsed;
  }

  brandClick(e): void {
    this.stateService.resetScroll$.next(true);
  }

  ngOnDestroy(): void {
    if (this.enterpriseInfo$) {
      this.enterpriseInfo$.unsubscribe();
    }
  }

}
