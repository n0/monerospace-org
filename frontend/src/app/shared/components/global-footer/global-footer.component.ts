import { Input, ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit, OnChanges, SimpleChanges, OnDestroy } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { Env, StateService } from '@app/services/state.service';
import { StorageService } from '@app/services/storage.service';
import { EnterpriseService } from '@app/services/enterprise.service';

@Component({
  selector: 'app-global-footer',
  templateUrl: './global-footer.component.html',
  styleUrls: ['./global-footer.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GlobalFooterComponent implements OnInit, OnDestroy, OnChanges {
  @Input() user: any = undefined;

  env: Env;
  frontendGitCommitHash = this.stateService.env.GIT_COMMIT_HASH;
  packetJsonVersion = this.stateService.env.PACKAGE_JSON_VERSION;
  urlSubscription: Subscription;
  isServicesPage = false;

  enterpriseInfo: any;
  enterpriseInfo$: Subscription;

  constructor(
    public stateService: StateService,
    private enterpriseService: EnterpriseService,
    private storageService: StorageService,
    private route: ActivatedRoute,
    private cd: ChangeDetectorRef,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.isServicesPage = this.router.url.includes('/services/');

    this.env = this.stateService.env;
    this.enterpriseInfo$ = this.enterpriseService.info$.subscribe(info => {
      this.enterpriseInfo = info;
    });

    this.urlSubscription = this.route.url.subscribe((url) => {
      this.user = this.storageService.getAuth();
      this.cd.markForCheck();
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.user) {
      this.user = this.storageService.getAuth();
    }
  }

  ngOnDestroy(): void {
    this.urlSubscription.unsubscribe();
    if (this.enterpriseInfo$) {
      this.enterpriseInfo$.unsubscribe();
    }
  }
}
