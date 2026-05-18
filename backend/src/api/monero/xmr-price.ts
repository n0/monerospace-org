import memoryCache from '../memory-cache';
import logger from '../../logger';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { RowDataPacket } from 'mysql2/typings/mysql';
import config from '../../config';
import database from '../../database';

const COINGECKO_BASE = process.env.XMR_PRICE_API_URL ?? 'https://api.coingecko.com/api/v3';
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'CHF', 'AUD', 'JPY'] as const;
type XmrCurrency = typeof CURRENCIES[number];
const HOUR_SECONDS = 3600;
const DEFAULT_HISTORY_DAYS = Math.max(1, Number(process.env.XMR_PRICE_HISTORY_DAYS ?? 1095));
const DEFAULT_HISTORY_FILE = process.env.XMR_PRICE_HISTORY_FILE
  ?? path.join(process.env.XMR_INDEX_DIR ?? path.join(os.homedir(), '.xmr-space'), 'xmr-price-history.json');
const HISTORY_TABLE = 'xmr_price_history';
const NEAREST_PRICE_TOLERANCE_SECONDS = 36 * HOUR_SECONDS;

export interface XmrApiPrice {
  time: number;
  USD: number;
  EUR: number;
  GBP: number;
  CAD: number;
  CHF: number;
  AUD: number;
  JPY: number;
}

export interface XmrExchangeRates {
  USDEUR: number;
  USDGBP: number;
  USDCAD: number;
  USDCHF: number;
  USDAUD: number;
  USDJPY: number;
}

export interface XmrPriceConversion {
  prices: XmrApiPrice[];
  exchangeRates: XmrExchangeRates;
}

const emptyPrice = (time = Math.floor(Date.now() / 1000)): XmrApiPrice => ({
  time,
  USD: -1,
  EUR: -1,
  GBP: -1,
  CAD: -1,
  CHF: -1,
  AUD: -1,
  JPY: -1,
});

const emptyExchangeRates = (): XmrExchangeRates => ({
  USDEUR: 0,
  USDGBP: 0,
  USDCAD: 0,
  USDCHF: 0,
  USDAUD: 0,
  USDJPY: 0,
});

function isValidPrice(price: XmrApiPrice): boolean {
  return Number.isFinite(price?.time)
    && CURRENCIES.some((currency) => Number.isFinite(price[currency]) && price[currency] > 0);
}

function exchangeRatesFromPrice(price: XmrApiPrice): XmrExchangeRates {
  if (price.USD <= 0) {
    return emptyExchangeRates();
  }
  return {
    USDEUR: price.EUR > 0 ? price.EUR / price.USD : 0,
    USDGBP: price.GBP > 0 ? price.GBP / price.USD : 0,
    USDCAD: price.CAD > 0 ? price.CAD / price.USD : 0,
    USDCHF: price.CHF > 0 ? price.CHF / price.USD : 0,
    USDAUD: price.AUD > 0 ? price.AUD / price.USD : 0,
    USDJPY: price.JPY > 0 ? price.JPY / price.USD : 0,
  };
}

function normalizePriceTime(price: XmrApiPrice): XmrApiPrice {
  return {
    ...price,
    time: Math.floor(price.time / HOUR_SECONDS) * HOUR_SECONDS,
  };
}

function sortPrices(prices: XmrApiPrice[]): XmrApiPrice[] {
  return prices
    .filter(isValidPrice)
    .sort((a, b) => a.time - b.time);
}

function mergePrices(prices: XmrApiPrice[]): XmrApiPrice[] {
  const merged = new Map<number, XmrApiPrice>();
  for (const price of prices) {
    const normalized = normalizePriceTime(price);
    const current = merged.get(normalized.time) ?? emptyPrice(normalized.time);
    for (const currency of CURRENCIES) {
      if (normalized[currency] > 0) {
        current[currency] = normalized[currency];
      }
    }
    merged.set(normalized.time, current);
  }
  return sortPrices([...merged.values()]);
}

