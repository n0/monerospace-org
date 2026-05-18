import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgxEchartsModule } from 'ngx-echarts';
import { GraphsRoutingModule } from '@app/graphs/graphs.routing.module';
import { SharedModule } from '@app/shared/shared.module';

import { BlockFeesGraphComponent } from '@components/block-fees-graph/block-fees-graph.component';
import { BlockFeesSubsidyGraphComponent } from '@components/block-fees-subsidy-graph/block-fees-subsidy-graph.component';
import { PriceChartComponent } from '@components/price-chart/price-chart.component';
import { BlockRewardsGraphComponent } from '@components/block-rewards-graph/block-rewards-graph.component';
import { BlockFeeRatesGraphComponent } from '@components/block-fee-rates-graph/block-fee-rates-graph.component';
import { BlockSizesWeightsGraphComponent } from '@components/block-sizes-weights-graph/block-sizes-weights-graph.component';
import { FeeDistributionGraphComponent } from '@components/fee-distribution-graph/fee-distribution-graph.component';
import { IncomingTransactionsGraphComponent } from '@components/incoming-transactions-graph/incoming-transactions-graph.component';
import { MempoolGraphComponent } from '@components/mempool-graph/mempool-graph.component';
import { GraphsComponent } from '@components/graphs/graphs.component';
import { StatisticsComponent } from '@components/statistics/statistics.component';
import { MempoolBlockComponent } from '@components/mempool-block/mempool-block.component';
import { DashboardComponent } from '@app/dashboard/dashboard.component';
import { HashrateChartComponent } from '@components/hashrate-chart/hashrate-chart.component';
import { PoolRankingComponent } from '@components/pool-ranking/pool-ranking.component';
import { PoolComponent } from '@components/pool/pool.component';

@NgModule({
  declarations: [
    DashboardComponent,
    MempoolBlockComponent,
    StatisticsComponent,
    GraphsComponent,
    BlockFeesGraphComponent,
    BlockFeesSubsidyGraphComponent,
    PriceChartComponent,
    BlockRewardsGraphComponent,
    BlockFeeRatesGraphComponent,
    BlockSizesWeightsGraphComponent,
    FeeDistributionGraphComponent,
    IncomingTransactionsGraphComponent,
    MempoolGraphComponent,
    HashrateChartComponent,
    PoolRankingComponent,
    PoolComponent,
  ],
  imports: [
    CommonModule,
    SharedModule,
    GraphsRoutingModule,
    NgxEchartsModule.forRoot({
      echarts: () => import('@app/graphs/echarts').then(m => m.echarts),
    })
  ],
  exports: [
    NgxEchartsModule,
  ]
})
export class GraphsModule { }
