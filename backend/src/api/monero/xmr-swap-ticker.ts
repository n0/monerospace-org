import { Application, Request, Response } from 'express';
import { handleError } from '../../utils/api';

const HAVENO_BASE_URL = process.env.XMR_HAVENO_MARKETS_API_URL ?? 'https://haveno.markets/api/v1';
const CACHE_MS = Math.max(5_000, Number(process.env.XMR_SWAP_TICKER_CACHE_MS ?? 60_000));
const DEFAULT_PAIRS = ['BTC_XMR', 'XMR_USD', 'XMR_EUR'];
const EIGENWALLET_DISCOVERY_DOCS = 'https://docs.eigenwallet.org/usage/market_maker_discovery';

type SwapTimePeriod = '24h' | '7d';
type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
}>;

interface HavenoNetwork {
  id?: string;
  name?: string;
  link?: string;
  fee?: unknown;
}

interface HavenoTickerRow {
  pair?: string;
  base_vol?: number;
  rel_vol?: number;
  highest_price?: number;
  lowest_price?: number;
  last_price?: number;
  price_change_percent?: number;
  highest_bid?: number | null;
  lowest_ask?: number | null;
}

interface HavenoTradeRow {
  currency?: string;
  price?: number;
  date?: number;
  paymentMethod?: string;
  base_vol?: number;
  rel_vol?: number;
}

export interface XmrSwapMarket {
  source: 'haveno.markets';
  protocol: 'haveno';
  network: string;
  pair: string;
  displayPair: string;
  counterCurrency: string;
  price: number;
  high: number;
  low: number;
  changePercent: number;
  xmrVolume: number;
  counterVolume: number;
  highestBid: number | null;
  lowestAsk: number | null;
}

export interface XmrSwapTrade {
  source: 'haveno.markets';
  protocol: 'haveno';
  pair: string;
  counterCurrency: string;
  price: number;
  timestamp: number;
  paymentMethod: string;
  xmrVolume: number;
  counterVolume: number;
}

export interface XmrSwapTicker {
  updatedAt: string;
  network: {
    id: string;
    name: string;
    link: string;
  };
  timePeriod: SwapTimePeriod;
  totals: {
    activePairs: number;
    xmrVolume: number;
    recentTrades: number;
  };
  markets: XmrSwapMarket[];
  recentTrades: XmrSwapTrade[];
  atomicSwap: {
    protocol: 'eigenwallet';
    label: string;
    direction: string;
    status: 'maker-discovery';
    docsUrl: string;
    note: string;
    rendezvousPoints: string[];
  };
  sources: Array<{
    name: string;
    url: string;
  }>;
}

let fetchOverride: FetchLike | null = null;
let cache: { key: string; expiresAt: number; value: XmrSwapTicker } | null = null;

export function setXmrSwapTickerFetchForTests(fetcher: FetchLike | null): void {
  fetchOverride = fetcher;
  cache = null;
}

export async function getXmrSwapTicker(
  timePeriod: string | undefined = '24h',
  networkId = 'reto',
): Promise<XmrSwapTicker> {
  const period = normalizeTimePeriod(timePeriod);
  const network = normalizeNetwork(networkId);
  const key = `${network}:${period}`;
  const now = Date.now();
  if (cache && cache.key === key && cache.expiresAt > now) {
    return cache.value;
  }

  const fetcher = activeFetch();
  const [networks, tickerMap] = await Promise.all([
    fetchJson<Record<string, HavenoNetwork>>(fetcher, `${HAVENO_BASE_URL}/networks`),
    fetchJson<Record<string, HavenoTickerRow>>(fetcher, `${HAVENO_BASE_URL}/tickers?network=${encodeURIComponent(network)}&time_period=${period}`),
  ]);
  const selectedNetwork = networks[network] ?? {};
  const markets = Object.values(tickerMap ?? {})
    .map((row) => normalizeMarket(row, network))
    .filter((row): row is XmrSwapMarket => !!row)
    .sort((a, b) => b.xmrVolume - a.xmrVolume || a.displayPair.localeCompare(b.displayPair));

  const tradePairs = unique([
    ...DEFAULT_PAIRS,
    ...markets.slice(0, 3).map((market) => market.pair),
  ]);
  const recentTrades = (await Promise.all(
    tradePairs.map((pair) => fetchHavenoTrades(fetcher, pair, network)),
  ))
    .flat()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 12);

  const value: XmrSwapTicker = {
    updatedAt: new Date(now).toISOString(),
    network: {
      id: selectedNetwork.id || network,
      name: selectedNetwork.name || network,
      link: selectedNetwork.link || 'https://haveno.markets/',
    },
    timePeriod: period,
    totals: {
      activePairs: markets.filter((market) => market.xmrVolume > 0).length,
      xmrVolume: round(markets.reduce((sum, market) => sum + market.xmrVolume, 0), 8),
      recentTrades: recentTrades.length,
    },
    markets,
    recentTrades,
    atomicSwap: {
      protocol: 'eigenwallet',
      label: 'XMR/BTC atomic swaps',
      direction: 'BTC to XMR makers',
      status: 'maker-discovery',
      docsUrl: EIGENWALLET_DISCOVERY_DOCS,
      note: 'Atomic-swap makers advertise through the eigenwallet public registry and libp2p rendezvous discovery instead of a centralized order-book ticker.',
      rendezvousPoints: [
        'discover.unstoppableswap.net:8888',
        'discover2.unstoppableswap.net:8888',
        'eigen.center:8888',
        'rendezvous.observer:8888',
      ],
    },
    sources: [
      { name: 'Haveno Markets API', url: 'https://haveno.markets/api' },
      { name: 'eigenwallet maker discovery', url: EIGENWALLET_DISCOVERY_DOCS },
    ],
  };

  cache = { key, expiresAt: now + CACHE_MS, value };
  return value;
}

