import { Component, OnInit, ChangeDetectionStrategy, OnDestroy } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { BehaviorSubject, EMPTY, Observable, Subscription } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import { RbfTree } from '@interfaces/node-api.interface';
import { RbfApiService } from '@app/services/rbf-api.service';
import { StateService } from '@app/services/state.service';
import { SeoService } from '@app/services/seo.service';
import { OpenGraphService } from '@app/services/opengraph.service';
import { seoDescriptionNetwork } from '@app/shared/common.utils';

@Component({
  selector: 'app-rbf-list',
  templateUrl: './rbf-list.component.html',
  styleUrls: ['./rbf-list.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RbfList implements OnInit, OnDestroy {
  rbfTrees$: Observable<RbfTree[]>;
  nextRbfSubject = new BehaviorSubject(null);
  urlFragmentSubscription: Subscription;
  fullRbf: boolean;
  isLoading = true;

  constructor(
    private route: ActivatedRoute,
    private rbfApiService: RbfApiService,
    public stateService: StateService,
    private seoService: SeoService,
    private ogService: OpenGraphService,
  ) { }

  ngOnInit(): void {
    this.urlFragmentSubscription = this.route.fragment.subscribe((fragment) => {
      this.fullRbf = (fragment === 'fullrbf');
      this.nextRbfSubject.next(null);
      this.isLoading = true;
    });

    this.rbfTrees$ = this.nextRbfSubject.pipe(
      switchMap(() => {
        return this.rbfApiService.getRbfList$(this.fullRbf);
      }),
      catchError((e) => {
        return EMPTY;
      })
    )
    .pipe(
      tap(() => {
        this.isLoading = false;
      })
    );

    this.seoService.setTitle($localize`:@@5e3d5a82750902f159122fcca487b07f1af3141f:RBF Replacements`);
    this.seoService.setDescription($localize`:@@meta.description.rbf-list:See the most recent RBF replacements on the Bitcoin${seoDescriptionNetwork(this.stateService.network)} network, updated in real-time.`);
    this.ogService.setManualOgImage('rbf.jpg');
  }

  ngOnDestroy(): void {
    this.urlFragmentSubscription.unsubscribe();
  }
}
