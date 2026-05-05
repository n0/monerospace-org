import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { GraphsComponent } from '@components/graphs/graphs.component';
import { MempoolBlockComponent } from '@components/mempool-block/mempool-block.component';
import { StartComponent } from '@components/start/start.component';
import { StatisticsComponent } from '@components/statistics/statistics.component';
import { DashboardComponent } from '@app/dashboard/dashboard.component';
import { CustomDashboardComponent } from '@components/custom-dashboard/custom-dashboard.component';
import { CalculatorComponent } from '@components/calculator/calculator.component';

const browserWindow = window || {};
// @ts-ignore
const browserWindowEnv = browserWindow.__env || {};
const isCustomized = browserWindowEnv?.customize?.dashboard;

const routes: Routes = [
  // xmr-space: stripped Bitcoin-only sub-routes from this graphs module:
  //   mining/pool/:slug, mining, acceleration*, address/:id, wallet/:wallet
  //   — all impossible (Monero has no public address tracking, no
  //     accelerator market, our pool fingerprinting is stub-only)
  // Stripped graphs/mining/* (hashrate, pool dominance, block-fees,
  // subsidy, rewards, block-fee-rates, sizes-weights, block-health)
  // because they all depend on Bitcoin-specific indexer state we don't
  // build.
  // Kept: tools/calculator (feasible reuse), mempool-block/:id (works),
  // graphs/mempool (uses our /api/v1/statistics/* time series).
  {
    path: '',
    children: [
      {
        path: 'tools/calculator',
        component: CalculatorComponent
      },
      {
        path: 'mempool-block/:id',
        component: StartComponent,
        children: [
          {
            path: '',
            component: MempoolBlockComponent,
          },
        ]
      },
      {
        path: 'graphs',
        component: GraphsComponent,
        children: [
          {
            path: 'mempool',
            component: StatisticsComponent,
          },
          {
            path: '',
            pathMatch: 'full',
            redirectTo: 'mempool',
          },
        ]
      },
      {
        path: '',
        component: StartComponent,
        children: [{
          path: '',
          component: isCustomized ? CustomDashboardComponent : DashboardComponent,
        }]
      },
    ]
  },
];

// xmr-space: removed OFFICIAL_MEMPOOL_SPACE 'treasuries' branch
// (Bitcoin treasury holdings dashboard, doesn't apply).

@NgModule({
  imports: [RouterModule.forChild(routes)],
})
export class GraphsRoutingModule { }
