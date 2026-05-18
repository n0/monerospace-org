import { identifyXmrMinerPoolFromExtra } from '../xmr-miner-fingerprint';

const PUBKEY = Array.from({ length: 32 }, (_, i) => i + 1);
const ROOT = Array.from({ length: 32 }, (_, i) => 255 - i);

function asciiBytes(value: string): number[] {
  return Array.from(Buffer.from(value, 'ascii'));
}

describe('xmr miner fingerprinting', () => {
  it('identifies P2Pool from a valid merge-mining tx-extra tag', () => {
    const pool = identifyXmrMinerPoolFromExtra([
      0x01, ...PUBKEY,
      0x02, 0x04, 0xaa, 0xbb, 0xcc, 0xdd,
      0x03, 0x00, ...ROOT,
    ]);

    expect(pool).toEqual({
      id: 1,
      name: 'P2Pool',
      slug: 'p2pool',
      minerNames: ['P2Pool', 'P2Pool merge-mined sidechain'],
    });
  });

  it('identifies known clear-text pool tags when miners publish one', () => {
    const pool = identifyXmrMinerPoolFromExtra([
      0x01, ...PUBKEY,
      0x02, 0x18, ...asciiBytes('mined-by-MoneroOcean-xmr'),
    ]);

    expect(pool).toEqual({
      id: 3,
      name: 'MoneroOcean',
      slug: 'moneroocean',
      minerNames: ['MoneroOcean'],
    });
  });

  it('does not treat random nonce bytes as a pool fingerprint', () => {
    const pool = identifyXmrMinerPoolFromExtra([
      0x01, ...PUBKEY,
      0x02, 0x06, 0x03, 0xff, 0xee, 0xdd, 0xcc, 0xbb,
    ]);

    expect(pool).toEqual({
      id: 0,
      name: 'unknown',
      slug: 'unknown',
      minerNames: [],
    });
  });
});