function simplePriceUrl(): string {
  const vs = CURRENCIES.map((c) => c.toLowerCase()).join(',');
  return `${COINGECKO_BASE}/simple/price?ids=monero&vs_currencies=${vs}&include_last_updated_at=true`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

export interface XmrPriceStore {
  describe(): string;
  loadAll(): Promise<XmrApiPrice[]>;
  findNearest(timestamp: number, toleranceSeconds: number): Promise<XmrApiPrice | null>;
  saveMany(prices: XmrApiPrice[]): Promise<void>;
}

class FileXmrPriceStore implements XmrPriceStore {
  constructor(private persistFile: string) {}

  public describe(): string {
    return this.persistFile;
  }

  public async loadAll(): Promise<XmrApiPrice[]> {
    try {
      const raw = await fs.readFile(this.persistFile, 'utf-8');
      const parsed = JSON.parse(raw) as { prices?: XmrApiPrice[] };
      return sortPrices(parsed.prices ?? []);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code !== 'ENOENT') {
        throw err;
      }
      return [];
    }
  }

  public async findNearest(timestamp: number, toleranceSeconds: number): Promise<XmrApiPrice | null> {
    const prices = await this.loadAll();
    return nearestPrice(prices, timestamp, toleranceSeconds);
  }

  public async saveMany(prices: XmrApiPrice[]): Promise<void> {
    const existing = await this.loadAll();
    const merged = mergePrices(existing.concat(prices));
    await fs.mkdir(path.dirname(this.persistFile), { recursive: true });
    const tmp = this.persistFile + '.tmp';
    await fs.writeFile(tmp, JSON.stringify({
      version: 1,
      savedAt: Math.floor(Date.now() / 1000),
      prices: merged,
    }));
    await fs.rename(tmp, this.persistFile);
  }
}

interface XmrPriceRow extends RowDataPacket {
  time: number;
  USD: number;
  EUR: number;
  GBP: number;
  CAD: number;
  CHF: number;
  AUD: number;
  JPY: number;
}

class MysqlXmrPriceStore implements XmrPriceStore {
  private initialized = false;

  public describe(): string {
    return `mysql:${HISTORY_TABLE}`;
  }

  public async loadAll(): Promise<XmrApiPrice[]> {
    await this.ensureTable();
    const [rows] = await database.query<XmrPriceRow[]>(`
      SELECT time, USD, EUR, GBP, CAD, CHF, AUD, JPY
      FROM ${this.table()}
      ORDER BY time ASC
    `, undefined, 'warn');
    return sortPrices(rows.map((row) => this.rowToPrice(row)));
  }

  public async findNearest(timestamp: number, toleranceSeconds: number): Promise<XmrApiPrice | null> {
    await this.ensureTable();
    const [rows] = await database.query<XmrPriceRow[]>(`
      SELECT time, USD, EUR, GBP, CAD, CHF, AUD, JPY
      FROM ${this.table()}
      WHERE time BETWEEN ? AND ?
      ORDER BY ABS(time - ?) ASC
      LIMIT 1
    `, [timestamp - toleranceSeconds, timestamp + toleranceSeconds, timestamp], 'warn');
    return rows[0] ? this.rowToPrice(rows[0]) : null;
  }

  public async saveMany(prices: XmrApiPrice[]): Promise<void> {
    const validPrices = mergePrices(prices);
    if (validPrices.length === 0) {
      return;
    }
    await this.ensureTable();
    for (const price of validPrices) {
      await database.query(`
        INSERT INTO ${this.table()} (time, USD, EUR, GBP, CAD, CHF, AUD, JPY)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          USD = VALUES(USD),
          EUR = VALUES(EUR),
          GBP = VALUES(GBP),
          CAD = VALUES(CAD),
          CHF = VALUES(CHF),
          AUD = VALUES(AUD),
          JPY = VALUES(JPY)
      `, [
        price.time,
        price.USD,
        price.EUR,
        price.GBP,
        price.CAD,
        price.CHF,
        price.AUD,
        price.JPY,
      ], 'warn');
    }
  }

  private async ensureTable(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await database.query(`
      CREATE TABLE IF NOT EXISTS ${this.table()} (
        time INT UNSIGNED NOT NULL,
        USD DOUBLE NOT NULL DEFAULT -1,
        EUR DOUBLE NOT NULL DEFAULT -1,
        GBP DOUBLE NOT NULL DEFAULT -1,
        CAD DOUBLE NOT NULL DEFAULT -1,
        CHF DOUBLE NOT NULL DEFAULT -1,
        AUD DOUBLE NOT NULL DEFAULT -1,
        JPY DOUBLE NOT NULL DEFAULT -1,
        PRIMARY KEY (time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `, undefined, 'warn');
    this.initialized = true;
  }

  private rowToPrice(row: XmrPriceRow): XmrApiPrice {
    return {
      time: Number(row.time),
      USD: Number(row.USD),
      EUR: Number(row.EUR),
      GBP: Number(row.GBP),
      CAD: Number(row.CAD),
      CHF: Number(row.CHF),
      AUD: Number(row.AUD),
      JPY: Number(row.JPY),
    };
  }

  private table(): string {
    return `\`${HISTORY_TABLE}\``;
  }
}

class FallbackXmrPriceStore implements XmrPriceStore {
  constructor(
    private primary: XmrPriceStore,
    private fallback: XmrPriceStore,
  ) {}

  public describe(): string {
    return `${this.primary.describe()} with ${this.fallback.describe()} fallback`;
  }

