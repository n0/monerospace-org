import { mockWebSocketV2, receiveWebSocketMessageFromServer } from '../../support/websocket';

const baseModule = Cypress.env('BASE_MODULE');

const TXID = 'a'.repeat(64);
const BLOCK_HASH = 'd'.repeat(64);
const PREVIOUS_BLOCK_HASH = 'e'.repeat(64);
const XMR_PUBLIC_SIGNAL_FLAGS = 0x70000000;
const XMR_ADDRESS = `4${'1'.repeat(94)}`;
const XMR_PROOF_SIGNATURE = `OutProofV2${'c'.repeat(120)}`;
const XMR_PRIVATE_VIEW_KEY = 'a'.repeat(64);
const XMR_TX_SECRET_KEY = 'b'.repeat(64);
const XMR_SCANNER_VECTOR = {
  txid: 'f'.repeat(64),
  address: `4${'1'.repeat(94)}`,
  privateViewKey: '12'.repeat(32),
  txSecretKey: '34'.repeat(32),
  receivedAtomic: '2500000000000',
  confirmations: 7,
};
const XMR_FEES = {
  minimumFee: 20_000,
  economyFee: 20_000,
  hourFee: 80_000,
  halfHourFee: 320_000,
  fastestFee: 4_000_000,
};
const XMR_MEMPOOL_INFO = {
  count: 0,
  size: 0,
  vsize: 0,
  usage: 0,
  maxmempool: 300_000_000,
  total_fee: 0,
  mempoolminfee: 20_000,
  minrelaytxfee: 20_000,
};

function loadedAppScriptUrls(win: Window): string[] {
  const appBundlePattern = /\/(?:(?:runtime|polyfills|main)(?:\.[^/]+)?|(?:\d+|src_app_[^/]+|default-src_app_[^/]+)(?:\.[^/]+)?)\.js(?:$|\?)/;

  return Array.from(new Set(
    win.performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(win.location.origin) && appBundlePattern.test(name))
  ));
}

function expectTextIncludes(source: string, needle: string, context: string): void {
  expect(source.includes(needle), `${context} includes "${needle}"`).to.equal(true);
}

function expectTextExcludes(source: string, needle: string, context: string): void {
  expect(source.includes(needle), `${context} excludes "${needle}"`).to.equal(false);
}

function stubDashboardApis(): void {
  const now = Math.floor(Date.now() / 1000);
  cy.intercept('GET', '/api/v1/init-data', {
    blocks: [],
    'mempool-blocks': [],
    mempoolInfo: XMR_MEMPOOL_INFO,
    fees: XMR_FEES,
    conversions: { USD: 150 },
    transactions: [],
    bytesPerSecond: 0,
  });
  cy.intercept('GET', '/api/v1/statistics/*', []);
  cy.intercept('GET', '/api/mempool/recent', []);
  cy.intercept('GET', '/api/v1/fees/mempool-blocks', []);
  cy.intercept('GET', '/api/v1/fees/recommended', XMR_FEES);
  cy.intercept('GET', '/api/v1/mining/reward-stats/144', {
    startBlock: 3_699_857,
    endBlock: 3_700_000,
    blockCount: 144,
    totalReward: 86_400_000_000_000,
    totalFee: 4_320_000_000,
    totalTx: 288,
  });
  cy.intercept('GET', '/api/v1/difficulty-adjustment', {
    progressPercent: 100,
    difficultyChange: 0,
    estimatedRetargetDate: Date.now(),
    remainingBlocks: 0,
    remainingTime: 0,
    previousRetarget: 0,
    nextRetargetHeight: 0,
    timeAvg: 120_000,
    adjustedTimeAvg: 120_000,
    timeOffset: 0,
    expectedBlocks: 0,
  });
  cy.intercept('GET', '/api/v1/historical-price*', {
    prices: [
      { time: now - 7200, USD: 140, EUR: 130, GBP: 112, CAD: 190, CHF: 126, AUD: 210, JPY: 21_000 },
      { time: now - 3600, USD: 145, EUR: 135, GBP: 116, CAD: 198, CHF: 131, AUD: 222, JPY: 22_000 },
      { time: now, USD: 150, EUR: 140, GBP: 120, CAD: 205, CHF: 135, AUD: 230, JPY: 23_000 },
    ],
    exchangeRates: { USDEUR: 0.93, USDGBP: 0.8, USDCAD: 1.36, USDCHF: 0.9, USDAUD: 1.53, USDJPY: 153 },
  });
}

function stubStatusApis(): void {
  const startTime = Math.floor(Date.now() / 1000) - 7200;
  cy.intercept('GET', '/healthz', {
    ok: true,
    service: 'xmr-space-backend',
  });
  cy.intercept('GET', '/api/v1/info', {
    height: 3_700_001,
    target_height: 3_700_001,
    difficulty: 360_000_000,
    hashrate_hs: 3_000_000,
    mempool_size: 9,
    tx_count: 42_000_000,
    nettype: 'mainnet',
    top_block_hash: BLOCK_HASH,
    block_size_limit: 600_000,
    version: '0.18.4.2-release',
    daemon_status: 'OK',
    synced: true,
    offline: false,
    untrusted: false,
    outgoing_connections_count: 8,
    incoming_connections_count: 12,
    rpc_connections_count: 2,
    white_peerlist_size: 900,
    grey_peerlist_size: 1200,
    start_time: startTime,
    uptime_s: 7200,
    database_size: 180_000_000_000,
    free_space: 900_000_000_000,
    height_without_bootstrap: 3_700_001,
    bootstrap_daemon_address: '',
    was_bootstrap_ever_used: false,
    update_available: false,
  }).as('daemonInfo');
}

function stubSwapTickerApi(): void {
  cy.intercept('GET', '/api/v1/swaps/ticker*', {
    updatedAt: new Date().toISOString(),
    network: {
      id: 'reto',
      name: 'RetoSwap',
      link: 'https://retoswap.com/',
    },
    timePeriod: '24h',
    totals: {
      activePairs: 2,
      xmrVolume: 7037.74,
      recentTrades: 2,
    },
    markets: [{
      source: 'haveno.markets',
      protocol: 'haveno',
      network: 'reto',
      pair: 'BTC_XMR',
      displayPair: 'BTC/XMR',
      counterCurrency: 'BTC',
      price: 195.71,
      high: 207.15,
      low: 132.86,
      changePercent: -0.65,
      xmrVolume: 6977.97,
      counterVolume: 35.13,
      highestBid: null,
      lowestAsk: null,
    }, {
      source: 'haveno.markets',
      protocol: 'haveno',
      network: 'reto',
      pair: 'XMR_USD',
      displayPair: 'XMR/USD',
      counterCurrency: 'USD',
      price: 430.66,
      high: 480,
      low: 363.7,
      changePercent: 8.55,
      xmrVolume: 59.77,
      counterVolume: 25_734.53,
      highestBid: null,
      lowestAsk: null,
    }],
    recentTrades: [{
      source: 'haveno.markets',
      protocol: 'haveno',
      pair: 'BTC_XMR',
      counterCurrency: 'BTC',
      price: 195.71,
      timestamp: Math.floor(Date.now() / 1000) - 60,
      paymentMethod: 'BLOCK_CHAINS_INSTANT',
      xmrVolume: 59.91,
      counterVolume: 0.3061,
    }],
    atomicSwap: {
      protocol: 'eigenwallet',
      label: 'XMR/BTC atomic swaps',
      direction: 'BTC to XMR makers',
      status: 'maker-discovery',
      docsUrl: 'https://docs.eigenwallet.org/usage/market_maker_discovery',
      note: 'Atomic-swap makers advertise through the eigenwallet public registry and libp2p rendezvous discovery instead of a centralized order-book ticker.',
      rendezvousPoints: ['discover.unstoppableswap.net:8888'],
    },
    sources: [
      { name: 'Haveno Markets API', url: 'https://haveno.markets/api' },
      { name: 'eigenwallet maker discovery', url: 'https://docs.eigenwallet.org/usage/market_maker_discovery' },
    ],
  });
}

function stubMiningGraphApis(): void {
  const now = Math.floor(Date.now() / 1000);
  const fees = [
    {
      timestamp: now - 7200,
      avgHeight: 3_700_001,
      avgFees: 40_000_000_000,
      avgRewards: 640_000_000_000,
      avgSubsidy: 600_000_000_000,
      USD: 150,
      EUR: 140,
      GBP: 120,
      CAD: 205,
      CHF: 135,
      AUD: 230,
      JPY: 23_000,
    },
    {
      timestamp: now - 3600,
      avgHeight: 3_700_031,
      avgFees: 60_000_000_000,
      avgRewards: 660_000_000_000,
      avgSubsidy: 600_000_000_000,
      USD: 155,
      EUR: 144,
      GBP: 124,
      CAD: 211,
      CHF: 139,
      AUD: 237,
      JPY: 23_700,
    },
  ];
  cy.intercept('GET', /\/api\/v1\/mining\/blocks\/fees(?:\/[^?]*)?(?:\?.*)?$/, {
    statusCode: 200,
    headers: { 'x-total-count': '52560' },
    body: fees,
  });
  cy.intercept('GET', /\/api\/v1\/mining\/blocks\/rewards(?:\/[^?]*)?(?:\?.*)?$/, {
    statusCode: 200,
    headers: { 'x-total-count': '52560' },
    body: fees.map((row) => ({
      timestamp: row.timestamp,
      avgHeight: row.avgHeight,
      avgRewards: row.avgRewards,
      USD: row.USD,
      EUR: row.EUR,
      GBP: row.GBP,
      CAD: row.CAD,
      CHF: row.CHF,
      AUD: row.AUD,
      JPY: row.JPY,
    })),
  });
}

