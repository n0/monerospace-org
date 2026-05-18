import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { MasterPageComponent } from '@components/master-page/master-page.component';

const routes: Routes = [
  {
    path: '',
    component: MasterPageComponent,
    loadChildren: () => import('@app/graphs/graphs.module').then(m => m.GraphsModule),
    data: { preload: true },
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
export class XmrGraphsShellRoutingModule { }

@NgModule({
  imports: [
    CommonModule,
    XmrGraphsShellRoutingModule,
  ],
})
export class XmrGraphsShellModule { }
