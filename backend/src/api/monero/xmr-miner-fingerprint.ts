import { IMoneroApi } from './monero-api.interface';

export interface XmrMinerPool {
  id: number;
  name: string;
  slug: string;
  minerNames: string[];
}

const UNKNOWN_POOL: XmrMinerPool = {
  id: 0,
  name: 'unknown',
  slug: 'unknown',
  minerNames: [],
};

const POOLS: Record<string, XmrMinerPool> = {
  p2pool: {
    id: 1,
    name: 'P2Pool',
    slug: 'p2pool',
    minerNames: ['P2Pool', 'P2Pool merge-mined sidechain'],
  },
  supportxmr: {
    id: 2,
    name: 'SupportXMR',
    slug: 'supportxmr',
    minerNames: ['SupportXMR'],
  },
  moneroocean: {
    id: 3,
    name: 'MoneroOcean',
    slug: 'moneroocean',
    minerNames: ['MoneroOcean'],
  },
  nanopool: {
    id: 4,
    name: 'Nanopool',
    slug: 'nanopool',
    minerNames: ['Nanopool'],
  },
  hashvault: {
    id: 5,
    name: 'HashVault',
    slug: 'hashvault',
    minerNames: ['HashVault'],
  },
  herominers: {
    id: 6,
    name: 'HeroMiners',
    slug: 'herominers',
    minerNames: ['HeroMiners'],
  },
  '2miners': {
    id: 7,
    name: '2Miners',
    slug: '2miners',
    minerNames: ['2Miners'],
  },
};

const ASCII_TAG_PATTERNS: Array<[RegExp, keyof typeof POOLS]> = [
  [/p2pool/i, 'p2pool'],
  [/supportxmr/i, 'supportxmr'],
  [/monero[\s._-]*ocean/i, 'moneroocean'],
  [/nanopool/i, 'nanopool'],
  [/hash[\s._-]*vault/i, 'hashvault'],
  [/hero[\s._-]*miners/i, 'herominers'],
  [/2[\s._-]*miners/i, '2miners'],
];

const TX_EXTRA_TAG_PADDING = 0x00;
const TX_EXTRA_TAG_PUBKEY = 0x01;
const TX_EXTRA_NONCE = 0x02;
const TX_EXTRA_MERGE_MINING_TAG = 0x03;
const TX_EXTRA_TAG_ADDITIONAL_PUBKEYS = 0x04;
const PUBKEY_BYTES = 32;

export function unknownXmrMinerPool(): XmrMinerPool {
  return { ...UNKNOWN_POOL, minerNames: [] };
}

export function knownXmrMinerPools(): XmrMinerPool[] {
  return Object.values(POOLS).map(clonePool);
}

export function identifyXmrMinerPool(block: IMoneroApi.Block | null | undefined): XmrMinerPool {
  const parsed = parseBlockJson(block?.json);
  return identifyXmrMinerPoolFromExtra(parsed?.miner_tx?.extra);
}

export function identifyXmrMinerPoolFromExtra(extra: number[] | null | undefined): XmrMinerPool {
  if (!Array.isArray(extra) || extra.length === 0) {
    return unknownXmrMinerPool();
  }

  const asciiPool = identifyFromAsciiRuns(extra);
  if (asciiPool) {
    return clonePool(asciiPool);
  }

  if (hasMergeMiningTag(extra)) {
    return clonePool(POOLS.p2pool);
  }

  return unknownXmrMinerPool();
}

function parseBlockJson(raw: string | undefined): IMoneroApi.BlockJson | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as IMoneroApi.BlockJson;
  } catch {
    return null;
  }
}

function clonePool(pool: XmrMinerPool): XmrMinerPool {
  return { ...pool, minerNames: [...pool.minerNames] };
}

function identifyFromAsciiRuns(extra: number[]): XmrMinerPool | null {
  const runs = asciiRuns(extra).join(' ');
  if (!runs) {
    return null;
  }
  for (const [pattern, key] of ASCII_TAG_PATTERNS) {
    if (pattern.test(runs)) {
      return POOLS[key];
    }
  }
  return null;
}

function asciiRuns(bytes: number[]): string[] {
  const runs: string[] = [];
  let current = '';
  for (const byte of bytes) {
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
      continue;
    }
    if (current.length >= 3) {
      runs.push(current);
    }
    current = '';
  }
  if (current.length >= 3) {
    runs.push(current);
  }
  return runs;
}

function hasMergeMiningTag(extra: number[]): boolean {
  let offset = 0;
  while (offset < extra.length) {
    const tag = extra[offset++];
    switch (tag) {
      case TX_EXTRA_TAG_PADDING:
        break;
      case TX_EXTRA_TAG_PUBKEY:
        offset += PUBKEY_BYTES;
        break;
      case TX_EXTRA_NONCE: {
        const length = readVarint(extra, offset);
        if (!length) {
          return false;
        }
        offset = length.next + length.value;
        break;
      }
      case TX_EXTRA_MERGE_MINING_TAG: {
        const depth = readVarint(extra, offset);
        if (!depth) {
          return false;
        }
        return depth.next + PUBKEY_BYTES <= extra.length;
      }
      case TX_EXTRA_TAG_ADDITIONAL_PUBKEYS: {
        const count = readVarint(extra, offset);
        if (!count) {
          return false;
        }
        offset = count.next + count.value * PUBKEY_BYTES;
        break;
      }
      default:
        return false;
    }

    if (offset > extra.length) {
      return false;
    }
  }
  return false;
}

function readVarint(bytes: number[], offset: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  for (let i = offset; i < bytes.length; i++) {
    const byte = bytes[i];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return { value, next: i + 1 };
    }
    shift += 7;
    if (shift > 28) {
      return null;
    }
  }
  return null;
}