  public async loadAll(): Promise<XmrApiPrice[]> {
    try {
      const prices = await this.primary.loadAll();
      if (prices.length > 0) {
        return prices;
      }
    } catch (err) {
      logger.warn(`xmr-price: primary history load failed (${err instanceof Error ? err.message : err}); trying fallback`);
    }
    return this.fallback.loadAll();
  }

  public async findNearest(timestamp: number, toleranceSeconds: number): Promise<XmrApiPrice | null> {
    try {
      const price = await this.primary.findNearest(timestamp, toleranceSeconds);
      if (price) {
        return price;
      }
    } catch (err) {
      logger.warn(`xmr-price: primary nearest lookup failed (${err instanceof Error ? err.message : err}); trying fallback`);
    }
    return this.fallback.findNearest(timestamp, toleranceSeconds);
  }

  public async saveMany(prices: XmrApiPrice[]): Promise<void> {
    try {
      await this.primary.saveMany(prices);
    } catch (err) {
      logger.warn(`xmr-price: primary history persist failed (${err instanceof Error ? err.message : err}); writing fallback`);
      await this.fallback.saveMany(prices);
    }
  }
}

function createDefaultStore(): XmrPriceStore {
  const fileStore = new FileXmrPriceStore(DEFAULT_HISTORY_FILE);
  if (isDatabaseEnabled()) {
    return new FallbackXmrPriceStore(new MysqlXmrPriceStore(), fileStore);
  }
  return fileStore;
}

function isDatabaseEnabled(): boolean {
  const override = process.env.XMR_DATABASE_ENABLED ?? process.env.DATABASE_ENABLED;
  if (override != null) {
    return override === 'true' || override === '1';
  }
  return config.DATABASE.ENABLED === true;
}

let priceStore = createDefaultStore();

export function setXmrPriceStoreForTests(store: XmrPriceStore | null): void {
  priceStore = store ?? createDefaultStore();
}

function nearestPrice(prices: XmrApiPrice[], timestamp: number, toleranceSeconds: number): XmrApiPrice | null {
  const sorted = sortPrices(prices);
  let best: XmrApiPrice | null = null;
  for (const price of sorted) {
    if (!best || Math.abs(price.time - timestamp) < Math.abs(best.time - timestamp)) {
      best = price;
    }
  }
  if (!best || Math.abs(best.time - timestamp) > toleranceSeconds) {
    return null;
  }
  return best;
}

function parseSimplePrice(body: unknown): XmrApiPrice {
  const monero = (body as { monero?: Record<string, unknown> })?.monero ?? {};
  const price = emptyPrice(Number(monero.last_updated_at) || Math.floor(Date.now() / 1000));
  for (const currency of CURRENCIES) {
    const value = Number(monero[currency.toLowerCase()]);
    price[currency] = Number.isFinite(value) && value > 0 ? value : -1;
  }
  return price;
}

export function priceToConversions(price: XmrApiPrice): Record<XmrCurrency, number> {
  return {
    USD: price.USD,
    EUR: price.EUR,
    GBP: price.GBP,
    CAD: price.CAD,
    CHF: price.CHF,
    AUD: price.AUD,
    JPY: price.JPY,
  };
}

export async function getLatestXmrPrice(): Promise<XmrApiPrice> {
  const cached = memoryCache.get<XmrApiPrice>('xmr-price', 'latest');
  if (cached) {
    return cached;
  }

  try {
    const price = parseSimplePrice(await fetchJson<unknown>(simplePriceUrl()));
    memoryCache.set('xmr-price', 'latest', price, 60);
    memoryCache.set('xmr-price', 'latest-stale', price, 86_400);
    await savePriceHistory([price]);
    return price;
  } catch (err) {
    logger.warn(`xmr-price: latest price fetch failed: ${err instanceof Error ? err.message : err}`);
    return memoryCache.get<XmrApiPrice>('xmr-price', 'latest-stale') ?? emptyPrice();
  }
}

async function fetchHistoricalCurrencyPoint(currency: XmrCurrency, timestamp: number): Promise<number> {
  const bucket = Math.floor(timestamp / 3600) * 3600;
  const cacheKey = `${currency}:${bucket}`;
  const cached = memoryCache.get<number>('xmr-price-history', cacheKey);
  if (cached !== null) {
    return cached;
  }

  const from = Math.max(0, timestamp - NEAREST_PRICE_TOLERANCE_SECONDS);
  const to = timestamp + NEAREST_PRICE_TOLERANCE_SECONDS;
  try {
    const points = await fetchHistoricalCurrencyRange(currency, from, to);
    if (!points.length) {
      memoryCache.set('xmr-price-history', cacheKey, -1, 300);
      return -1;
    }
    const best = points.reduce((closest, point) => (
      Math.abs(point.time - timestamp) < Math.abs(closest.time - timestamp) ? point : closest
    ));
    const value = Number(best[currency]);
    const price = Number.isFinite(value) && value > 0 ? value : -1;
    memoryCache.set('xmr-price-history', cacheKey, price, 3600);
    return price;
  } catch (err) {
    logger.warn(`xmr-price: historical ${currency} fetch failed: ${err instanceof Error ? err.message : err}`);
    memoryCache.set('xmr-price-history', cacheKey, -1, 300);
    return -1;
  }
}

