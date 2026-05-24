import logger from '../../logger';

/**
 * xmr-pool-blocks
 *
 * Monero coinbase outputs use one-time stealth addresses and pools do
 * NOT embed an identifying tag in the coinbase `tx_extra` (unlike
 * Bitcoin). The only pool detectable from chain data alone is P2Pool,
 * via its `0x03` merge-mining tag. Everything else is invisible
 * on-chain — which is why ~78% of blocks land in "Unknown".
 *
 * The reliable way to attribute the rest is to cross-reference each
 * pool's own "found blocks" feed and match by Monero block hash. A
 * given mainchain block is found by exactly one pool, so there are no
 * real conflicts: if SupportXMR lists block <hash>, SupportXMR mined it.
 *
 * Each source is fetched independently and failure-isolated: one pool's
 * API being down (or rate-limiting us) never blocks the others. The
 * pure `parse*` functions are exported for unit testing against
 * captured real-world payloads.
 */

export interface PoolBlockRecord {
  /** Monero mainchain block hash, lowercase hex64. */
  hash: string;
  height: number;
  /** Canonical pool display name; resolved to an id via xmrMinerPoolFromProofName. */
  poolName: string;
  /** Short source identifier (api host) for provenance. */
  source: string;
  /**
   * True only for P2Pool (observer publishes the coinbase private key,
   * a cryptographic proof). Self-reported pool APIs are attribution,
   * not proof.
   */
  hasProof: boolean;
}

const HEX64 = /^[a-f0-9]{64}$/;
const FETCH_TIMEOUT_MS = Math.max(500, Number(process.env.XMR_POOL_BLOCKS_TIMEOUT_MS ?? 4_000));
// Recent blocks to pull per source per refresh. Bigger windows backfill
// deeper history but cost more bandwidth; the live path only needs the
// last few hours. Tunable via env.
const LIMIT = Math.max(10, Number(process.env.XMR_POOL_BLOCKS_LIMIT ?? 500));
const NANO_LIMIT = Math.min(LIMIT, 100); // nanopool is a small XMR pool; keep it light

const P2POOL_OBSERVER_URL = (process.env.XMR_P2POOL_OBSERVER_URL ?? 'https://p2pool.observer').replace(/\/+$/, '');
const P2POOL_MINI_OBSERVER_URL = (process.env.XMR_P2POOL_MINI_OBSERVER_URL ?? 'https://mini.p2pool.observer').replace(/\/+$/, '');

function normHash(value: unknown): string | null {
  if (typeof value !== 'string') {return null;}
  const h = value.toLowerCase();
  return HEX64.test(h) ? h : null;
}

