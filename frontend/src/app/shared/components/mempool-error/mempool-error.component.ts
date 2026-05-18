import { Component, Input, OnChanges } from '@angular/core';

export const MempoolErrors = {
  'bad_request': `Your request was not valid. Please try again.`,
  'internal_server_error': `Something went wrong, please try again later`,
  'cannot_decode_raw_tx': `Cannot decode this raw transaction.`,
  'cannot_fetch_raw_tx': `Cannot find this transaction.`,
  'invalid_tx_dependencies': `This transaction dependencies are not valid.`,
  'mempool_rejected_raw_tx': `Our mempool rejected this transaction`,
  'no_mining_pool_available': `No mining pool available at the moment`,
  'not_available': `This feature is not available for your account.`,
  'not_verified': `You must verify your account to use this feature.`,
  'recommended_fees_not_available': `Recommended fees are not available right now.`,
  'too_many_relatives': `This transaction has too many relatives.`,
  'txid_not_in_mempool': `This transaction is not in the mempool.`,
  'unauthorized': `You are not authorized to do this`,
  'faucet_too_soon': `You cannot request any more coins right now. Try again later.`,
  'faucet_not_available': `The faucet is not available right now. Try again later.`,
  'faucet_not_available_no_utxo': `The faucet is not available right now. Please try again once a new block has been mined.`,
  'faucet_maximum_reached': `You are not allowed to request more coins`,
  'faucet_address_not_allowed': `You cannot use this address`,
  'faucet_below_minimum': `Requested amount is too small`,
  'faucet_above_maximum': `Requested amount is too high`,
  'invalid_credentials': `Invalid credentials`,
  'forbidden': `You are not allowed to do this.`,
} as { [error: string]: string };

export function isMempoolError(error: string) {
  return Object.prototype.hasOwnProperty.call(MempoolErrors, error);
}

@Component({
  selector: 'app-mempool-error',
  templateUrl: './mempool-error.component.html',
  standalone: false,
})
export class MempoolErrorComponent implements OnChanges {
  @Input() error = '';
  @Input() alertClass = 'alert-danger';
  @Input() textOnly = false;
  errorContent = '';

  ngOnChanges(): void {
    this.errorContent = isMempoolError(this.error) ? MempoolErrors[this.error] : this.error;
  }
}
