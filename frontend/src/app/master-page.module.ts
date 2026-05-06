import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule, ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { MasterPageComponent } from '@components/master-page/master-page.component';
import { SharedModule } from '@app/shared/shared.module';

import { StartComponent } from '@components/start/start.component';
import { RecentTransactionsList } from '@components/recent-transactions-list/recent-transactions-list.component';
import { BlocksList } from '@components/blocks-list/blocks-list.component';
import { ServerHealthComponent } from '@components/server-health/server-health.component';
import { ServerStatusComponent } from '@components/server-health/server-status.component';
import { FaucetComponent } from '@components/faucet/faucet.component';
import { SimpleProofWidgetComponent } from '@components/simpleproof-widget/simpleproof-widget.component';
import { SimpleProofCuboWidgetComponent } from '@components/simpleproof-widget/simpleproof-cubo-widget.component';

const browserWindow = window || {};
// @ts-ignore
const browserWindowEnv = browserWindow.__env || {};

const routes: Routes = [
  {
    path: '',
    component: MasterPageComponent,
    children: [
      // xmr-space: stripped Bitcoin-only routes from this children list.
      // Each was either UTXO-shaped or unique to mempool's commercial
      // surface and impossible to retarget meaningfully:
      //
      //   tx/push, pushtx, tx/test  → PushTransaction & Testmempoolaccept
      //                               UI: Bitcoin raw-tx hex format,
      //                               vin/vout decoder. Strip; a Monero
      //                               broadcast tool is a future iter.
      //   blocks/stale              → Bitcoin stale-block tracking
      //   rbf                       → RBF replacements (impossible)
      //   stratum                   → Stratum mining pool dashboard
      //   mining/blocks             → relies on per-pool fingerprinting
      //   lightning                 → Lightning Network (impossible)
      //   blocks*                   → upstream BlocksList expects pool +
      //                               fee-range extras we don't provide;
      //                               redirected to '/' until iter 23
      //                               builds XmrBlocksListModule.
      //
      // Kept: about, terms/privacy/trademark, docs, api, tx, block.
      // Files for the stripped routes remain on disk for git-blame and
      // license compliance; only the routing entries are removed.
      {
        path: 'about',
        loadChildren: () => import('@components/about/about.module').then(m => m.AboutModule),
      },
      // xmr-space: route /blocks back to upstream BlocksList. Our
      // /api/v1/blocks endpoint now returns the upstream `extras`
      // envelope with totalFees / medianFee / feeRange / pool, so the
      // Bitcoin table layout (Pool column with logo, Size progress
      // bar, fee tier coloring) renders correctly against Monero data.
      // XmrBlocksListModule preserved on disk.
      { path: 'blocks/:page', component: BlocksList },
      { path: 'blocks', redirectTo: 'blocks/1' },
      {
        path: 'txs',
        component: RecentTransactionsList,
      },
      {
        path: 'terms-of-service',
        loadChildren: () => import('@components/terms-of-service/terms-of-service.module').then(m => m.TermsOfServiceModule),
      },
      {
        path: 'privacy-policy',
        loadChildren: () => import('@components/privacy-policy/privacy-policy.module').then(m => m.PrivacyPolicyModule),
      },
      {
        path: 'trademark-policy',
        loadChildren: () => import('@components/trademark-policy/trademark-policy.module').then(m => m.TrademarkModule),
      },
      {
        // xmr-space: replace upstream transaction.module (heavily
        // UTXO-shaped) with our public-only XmrTxDetailModule.
        path: 'tx',
        component: StartComponent,
        data: { preload: true, networkSpecific: true },
        loadChildren: () => import('@app/xmr/tx-detail/xmr-tx-detail.module').then(m => m.XmrTxDetailModule),
      },
      {
        // xmr-space: route /block back to upstream BlockModule for full
        // visual parity with mempool.space. Bitcoin-only sub-features
        // are gated by env flags (AUDIT/MINING_DASHBOARD/ACCELERATOR
        // all default false) so the audit comparison and accelerator
        // panels stay hidden. The per-tx vin/vout decoder used by
        // BlockTransactionsComponent will render rows with empty inputs/
        // outputs for Monero txs (RingCT-hidden), which matches the
        // privacy invariant — wallet/key-bearing reveals stay on the
        // tx-detail page.
        path: 'block',
        component: StartComponent,
        data: { preload: true, networkSpecific: true },
        loadChildren: () => import('@components/block/block.module').then(m => m.BlockModule),
      },
      {
        // xmr-space: replace upstream DocsModule (loaded a 13k-line
        // Bitcoin FAQ + REST/WebSocket/Electrum docs file) with a
        // focused XmrDocsModule covering only the docs that apply to
        // this fork. Upstream module preserved on disk.
        path: 'docs',
        loadChildren: () => import('@app/xmr/docs/xmr-docs.module').then(m => m.XmrDocsModule),
        data: { preload: true },
      },
      {
        path: 'api',
        loadChildren: () => import('@app/xmr/docs/xmr-docs.module').then(m => m.XmrDocsModule),
      },
    ],
  }
];

if (window['__env']?.OFFICIAL_MEMPOOL_SPACE) {
  routes[0].children.push({
    path: 'monitoring',
    data: { networks: ['bitcoin', 'liquid'] },
    component: ServerHealthComponent
  });
  routes[0].children.push({
    path: 'nodes',
    data: { networks: ['bitcoin', 'liquid'] },
    component: ServerStatusComponent
  });
  if (window['isMempoolSpaceBuild']) {
    routes[0].children.push({
      path: 'faucet',
      canActivate: [(route: ActivatedRouteSnapshot, state: RouterStateSnapshot) => {
        return state.url.startsWith('/testnet4/');
      }],
      component: StartComponent,
      data: { preload: true, networkSpecific: true },
      children: [{
        path: '',
        data: { networks: ['bitcoin'] },
        component: FaucetComponent,
      }]
    });
  }
}

if (window['__env']?.customize?.dashboard?.widgets?.some(w => w.component ==='simpleproof')) {
  routes[0].children.push({
    path: 'sp/verified',
    component: SimpleProofWidgetComponent,
  });
}

if (window['__env']?.customize?.dashboard?.widgets?.some(w => w.component ==='simpleproof_cubo')) {
  routes[0].children.push({
    path: 'sp/cubo',
    component: SimpleProofCuboWidgetComponent,
  });
}

@NgModule({
  imports: [
    RouterModule.forChild(routes)
  ],
  exports: [
    RouterModule
  ]
})
export class MasterPageRoutingModule { }

@NgModule({
  imports: [
    CommonModule,
    MasterPageRoutingModule,
    SharedModule,
  ],
  declarations: [
    MasterPageComponent,
  ],
  exports: [
    MasterPageComponent,
  ]
})
export class MasterPageModule { }
