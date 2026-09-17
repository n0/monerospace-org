import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { SharedModule } from '@app/shared/shared.module';
import { XmrUswapComponent } from './xmr-uswap.component';

const routes: Routes = [
  {
    path: '',
    component: XmrUswapComponent,
  },
];

@NgModule({
  declarations: [XmrUswapComponent],
  imports: [
    CommonModule,
    RouterModule.forChild(routes),
    SharedModule,
  ],
})
export class XmrUswapModule {}
