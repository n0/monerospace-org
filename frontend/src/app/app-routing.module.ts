import { NgModule } from '@angular/core';
import { CanMatchFn, Route, Routes, RouterModule, UrlSegment } from '@angular/router';
import { AppPreloadingStrategy } from '@app/app.preloading-strategy';

const XMR_GRAPH_SHELL_SEGMENTS = new Set(['graphs', 'mempool-block', 'tools', 'mining']);

const xmrGraphShellCanMatch: CanMatchFn = (_route: Route, segments: UrlSegment[]): boolean => {
  return segments.length === 0 || XMR_GRAPH_SHELL_SEGMENTS.has(segments[0].path);
};

const routes: Routes = [
  {
    path: '',
    canMatch: [xmrGraphShellCanMatch],
    loadChildren: () => import('@app/xmr-graphs-shell.module').then(m => m.XmrGraphsShellModule),
    data: { preload: true },
  },
  {
    path: '',
    loadChildren: () => import('@app/master-page.module').then(m => m.MasterPageModule),
    data: { preload: true },
  },
  // xmr-space: stripped top-level upstream routes that are not safe
  // public Monero features:
  //   tx tracker     -> Bitcoin fee-bump/accelerator/RBF status UI;
  //                     removing it ensures mobile /tx/:hash uses the
  //                     retargeted TransactionModule from MasterPage.
  //   widget/wallet  -> address/wallet tracking is impossible from
  //                     public Monero chain data.
  //   preview*       -> Bitcoin/Liquid/OpenGraph previews include
  //                     address, wallet, pool, and Lightning branches.
  //   clock/view*    -> legacy Bitcoin embed views not part of the
  //                     audited XMR surface.
  //   testnet/signet/regtest/liquid env branches -> Bitcoin/Liquid
  //                     route trees; XMR networks need explicit
  //                     Monero-shaped routing when supported.
  //   preview*       -> removed entirely from the XMR build graph so
  //                     Bitcoin/Liquid/OpenGraph modules are not
  //                     bundled just because env flags exist.
];

if (!window['isMempoolSpaceBuild']) {
  routes.push({
    path: '**',
    redirectTo: ''
  });
}

@NgModule({
  imports: [RouterModule.forRoot(routes, {
    initialNavigation: 'enabledBlocking',
    scrollPositionRestoration: 'disabled',
    anchorScrolling: 'disabled',
    preloadingStrategy: AppPreloadingStrategy
  })],
})
export class AppRoutingModule { }
