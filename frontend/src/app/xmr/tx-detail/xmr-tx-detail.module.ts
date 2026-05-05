import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClientModule } from '@angular/common/http';
import { RouterModule, Routes } from '@angular/router';
import { XmrTxDetailComponent } from './xmr-tx-detail.component';

const routes: Routes = [
  {
    path: ':id',
    component: XmrTxDetailComponent,
    data: { networkSpecific: true },
  },
];

@NgModule({
  declarations: [XmrTxDetailComponent],
  imports: [CommonModule, FormsModule, HttpClientModule, RouterModule.forChild(routes)],
})
export class XmrTxDetailModule {}
