import { Component, OnInit } from '@angular/core';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { Router, ActivatedRoute } from '@angular/router';
import { handleDemoRedirect } from '@app/shared/common.utils';

@Component({
  selector: 'app-graphs',
  templateUrl: './graphs.component.html',
  styleUrls: ['./graphs.component.scss'],
  standalone: false,
})
export class GraphsComponent implements OnInit {
  isMainnet = this.stateService.isMainnet();

  constructor(
    public stateService: StateService,
    private websocketService: WebsocketService,
    private router: Router,
    private route: ActivatedRoute
  ) { }

  ngOnInit(): void {
    this.websocketService.want(['blocks']);

    handleDemoRedirect(this.route, this.router);
  }
}