function stubBlocksListApis(): void {
  cy.intercept('GET', '/api/v1/blocks', [xmrBlock()]);
}

function xmrBlock(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: BLOCK_HASH,
    height: 3_700_000,
    timestamp: now,
    tx_count: 7,
    size: 120_000,
    weight: 120_000,
    difficulty: 360_000_000,
    extras: {
      reward: 600_123_456_789,
      totalFees: 123_456_789,
      medianFee: 20_000,
      feeRange: [20_000, 80_000, 320_000],
      pool: {
        id: 1,
        name: 'P2Pool',
        slug: 'p2pool',
        minerNames: ['P2Pool', 'P2Pool merge-mined sidechain'],
      },
    },
  };
}

function xmrRecentTx(txid: string, fee: number, bytes: number): Record<string, unknown> {
  return {
    txid,
    fee,
    vsize: bytes,
    value: 0,
    rate: fee / bytes,
    flags: XMR_PUBLIC_SIGNAL_FLAGS,
    time: Math.floor(Date.now() / 1000),
  };
}

function stubTransactionApis(txid: string): void {
  cy.intercept('GET', `/api/tx/${txid}`, {
    txid,
    version: 2,
    locktime: 0,
    size: 500,
    weight: 500,
    fee: 123_456,
    vin: [{
      is_coinbase: false,
      ringct: true,
      ring_size: 16,
      key_image: 'b'.repeat(64),
      ring_offsets: [1, 2, 3],
      ring_members: [{
        amount: 0,
        global_index: 42,
        height: 3_699_990,
        txid: 'f'.repeat(64),
        unlocked: true,
        age_blocks: 10,
      }],
      prevout: null,
      scriptsig: '',
      scriptsig_asm: '',
      sequence: 0,
      witness: [],
    }],
    vout: [{
      ringct: true,
      value: 0,
      scriptpubkey: '',
      scriptpubkey_asm: '',
      scriptpubkey_address: '',
      scriptpubkey_type: 'ringct',
    }],
    status: { confirmed: false },
    rct_type: 6,
    has_view_tags: true,
  });
  cy.intercept('GET', '/api/v1/transaction-times*', [0]);
  cy.intercept('GET', `/api/v1/cpfp/${txid}`, {
    ancestors: [],
    descendants: [],
    bestDescendant: null,
    sigops: 0,
    adjustedVsize: 0,
    effectiveFeePerVsize: 0,
  });
  cy.intercept('GET', `/api/v1/tx/${txid}/rbf`, { statusCode: 204, body: '' });
  cy.intercept('GET', `/api/v1/tx/${txid}/cached`, { statusCode: 204, body: '' });
  cy.intercept('GET', `/api/txs/outspends?txids=${txid}`, []);
  cy.intercept('GET', '/api/v1/mining/pools/1m', {
    statusCode: 200,
    headers: { 'x-total-count': '0' },
    body: {
      blockCount: 0,
      lastEstimatedHashrate: 0,
      lastEstimatedHashrate3d: 0,
      lastEstimatedHashrate1w: 0,
      pools: [],
    },
  });
}

function stubBlockApis(blockHash: string): { auditCalls: () => number; accelerationCalls: () => number } {
  const now = Math.floor(Date.now() / 1000);
  let auditCalls = 0;
  let accelerationCalls = 0;

  cy.intercept('GET', `/api/v1/block/${blockHash}`, {
    id: blockHash,
    height: 3_700_000,
    version: 16,
    major_version: 16,
    minor_version: 0,
    timestamp: now,
    bits: 0,
    nonce: 123456,
    difficulty: 1,
    merkle_root: 'f'.repeat(64),
    miner_tx_hash: 'f'.repeat(64),
    tx_count: 1,
    size: 1_800,
    weight: 1_800,
    previousblockhash: PREVIOUS_BLOCK_HASH,
    extras: {
      totalFees: 123_456,
      medianFee: 247,
      feeRange: [120, 180, 247, 320],
      reward: 600_000_123_456,
      pool: null,
      orphans: [],
    },
  });
  cy.intercept('GET', `/api/v1/block/${blockHash}/summary`, [{
    txid: TXID,
    fee: 123_456,
    vsize: 500,
    value: 0,
    rate: 247,
    flags: XMR_PUBLIC_SIGNAL_FLAGS,
    time: now,
  }]);
  cy.intercept('GET', `/api/block/${PREVIOUS_BLOCK_HASH}/txs/0`, []);
  cy.intercept('GET', '/api/v1/block/*/audit-summary', (req) => {
    auditCalls++;
    req.reply({ statusCode: 500, body: { error: 'audit should stay disabled for XMR' } });
  });
  cy.intercept('GET', '/api/v1/accelerations/block/*', (req) => {
    accelerationCalls++;
    req.reply([]);
  });

  return {
    auditCalls: () => auditCalls,
    accelerationCalls: () => accelerationCalls,
  };
}

function sendMinimalSnapshot(overrides: Record<string, unknown> = {}): void {
  cy.window({ timeout: 5_000 })
    .should((win) => {
      expect(win.mockSocket).to.not.be.undefined;
    })
    .then(() => {
      receiveWebSocketMessageFromServer({
        params: {
          message: {
            contents: JSON.stringify({
              blocks: [],
              'mempool-blocks': [],
              mempoolInfo: XMR_MEMPOOL_INFO,
              fees: XMR_FEES,
              conversions: { USD: 150 },
              transactions: [],
              bytesPerSecond: 0,
              loadingIndicators: { mempool: 100 },
              ...overrides,
            }),
          },
        },
      });
    });
}

