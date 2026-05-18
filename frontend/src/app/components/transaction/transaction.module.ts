import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { TransactionComponent } from '@components/transaction/transaction.component';
import { TransactionDetailsComponent } from '@components/transaction/transaction-details/transaction-details.component';
import { SharedModule } from '@app/shared/shared.module';
import { TransactionExtrasModule } from '@components/transaction/transaction-extras.module';

const routes: Routes = [
  {
    path: '',
    redirectTo: '/',
    pathMatch: 'full',
  },
  {
    // xmr-space: upstream's raw transaction preview / push / test
    // pages decode Bitcoin PSBT/raw-tx shapes. Keep these child routes
    // from falling through to the generic :id transaction route.
    path: 'preview',
    redirectTo: '/',
    pathMatch: 'full',
  },
  {
    path: 'push',
    redirectTo: '/',
    pathMatch: 'full',
  },
  {
    path: 'test',
    redirectTo: '/',
    pathMatch: 'full',
  },
  {
    path: ':id',
    component: TransactionComponent,
    data: {
      ogImage: true
    }
  }
];

@NgModule({
  imports: [
    RouterModule.forChild(routes)
  ],
  exports: [
    RouterModule
  ]
})
export class TransactionRoutingModule { }

@NgModule({
  imports: [
    CommonModule,
    TransactionRoutingModule,
    SharedModule,
    TransactionExtrasModule,
  ],
  declarations: [
    TransactionComponent,
    TransactionDetailsComponent,
  ],
  exports: [
    TransactionComponent,
    TransactionDetailsComponent,
  ]
})
export class TransactionModule { }



