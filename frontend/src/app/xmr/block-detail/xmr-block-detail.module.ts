import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClientModule } from '@angular/common/http';
import { RouterModule, Routes } from '@angular/router';
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
  imports: [CommonModule, HttpClientModule, RouterModule.forChild(routes)],
})
export class XmrBlockDetailModule {}
