import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClientModule } from '@angular/common/http';
import { RouterModule, Routes } from '@angular/router';
import { SharedModule } from '@app/shared/shared.module';
import { XmrBlockDetailComponent } from './xmr-block-detail.component';

const routes: Routes = [
  {
    path: ':id',
    component: XmrBlockDetailComponent,
    data: { networkSpecific: true },
  },
];

@NgModule({
  declarations: [XmrBlockDetailComponent],
  // SharedModule re-exports BlockOverviewGraphComponent (the WebGL
  // tile visualization). Pulling that one component manually would
  // require declaring its dependency tree; importing the shared module
  // is the cheap correct path.
  imports: [CommonModule, HttpClientModule, SharedModule, RouterModule.forChild(routes)],
})
export class XmrBlockDetailModule {}
