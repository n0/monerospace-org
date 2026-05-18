// Bitcoin-era transaction classification flags kept for stripped/unrouted
// upstream helpers that still decode Bitcoin raw transactions.
export const LegacyTransactionFlags = {
  // features
  rbf:                                                         0b00000001n,
  no_rbf:                                                      0b00000010n,
  v1:                                                          0b00000100n,
  v2:                                                          0b00001000n,
  v3:                                                          0b00010000n,
  nonstandard:                                                 0b00100000n,
  // address types
  p2pk:                                               0b00000001_00000000n,
  p2ms:                                               0b00000010_00000000n,
  p2pkh:                                              0b00000100_00000000n,
  p2sh:                                               0b00001000_00000000n,
  p2wpkh:                                             0b00010000_00000000n,
  p2wsh:                                              0b00100000_00000000n,
  p2tr:                                               0b01000000_00000000n,
  // behavior
  cpfp_parent:                               0b00000001_00000000_00000000n,
  cpfp_child:                                0b00000010_00000000_00000000n,
  replacement:                               0b00000100_00000000_00000000n,
  acceleration:                              0b00001000_00000000_00000000n,
  // data
  op_return:                        0b00000001_00000000_00000000_00000000n,
  fake_pubkey:                      0b00000010_00000000_00000000_00000000n,
  inscription:                      0b00000100_00000000_00000000_00000000n,
  fake_scripthash:                  0b00001000_00000000_00000000_00000000n,
  annex:                            0b00010000_00000000_00000000_00000000n,
  // heuristics
  coinjoin:                0b00000001_00000000_00000000_00000000_00000000n,
  consolidation:           0b00000010_00000000_00000000_00000000_00000000n,
  batch_payout:            0b00000100_00000000_00000000_00000000_00000000n,
  // sighash
  sighash_all:    0b00000001_00000000_00000000_00000000_00000000_00000000n,
  sighash_none:   0b00000010_00000000_00000000_00000000_00000000_00000000n,
  sighash_single: 0b00000100_00000000_00000000_00000000_00000000_00000000n,
  sighash_default:0b00001000_00000000_00000000_00000000_00000000_00000000n,
  sighash_acp:    0b00010000_00000000_00000000_00000000_00000000_00000000n,
};
