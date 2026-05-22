import { parseMinerProofSvg, xmrMinerPoolFromProofName } from '../xmr-miner-proof-registry';

const VERIFIED_HASH = 'a'.repeat(64);
const MISSING_HASH = 'b'.repeat(64);
const UNAVAILABLE_HASH = 'c'.repeat(64);

describe('XmrMinerProofRegistry parser', () => {
  it('parses proof state, type, pool name, and observer block links from plot.svg', () => {
    const svg = `
      <svg>
        <svg class="block verified txs">
          <a xlink:href="/block/${VERIFIED_HASH}" xlink:title="Block 3200000 from SupportXMR (${VERIFIED_HASH})">
            <use xlink:href="#block-true-viewkey"></use>
          </a>
        </svg>
        <svg class="block unverified txs">
          <a xlink:href="/block/${MISSING_HASH}" xlink:title="Block 3200001 from Pool &amp; Friends (${MISSING_HASH})">
            <use xlink:href="#block-false-missing"></use>
          </a>
        </svg>
        <svg class="block none">
          <a xlink:href="/block/${UNAVAILABLE_HASH}" xlink:title="Orphan Block 3200002 from P2Pool (${UNAVAILABLE_HASH})">
            <use xlink:href="#block-true-none"></use>
          </a>
        </svg>
      </svg>
    `;

    const proofs = parseMinerProofSvg(svg, 'https://blocks.p2pool.observer/');

    expect(proofs.get(VERIFIED_HASH)).toMatchObject({
      status: 'verified',
      type: 'viewkey',
      source: 'blocks.p2pool.observer',
      sourceUrl: `https://blocks.p2pool.observer/block/${VERIFIED_HASH}`,
      registryUrl: 'https://blocks.p2pool.observer/proofs',
      height: 3200000,
      poolName: 'SupportXMR',
      poolSlug: 'supportxmr',
      poolId: 2,
    });
    expect(proofs.get(MISSING_HASH)).toMatchObject({
      status: 'missing',
      poolName: 'Pool & Friends',
      poolSlug: 'pool-and-friends',
    });
    expect(proofs.get(UNAVAILABLE_HASH)).toMatchObject({
      status: 'unavailable',
      poolName: 'P2Pool',
      poolSlug: 'p2pool',
    });
  });

  it('creates stable pool identities for proof-only pool names', () => {
    const first = xmrMinerPoolFromProofName('Example Pool');
    const second = xmrMinerPoolFromProofName('Example Pool');

    expect(first).toEqual(second);
    expect(first.id).toBeGreaterThanOrEqual(10_000);
    expect(first.slug).toBe('example-pool');
  });
});
