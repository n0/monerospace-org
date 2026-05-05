import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClientModule } from '@angular/common/http';
import { RouterModule, Routes } from '@angular/router';
import { XmrBlocksListComponent } from './xmr-blocks-list.component';

const routes: Routes = [
  { path: '', component: XmrBlocksListComponent },
  { path: ':page', component: XmrBlocksListComponent },
];

@NgModule({
  declarations: [XmrBlocksListComponent],
  imports: [CommonModule, HttpClientModule, RouterModule.forChild(routes)],
})
export class XmrBlocksListModule {}
