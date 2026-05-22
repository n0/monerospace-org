import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { MasterPageComponent } from '@components/master-page/master-page.component';
import { SharedModule } from '@app/shared/shared.module';

import { StartComponent } from '@components/start/start.component';
import { RecentTransactionsList } from '@components/recent-transactions-list/recent-transactions-list.component';
import { BlocksList } from '@components/blocks-list/blocks-list.component';

const routes: Routes = [
  {
    path: '',
    component: MasterPageComponent,
    children: [
      // xmr-space: stripped upstream-only routes from this children list.
      // Each was either UTXO-shaped or unique to mempool's commercial
      // surface and impossible to retarget meaningfully:
      //
      //   tx/push, pushtx, tx/test  → PushTransaction & Testmempoolaccept
      //                               UI: transparent-chain raw-tx hex format,
      //                               vin/vout decoder. Strip; a Monero
      //                               broadcast tool is a future iter.
      //   blocks/stale              → stale-block tracking from the parent app
      //   rbf                       → RBF replacements (impossible)
      //   stratum                   → Stratum mining pool dashboard
      //   mining/blocks             → relies on per-pool fingerprinting
      //   lightning                 → Lightning Network (impossible)
      //   monitoring, nodes, faucet → official parent-app surfaces
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
      {
        // xmr-space: dedicated Monero daemon status page. This replaces
        // upstream's monitoring/status surface with a
        // small view backed by /healthz and /api/v1/info.
        path: 'status',
        loadChildren: () => import('@app/xmr/status/xmr-status.module').then(m => m.XmrStatusModule),
      },
      // xmr-space: route /blocks back to upstream BlocksList. Our
      // /api/v1/blocks endpoint now returns the upstream `extras`
      // envelope with totalFees / medianFee / feeRange / pool, so the
      // parent table layout (Pool column with logo, Size progress
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
        // xmr-space: route /tx back to upstream TransactionModule for
        // visual parity with mempool.space. The upstream component
        // expects vin/vout — our backend returns synthetic placeholders
        // tagged ringct:true so the inputs/outputs section renders
        // (with the values flagged as RingCT-hidden) but doesn't crash.
        // upstream-only sub-features (RBF panel, paid fee-bump panel,
        // CPFP cluster) are gated by env flags and stay hidden. The
        // active XMR proof UI lives in TransactionComponent so there is
        // no separate unrouted tx-detail module accepting private keys.
        path: 'tx',
        component: StartComponent,
        data: { preload: true, networkSpecific: true },
        loadChildren: () => import('@components/transaction/transaction.module').then(m => m.TransactionModule),
      },
      {
        // xmr-space: route /block back to upstream BlockModule for full
        // visual parity with mempool.space. Upstream paid fee-bump and
        // audit paths are stripped; stale-block comparison stays for
        // fork visibility. The per-tx vin/vout decoder used by
        // BlockTransactionsComponent renders rows with empty inputs/
        // outputs for Monero txs (RingCT-hidden), which matches the
        // privacy invariant — wallet/key-bearing reveals stay on the
        // tx-detail page.
        path: 'block',
        component: StartComponent,
        data: { preload: true, networkSpecific: true },
        loadChildren: () => import('@components/block/block.module').then(m => m.BlockModule),
      },
      {
        // xmr-space: replace the upstream FAQ/REST/WebSocket/
        // Electrum docs with a focused XmrDocsModule covering only
        // the docs that apply to this fork.
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

// xmr-space: do not re-add upstream official-instance routes here.
// `monitoring`, `nodes`, and `faucet` are parent-app network surfaces;
// the dedicated Monero daemon-health page lives at `/status` instead
// of reusing those components.
// SimpleProof dashboard-service routes (`sp/verified`, `sp/cubo`) are
// also stripped from the XMR route table. They are external proof
// widgets, not Monero chain-explorer pages; retarget explicitly if
// XMR SPACE ever ships a first-party proof service.

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
