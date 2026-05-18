export type LegacyWebsocketTrackingMessage =
  | { 'track-address': string }
  | { 'track-addresses': string[] }
  | { 'track-asset': string }
  | { 'track-wallet': string }
  | { 'track-stratum': string | number | null };

export interface StratumJob {
  pool: number;
  height: number;
  coinbase: string;
  scriptsig: string;
  reward: number;
  jobId: string;
  extraNonce: string;
  extraNonce2Size: number;
  prevHash: string;
  coinbase1: string;
  coinbase2: string;
  merkleBranches: string[];
  version: string;
  bits: string;
  time: string;
  timestamp: number;
  cleanJobs: boolean;
  received: number;
}
