import logger from '../../logger';
import { knownXmrMinerPools, XmrMinerPool } from './xmr-miner-fingerprint';
import { fetchAllPoolBlocks, PoolBlockRecord } from './xmr-pool-blocks';

/**
 * Pool attribution registry.
 *
 * Builds a `hash -> attribution` map by cross-referencing every major
 * Monero pool's "found blocks" feed (see xmr-pool-blocks). A mainchain
 * block is found by exactly one pool, so a hash match is authoritative.
 *
 * Two distinct signals come out of this:
 *   - **attribution** (which pool mined the block) — available for ALL
 *     pools that publish a found-blocks feed. Drives the pool pie /
 *     per-pool block counts.
 *   - **proof** (cryptographic coinbase proof) — only P2Pool, via the
 *     observer's published coinbase private key. Drives the per-block
 *     "miner proof" badge.
 *
 * The class name is retained for import stability across the indexer,
 * ws adapter and REST routes; `getProofForBlock` stays as a thin
 * back-compat shim over `getAttributionForBlock`.
 */

export type XmrMinerProofStatus = 'verified' | 'missing' | 'unavailable' | 'unknown';
export type XmrMinerProofType = 'viewkey' | 'txkey' | 'txproof';

export interface XmrMinerProof {
  status: XmrMinerProofStatus;
  type?: XmrMinerProofType;
  source: string;
  sourceName: string;
  sourceUrl: string;
  registryUrl: string;
  blockHash: string;
  height?: number;
  poolName?: string;
  poolSlug?: string;
  poolId?: number;
}

/** Resolved pool attribution for a single Monero block. */
export interface XmrBlockAttribution {
  pool: XmrMinerPool;
  /** Provenance — the API host the attribution came from. */
  source: string;
  /** Present only when the source supplies a cryptographic proof (P2Pool observer). */
  proof?: XmrMinerProof;
}

const DEFAULT_TTL_MS = 60_000;
const HEX64 = /^[a-f0-9]{64}$/i;

interface CacheEntry {
  expiresAt: number;
  attributions: Map<string, XmrBlockAttribution>;
}

export class XmrMinerProofRegistry {
  private cache: CacheEntry | null = null;
  private inFlight: Promise<Map<string, XmrBlockAttribution>> | null = null;

  constructor(
    private ttlMs = Math.max(5_000, Number(process.env.XMR_MINER_PROOF_REGISTRY_TTL_MS ?? DEFAULT_TTL_MS)),
  ) {}

  public sourceName(): string {
    return 'pool block feeds';
  }

  public proofsUrl(): string {
    return 'p2pool.observer + supportxmr/hashvault/moneroocean/nanopool/herominers';
  }

  public async getAttributionForBlock(hash: string): Promise<XmrBlockAttribution | null> {
    const normalized = hash.toLowerCase();
    if (!HEX64.test(normalized)) {
      return null;
    }
    const attributions = await this.recentAttributions();
    return attributions.get(normalized) ?? null;
  }

  /** Back-compat: returns only the cryptographic proof (P2Pool), if any. */
  public async getProofForBlock(hash: string): Promise<XmrMinerProof | null> {
    return (await this.getAttributionForBlock(hash))?.proof ?? null;
  }

  public async recentAttributions(): Promise<Map<string, XmrBlockAttribution>> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.attributions;
    }
    if (!this.inFlight) {
      this.inFlight = this.build()
        .catch((err) => {
          logger.warn(`xmr pool attribution: build failed: ${err instanceof Error ? err.message : String(err)}`);
          return this.cache?.attributions ?? new Map<string, XmrBlockAttribution>();
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    const attributions = await this.inFlight;
    this.cache = {
      expiresAt: now + this.ttlMs,
      attributions,
    };
    return attributions;
  }

  private async build(): Promise<Map<string, XmrBlockAttribution>> {
    return buildAttributionMap(await fetchAllPoolBlocks());
  }
}

/**
 * Collapse per-pool found-block records into a hash -> attribution map.
 * When two sources claim the same hash (shouldn't happen for real
 * found blocks), the proof-carrying source (P2Pool) wins.
 */
export function buildAttributionMap(records: PoolBlockRecord[]): Map<string, XmrBlockAttribution> {
  const map = new Map<string, XmrBlockAttribution>();
  for (const rec of records) {
    const existing = map.get(rec.hash);
    if (existing && existing.proof && !rec.hasProof) {
      continue;
    }
    const pool = xmrMinerPoolFromProofName(rec.poolName);
    const attribution: XmrBlockAttribution = { pool, source: rec.source };
    if (rec.hasProof) {
      attribution.proof = {
        status: 'verified',
        type: 'txproof',
        source: rec.source,
        sourceName: 'P2Pool Observer',
        sourceUrl: `https://${rec.source}/block/${rec.hash}`,
        registryUrl: `https://${rec.source}/api/found_blocks`,
        blockHash: rec.hash,
        ...(rec.height ? { height: rec.height } : {}),
        poolName: pool.name,
        poolSlug: pool.slug,
        poolId: pool.id,
      };
    }
    map.set(rec.hash, attribution);
  }
  return map;
}

export function xmrMinerPoolFromProofName(poolName: string): XmrMinerPool {
  const normalizedSlug = slugifyPoolName(poolName);
  const known = knownXmrMinerPools().find((pool) => {
    return pool.slug === normalizedSlug || slugifyPoolName(pool.name) === normalizedSlug;
  });
  if (known) {
    return known;
  }
  return {
    id: 10_000 + (stableHash(normalizedSlug) % 900_000),
    name: poolName.trim(),
    slug: normalizedSlug || 'verified-miner',
    minerNames: [poolName.trim()],
  };
}

function slugifyPoolName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
