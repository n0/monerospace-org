import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Routes } from '@angular/router';
import { XmrDocsComponent } from './xmr-docs.component';

const routes: Routes = [
  {
    path: '',
    component: XmrDocsComponent,
  },
  {
    path: 'faq',
    component: XmrDocsComponent,
  },
  {
    path: 'api',
    component: XmrDocsComponent,
  },
  {
    path: 'api/rest',
    component: XmrDocsComponent,
  },
  {
    path: 'api/websocket',
    component: XmrDocsComponent,
  },
];

@NgModule({
  declarations: [XmrDocsComponent],
  imports: [CommonModule, RouterModule.forChild(routes)],
})
export class XmrDocsModule {}