function toHeight(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function fetchText(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'monerospace.org/1.0 (+pool-attribution)' },
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function safeParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// ---- pure parsers (exported for tests) ----

/** P2Pool observer /api/found_blocks: [{ main_block: { id, height }, ... }] */
export function parseP2poolFoundBlocks(body: string, poolName: string, source: string): PoolBlockRecord[] {
  const data = safeParse(body);
  if (!Array.isArray(data)) {return [];}
  const out: PoolBlockRecord[] = [];
  for (const entry of data) {
    const block = (entry as { main_block?: { id?: unknown; height?: unknown } })?.main_block;
    const hash = normHash(block?.id);
    if (!hash) {continue;}
    out.push({ hash, height: toHeight(block?.height), poolName, source, hasProof: true });
  }
  return out;
}

/** SupportXMR / HashVault / MoneroOcean share a cryptonote-pool block shape: [{ hash, height, valid }] */
export function parseCryptonotePoolBlocks(body: string, poolName: string, source: string): PoolBlockRecord[] {
  const data = safeParse(body);
  if (!Array.isArray(data)) {return [];}
  const out: PoolBlockRecord[] = [];
  for (const entry of data as Array<{ hash?: unknown; height?: unknown; valid?: unknown }>) {
    if (entry?.valid === false) {continue;}
    const hash = normHash(entry?.hash);
    if (!hash) {continue;}
    out.push({ hash, height: toHeight(entry?.height), poolName, source, hasProof: false });
  }
  return out;
}

/** Nanopool /v1/xmr/pool/blocks: { status, data: [{ hash, block_number }] } */
export function parseNanopoolBlocks(body: string, poolName: string, source: string): PoolBlockRecord[] {
  const data = safeParse(body) as { data?: Array<{ hash?: unknown; block_number?: unknown }> } | null;
  if (!data || !Array.isArray(data.data)) {return [];}
  const out: PoolBlockRecord[] = [];
  for (const entry of data.data) {
    const hash = normHash(entry?.hash);
    if (!hash) {continue;}
    out.push({ hash, height: toHeight(entry?.block_number), poolName, source, hasProof: false });
  }
  return out;
}

/**
 * HeroMiners /api/get_blocks: flat redis zset dump alternating
 * [blockString, height, blockString, height, ...] where blockString is
 * "hash:time:diff:...:status:reward:address:region:rewardType".
 */
export function parseHerominersBlocks(body: string, poolName: string, source: string): PoolBlockRecord[] {
  const data = safeParse(body);
  if (!Array.isArray(data)) {return [];}
  const out: PoolBlockRecord[] = [];
  for (let i = 0; i < data.length - 1; i += 2) {
    const blockStr = data[i];
    if (typeof blockStr !== 'string') {continue;}
    const parts = blockStr.split(':');
    const hash = normHash(parts[0]);
    if (!hash) {continue;}
    if (parts[6] === 'orphaned') {continue;}
    out.push({ hash, height: toHeight(data[i + 1]), poolName, source, hasProof: false });
  }
  return out;
}

// ---- per-source fetchers (failure-isolated) ----

type Fetcher = { label: string; run: () => Promise<PoolBlockRecord[]> };

async function viaParser(
  url: string,
  parse: (body: string, poolName: string, source: string) => PoolBlockRecord[],
  poolName: string,
  source: string,
): Promise<PoolBlockRecord[]> {
  const body = await fetchText(url);
  return body ? parse(body, poolName, source) : [];
}

const FETCHERS: Fetcher[] = [
  {
    label: 'p2pool',
    run: () => viaParser(`${P2POOL_OBSERVER_URL}/api/found_blocks?limit=${LIMIT}`, parseP2poolFoundBlocks, 'P2Pool', 'p2pool.observer'),
  },
  {
    label: 'p2pool-mini',
    run: () => viaParser(`${P2POOL_MINI_OBSERVER_URL}/api/found_blocks?limit=${LIMIT}`, parseP2poolFoundBlocks, 'P2Pool', 'mini.p2pool.observer'),
  },
  {
    label: 'supportxmr',
    run: () => viaParser(`https://www.supportxmr.com/api/pool/blocks?limit=${LIMIT}`, parseCryptonotePoolBlocks, 'SupportXMR', 'supportxmr.com'),
  },
  {
    label: 'hashvault',
    run: () => viaParser(`https://api.hashvault.pro/v3/monero/pool/blocks?limit=${LIMIT}&page=0`, parseCryptonotePoolBlocks, 'HashVault', 'hashvault.pro'),
  },
  {
    label: 'moneroocean',
    run: () => viaParser(`https://api.moneroocean.stream/pool/blocks?limit=${LIMIT}`, parseCryptonotePoolBlocks, 'MoneroOcean', 'moneroocean.stream'),
  },
  {
    label: 'nanopool',
    run: () => viaParser(`https://api.nanopool.org/v1/xmr/pool/blocks/0/${NANO_LIMIT}`, parseNanopoolBlocks, 'Nanopool', 'nanopool.org'),
  },
  {
    label: 'herominers',
    run: () => viaParser('https://monero.herominers.com/api/get_blocks?height=999999999', parseHerominersBlocks, 'HeroMiners', 'herominers.com'),
  },
];

/**
 * Fetch every pool's recent found-blocks in parallel and flatten. Each
 * source is independently failure-isolated; a rejected/empty source is
 * logged at debug level and simply contributes no records.
 */
export async function fetchAllPoolBlocks(): Promise<PoolBlockRecord[]> {
  const results = await Promise.allSettled(FETCHERS.map((f) => f.run()));
  const out: PoolBlockRecord[] = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      out.push(...result.value);
    } else {
      logger.debug(`xmr pool-blocks: ${FETCHERS[i].label} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  });
  return out;
}
