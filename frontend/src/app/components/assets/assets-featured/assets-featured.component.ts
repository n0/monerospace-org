import { Component, OnInit } from '@angular/core';
import { Observable } from 'rxjs';
import { LiquidApiService } from '@app/services/liquid-api.service';
import { StateService } from '@app/services/state.service';

@Component({
  selector: 'app-assets-featured',
  templateUrl: './assets-featured.component.html',
  styleUrls: ['./assets-featured.component.scss'],
  standalone: false,
})
export class AssetsFeaturedComponent implements OnInit {
  featuredAssets$: Observable<any>;

  constructor(
    private liquidApiService: LiquidApiService,
    private stateService: StateService,
  ) { }

  ngOnInit(): void {
    this.featuredAssets$ = this.liquidApiService.listFeaturedAssets$(this.stateService.network);
  }

}
