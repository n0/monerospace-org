import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { SharedModule } from '@app/shared/shared.module';
import { XmrDonateComponent } from './xmr-donate.component';

const routes: Routes = [
  {
    path: '',
    component: XmrDonateComponent,
  },
];

@NgModule({
  declarations: [XmrDonateComponent],
  imports: [
    CommonModule,
    RouterModule.forChild(routes),
    SharedModule,
  ],
})
export class XmrDonateModule {}
