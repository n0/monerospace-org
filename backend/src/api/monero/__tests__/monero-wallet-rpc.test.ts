import { MoneroWalletRpc } from '../monero-wallet-rpc';

describe('MoneroWalletRpc', () => {
  it('calls wallet-rpc check_tx_proof with shareable proof fields', async () => {
    const jsonRpc = jest.fn().mockResolvedValue({
      confirmations: 12,
      good: true,
      in_pool: false,
      received: 1_500_000_000_000,
    });
    const wallet = new MoneroWalletRpc({ jsonRpc });

    const result = await wallet.checkTxProof({
      txid: 'a'.repeat(64),
      address: `4${'A'.repeat(94)}`,
      signature: 'OutProofV1'.padEnd(90, 'x'),
      message: 'invoice-42',
    });

    expect(jsonRpc).toHaveBeenCalledWith('check_tx_proof', {
      txid: 'a'.repeat(64),
      address: `4${'A'.repeat(94)}`,
      signature: 'OutProofV1'.padEnd(90, 'x'),
      message: 'invoice-42',
    });
    expect(result).toEqual({
      confirmations: 12,
      good: true,
      in_pool: false,
      received: 1_500_000_000_000,
    });
  });

  it('omits the optional proof message when empty', async () => {
    const jsonRpc = jest.fn().mockResolvedValue({
      confirmations: 0,
      good: false,
      in_pool: false,
      received: 0,
    });
    const wallet = new MoneroWalletRpc({ jsonRpc });

    await wallet.checkTxProof({
      txid: 'b'.repeat(64),
      address: `8${'B'.repeat(94)}`,
      signature: 'InProofV1'.padEnd(90, 'y'),
    });

    expect(jsonRpc).toHaveBeenCalledWith('check_tx_proof', {
      txid: 'b'.repeat(64),
      address: `8${'B'.repeat(94)}`,
      signature: 'InProofV1'.padEnd(90, 'y'),
    });
  });
});
