import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { XmrStatusComponent } from './xmr-status.component';

const routes: Routes = [
  {
    path: '',
    component: XmrStatusComponent,
  },
];

@NgModule({
  declarations: [XmrStatusComponent],
  imports: [
    CommonModule,
    RouterModule.forChild(routes),
  ],
})
export class XmrStatusModule {}
