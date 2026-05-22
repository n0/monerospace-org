import logger from '../../logger';
import { knownXmrMinerPools, XmrMinerPool } from './xmr-miner-fingerprint';

export type XmrMinerProofStatus = 'verified' | 'missing' | 'unavailable' | 'unknown';
export type XmrMinerProofType = 'viewkey' | 'txkey' | 'txproof';

export interface XmrMinerProof {
  status: XmrMinerProofStatus;
  type?: XmrMinerProofType;
  source: 'blocks.p2pool.observer';
  sourceName: string;
  sourceUrl: string;
  registryUrl: string;
  blockHash: string;
  height?: number;
  poolName?: string;
  poolSlug?: string;
  poolId?: number;
}

const DEFAULT_REGISTRY_BASE_URL = 'https://blocks.p2pool.observer';
const DEFAULT_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = Math.max(500, Number(process.env.XMR_MINER_PROOF_REGISTRY_TIMEOUT_MS ?? 2_500));
const HEX64 = /^[a-f0-9]{64}$/i;

interface CacheEntry {
  expiresAt: number;
  proofs: Map<string, XmrMinerProof>;
}

export class XmrMinerProofRegistry {
  private cache: CacheEntry | null = null;
  private inFlight: Promise<Map<string, XmrMinerProof>> | null = null;

  constructor(
    private baseUrl = process.env.XMR_MINER_PROOF_REGISTRY_URL ?? DEFAULT_REGISTRY_BASE_URL,
    private ttlMs = Math.max(5_000, Number(process.env.XMR_MINER_PROOF_REGISTRY_TTL_MS ?? DEFAULT_TTL_MS)),
  ) {
    this.baseUrl = this.baseUrl.replace(/\/+$/, '');
  }

  public sourceName(): string {
    return 'blocks.p2pool.observer';
  }

  public proofsUrl(): string {
    return `${this.baseUrl}/proofs`;
  }

  public async getProofForBlock(hash: string): Promise<XmrMinerProof | null> {
    const normalized = hash.toLowerCase();
    if (!HEX64.test(normalized)) {
      return null;
    }
    const proofs = await this.recentProofs();
    return proofs.get(normalized) ?? null;
  }

  public async recentProofs(): Promise<Map<string, XmrMinerProof>> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.proofs;
    }
    if (!this.inFlight) {
      this.inFlight = this.fetchProofs()
        .catch((err) => {
          logger.warn(`xmr miner proofs: fetch failed: ${err instanceof Error ? err.message : String(err)}`);
          return this.cache?.proofs ?? new Map<string, XmrMinerProof>();
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    const proofs = await this.inFlight;
    this.cache = {
      expiresAt: now + this.ttlMs,
      proofs,
    };
    return proofs;
  }

  private async fetchProofs(): Promise<Map<string, XmrMinerProof>> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/plot.svg`, { signal: ctrl.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return parseMinerProofSvg(await res.text(), this.baseUrl);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseMinerProofSvg(svg: string, baseUrl = DEFAULT_REGISTRY_BASE_URL): Map<string, XmrMinerProof> {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const proofs = new Map<string, XmrMinerProof>();
  const blockSvgRegex = /<svg\b[^>]*class="block\s+([^"]*)"[^>]*>[\s\S]*?<\/svg>/gi;
  let match: RegExpExecArray | null;

  while ((match = blockSvgRegex.exec(svg)) !== null) {
    const fragment = match[0];
    const classTokens = new Set(match[1].split(/\s+/).filter(Boolean));
    const hash = fragment.match(/xlink:href="\/block\/([a-f0-9]{64})"/i)?.[1]?.toLowerCase();
    if (!hash) {
      continue;
    }

    const title = decodeXmlEntities(fragment.match(/xlink:title="([^"]+)"/i)?.[1] ?? '');
    const titleParts = title.match(/^(?:Orphan\s+)?Block\s+(\d+)\s+from\s+(.+)\s+\(([a-f0-9]{64})\)$/i);
    const proofToken = fragment.match(/xlink:href="#block-(?:true|false)-([^"]+)"/i)?.[1]?.toLowerCase();
    const type = proofType(proofToken);
    const status = proofStatus(classTokens, proofToken, type);
    const poolName = titleParts?.[2]?.trim();
    const proof: XmrMinerProof = {
      status,
      ...(type ? { type } : {}),
      source: 'blocks.p2pool.observer',
      sourceName: 'blocks.p2pool.observer',
      sourceUrl: `${normalizedBase}/block/${hash}`,
      registryUrl: `${normalizedBase}/proofs`,
      blockHash: hash,
      ...(titleParts ? { height: Number(titleParts[1]) } : {}),
      ...(poolName ? { poolName } : {}),
    };

    if (poolName) {
      const pool = xmrMinerPoolFromProofName(poolName);
      proof.poolName = pool.name;
      proof.poolSlug = pool.slug;
      proof.poolId = pool.id;
    }

    proofs.set(hash, proof);
  }

  return proofs;
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

function proofType(token: string | undefined): XmrMinerProofType | undefined {
  if (token === 'viewkey' || token === 'txkey' || token === 'txproof') {
    return token;
  }
  return undefined;
}

function proofStatus(
  classTokens: Set<string>,
  proofToken: string | undefined,
  type: XmrMinerProofType | undefined,
): XmrMinerProofStatus {
  if (type || classTokens.has('verified')) {
    return 'verified';
  }
  if (proofToken === 'missing' || classTokens.has('unverified')) {
    return 'missing';
  }
  if (proofToken === 'none' || classTokens.has('none')) {
    return 'unavailable';
  }
  return 'unknown';
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
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
