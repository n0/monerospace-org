import { Pipe, PipeTransform } from '@angular/core';
import { StateService } from '@app/services/state.service';

@Pipe({
  name: 'relativeUrl',
  standalone: false,
})
export class RelativeUrlPipe implements PipeTransform {

  constructor(
    _stateService?: StateService,
  ) { }

  transform(value: string, _swapNetwork?: string): string {
    return value;
  }

}
