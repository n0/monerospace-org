import { mockWebSocketV2, receiveWebSocketMessageFromServer } from '../../support/websocket';

type MockPool = { slug: string; name: string };
type MockBlock = Record<string, unknown>;

const pools = [
  { slug: 'p2pool', name: 'P2Pool' },
  { slug: 'supportxmr', name: 'SupportXMR' },
  { slug: 'moneroocean', name: 'MoneroOcean' },
  { slug: 'nanopool', name: 'Nanopool' },
  { slug: 'hashvault', name: 'HashVault' },
  { slug: 'herominers', name: 'HeroMiners' },
  { slug: '2miners', name: '2Miners' },
];

function blockForPool(pool: MockPool, index: number): MockBlock {
  const now = Math.floor(Date.now() / 1000);

  return {
    id: (index + 1).toString(16).padStart(64, '0'),
    height: 3_700_100 - index,
    version: 0,
    timestamp: now - index * 120,
    bits: 0,
    nonce: 0,
    difficulty: 360_000_000,
    merkle_root: ''.padStart(64, 'a'),
    tx_count: 3 + index,
    size: 120_000 + index * 1_000,
    weight: 120_000 + index * 1_000,
    previousblockhash: ''.padStart(64, 'b'),
    extras: {
      reward: 600_123_456_789,
      totalFees: 123_456_789,
      medianFee: 20_000,
      feeRange: [20_000, 80_000, 320_000],
      pool: {
        id: index + 1,
        name: pool.name,
        slug: pool.slug,
        minerNames: [pool.name],
      },
    },
  };
}

function sendBlocksSnapshot(blocks: MockBlock[]): void {
  cy.window({ timeout: 5_000 })
    .should((win) => {
      expect(win.mockSocket).not.to.equal(undefined);
    })
    .then(() => {
      receiveWebSocketMessageFromServer({
        params: {
          message: {
            contents: JSON.stringify({
              blocks,
              'mempool-blocks': [],
              mempoolInfo: {
                count: 0,
                size: 0,
                vsize: 0,
                usage: 0,
                maxmempool: 300_000_000,
                total_fee: 0,
                mempoolminfee: 20_000,
                minrelaytxfee: 20_000,
              },
              fees: {
                minimumFee: 20_000,
                economyFee: 20_000,
                hourFee: 80_000,
                halfHourFee: 320_000,
                fastestFee: 4_000_000,
              },
              conversions: { USD: 150 },
              transactions: [],
              bytesPerSecond: 0,
              loadingIndicators: { mempool: 100 },
            }),
          },
        },
      });
    });
}

function assertImagesLoaded(selector: string): void {
  cy.get(`${selector} img.mining-pool-logo`).should(($images) => {
    expect($images.length).to.be.greaterThan(0);
    $images.each((_, img) => {
      const image = img as HTMLImageElement;
      expect(image.complete, `${image.currentSrc} loaded`).to.equal(true);
      expect(image.naturalWidth, `${image.currentSrc} natural width`).to.be.greaterThan(0);
      expect(image.naturalHeight, `${image.currentSrc} natural height`).to.be.greaterThan(0);
    });
  });
}

describe('XMR pool logos verification', () => {
  beforeEach(() => {
    mockWebSocketV2();
    cy.intercept('GET', '/api/v1/statistics/*', []);
    cy.intercept('GET', /\/api\/v1\/blocks\/\d+$/, []);
  });

  it('serves all tracked XMR pool logo assets', () => {
    for (const pool of pools) {
      cy.request(`/resources/mining-pools/${pool.slug}.svg`)
        .its('status')
        .should('eq', 200);
    }
  });

  it('renders pool logos in the blocks list with stable sizing', () => {
    const blocks = pools.map(blockForPool);
    cy.intercept('GET', '/api/v1/blocks', blocks);

    cy.viewport(1280, 900);
    cy.visit('/blocks');
    sendBlocksSnapshot(blocks);
    cy.contains('td.pool', 'SupportXMR', { timeout: 10_000 }).should('be.visible');

    assertImagesLoaded('td.pool');

    for (const pool of pools) {
      cy.get(`td.pool img[src$="/${pool.slug}.svg"]`)
        .should('have.css', 'width', '22px')
        .and('have.css', 'height', '22px');
      cy.contains('td.pool', pool.name).should('be.visible');
    }
  });

  it('renders live block pool badges without overflowing the block tile', () => {
    const blocks = pools.map(blockForPool);

    cy.viewport(1280, 900);
    cy.visit('/');
    sendBlocksSnapshot(blocks);
    cy.contains('[data-cy$="-miner"]', '2Miners', { timeout: 10_000 }).should('be.visible');
    cy.get('[data-cy$="-miner"]').should('have.length.at.least', 4);

    assertImagesLoaded('[data-cy$="-miner"]');

    cy.get('[data-cy$="-miner"] .on-pool').each(($badge) => {
      const badgeRect = $badge[0].getBoundingClientRect();
      const blockRect = $badge.closest('.xmr-block')[0].getBoundingClientRect();
      expect(badgeRect.width, $badge.text().trim()).to.be.lessThan(blockRect.width + 1);
      expect(badgeRect.left, $badge.text().trim()).to.be.greaterThan(blockRect.left - 1);
      expect(badgeRect.right, $badge.text().trim()).to.be.lessThan(blockRect.right + 1);
    });

    cy.get('[data-cy$="-miner"] img.mining-pool-logo')
      .should('have.css', 'width', '18px')
      .and('have.css', 'height', '18px');
  });
});