describe('XMR routing contract', () => {
  if (baseModule === 'mempool') {
    const strippedRoutes = [
      '/widget/wallet',
      '/preview',
      '/clock',
      '/clock/mempool/0',
      `/view/block/${'c'.repeat(64)}`,
      '/view/mempool-block/0',
      '/view/blocks',
      '/monitoring',
      '/nodes',
      '/faucet',
      '/sp/verified',
      '/sp/cubo',
      '/testnet/status',
      '/testnet/widget/wallet',
      '/testnet4/wallet',
      '/signet/mining/blocks',
      '/regtest/widget/wallet',
      '/preview/lightning',
      '/tx/preview',
      '/tx/push',
      '/tx/test',
    ];

    strippedRoutes.forEach((route) => {
      it(`redirects stripped upstream route ${route} to the XMR dashboard`, () => {
        mockWebSocketV2();
        stubDashboardApis();

        cy.visit(route);
        cy.location('pathname', { timeout: 10_000 }).should('eq', '/');
        cy.get('app-dashboard').should('exist');
        cy.get('app-tracker').should('not.exist');
        cy.get('app-address-group').should('not.exist');
      });
    });

    it('serves an XMR-native daemon status page at /status', () => {
      mockWebSocketV2();
      stubStatusApis();

      cy.visit('/status');

      cy.location('pathname', { timeout: 10_000 }).should('eq', '/status');
      cy.wait('@daemonInfo');
      cy.contains('h1', 'Monero daemon status').should('be.visible');
      cy.contains('.status-pill', 'monerod reachable').should('be.visible');
      cy.contains('strong', 'reachable').should('be.visible');
      cy.contains('3,700,001').should('be.visible');
      cy.contains('0 blocks').should('be.visible');
      cy.contains('3 MH/s').should('be.visible');
      cy.get('app-xmr-status').should('exist');
      cy.get('app-server-status').should('not.exist');
      cy.get('app-server-health').should('not.exist');
      cy.get('app-status-view').should('not.exist');
    });

    it('ignores upstream Bitcoin/Liquid network env flags in XMR mode', () => {
      mockWebSocketV2();
      stubDashboardApis();

      cy.visit('/testnet/status', {
        onBeforeLoad(win) {
          const envWindow = win as Window & { __env?: Record<string, unknown> };
          envWindow.__env = {
            ...envWindow.__env,
            TESTNET_ENABLED: true,
            TESTNET4_ENABLED: true,
            SIGNET_ENABLED: true,
            REGTEST_ENABLED: true,
            LIQUID_TESTNET_ENABLED: true,
          };
        },
      });

      cy.location('pathname', { timeout: 10_000 }).should('eq', '/');
      cy.get('app-dashboard').should('exist');
      cy.get('app-status-view').should('not.exist');
      cy.get('app-address-group').should('not.exist');
    });

    it('ignores upstream custom dashboard widgets in XMR mode', () => {
      mockWebSocketV2();
      stubDashboardApis();

      cy.visit('/', {
        onBeforeLoad(win) {
          const envWindow = win as Window & { __env?: Record<string, any> };
          envWindow.__env = {
            ...envWindow.__env,
            customize: {
              dashboard: {
                widgets: [
                  { component: 'address', props: { address: XMR_ADDRESS } },
                  { component: 'simpleproof', props: { key: 'documents', label: 'Documents' } },
                ],
              },
            },
          };
        },
      });

      cy.location('pathname', { timeout: 10_000 }).should('eq', '/');
      cy.get('app-dashboard').should('exist');
      cy.get('app-custom-dashboard').should('not.exist');
      cy.get('app-balance-widget').should('not.exist');
      cy.get('app-simpleproof-widget').should('not.exist');
    });

    it('keeps startup milestone constants retargeted to Monero', () => {
      cy.request('/').then((response) => {
        const html = String(response.body);
        const match = html.match(/src="([^"]*main(?:\.[^"]+)?\.js)"/);
        expect(match, 'main bundle script').to.not.equal(null);
        const mainBundle = match[1].startsWith('/') ? match[1] : `/${match[1]}`;

        cy.request(mainBundle).its('body').then((body) => {
          const js = String(body);
          expectTextIncludes(js, 'The Genesis of Monero', 'bundle');
          expectTextIncludes(js, 'RingCT activation', 'bundle');
          expectTextIncludes(js, 'RandomX activation', 'bundle');
          expectTextIncludes(js, 'Tail emission era', 'bundle');
          expectTextIncludes(js, 'bytesPerSecond', 'bundle');
          expectTextExcludes(js, 'vBytes', 'bundle');
          expectTextExcludes(js, 'vBytesPerSecond', 'bundle');
          expectTextExcludes(js, "Bitcoin's", 'bundle');
          expectTextExcludes(js, 'Block Subsidy has halved', 'bundle');
          expectTextExcludes(js, 'Taproot', 'bundle');
          expectTextExcludes(js, 'Simplicity activation', 'bundle');
          expectTextExcludes(js, 'Explore the full Bitcoin ecosystem', 'bundle');
          expectTextExcludes(js, 'Bitcoin Testnet3', 'bundle');
          expectTextExcludes(js, 'liquid/pegs', 'bundle');
          expectTextExcludes(js, 'liquid/reserves', 'bundle');
          expectTextExcludes(js, 'assets/featured', 'bundle');
          expectTextExcludes(js, 'assets/group', 'bundle');
          expectTextExcludes(js, 'address-prefix', 'bundle');
          expectTextExcludes(js, 'scripthash', 'bundle');
          expectTextExcludes(js, 'BTCPay', 'bundle');
          expectTextExcludes(js, 'payments/bitcoin', 'bundle');
          expectTextExcludes(js, 'accelerator/invoice', 'bundle');
          expectTextExcludes(js, '/acceleration', 'bundle');
          expectTextExcludes(js, '/lightning', 'bundle');
          expectTextExcludes(js, 'track-rbf', 'bundle');
          expectTextExcludes(js, 'track-rbf-summary', 'bundle');
          expectTextExcludes(js, 'track-accelerations', 'bundle');
          expectTextExcludes(js, 'track-address', 'bundle');
          expectTextExcludes(js, 'track-addresses', 'bundle');
          expectTextExcludes(js, 'track-wallet', 'bundle');
          expectTextExcludes(js, 'track-asset', 'bundle');
          expectTextExcludes(js, 'track-stratum', 'bundle');
          expectTextExcludes(js, 'setLightningBasedonUrl', 'bundle');
          expectTextExcludes(js, 'networkSupportsLightning', 'bundle');
          expectTextExcludes(js, 'lightningChanged', 'bundle');
          expectTextExcludes(js, 'startTrackRbf', 'bundle');
          expectTextExcludes(js, 'stopTrackRbf', 'bundle');
          expectTextExcludes(js, 'startTrackRbfSummary', 'bundle');
          expectTextExcludes(js, 'stopTrackRbfSummary', 'bundle');
          expectTextExcludes(js, 'startTrackAccelerations', 'bundle');
          expectTextExcludes(js, 'ensureTrackAccelerations', 'bundle');
          expectTextExcludes(js, 'stopTrackAccelerations', 'bundle');
          expectTextExcludes(js, 'liveAccelerations', 'bundle');
          expectTextExcludes(js, 'accelerations$', 'bundle');
          expectTextExcludes(js, 'rbfInfo', 'bundle');
          expectTextExcludes(js, 'rbfLatest', 'bundle');
          expectTextExcludes(js, 'rbfLatestSummary', 'bundle');
          expectTextExcludes(js, 'rbfTransaction', 'bundle');
          expectTextExcludes(js, 'stratumJob', 'bundle');
          expectTextExcludes(js, 'stratumJobs', 'bundle');
          expectTextExcludes(js, 'STRATUM_ENABLED', 'bundle');
          expectTextExcludes(js, 'utxoSpent', 'bundle');
          expectTextExcludes(js, 'mempoolRemovedTransactions', 'bundle');
          expectTextExcludes(js, 'multiAddressTransactions', 'bundle');
          expectTextExcludes(js, 'walletTransactions', 'bundle');
          expectTextExcludes(js, 'BSQ', 'bundle');
          expectTextExcludes(js, 'Bisq', 'bundle');
          expectTextExcludes(js, 'bisq', 'bundle');
          expectTextExcludes(js, 'bsqPrice', 'bundle');
          expectTextExcludes(js, 'bsq-price', 'bundle');
          expectTextExcludes(js, 'bisq.transaction.browser-title', 'bundle');
          expectTextExcludes(js, 'txReplaced', 'bundle');
          expectTextExcludes(js, 'fullrbf/', 'bundle');
          expectTextExcludes(js, 'replacements/', 'bundle');
          expectTextExcludes(js, '/rbf', 'bundle');
          expectTextExcludes(js, '/cached', 'bundle');
          expectTextExcludes(js, '/api/v1/accelerations/block', 'bundle');
          expectTextExcludes(js, '/api/v1/accelerations/interval', 'bundle');
          expectTextExcludes(js, '/api/v1/accelerations/total', 'bundle');
          expectTextExcludes(js, '/api/v1/accelerations/pool', 'bundle');
          expectTextExcludes(js, '/api/v1/acceleration/request', 'bundle');
          expectTextExcludes(js, '/api/v1/cpfp', 'bundle');
          expectTextExcludes(js, '/api/v1/prevouts', 'bundle');
          expectTextExcludes(js, '/api/v1/mining/pools', 'bundle');
          expectTextExcludes(js, '/api/v1/mining/pool/', 'bundle');
          expectTextExcludes(js, '/api/v1/mining/hashrate/pools', 'bundle');
          expectTextExcludes(js, 'audit-summary', 'bundle');
          expectTextExcludes(js, '/api/v1/mining/blocks/audit/scores', 'bundle');
          expectTextExcludes(js, '/api/v1/mining/blocks/audit/score', 'bundle');
          expectTextExcludes(js, '/api/txs/test', 'bundle');
          expectTextExcludes(js, '/api/v1/txs/package', 'bundle');
          expectTextExcludes(js, '/api/v1/validate-address', 'bundle');
          expectTextExcludes(js, '/api/v1/chain-tips', 'bundle');
          expectTextExcludes(js, '/api/v1/stale-tips', 'bundle');
          expectTextExcludes(js, '/api/v1/treasuries', 'bundle');
          expectTextExcludes(js, '/api/v1/wallet', 'bundle');
          expectTextExcludes(js, '/api/v1/services/sponsors', 'bundle');
          expectTextExcludes(js, '/api/v1/donations', 'bundle');
          expectTextExcludes(js, '/api/v1/translators', 'bundle');
          expectTextExcludes(js, '/api/v1/contributors', 'bundle');
          expectTextExcludes(js, '/api/v1/services/enterprise/info', 'bundle');
          expectTextExcludes(js, 'services/enterprise/images', 'bundle');
          expectTextExcludes(js, 'stats.mempool.space', 'bundle');
          expectTextExcludes(js, 'stats.liquid.network', 'bundle');
          expectTextExcludes(js, 'mempool.ninja', 'bundle');
          expectTextExcludes(js, 'liquid.network', 'bundle');
          expectTextExcludes(js, '.mempool.space', 'bundle');
          expectTextExcludes(js, 'https://mempool.space', 'bundle');
          expectTextExcludes(js, 'getCpfpinfo', 'bundle');
          expectTextExcludes(js, 'getCpfpLocalTx', 'bundle');
          expectTextExcludes(js, 'submitPackage', 'bundle');
          expectTextExcludes(js, 'testTransactions', 'bundle');
          expectTextExcludes(js, 'validateAddress', 'bundle');
          expectTextExcludes(js, 'getWallet', 'bundle');
          expectTextExcludes(js, 'getTreasuries', 'bundle');
          expectTextExcludes(js, 'getStaleTips', 'bundle');
          expectTextExcludes(js, 'getEnterpriseInfo', 'bundle');
          expectTextExcludes(js, 'listPools', 'bundle');
          expectTextExcludes(js, 'getPoolStats', 'bundle');
          expectTextExcludes(js, 'getPoolHashrate', 'bundle');
          expectTextExcludes(js, 'getPoolBlocks', 'bundle');
          expectTextExcludes(js, 'getHistoricalPoolsHashrate', 'bundle');
          expectTextExcludes(js, 'getBlockAudit', 'bundle');
          expectTextExcludes(js, 'getBlockTxAudit', 'bundle');
          expectTextExcludes(js, 'getBlockAuditScores', 'bundle');
          expectTextExcludes(js, 'getBlockAuditScore', 'bundle');
          expectTextExcludes(js, 'blockAuditLoaded', 'bundle');
          expectTextExcludes(js, 'getHistoricalBlocksHealth', 'bundle');
          expectTextExcludes(js, '/api/v1/mining/blocks/predictions', 'bundle');
          expectTextExcludes(js, 'app-block-health-graph', 'bundle');
          expectTextExcludes(js, 'MAINNET_BLOCK_AUDIT_START_HEIGHT', 'bundle');
          expectTextExcludes(js, 'TESTNET_BLOCK_AUDIT_START_HEIGHT', 'bundle');
          expectTextExcludes(js, 'TESTNET4_BLOCK_AUDIT_START_HEIGHT', 'bundle');
          expectTextExcludes(js, 'SIGNET_BLOCK_AUDIT_START_HEIGHT', 'bundle');
          expectTextExcludes(js, 'REGTEST_BLOCK_AUDIT_START_HEIGHT', 'bundle');
          expectTextExcludes(js, 'Matomo', 'bundle');
          expectTextExcludes(js, 'TWIDGET_API', 'bundle');
        });
      });
    });

    it('keeps active dashboard, graph, and search bundles free of stripped upstream labels', () => {
      mockWebSocketV2();
      stubDashboardApis();

      cy.visit('/graphs/price');
      sendMinimalSnapshot();
      cy.get('app-price-chart').should('exist');

      cy.window().then((win) => {
        const jsUrls = loadedAppScriptUrls(win);
        let xmrShellScripts = 0;
        let xmrBlockchainScripts = 0;
        let xmrMempoolBlockScripts = 0;
        let xmrDashboardScripts = 0;
        let xmrGraphScripts = 0;
        let xmrGraphModuleScripts = 0;

        expect(jsUrls, 'loaded js resources').to.not.be.empty;

        cy.wrap(jsUrls).each((url) => {
          cy.request(String(url)).its('body').then((body) => {
            const js = String(body);
            expectTextExcludes(js, 'BitcoinGraphsModule', 'bundle');
            expectTextExcludes(js, 'bitcoin-graphs.module', 'bundle');
            expectTextExcludes(js, 'Mempool Goggles', 'bundle');
            expectTextExcludes(js, 'Mempool Accelerator', 'bundle');
            expectTextExcludes(js, 'Lightning Network Capacity', 'bundle');
            expectTextExcludes(js, 'Acceleration Fees', 'bundle');
            expectTextExcludes(js, 'Block Health', 'bundle');
            expectTextExcludes(js, 'See hashrate and difficulty for the Bitcoin', 'bundle');
            expectTextExcludes(js, 'See Bitcoin feerates', 'bundle');
            if (js.includes('Monero Block / Transaction')) {
              xmrShellScripts++;
              expectTextExcludes(js, 'accelerator', 'bundle');
              expectTextExcludes(js, 'Lightning Nodes', 'bundle');
              expectTextExcludes(js, 'Lightning Channels', 'bundle');
              expectTextExcludes(js, 'Mining Pools', 'bundle');
              expectTextExcludes(js, 'Liquid Asset', 'bundle');
              expectTextExcludes(js, 'Other Network Address', 'bundle');
              expectTextExcludes(js, 'bech32', 'bundle');
            }
            if (js.includes('app-blockchain-blocks')) {
              xmrBlockchainScripts++;
              expectTextExcludes(js, 'bitcoin-block', 'bundle');
              expectTextIncludes(js, 'xmr-block', 'bundle');
            }
            if (js.includes('app-mempool-blocks')) {
              xmrMempoolBlockScripts++;
              expectTextExcludes(js, 'app-acceleration-sparkles', 'bundle');
              expectTextExcludes(js, 'bitcoin-block', 'bundle');
              expectTextIncludes(js, 'xmr-block', 'bundle');
            }
            if (js.includes('app-dashboard')) {
              xmrDashboardScripts++;
              expectTextExcludes(js, 'card-liquid', 'bundle');
              expectTextExcludes(js, 'liquid-indexing', 'bundle');
            }
            if (js.includes('app-hashrate-chart')) {
              xmrGraphScripts++;
              expectTextExcludes(js, '/api/v1/mining/hashrate/pools', 'bundle');
              expectTextExcludes(js, 'getHistoricalPoolsHashrate', 'bundle');
            }
            if (js.includes('app-price-chart')) {
              xmrGraphModuleScripts++;
              expectTextExcludes(js, 'bitcoin-color', 'bundle');
              expectTextExcludes(js, 'bitcoin-satoshis-text', 'bundle');
              expectTextExcludes(js, '/api/v1/mining/hashrate/pools', 'bundle');
              expectTextExcludes(js, 'getHistoricalPoolsHashrate', 'bundle');
              expectTextIncludes(js, 'xmr-color', 'bundle');
            }
          });
        }).then(() => {
          expect(xmrShellScripts, 'loaded XMR shell scripts').to.be.greaterThan(0);
          expect(xmrBlockchainScripts, 'loaded XMR blockchain-strip scripts').to.be.greaterThan(0);
          expect(xmrMempoolBlockScripts, 'loaded XMR mempool-block scripts').to.be.greaterThan(0);
          expect(xmrDashboardScripts, 'loaded XMR dashboard scripts').to.be.greaterThan(0);
          expect(xmrGraphScripts, 'loaded XMR graph scripts').to.be.greaterThan(0);
          expect(xmrGraphModuleScripts, 'loaded XMR graph module scripts').to.be.greaterThan(0);
        });
      });
    });

    it('serves the XMR price graph from the historical series', () => {
      mockWebSocketV2();
      stubDashboardApis();

      cy.visit('/graphs/price');
      sendMinimalSnapshot();

      cy.location('pathname', { timeout: 10_000 }).should('eq', '/graphs/price');
      cy.get('app-price-chart').should('exist');
      cy.contains('XMR Price').should('be.visible');
      cy.contains('Bitcoin Price').should('not.exist');
    });

    it('serves the Haveno and atomic-swap ticker from the graph shell route', () => {
      mockWebSocketV2();
      stubDashboardApis();
      stubSwapTickerApi();

      cy.visit('/graphs/swaps');
      sendMinimalSnapshot();

      cy.location('pathname', { timeout: 10_000 }).should('eq', '/graphs/swaps');
      cy.get('app-swap-ticker').should('exist');
      cy.contains('Swap ticker').should('be.visible');
      cy.contains('RetoSwap').should('be.visible');
      cy.contains('BTC/XMR').should('be.visible');
      cy.contains('XMR/BTC atomic swaps').should('be.visible');
      cy.contains('Maker discovery').should('be.visible');
      cy.contains('Swap goggles').should('be.visible');

      cy.contains('button.goggle-button', 'Fiat').click();
      cy.contains('XMR/USD').should('be.visible');
      cy.contains('BTC/XMR').should('not.exist');
      cy.contains('No recent trades match this goggle.').should('be.visible');

      cy.contains('button.goggle-button', 'XMR/BTC').click();
      cy.contains('BTC/XMR').should('be.visible');
      cy.contains('XMR/USD').should('not.exist');
    });

    it('serves the XMR calculator through the graph shell route', () => {
      mockWebSocketV2();
      stubDashboardApis();

      cy.visit('/tools/calculator');
      sendMinimalSnapshot();

      cy.location('pathname', { timeout: 10_000 }).should('eq', '/tools/calculator');
      cy.get('app-calculator').should('exist');
      cy.get('app-calculator').within(() => {
        cy.contains('XMR').should('be.visible');
        cy.contains('atomic units').should('be.visible');
        cy.contains('BTC').should('not.exist');
        cy.contains('sats').should('not.exist');
      });
    });

    it('serves the recent blocks page with Monero metadata', () => {
      mockWebSocketV2();
      stubDashboardApis();
      stubBlocksListApis();

      cy.visit('/blocks');
      sendMinimalSnapshot({ blocks: [xmrBlock()] });

      cy.location('pathname', { timeout: 10_000 }).should('eq', '/blocks/1');
      cy.get('app-blocks-list').should('exist');
      cy.contains('app-blocks-list a', '3700000').should('be.visible');
      cy.contains('app-blocks-list th', 'Pool').should('be.visible');
      cy.contains('app-blocks-list td.pool', 'P2Pool').should('be.visible');
      cy.get('app-blocks-list')
        .should('not.contain', 'Health')
        .and('not.contain', 'Avg Health')
        .and('not.contain', 'Avg Block Fees');
      cy.get('meta[name="description"]')
        .should('have.attr', 'content')
        .and('contain', 'Monero blocks')
        .and('not.contain', 'Bitcoin')
        .and('not.contain', 'Liquid');
    });

    it('keeps the live recent transactions page on Monero byte units', () => {
      mockWebSocketV2();
      stubDashboardApis();
      const firstTxid = 'b'.repeat(64);
      const secondTxid = 'c'.repeat(64);
      const liveTxid = 'e'.repeat(64);

      cy.visit('/txs');
      cy.scrollTo('top');
      sendMinimalSnapshot({
        transactions: [
          xmrRecentTx(firstTxid, 120_000, 500),
          xmrRecentTx(secondTxid, 240_000, 1_000),
        ],
      });

      cy.location('pathname', { timeout: 10_000 }).should('eq', '/txs');
      cy.get('app-recent-transactions-list').within(() => {
        cy.contains('h1', 'Recent Transactions').should('be.visible');
        cy.contains('a', firstTxid.slice(0, 7)).should('be.visible');
        cy.contains('500 B').should('be.visible');
        cy.contains('ɱ/B').should('be.visible');
        cy.root()
          .should('not.contain', 'vB')
          .and('not.contain', 'vBytes')
          .and('not.contain', 'sat/vB')
          .and('not.contain', 'sats');
      });

      sendMinimalSnapshot({
        transactions: [
          xmrRecentTx(liveTxid, 480_000, 2_000),
        ],
      });
      cy.get('app-recent-transactions-list').contains('a', liveTxid.slice(0, 7)).should('be.visible');
    });

    it('serves the mempool graph with Monero byte units and no stripped clock link', () => {
      mockWebSocketV2();
      stubDashboardApis();

      cy.visit('/graphs/mempool');
      sendMinimalSnapshot();

      cy.location('pathname', { timeout: 10_000 }).should('eq', '/graphs/mempool');
      cy.get('app-statistics').should('exist');
      cy.contains('app-statistics .card-header', 'Mempool by bytes (ɱ/B)').should('be.visible');
      cy.contains('app-statistics .card-header', 'Transaction bytes per second (B/s)').should('be.visible');
      cy.get('app-statistics')
        .should('not.contain', 'Mempool by vBytes')
        .and('not.contain', 'Transaction vBytes per second')
        .and('not.contain', 'sat/vByte')
        .and('not.contain', 'vB/s')
        .and('not.contain', 'WU/s');
      cy.get('app-statistics #btn-clock').should('not.exist');
      cy.get('app-statistics a[href*="/clock/mempool"]').should('not.exist');
    });

    it('shows dashboard fee data in Monero byte units', () => {
      mockWebSocketV2();
      stubDashboardApis();
      const latestBlock = {
        ...xmrBlock(),
        timestamp: Math.floor(Date.now() / 1000) - 120,
      };

      cy.visit('/');
      sendMinimalSnapshot({ bytesPerSecond: 42, blocks: [latestBlock] });

      cy.get('app-blockchain').should('exist');
      cy.get('app-mempool-blocks').should('exist');
      cy.get('app-blockchain-blocks').should('exist');
      cy.get('app-dashboard').contains('Minimum fee').should('be.visible');
      cy.get('app-dashboard').contains('ɱ/B').should('be.visible');
      cy.get('app-fees-box').contains('ɱ/B').should('be.visible');
      cy.contains('app-difficulty .widget-toggler a', 'rewards').click();
      cy.get('app-reward-stats').within(() => {
        cy.contains('Avg Block Fees').should('be.visible');
        cy.contains('Avg Tx Fee').should('be.visible');
        cy.contains('XMR').should('be.visible');
        cy.root()
          .should('not.contain', 'BTC/block')
          .and('not.contain', 'sats/tx');
      });
      cy.get('app-dashboard')
        .should('not.contain', 'native segwit')
        .and('not.contain', '140 vBytes')
        .and('not.contain', 'BTC/block')
        .and('not.contain', 'sats/tx')
        .and('not.contain', 'sat/vByte')
        .and('not.contain', 'vB/s')
        .and('not.contain', 'WU/s');
    });

    it('keeps mempool-block fee display free of Bitcoin SegWit estimates', () => {
      mockWebSocketV2();
      stubDashboardApis();

      cy.visit('/mempool-block/0');
      sendMinimalSnapshot({
        'mempool-blocks': [{
          index: 0,
          blockSize: 1_800,
          blockVSize: 1_800,
          feeRange: [20_000, 80_000, 320_000],
          medianFee: 80_000,
          nTx: 3,
          totalFees: 420_000,
        }],
      });

      cy.location('pathname', { timeout: 10_000 }).should('eq', '/mempool-block/0');
      cy.get('app-mempool-block').should('exist');
      cy.contains('app-mempool-block tr', 'Median fee').within(() => {
        cy.contains('ɱ/B').should('be.visible');
        cy.root().should('not.contain', '$');
      });
      cy.get('app-mempool-block')
        .should('not.contain', 'native segwit')
        .and('not.contain', '140 vBytes')
        .and('not.contain', 'sat/vByte')
        .and('not.contain', 'vBytes');
    });

    it('serves the Monero fee/subsidy graph with indexed fiat prices', () => {
      mockWebSocketV2();
      stubDashboardApis();
      stubMiningGraphApis();

      cy.visit('/graphs/mining/block-fees-subsidy');
      sendMinimalSnapshot();

      cy.location('pathname', { timeout: 10_000 }).should('eq', '/graphs/mining/block-fees-subsidy');
      cy.get('app-block-fees-subsidy-graph').should('exist');
      cy.get('app-block-fees-subsidy-graph .card-header').contains('Block Fees Vs Subsidy').should('be.visible');
      cy.get('app-block-fees-subsidy-graph').should('not.contain', 'BTC');
    });

    it('serves the best-effort Monero mining pool ranking graph', () => {
      mockWebSocketV2();
      stubDashboardApis();
      cy.intercept('GET', /\/api\/v1\/mining\/pools(?:\/[^?]*)?(?:\?.*)?$/, {
        statusCode: 200,
        headers: { 'x-total-count': '144' },
        body: {
          blockCount: 144,
          lastEstimatedHashrate: 3_000_000_000,
          lastEstimatedHashrate3d: 3_000_000_000,
          lastEstimatedHashrate1w: 3_000_000_000,
          pools: [
            {
              poolId: 1,
              poolUniqueId: 1,
              name: 'P2Pool',
              link: 'https://p2pool.io',
              blockCount: 80,
              emptyBlocks: 0,
              rank: 1,
              slug: 'p2pool',
            },
            {
              poolId: 0,
              poolUniqueId: 0,
              name: 'unknown',
              link: '',
              blockCount: 64,
              emptyBlocks: 1,
              rank: 2,
              slug: 'unknown',
            },
          ],
        },
      }).as('poolRanking');

      cy.visit('/graphs/mining/pools');
      sendMinimalSnapshot();

      cy.location('pathname', { timeout: 10_000 }).should('eq', '/graphs/mining/pools');
      cy.wait('@poolRanking');
      cy.get('app-pool-ranking').should('exist');
      cy.contains('app-pool-ranking .card-header', 'Pools Ranking').should('be.visible');
      cy.get('[data-cy="pool-row-p2pool"]').contains('P2Pool').should('be.visible');
      cy.get('[data-cy="pool-row-unknown"]').contains('Unknown').should('be.visible');
      cy.contains('app-pool-ranking', 'GH/s').should('be.visible');
      cy.contains('app-pool-ranking a[href*="/mining/pool/p2pool"]', 'P2Pool').should('be.visible');
      cy.get('app-pool-ranking')
        .should('not.contain', 'Bitcoin')
        .and('not.contain', '10 minutes');
    });

    it('serves best-effort Monero mining pool detail pages', () => {
      const now = Math.floor(Date.now() / 1000);
      mockWebSocketV2();
      stubDashboardApis();
      cy.intercept('GET', '/api/v1/mining/pool/p2pool/hashrate', [
        { timestamp: now - 3600, avgHeight: 3_699_970, avgHashRate: 1_400_000_000, avgHashrate: 1_400_000_000, share: 0.45, poolName: 'P2Pool', poolSlug: 'p2pool' },
        { timestamp: now, avgHeight: 3_700_000, avgHashRate: 1_600_000_000, avgHashrate: 1_600_000_000, share: 0.53, poolName: 'P2Pool', poolSlug: 'p2pool' },
      ]).as('poolHashrate');
      cy.intercept('GET', '/api/v1/mining/pool/p2pool', {
        pool: {
          id: 1,
          poolId: 1,
          unique_id: 1,
          uniqueId: 1,
          poolUniqueId: 1,
          name: 'P2Pool',
          link: '',
          regexes: ['P2Pool', 'P2Pool merge-mined sidechain'],
          addresses: [],
          emptyBlocks: 0,
          slug: 'p2pool',
        },
        blockCount: { all: 80, '24h': 12, '1w': 80 },
        blockShare: { all: 0.5, '24h': 0.53, '1w': 0.51 },
        estimatedHashrate: 1_600_000_000,
        totalReward: 48_000_000_000_000,
      }).as('poolStats');
      cy.intercept('GET', '/api/v1/mining/pool/p2pool/blocks*', [{
        id: BLOCK_HASH,
        height: 3_700_000,
        version: 0,
        timestamp: now,
        bits: 0,
        nonce: 0,
        difficulty: 360_000_000,
        merkle_root: '',
        tx_count: 7,
        size: 120_000,
        weight: 120_000,
        previousblockhash: PREVIOUS_BLOCK_HASH,
        extras: {
          reward: 600_123_456_789,
          totalFees: 123_456_789,
          pool: {
            id: 1,
            name: 'P2Pool',
            slug: 'p2pool',
            minerNames: ['P2Pool'],
          },
        },
      }]).as('poolBlocks');

      cy.visit('/mining/pool/p2pool');
      sendMinimalSnapshot();

      cy.location('pathname', { timeout: 10_000 }).should('eq', '/mining/pool/p2pool');
      cy.wait(['@poolHashrate', '@poolStats', '@poolBlocks']);
      cy.get('app-pool').should('exist');
      cy.get('[data-cy="pool-detail-p2pool"]').contains('h1', 'P2Pool').should('be.visible');
      cy.contains('app-pool', 'P2Pool merge-mined sidechain').should('be.visible');
      cy.contains('app-pool', 'GH/s').should('be.visible');
      cy.get('[data-cy="pool-block-3700000"]').contains('3700000').should('be.visible');
      cy.get('app-pool')
        .should('not.contain', 'Addresses')
        .and('not.contain', 'Merkle Branches')
        .and('not.contain', 'Coinbase tag')
        .and('not.contain', 'Stratum')
        .and('not.contain', 'Bitcoin');
    });

    it('keeps mobile transaction status links on the XMR transaction detail route', () => {
      cy.viewport('iphone-x');
      mockWebSocketV2();
      stubDashboardApis();
      stubTransactionApis(TXID);

      cy.visit(`/tx/${TXID}?mode=status`);
      sendMinimalSnapshot();

      cy.location('pathname', { timeout: 10_000 }).should('eq', `/tx/${TXID}`);
      cy.get('app-transaction').should('exist');
      cy.get('app-tracker').should('not.exist');
      cy.contains('h2', 'Payment verification').should('be.visible');
    });

    it('marks a mempool transaction confirmed from the XMR websocket block broadcast', () => {
      mockWebSocketV2();
      stubDashboardApis();
      stubTransactionApis(TXID);
      const previousTip = xmrBlock();
      const confirmingBlock = {
        ...xmrBlock(),
        id: BLOCK_HASH,
        height: 3_700_001,
        timestamp: Math.floor(Date.now() / 1000),
        previousblockhash: previousTip.id,
      };

      cy.visit(`/tx/${TXID}`);
      sendMinimalSnapshot({ blocks: [previousTip] });

      cy.contains('app-confirmations button', 'Unconfirmed').should('be.visible');

      receiveWebSocketMessageFromServer({
        params: {
          message: {
            contents: JSON.stringify({
              block: confirmingBlock,
              txConfirmed: TXID,
            }),
          },
        },
      });

      cy.contains('app-confirmations button', '1 confirmation').should('be.visible');
      cy.contains('app-transaction', 'Unconfirmed').should('not.exist');
    });

    it('keeps transaction proof verification scoped to non-secret tx_proof data', () => {
      mockWebSocketV2();
      stubDashboardApis();
      stubTransactionApis(TXID);
      cy.intercept('POST', `/api/tx/${TXID}/verify-proof`, (req) => {
        expect(req.body).to.deep.equal({
          address: XMR_ADDRESS,
          message: 'invoice-123',
          signature: XMR_PROOF_SIGNATURE,
        });
        expect(req.body).not.to.have.property('privateViewKey');
        expect(req.body).not.to.have.property('txSecretKey');
        req.reply({
          statusCode: 503,
          body: {
            ok: false,
            message: 'tx_proof verification requires monero-wallet-rpc',
          },
        });
      }).as('verifyProof');

      cy.visit(`/tx/${TXID}`);
      sendMinimalSnapshot();

      cy.contains('h2', 'Payment verification').should('be.visible');
      cy.contains('tx_proof verification uses the backend wallet RPC').should('be.visible');
      cy.get('#xmr-proof-form').within(() => {
        cy.get('input[type="password"]').should('not.exist');
        cy.contains('label', /private view key/i).should('not.exist');
        cy.contains('label', /tx_secret_key/i).should('not.exist');
      });

      cy.get('#xmr-proof-form button[type="submit"]').click();
      cy.contains('#xmr-proof-result', 'Address and tx_proof signature are required.').should('be.visible');

      cy.get('#xmr-proof-address').clear().type('not-an-address');
      cy.get('#xmr-proof-signature').clear().type(XMR_PROOF_SIGNATURE);
      cy.get('#xmr-proof-form button[type="submit"]').click();
      cy.contains('#xmr-proof-result', 'Enter a valid-looking Monero mainnet address.').should('be.visible');

      cy.get('#xmr-proof-address').clear().type(XMR_ADDRESS);
      cy.get('#xmr-proof-signature').clear().type('short');
      cy.get('#xmr-proof-form button[type="submit"]').click();
      cy.contains('#xmr-proof-result', 'Enter the tx_proof signature generated by a Monero wallet.').should('be.visible');

      cy.get('#xmr-proof-message').clear().type('invoice-123');
      cy.get('#xmr-proof-signature').clear().type(XMR_PROOF_SIGNATURE);
      cy.get('#xmr-proof-form button[type="submit"]').click();
      cy.wait('@verifyProof');
      cy.contains('#xmr-proof-result', 'tx_proof verification requires monero-wallet-rpc').should('be.visible');
    });

    it('keeps view-key and tx_secret_key scanner inputs browser-local on validation failures', () => {
      let apiPosts = 0;
      mockWebSocketV2();
      stubDashboardApis();
      stubTransactionApis(TXID);
      cy.intercept('POST', '/api/**', (req) => {
        apiPosts++;
        const serialized = JSON.stringify(req.body ?? {});
        expect(serialized).not.to.include(XMR_PRIVATE_VIEW_KEY);
        expect(serialized).not.to.include(XMR_TX_SECRET_KEY);
        req.reply({ statusCode: 500, body: { error: 'unexpected POST during local validation' } });
      });

      cy.visit(`/tx/${TXID}`);
      sendMinimalSnapshot();

      cy.contains('h2', 'Payment verification').should('be.visible');
      cy.contains('button', 'Received').click();
      cy.get('#xmr-local-receive-form').within(() => {
        cy.contains('label', 'Private view key').should('be.visible');
        cy.get('#xmr-local-receive-address').type(XMR_ADDRESS);
        cy.get('#xmr-local-view-key').type(XMR_PRIVATE_VIEW_KEY).clear().type('short');
        cy.contains('button', 'Scan this tx').click();
      });
      cy.contains('#xmr-local-result', 'Enter a 64-character hexadecimal private view key.').should('be.visible');

      cy.contains('button', 'tx_secret_key').click();
      cy.get('#xmr-tx-secret-form').within(() => {
        cy.contains('label', 'tx_secret_key').should('be.visible');
        cy.get('#xmr-tx-secret-address').type(XMR_ADDRESS);
        cy.get('#xmr-tx-secret-key').type(XMR_TX_SECRET_KEY).clear().type('not-hex');
        cy.contains('button', 'Check key').click();
      });
      cy.contains('#xmr-local-result', 'Enter the hexadecimal tx_secret_key from the sending wallet.').should('be.visible');

      cy.window().then((win) => {
        const localStorageValues = Object.keys(win.localStorage).map((key) => win.localStorage.getItem(key)).join('\n');
        const sessionStorageValues = Object.keys(win.sessionStorage).map((key) => win.sessionStorage.getItem(key)).join('\n');
        expect(localStorageValues).not.to.include(XMR_PRIVATE_VIEW_KEY);
        expect(localStorageValues).not.to.include(XMR_TX_SECRET_KEY);
        expect(sessionStorageValues).not.to.include(XMR_PRIVATE_VIEW_KEY);
        expect(sessionStorageValues).not.to.include(XMR_TX_SECRET_KEY);
      });
      cy.wrap(null).should(() => expect(apiPosts).to.equal(0));
    });

    it('runs browser-local view-key and tx_secret_key scanner vectors without leaking secrets', () => {
      let apiPosts = 0;
      mockWebSocketV2();
      stubDashboardApis();
      stubTransactionApis(XMR_SCANNER_VECTOR.txid);
      cy.intercept('POST', '/api/**', (req) => {
        apiPosts++;
        const serialized = JSON.stringify(req.body ?? {});
        expect(serialized).not.to.include(XMR_SCANNER_VECTOR.privateViewKey);
        expect(serialized).not.to.include(XMR_SCANNER_VECTOR.txSecretKey);
        req.reply({ statusCode: 500, body: { error: 'unexpected POST during local scanner vector' } });
      });

      cy.visit(`/tx/${XMR_SCANNER_VECTOR.txid}`, {
        onBeforeLoad(win) {
          const testWindow = win as Window & {
            __xmrScannerCalls?: Array<Record<string, unknown>>;
            __xmrMoneroTsLoader?: () => Promise<unknown>;
          };
          testWindow.__xmrScannerCalls = [];
          testWindow.__xmrMoneroTsLoader = async () => ({
            MoneroNetworkType: { MAINNET: 0, TESTNET: 1, STAGENET: 2 },
            createWalletFull: async (options: Record<string, unknown>) => {
              testWindow.__xmrScannerCalls.push({ method: 'createWalletFull', options });
              return {
                scanTxs: async (txids: string[]) => {
                  testWindow.__xmrScannerCalls.push({ method: 'scanTxs', txids });
                },
                getTxs: async (query: Record<string, unknown>) => {
                  testWindow.__xmrScannerCalls.push({ method: 'getTxs', query });
                  return [{
                    getIncomingAmount: () => BigInt(XMR_SCANNER_VECTOR.receivedAtomic),
                    getNumConfirmations: () => XMR_SCANNER_VECTOR.confirmations,
                    getInTxPool: () => false,
                  }];
                },
                checkTxKey: async (txid: string, txSecretKey: string, address: string) => {
                  testWindow.__xmrScannerCalls.push({ method: 'checkTxKey', txid, txSecretKey, address });
                  return {
                    getReceivedAmount: () => BigInt(XMR_SCANNER_VECTOR.receivedAtomic),
                    getNumConfirmations: () => XMR_SCANNER_VECTOR.confirmations,
                    getInTxPool: () => false,
                  };
                },
                close: async (save: boolean) => {
                  testWindow.__xmrScannerCalls.push({ method: 'close', save });
                },
              };
            },
          });
        },
      });
      sendMinimalSnapshot();

      cy.contains('h2', 'Payment verification').should('be.visible');
      cy.contains('button', 'Received').click();
      cy.get('#xmr-local-receive-form').within(() => {
        cy.get('#xmr-local-receive-address').type(XMR_SCANNER_VECTOR.address);
        cy.get('#xmr-local-view-key').type(XMR_SCANNER_VECTOR.privateViewKey);
        cy.contains('button', 'Scan this tx').click();
      });
      cy.contains('#xmr-local-result', 'Payment found').should('be.visible');
      cy.contains('#xmr-local-result', `${XMR_SCANNER_VECTOR.confirmations} confirmations`).should('be.visible');

      cy.contains('button', 'tx_secret_key').click();
      cy.get('#xmr-tx-secret-form').within(() => {
        cy.get('#xmr-tx-secret-address').type(XMR_SCANNER_VECTOR.address);
        cy.get('#xmr-tx-secret-key').type(XMR_SCANNER_VECTOR.txSecretKey);
        cy.contains('button', 'Check key').click();
      });
      cy.contains('#xmr-local-result', 'Payment found').should('be.visible');
      cy.contains('#xmr-local-result', `${XMR_SCANNER_VECTOR.confirmations} confirmations`).should('be.visible');

      cy.window().then((win) => {
        const testWindow = win as Window & { __xmrScannerCalls?: Array<Record<string, unknown>> };
        const calls = testWindow.__xmrScannerCalls ?? [];
        expect(calls.filter((call) => call.method === 'createWalletFull')).to.have.length(2);
        expect(calls).to.deep.include({ method: 'scanTxs', txids: [XMR_SCANNER_VECTOR.txid] });
        expect(calls).to.deep.include({
          method: 'checkTxKey',
          txid: XMR_SCANNER_VECTOR.txid,
          txSecretKey: XMR_SCANNER_VECTOR.txSecretKey,
          address: XMR_SCANNER_VECTOR.address,
        });
        expect(calls.filter((call) => call.method === 'close')).to.have.length(2);
      });
      cy.wrap(null).should(() => expect(apiPosts).to.equal(0));
    });

    it('keeps active transaction details on XMR units and disables Bitcoin fee-bump surfaces', () => {
      mockWebSocketV2();
      stubDashboardApis();
      stubTransactionApis(TXID);

      cy.visit(`/tx/${TXID}`, {
        onBeforeLoad(win) {
          const envWindow = win as Window & { __env?: Record<string, unknown> };
          envWindow.__env = {
            ...envWindow.__env,
            MINING_DASHBOARD: true,
          };
        },
      });
      sendMinimalSnapshot();

      cy.location('pathname', { timeout: 10_000 }).should('eq', `/tx/${TXID}`);
      cy.get('app-transaction').should('exist');
      cy.contains('h2', 'Payment verification').should('be.visible');
      cy.contains('tr', 'Fee rate').within(() => {
        cy.contains(/246\.9|247/).should('be.visible');
        cy.contains('ɱ/B').should('be.visible');
        cy.contains(/987|988/).should('not.exist');
      });
      cy.contains('tr', 'Weight').contains('500 B').should('be.visible');
      cy.get('app-transactions-list').within(() => {
        cy.contains('Ring 16').should('be.visible');
        cy.contains('RingCT output').should('be.visible');
        cy.get('.xmr-amount-blur')
          .should('have.attr', 'aria-label', 'Amount hidden by RingCT');
      });
      cy.contains('button', 'Details').click();
      cy.get('app-transactions-list').within(() => {
        cy.contains('td', 'Key image').should('be.visible');
        cy.contains('td', 'Ring members').should('be.visible');
        cy.contains('.xmr-ring-member', 'h 3,699,990').should('be.visible');
        cy.contains('td', 'Hidden by RingCT').should('be.visible');
        cy.contains('td', 'Hidden by stealth addressing').should('be.visible');
      });
      [
        'Virtual size',
        'Adjusted vsize',
        'Sigops',
        'CPFP',
        'Cluster',
        'Related Transactions',
        'Flow',
        'Show diagram',
        'RBF Timeline',
        'RBF',
        'Accelerate',
        'Expected in Block',
        'BIP-30',
        'SegWit',
        'Taproot',
        'Liquid',
        'ScriptSig',
        'Witness',
        'ScriptPubKey',
        'P2PK',
        'OP_RETURN',
        'Runestone',
        'Inscription',
        'address poisoning',
        'Sighash',
        'Mempool Accelerator',
        'sat/vB',
        'vBytes',
        'WU',
      ].forEach((text) => {
        cy.get('app-transaction').should('not.contain', text);
      });
      cy.window().then((win) => {
        const jsUrls = loadedAppScriptUrls(win);
        let transactionModuleScripts = 0;
        let transactionListScripts = 0;

        cy.wrap(jsUrls).each((url) => {
          cy.request(String(url)).its('body').then((body) => {
            const js = String(body);
            expectTextExcludes(js, 'address-prefix', 'bundle');
            expectTextExcludes(js, 'scripthash', 'bundle');
            expectTextExcludes(js, '/api/address/', 'bundle');
            expectTextExcludes(js, '/api/addresses', 'bundle');
            if (js.includes('app-transaction')) {
              transactionModuleScripts++;
              expectTextExcludes(js, 'accelerator', 'bundle');
            }
            if (js.includes('app-transactions-list')) {
              transactionListScripts++;
              expectTextIncludes(js, 'atomic', 'bundle');
            }
          });
        }).then(() => {
          expect(transactionModuleScripts, 'loaded transaction module scripts').to.be.greaterThan(0);
          expect(transactionListScripts, 'loaded transaction-list scripts').to.be.greaterThan(0);
        });
      });
    });

    it('keeps active block details free of Bitcoin audit and segwit fee hints', () => {
      mockWebSocketV2();
      stubDashboardApis();
      const blockStubs = stubBlockApis(BLOCK_HASH);

      cy.visit(`/block/${BLOCK_HASH}`, {
        onBeforeLoad(win) {
          win.performance.clearResourceTimings();
          const envWindow = win as Window & { __env?: Record<string, unknown> };
          envWindow.__env = {
            ...envWindow.__env,
            MINING_DASHBOARD: true,
          };
        },
      });
      sendMinimalSnapshot();

      cy.location('pathname', { timeout: 10_000 }).should('eq', `/block/${BLOCK_HASH}`);
      cy.get('app-block').should('exist');
      cy.contains('a.block-link', '3700000').should('be.visible');
      cy.contains('tr', 'Weight').contains(/1\.8 kB|1,800 B/).should('be.visible');
      cy.contains('tr', 'Median fee').contains('ɱ/B').should('be.visible');
      cy.contains('button', 'Details').click();
      cy.contains('tr', 'Major version').contains('16').should('be.visible');
      cy.contains('tr', 'Minor version').contains('0').should('be.visible');
      cy.contains('tr', 'Miner tx hash').contains('fffffffffffff').should('be.visible');
      cy.contains('tr', 'Nonce').contains('123456').should('be.visible');
      cy.get('app-block-filters .menu-toggle').first().click({ force: true });
      cy.get('app-block-filters').within(() => {
        cy.contains('Monero public signals').should('be.visible');
        cy.contains('Standard ring (16)').should('be.visible');
        cy.contains('View tags').should('be.visible');
        cy.contains('RCT v6 (latest)').should('be.visible');
      });
      [
        'Health',
        'Audit',
        'Expected Block',
        'Actual Block',
        'Taproot',
        'Bits',
        'Merkle root',
        'Virtual size',
        'Effective fee rate',
        'Accelerated fee rate',
        'RBF enabled',
        'CPFP',
        'OP_RETURN',
        'Sighash',
        'native segwit',
        'vBytes',
        'WU',
      ].forEach((text) => {
        cy.get('app-block').should('not.contain', text);
      });
      cy.wrap(null).should(() => {
        expect(blockStubs.auditCalls()).to.eq(0);
        expect(blockStubs.accelerationCalls()).to.eq(0);
      });
      cy.window().then((win) => {
        const jsUrls = loadedAppScriptUrls(win);
        let blockModuleScripts = 0;

        expect(jsUrls, 'loaded block js resources').to.not.be.empty;

        cy.wrap(jsUrls).each((url) => {
          cy.request(String(url)).its('body').then((body) => {
            const js = String(body);
            if (!js.includes('app-block')) {
              return;
            }
            blockModuleScripts++;
            expectTextExcludes(js, 'Block Health', 'bundle');
            expectTextExcludes(js, 'address-prefix', 'bundle');
            expectTextExcludes(js, 'scripthash', 'bundle');
            expectTextExcludes(js, 'freshcpfp', 'bundle');
            expectTextExcludes(js, 'fullrbf', 'bundle');
            expectTextExcludes(js, 'sigop', 'bundle');
            expectTextExcludes(js, '"rbf"', 'bundle');
            expectTextExcludes(js, '8f5ff6', 'bundle');
            expectTextExcludes(js, '/api/v1/accelerations/block', 'bundle');
            expectTextExcludes(js, 'audit-summary', 'bundle');
            expectTextExcludes(js, '/api/v1/mining/blocks/audit/scores', 'bundle');
            expectTextExcludes(js, 'getBlockAudit', 'bundle');
            expectTextExcludes(js, 'blockAuditLoaded', 'bundle');
            expectTextExcludes(js, 'Avg Health', 'bundle');
            expectTextExcludes(js, 'latest-blocks.health', 'bundle');
            expectTextExcludes(js, 'health-badge', 'bundle');
            expectTextExcludes(js, 'fee-delta', 'bundle');
          });
        }).then(() => {
          expect(blockModuleScripts, 'loaded block module scripts').to.be.greaterThan(0);
        });
      });
    });

    it('keeps search typeahead scoped to Monero primitives', () => {
      let addressPrefixCalls = 0;
      let lightningSearchCalls = 0;
      let miningPoolCalls = 0;

      mockWebSocketV2();
      stubDashboardApis();
      cy.intercept('GET', '/api/address-prefix/**', (req) => {
        addressPrefixCalls++;
        req.reply([]);
      });
      cy.intercept('GET', '/api/v1/lightning/search*', (req) => {
        lightningSearchCalls++;
        req.reply({ nodes: [], channels: [] });
      });
      cy.intercept('GET', '/api/v1/mining/pools*', (req) => {
        miningPoolCalls++;
        req.reply([]);
      });

      cy.visit('/about');
      cy.get('input[placeholder="Search a Monero block height, block hash, or tx hash"]').as('search');
      cy.get('form[role="search"][aria-label="Monero chain search"]').should('exist');
      cy.get('@search')
        .should('have.attr', 'aria-label', 'Search a Monero block height, block hash, or tx hash')
        .and('have.attr', 'aria-autocomplete', 'list')
        .and('have.attr', 'aria-controls', 'xmr-search-results-listbox')
        .and('have.attr', 'autocomplete', 'off')
        .and('have.attr', 'spellcheck', 'false');
      cy.get('button.search-submit')
        .should('have.attr', 'aria-label', 'Search Monero chain')
        .and('have.attr', 'title', 'Search Monero chain');

      cy.get('@search').type('pool');
      cy.wait(350);
      cy.wrap(null).should(() => {
        expect(addressPrefixCalls).to.eq(0);
        expect(lightningSearchCalls).to.eq(0);
        expect(miningPoolCalls).to.eq(0);
      });
      cy.get('app-search-results').should('not.contain', 'Mining Pools');
      cy.get('app-search-results').should('not.contain', 'Lightning Nodes');
      cy.get('app-search-results').should('not.contain', 'Address');

      cy.get('@search').clear().type('2024-01-01');
      cy.wait(350);
      cy.get('app-search-results').should('not.contain', 'Date');
      cy.get('app-search-results').should('not.contain', 'Timestamp');

      cy.get('@search').clear().type(TXID);
      cy.contains('.card-title', 'Monero Block / Transaction').should('be.visible');
      cy.get('#xmr-search-results-listbox').should('have.attr', 'role', 'listbox');
      cy.get('#xmr-search-results-listbox [role="option"]').first().should('have.attr', 'aria-selected', 'true');
    });

    it('routes 64-hex search submissions through the Monero block probe', () => {
      mockWebSocketV2();
      stubDashboardApis();
      stubTransactionApis(TXID);
      cy.intercept('GET', `/api/v1/block/${TXID}`, { statusCode: 404, body: { error: 'not found' } }).as('blockProbe');

      cy.visit('/about');
      cy.get('input[placeholder="Search a Monero block height, block hash, or tx hash"]').type(`${TXID}{enter}`);

      cy.wait('@blockProbe');
      cy.location('pathname', { timeout: 10_000 }).should('eq', `/tx/${TXID}`);
      cy.get('app-transaction').should('exist');
    });

    it('documents the active XMR API surface instead of upstream Bitcoin APIs', () => {
      mockWebSocketV2();
      stubDashboardApis();

      cy.visit('/docs/api/rest');

      cy.location('pathname', { timeout: 10_000 }).should('eq', '/docs/api/rest');
      cy.get('app-xmr-docs').should('exist');
      cy.get('app-api-docs').should('not.exist');
      cy.contains('h2', 'REST API').should('be.visible');

      [
        '/api/v1/init-data',
        '/api/v1/difficulty-adjustment',
        '/api/v1/historical-price',
        '/api/v1/mempool',
        '/api/v1/block/:hash/summary',
        '/api/v1/fees/mempool-blocks',
        '/api/v1/mining/hashrate/:period',
        '/api/v1/mining/blocks/fees/:period',
        '/api/v1/mining/blocks/rewards/:period',
        '/api/v1/mining/blocks/fee-rates/:period',
        '/api/v1/mining/blocks/sizes-weights/:period',
        '/api/v1/mining/reward-stats/:blockCount',
        '/api/v1/mining/pools/:period',
        '/api/v1/mining/pool/:slug',
      ].forEach((endpoint) => {
        cy.contains('code', endpoint).should('be.visible');
      });

      cy.get('body').should('contain', 'RingCT-hidden by design');
      cy.get('body').should('contain', 'Monero has no fee-market priority service');
      cy.get('body').should('contain', 'bytesPerSecond');
      cy.get('body').should('not.contain', 'API - Electrum RPC');
      cy.get('body').should('not.contain', 'Bitcoin REST API service');
      cy.get('body').should('not.contain', '/api/v1/services/accelerator');
      cy.get('body').should('not.contain', 'sat/vB');
      cy.get('body').should('not.contain', 'vBytesPerSecond');
      cy.get('body').should('not.contain', 'scripthash');
    });

    it('ships only the XMR production resource allowlist', () => {
      [
        '/resources/config.js',
        '/resources/config.template.js',
        '/resources/customize.js',
        '/resources/favicons/site.webmanifest',
        '/resources/previews/dashboard.png',
        '/resources/previews/blocks.jpg',
        '/resources/previews/privacy-policy.jpg',
        '/resources/previews/terms-of-service.jpg',
        '/resources/mining-pools/default.svg',
        '/resources/mining-pools/p2pool.svg',
        '/resources/mining-pools/unknown.svg',
        '/resources/sounds/chime.mp3',
      ].forEach((resource) => {
        cy.request({ url: resource, failOnStatusCode: false }).then((response) => {
          expect(response.status, resource).to.eq(200);
        });
      });

      [
        '/resources/config.js',
        '/resources/config.template.js',
      ].forEach((resource) => {
        cy.request(resource).its('body').then((body) => {
          expectTextExcludes(String(body), 'STRATUM_ENABLED', 'resource');
        });
      });

      cy.readFile('sync-xmr-resources.js').then((body) => {
        const allowlist = String(body);
        [
          'bitcoin-logo.png',
          'lightning-logo.png',
          'liquid-network-logo-bigger.png',
          'promo-video/mempool-promo.mp4',
          'profile/btcpayserver.svg',
          'mining-pools/antpool.svg',
        ].forEach((resource) => {
          expectTextExcludes(allowlist, `'${resource}'`, 'XMR resource allowlist');
        });
      });
    });

    it('keeps active legal and footer surfaces retargeted to monerospace.org', () => {
      mockWebSocketV2();
      stubDashboardApis();

      cy.visit('/terms-of-service');
      cy.contains('h2', 'Terms of Service').should('be.visible');
      cy.contains('MoneroSpace is an open-source Monero block and mempool explorer').should('be.visible');
      cy.get('body').should('not.contain', 'Mempool Accelerator');
      cy.get('body').should('not.contain', 'Bitcoin community');

      cy.visit('/privacy-policy');
      cy.contains('h2', 'Privacy Policy').should('be.visible');
      cy.contains('Monero chain and mempool data').should('be.visible');
      cy.get('body').should('not.contain', 'Mempool Accelerator');
      cy.get('body').should('not.contain', 'Lightning node');

      cy.visit('/trademark-policy');
      cy.contains('h2', 'Trademark & Attribution').should('be.visible');
      cy.contains('not an official Monero Project website').should('be.visible');
      cy.get('body').should('not.contain', 'Mempool Accelerator');
      cy.get('body').should('not.contain', 'Explore the full Bitcoin ecosystem');

      cy.visit('/about');
      cy.contains('xmr-space').should('be.visible');
      cy.contains('Monero block & mempool explorer').should('be.visible');
      cy.get('body').should('not.contain', 'The Mempool Open Source Project');
      cy.get('body').should('not.contain', 'Become a Community Sponsor');
      cy.get('body').should('not.contain', 'Mempool Enterprise');
      cy.get('app-master-page .dropdown-container').should('not.exist');
      cy.get('app-master-page app-menu').should('not.exist');
      cy.get('app-master-page app-testnet-alert').should('not.exist');
      cy.get('body').should('not.contain', 'Testnet3');
      cy.get('body').should('not.contain', 'Liquid Testnet');
      cy.get('app-master-page a[aria-label="monerospace.org dashboard"]').should('exist');
      cy.get('app-master-page a.nav-link[aria-label="Dashboard"]').should('have.attr', 'title', 'Dashboard');
      cy.get('app-master-page a.nav-link[aria-label="Recent blocks"]').should('have.attr', 'title', 'Recent blocks');
      cy.get('app-master-page a.nav-link[aria-label="Graphs"]').should('have.attr', 'title', 'Graphs');
      cy.get('app-master-page a.nav-link[aria-label="Documentation"]').should('have.attr', 'title', 'Documentation');
      cy.get('app-master-page a.nav-link[aria-label="About monerospace.org"]').should('have.attr', 'title', 'About monerospace.org');
      cy.get('app-global-footer app-amount-selector').should('not.exist');
      cy.get('app-global-footer a[href*="github.com/n0/monerospace-org/commit"]').should('exist');
      cy.get('app-global-footer a[aria-label="mempool on X"]').should('not.exist');
    });
  }
});
