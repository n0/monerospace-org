import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { GraphsComponent } from '@components/graphs/graphs.component';
import { MempoolBlockComponent } from '@components/mempool-block/mempool-block.component';
import { StartComponent } from '@components/start/start.component';
import { StatisticsComponent } from '@components/statistics/statistics.component';
import { DashboardComponent } from '@app/dashboard/dashboard.component';
import { CalculatorComponent } from '@components/calculator/calculator.component';
// xmr-space: re-enabled mining graphs now that XmrChainIndexer
// (xmrchain.net + monerod) hydrates the per-block series the chart
// components consume. Pool ranking is best-effort and only exposes the
// supported attribution pages; dominance stays omitted until the
// historical pool series is complete enough to be honest.
import { HashrateChartComponent } from '@components/hashrate-chart/hashrate-chart.component';
import { PoolRankingComponent } from '@components/pool-ranking/pool-ranking.component';
import { PoolComponent } from '@components/pool/pool.component';
import { BlockFeesGraphComponent } from '@components/block-fees-graph/block-fees-graph.component';
import { BlockRewardsGraphComponent } from '@components/block-rewards-graph/block-rewards-graph.component';
import { BlockFeeRatesGraphComponent } from '@components/block-fee-rates-graph/block-fee-rates-graph.component';
import { BlockSizesWeightsGraphComponent } from '@components/block-sizes-weights-graph/block-sizes-weights-graph.component';
import { BlockFeesSubsidyGraphComponent } from '@components/block-fees-subsidy-graph/block-fees-subsidy-graph.component';
import { PriceChartComponent } from '@components/price-chart/price-chart.component';
import { SwapTickerComponent } from '@components/swap-ticker/swap-ticker.component';

const routes: Routes = [
  // xmr-space: stripped parent-chain-only sub-routes from this graphs module:
  //   mining, acceleration*, address/:id, wallet/:wallet
  //   — all impossible (Monero has no public address tracking, no
  //     paid fee-bump market)
  // Mining graphs are limited to series hydrated by XmrChainIndexer;
  // pool dominance and block-health remain stripped because they need
  // broader historical attribution/audit state we do not build.
  // Kept: tools/calculator (feasible reuse), mempool-block/:id (works),
  // graphs/mempool (uses our /api/v1/statistics/* time series), and
  // graphs/price (uses our durable /api/v1/historical-price XMR series).
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
        path: 'mining/pool/:slug',
        component: PoolComponent,
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
            path: 'price',
            component: PriceChartComponent,
          },
          {
            path: 'swaps',
            component: SwapTickerComponent,
          },
          {
            path: 'mining/hashrate-difficulty',
            component: HashrateChartComponent,
          },
          {
            path: 'mining/pools',
            component: PoolRankingComponent,
          },
          {
            path: 'mining/block-fees',
            component: BlockFeesGraphComponent,
          },
          {
            path: 'mining/block-fees-subsidy',
            component: BlockFeesSubsidyGraphComponent,
          },
          {
            path: 'mining/block-rewards',
            component: BlockRewardsGraphComponent,
          },
          {
            path: 'mining/block-fee-rates',
            component: BlockFeeRatesGraphComponent,
          },
          {
            path: 'mining/block-sizes-weights',
            component: BlockSizesWeightsGraphComponent,
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
          // xmr-space: force the Monero dashboard even when upstream
          // customize.dashboard widgets are present. The custom
          // dashboard can reintroduce address/wallet/SimpleProof
          // widgets that are not public Monero explorer primitives.
          component: DashboardComponent,
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
