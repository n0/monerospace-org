import { Injectable } from '@angular/core';
import { SeoService } from '@app/services/seo.service';
import { StateService } from '@app/services/state.service';
import { BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class EnterpriseService {
  subdomain: string | null = null;
  info$: BehaviorSubject<object> = new BehaviorSubject(null);

  constructor(
    private seoService: SeoService,
    private stateService: StateService,
  ) {
    const branding = this.stateService.env.customize?.branding;
    const subdomain = this.stateService.env.customize?.enterprise || null;

    if (branding) {
      this.subdomain = subdomain;
      this.disableSubnetworks();
      this.seoService.setEnterpriseTitle(branding.title, true);
      this.info$.next(this.processEnterpriseInfo(branding));
    }
  }

  getSubdomain(): string {
    return this.subdomain;
  }

  disableSubnetworks(): void {
    this.stateService.env.TESTNET_ENABLED = false;
    this.stateService.env.TESTNET4_ENABLED = false;
    this.stateService.env.LIQUID_ENABLED = false;
    this.stateService.env.LIQUID_TESTNET_ENABLED = false;
    this.stateService.env.SIGNET_ENABLED = false;
    this.stateService.env.REGTEST_ENABLED = false;
  }

  private processEnterpriseInfo(info: any): any {
    const isCustomDashboard = this.stateService.env.customize?.dashboard?.widgets?.length > 0;
    const dualLogo = !isCustomDashboard || info.cobranded;
    const logoUrl = info.header_img ?? info.img ?? info.footer_img;
    return {
      ...info,
      dualLogo,
      logoUrl,
    };
  }

  goal(_id: number) {}

  page() {}
}