export class XmrSwapTickerRoutes {
  constructor(private prefix = '/api/v1/') {}

  public initRoutes(app: Application): void {
    app.get(this.prefix + 'swaps/ticker', (req, res) => void this.ticker(req, res));
  }

  private async ticker(req: Request, res: Response): Promise<void> {
    try {
      res.json(await getXmrSwapTicker(String(req.query.timePeriod ?? '24h'), String(req.query.network ?? 'reto')));
    } catch (err) {
      handleError(req, res, 502, err instanceof Error ? err.message : 'swap ticker unavailable');
    }
  }
}

async function fetchHavenoTrades(fetcher: FetchLike, pair: string, network: string): Promise<XmrSwapTrade[]> {
  try {
    const rows = await fetchJson<HavenoTradeRow[]>(
      fetcher,
      `${HAVENO_BASE_URL}/trades/${encodeURIComponent(pair)}?network=${encodeURIComponent(network)}&limit=10`,
    );
    return (Array.isArray(rows) ? rows : [])
      .map((row) => normalizeTrade(row, pair))
      .filter((row): row is XmrSwapTrade => !!row);
  } catch {
    return [];
  }
}

async function fetchJson<T>(fetcher: FetchLike, url: string): Promise<T> {
  const response = await fetcher(url, {
    headers: { accept: 'application/json', 'user-agent': 'xmr-space swap ticker' },
  });
  if (!response.ok) {
    throw new Error(`upstream returned ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
  }
  return response.json() as Promise<T>;
}

function normalizeMarket(row: HavenoTickerRow, network: string): XmrSwapMarket | null {
  const pair = typeof row?.pair === 'string' ? row.pair : '';
  if (!pair.includes('_')) {
    return null;
  }
  const volume = volumesForPair(pair, row.base_vol, row.rel_vol);
  return {
    source: 'haveno.markets',
    protocol: 'haveno',
    network,
    pair,
    displayPair: pair.replace('_', '/'),
    counterCurrency: counterCurrency(pair),
    price: numberOrZero(row.last_price),
    high: numberOrZero(row.highest_price),
    low: numberOrZero(row.lowest_price),
    changePercent: numberOrZero(row.price_change_percent),
    xmrVolume: volume.xmrVolume,
    counterVolume: volume.counterVolume,
    highestBid: finiteOrNull(row.highest_bid),
    lowestAsk: finiteOrNull(row.lowest_ask),
  };
}

function normalizeTrade(row: HavenoTradeRow, pair: string): XmrSwapTrade | null {
  const price = numberOrZero(row?.price);
  const timestamp = Math.floor(numberOrZero(row?.date) / 1000);
  if (!price || !timestamp) {
    return null;
  }
  const volume = volumesForPair(pair, row.base_vol, row.rel_vol);
  return {
    source: 'haveno.markets',
    protocol: 'haveno',
    pair,
    counterCurrency: counterCurrency(pair),
    price,
    timestamp,
    paymentMethod: String(row.paymentMethod || 'unknown'),
    xmrVolume: volume.xmrVolume,
    counterVolume: volume.counterVolume,
  };
}

function volumesForPair(pair: string, baseVol: unknown, relVol: unknown): { xmrVolume: number; counterVolume: number } {
  const base = numberOrZero(baseVol);
  const rel = numberOrZero(relVol);
  if (pair.startsWith('XMR_')) {
    return { xmrVolume: rel, counterVolume: base };
  }
  if (pair.endsWith('_XMR')) {
    return { xmrVolume: base, counterVolume: rel };
  }
  return { xmrVolume: 0, counterVolume: base || rel };
}

function counterCurrency(pair: string): string {
  const [base, rel] = pair.split('_');
  return base === 'XMR' ? rel : base;
}

function normalizeTimePeriod(value: string | undefined): SwapTimePeriod {
  return value === '7d' ? '7d' : '24h';
}

function normalizeNetwork(value: string): string {
  return /^[a-z0-9_-]{2,32}$/i.test(value) ? value : 'reto';
}

function activeFetch(): FetchLike {
  const fetcher = fetchOverride ?? (globalThis as unknown as { fetch?: FetchLike }).fetch;
  if (!fetcher) {
    throw new Error('fetch is not available for swap ticker requests');
  }
  return fetcher;
}

function numberOrZero(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function finiteOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
