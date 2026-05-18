import { SafeResourceUrl } from '@angular/platform-browser';
import { ILoadingIndicators } from '@app/services/state.service';
import { Transaction } from '@interfaces/electrs.interface';
import { BlockExtended, DifficultyAdjustment, TransactionStripped } from '@interfaces/node-api.interface';

export interface WebsocketResponse {
  backend?: 'esplora' | 'electrum' | 'none';
  block?: BlockExtended;
  blocks?: BlockExtended[];
  conversions?: Record<string, number>;
  txConfirmed?: string;
  historicalDate?: string;
  mempoolInfo?: MempoolInfo;
  bytesPerSecond?: number;
  previousRetarget?: number;
  action?: string;
  data?: string[];
  tx?: Transaction;
  transactions?: TransactionStripped[];
  loadingIndicators?: ILoadingIndicators;
  backendInfo?: IBackendInfo;
  da?: DifficultyAdjustment;
  fees?: Recommendedfees;
  'track-tx'?: string;
  'track-mempool-block'?: number;
  'watch-mempool'?: boolean;
  'refresh-blocks'?: boolean;
}

export interface MempoolBlock {
  blink?: boolean;
  height?: number;
  blockSize: number;
  blockVSize: number;
  nTx: number;
  medianFee: number;
  totalFees: number;
  feeRange: number[];
  index: number;
  isStack?: boolean;
}

export interface MempoolBlockWithTransactions extends MempoolBlock {
  transactionIds: string[];
  transactions: TransactionStripped[];
}

export interface MempoolBlockDelta {
  block: number;
  added: TransactionStripped[];
  removed: string[];
  changed: { txid: string, rate: number, flags: number }[];
}
export interface MempoolBlockState {
  block: number;
  transactions: TransactionStripped[];
}
export type MempoolBlockUpdate = MempoolBlockDelta | MempoolBlockState;
export function isMempoolState(update: MempoolBlockUpdate): update is MempoolBlockState {
  return update['transactions'] !== undefined;
}
export function isMempoolDelta(update: MempoolBlockUpdate): update is MempoolBlockDelta {
  return update['transactions'] === undefined;
}

export interface MempoolBlockDeltaCompressed {
  added: TransactionCompressed[];
  removed: string[];
  changed: MempoolDeltaChange[];
}

export interface MempoolInfo {
  loaded: boolean;                 //  (boolean) True if the mempool is fully loaded
  size: number;                    //  (numeric) Current tx count
  bytes: number;                   //  (numeric) Sum of all virtual transaction sizes as defined in BIP 141.
  usage: number;                   //  (numeric) Total memory usage for the mempool
  maxmempool: number;              //  (numeric) Maximum memory usage for the mempool
  mempoolminfee: number;           //  (numeric) Minimum fee rate in BTC/kB for tx to be accepted.
  minrelaytxfee: number;           //  (numeric) Current minimum relay fee for transactions
}

// [txid, fee, vsize, value, rate, flags, time]
export type TransactionCompressed = [string, number, number, number, number, number, number];
// [txid, rate, flags]
export type MempoolDeltaChange = [string, number, number];

export interface IBackendInfo {
  hostname?: string;
  gitCommit: string;
  version: string;
}

export interface Recommendedfees {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  minimumFee: number;
  economyFee: number;
}

export interface HealthCheckHost {
  host: string;
  active: boolean;
  rtt: number;
  latestHeight: number;
  socket: boolean;
  outOfSync: boolean;
  unreachable: boolean;
  checked: boolean;
  lastChecked: number;
  link?: string;
  statusPage?: SafeResourceUrl;
  flag?: string;
  hashes?: {
    frontend?: string;
    backend?: string;
    electrs?: string;
    hybrid?: string;
    ssr?: string;
    core?: string;
    os?: string;
  };
  liquidAudit?: {
    pegRatio: number;
    bitcoinLastBlockUpdate: number;
    liquidLastBlockUpdate: number;
  };
}