async function fetchHistoricalCurrencyRange(currency: XmrCurrency, from: number, to: number): Promise<XmrApiPrice[]> {
  const url = `${COINGECKO_BASE}/coins/monero/market_chart/range?vs_currency=${currency.toLowerCase()}&from=${from}&to=${to}`;
  const body = await fetchJson<{ prices?: Array<[number, number]> }>(url);
  return (body.prices ?? [])
    .map(([timeMs, value]) => {
      const price = emptyPrice(Math.floor((timeMs / 1000) / HOUR_SECONDS) * HOUR_SECONDS);
      const numeric = Number(value);
      price[currency] = Number.isFinite(numeric) && numeric > 0 ? numeric : -1;
      return price;
    })
    .filter(isValidPrice);
}

async function fetchHistoricalPrice(timestamp: number): Promise<XmrApiPrice> {
  const price = emptyPrice(Math.floor(timestamp / HOUR_SECONDS) * HOUR_SECONDS);
  const values = await Promise.all(CURRENCIES.map((currency) => fetchHistoricalCurrencyPoint(currency, timestamp)));
  CURRENCIES.forEach((currency, index) => {
    price[currency] = values[index];
  });
  if (isValidPrice(price)) {
    await savePriceHistory([price]);
  }
  return price;
}

async function backfillRecentHistory(): Promise<void> {
  const cacheKey = `recent:${DEFAULT_HISTORY_DAYS}`;
  if (memoryCache.get<boolean>('xmr-price-backfill', cacheKey)) {
    return;
  }
  memoryCache.set('xmr-price-backfill', cacheKey, true, 12 * HOUR_SECONDS);
  const now = Math.floor(Date.now() / 1000);
  const from = Math.max(0, now - (DEFAULT_HISTORY_DAYS * 24 * HOUR_SECONDS));
  const ranges = await Promise.allSettled(CURRENCIES.map((currency) => fetchHistoricalCurrencyRange(currency, from, now)));
  const prices = mergePrices(ranges.flatMap((result) => result.status === 'fulfilled' ? result.value : []));
  if (prices.length > 0) {
    await savePriceHistory(prices);
    logger.notice(`xmr-price: backfilled ${prices.length} historical price points into ${priceStore.describe()}`);
  }
}

async function savePriceHistory(prices: XmrApiPrice[]): Promise<void> {
  const validPrices = mergePrices(prices);
  if (validPrices.length === 0) {
    return;
  }
  try {
    await priceStore.saveMany(validPrices);
  } catch (err) {
    logger.warn(`xmr-price: history persist failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function loadPriceHistory(): Promise<XmrApiPrice[]> {
  try {
    return await priceStore.loadAll();
  } catch (err) {
    logger.warn(`xmr-price: history load failed from ${priceStore.describe()}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export async function findStoredXmrPrice(timestamp: number, toleranceSeconds = NEAREST_PRICE_TOLERANCE_SECONDS): Promise<XmrApiPrice | null> {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }
  try {
    return await priceStore.findNearest(timestamp, toleranceSeconds);
  } catch (err) {
    logger.warn(`xmr-price: stored price lookup failed from ${priceStore.describe()}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export async function getXmrPriceConversion(timestamp?: number): Promise<XmrPriceConversion> {
  if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) {
    const latest = await getLatestXmrPrice();
    let prices = await loadPriceHistory();
    if (prices.length < 2 && process.env.XMR_PRICE_BACKFILL_ON_DEMAND !== 'false') {
      await backfillRecentHistory();
      prices = await loadPriceHistory();
    }
    prices = mergePrices(prices.concat([latest]));
    const exchangeRateSource = [...prices].reverse().find((price) => price.USD > 0) ?? latest;
    return {
      prices,
      exchangeRates: exchangeRatesFromPrice(exchangeRateSource),
    };
  }

  const stored = await priceStore.findNearest(timestamp, NEAREST_PRICE_TOLERANCE_SECONDS)
    .catch((err) => {
      logger.warn(`xmr-price: nearest history lookup failed: ${err instanceof Error ? err.message : err}`);
      return null;
    });
  const price = stored ?? await fetchHistoricalPrice(timestamp);

  return {
    prices: [price],
    exchangeRates: exchangeRatesFromPrice(price),
  };
}
