import express from 'express';
import { createServer, request as httpRequest, Server } from 'http';
import { AddressInfo } from 'net';
import {
  getXmrSwapTicker,
  setXmrSwapTickerFetchForTests,
  XmrSwapTickerRoutes,
} from '../xmr-swap-ticker';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'error',
    json: async () => body,
  };
}

function mockHavenoFetch() {
  return jest.fn(async (url: string) => {
    if (url.endsWith('/networks')) {
      return jsonResponse({
        reto: {
          id: 'reto',
          name: 'RetoSwap',
          link: 'https://retoswap.com/',
        },
      });
    }
    if (url.includes('/tickers')) {
      return jsonResponse({
        BTC: {
          pair: 'BTC_XMR',
          base_vol: 6977.97,
          rel_vol: 35.13,
          highest_price: 207.15,
          lowest_price: 132.86,
          last_price: 195.71,
          price_change_percent: -0.6548,
          highest_bid: null,
          lowest_ask: null,
        },
        USD: {
          pair: 'XMR_USD',
          base_vol: 17862.8,
          rel_vol: 44.77,
          highest_price: 480,
          lowest_price: 363.7,
          last_price: 430.66,
          price_change_percent: 8.55,
          highest_bid: null,
          lowest_ask: null,
        },
      });
    }
    if (url.includes('/trades/BTC_XMR')) {
      return jsonResponse([{
        currency: 'BTC',
        price: 195.71,
        date: 1779189186111,
        paymentMethod: 'BLOCK_CHAINS_INSTANT',
        base_vol: 59.91,
        rel_vol: 0.3061,
      }]);
    }
    if (url.includes('/trades/XMR_USD')) {
      return jsonResponse([{
        currency: 'USD',
        price: 430.66,
        date: 1779189185111,
        paymentMethod: 'ZELLE',
        base_vol: 430.66,
        rel_vol: 1,
      }]);
    }
    if (url.includes('/trades/XMR_EUR')) {
      return jsonResponse([]);
    }
    return jsonResponse({ error: 'not found' }, 404);
  });
}

function makeServer(): Promise<Server> {
  const app = express();
  new XmrSwapTickerRoutes().initRoutes(app);
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function getJson(server: Server, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('XMR swap ticker', () => {
  let server: Server | null = null;

  beforeEach(() => {
    setXmrSwapTickerFetchForTests(mockHavenoFetch());
  });

  afterEach((done) => {
    setXmrSwapTickerFetchForTests(null);
    if (!server) {
      done();
      return;
    }
    server.close(() => {
      server = null;
      done();
    });
  });

  it('normalizes Haveno market rows and recent trades into XMR volumes', async () => {
    const ticker = await getXmrSwapTicker('7d', 'reto');

    expect(ticker.network).toMatchObject({ id: 'reto', name: 'RetoSwap' });
    expect(ticker.timePeriod).toBe('7d');
    expect(ticker.markets[0]).toMatchObject({
      protocol: 'haveno',
      pair: 'BTC_XMR',
      displayPair: 'BTC/XMR',
      counterCurrency: 'BTC',
      xmrVolume: 6977.97,
      counterVolume: 35.13,
      price: 195.71,
    });
    expect(ticker.markets[1]).toMatchObject({
      pair: 'XMR_USD',
      counterCurrency: 'USD',
      xmrVolume: 44.77,
      counterVolume: 17862.8,
    });
    expect(ticker.totals).toMatchObject({
      activePairs: 2,
      xmrVolume: 7022.74,
      recentTrades: 2,
    });
    expect(ticker.recentTrades[0]).toMatchObject({
      pair: 'BTC_XMR',
      paymentMethod: 'BLOCK_CHAINS_INSTANT',
      xmrVolume: 59.91,
      counterVolume: 0.3061,
    });
    expect(ticker.atomicSwap).toMatchObject({
      protocol: 'eigenwallet',
      status: 'maker-discovery',
      direction: 'BTC to XMR makers',
    });
  });

  it('serves the ticker through /api/v1/swaps/ticker', async () => {
    server = await makeServer();

    const response = await getJson(server, '/api/v1/swaps/ticker?timePeriod=7d');

    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      timePeriod: '7d',
      network: { id: 'reto', name: 'RetoSwap' },
      atomicSwap: { protocol: 'eigenwallet' },
    });
  });
});
