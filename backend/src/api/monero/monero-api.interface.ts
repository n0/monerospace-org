/**
 * Type definitions for the subset of the monerod JSON-RPC and /endpoint
 * responses that xmr-space consumes. Field names mirror monerod's wire
 * format (snake_case, atomic-units integers as strings/numbers depending
 * on the field) so callers know they're looking at raw daemon shape.
 *
 * Reference: https://docs.getmonero.org/rpc-library/monerod-rpc/
 */
export namespace IMoneroApi {
  /** Response from `get_info` JSON-RPC. */
  export interface Info {
    height: number;
    target_height: number;
    difficulty: number;
    cumulative_difficulty: number;
    target: number;
    tx_count: number;
    tx_pool_size: number;
    alt_blocks_count: number;
    outgoing_connections_count: number;
    incoming_connections_count: number;
    rpc_connections_count: number;
    white_peerlist_size: number;
    grey_peerlist_size: number;
    mainnet: boolean;
    testnet: boolean;
    stagenet: boolean;
    nettype: 'mainnet' | 'testnet' | 'stagenet' | 'fakechain';
    top_block_hash: string;
    cumulative_difficulty_top64?: number;
    difficulty_top64?: number;
    block_size_limit: number;
    block_size_median: number;
    start_time: number;
    free_space?: number;
    offline?: boolean;
    untrusted: boolean;
    bootstrap_daemon_address?: string;
    height_without_bootstrap?: number;
    was_bootstrap_ever_used?: boolean;
    database_size?: number;
    update_available?: boolean;
    version?: string;
    busy_syncing?: boolean;
    synchronized?: boolean;
    status: string;
  }

  /** Response from `get_block_count`. */
  export interface BlockCount {
    count: number;
    status: string;
  }

  /** A block header as returned by `get_block_header_by_hash`, `get_block_header_by_height`, or embedded in `get_block`. */
  export interface BlockHeader {
    hash: string;
    height: number;
    depth: number;
    timestamp: number;
    nonce: number;
    orphan_status: boolean;
    prev_hash: string;
    reward: number;
    block_size: number;
    block_weight: number;
    num_txes: number;
    pow_hash?: string;
    major_version: number;
    minor_version: number;
    cumulative_difficulty: number;
    difficulty: number;
    miner_tx_hash: string;
    long_term_weight: number;
  }

  /** Response from `get_block`. */
  export interface Block {
    blob: string;
    block_header: BlockHeader;
    /** JSON-encoded miner_tx + tx_hashes. The daemon returns this as a string; callers must JSON.parse. */
    json: string;
    miner_tx_hash: string;
    /** Non-coinbase tx hashes in the block. Coinbase is `block_header.miner_tx_hash`. */
    tx_hashes?: string[];
    status: string;
  }

  /** Decoded payload of `Block.json`. */
  export interface BlockJson {
    major_version: number;
    minor_version: number;
    timestamp: number;
    prev_id: string;
    nonce: number;
    miner_tx: {
      version: number;
      unlock_time: number;
      vin: Array<{ gen: { height: number } }>;
      vout: Array<{ amount: number; target: { tagged_key?: { key: string; view_tag?: string } } }>;
      extra: number[];
      rct_signatures: { type: number };
    };
    tx_hashes: string[];
  }

  /** A single entry in the `get_transaction_pool` response. */
  export interface MempoolEntry {
    id_hash: string;
    tx_json: string;
    blob_size: number;
    tx_blob?: string;
    weight: number;
    fee: number;
    receive_time: number;
    relayed: boolean;
    last_relayed_time: number;
    do_not_relay: boolean;
    double_spend_seen: boolean;
    kept_by_block: boolean;
    last_failed_height?: number;
    last_failed_id_hash?: string;
    max_used_block_height?: number;
    max_used_block_id_hash?: string;
  }

  /** Response from `get_transaction_pool` (NB: this is a `/endpoint` call, not JSON-RPC). */
  export interface TransactionPool {
    transactions?: MempoolEntry[];
    spent_key_images?: Array<{ id_hash: string; txs_hashes: string[] }>;
    status: string;
    untrusted: boolean;
  }

  /** Response from `get_fee_estimate` JSON-RPC. */
  export interface FeeEstimate {
    /** Atomic-units per byte. */
    fee: number;
    quantization_mask: number;
    /** Atomic-units per byte: [slow, normal, fast, fastest]. */
    fees?: [number, number, number, number];
    status: string;
    untrusted: boolean;
  }

  /** Response entry from `get_transactions` (NB: `/get_transactions` endpoint, not JSON-RPC). */
  export interface TransactionEntry {
    tx_hash: string;
    as_hex: string;
    as_json?: string;
    in_pool: boolean;
    double_spend_seen: boolean;
    block_height?: number;
    block_timestamp?: number;
    confirmations?: number;
    received_timestamp?: number;
    relayed?: boolean;
    output_indices?: number[];
    pruned_as_hex?: string;
    prunable_as_hex?: string;
    prunable_hash?: string;
  }

  /** Request entry for `/get_outs`, used to resolve ring member heights. */
  export interface GetOutsRequestOutput {
    amount: number;
    index: number;
  }

  /** Public output metadata returned by `/get_outs`. */
  export interface GetOutsOutput {
    height: number;
    key: string;
    mask: string;
    txid?: string;
    unlocked: boolean;
  }

  /** Response from `/get_outs` (NB: `/endpoint` call, not JSON-RPC). */
  export interface GetOutsResponse {
    credits?: number;
    outs?: GetOutsOutput[];
    status: string;
    top_hash?: string;
    untrusted: boolean;
  }

  /** Decoded payload of `TransactionEntry.as_json`. */
  export interface TransactionJson {
    version: number;
    unlock_time: number;
    vin: Array<{ key?: { amount: number; key_offsets: number[]; k_image: string } }>;
    vout: Array<{ amount: number; target: { tagged_key?: { key: string; view_tag?: string }; key?: string } }>;
    extra: number[];
    rct_signatures: {
      type: number;
      txnFee?: number;
      ecdhInfo?: Array<{ amount: string }>;
      outPk?: string[];
    };
    rctsig_prunable?: unknown;
  }
}

/**
 * Internal monerod RPC error envelope. Surfaced when the daemon's `error`
 * field is populated; we wrap it in a thrown `Error` with the code/message.
 */
export interface MoneroRpcError {
  code: number;
  message: string;
}

/** Configured target daemon — typically derived from env. */
export interface MoneroDaemonConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  rpcUser?: string;
  rpcPassword?: string;
  /** Per-request timeout in ms. */
  timeoutMs: number;
  /**
   * When a fallback is configured, require the primary daemon to be synced
   * before routing reads to it. This keeps a bootstrapping local node from
   * serving stale early-chain data while it catches up.
   */
  requirePrimarySync?: boolean;
  /** Max tolerated primary height lag when requirePrimarySync is enabled. */
  maxPrimaryHeightLag?: number;
  /** How often to re-check primary daemon sync/health before using fallback. */
  primaryHealthCheckIntervalMs?: number;
}
