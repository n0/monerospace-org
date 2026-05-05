/* eslint-disable no-console */
/**
 * Smoke test against the configured public monerod. Run via:
 *
 *   npx ts-node src/api/monero/__tests__/monero-api.smoke.ts
 *
 * No assertions — prints the values so a human can eyeball them. The
 * intent is "did the wire format match what we expect" rather than CI.
 * Env: MONEROD_RPC_URL (defaults to https://xmr-node.cakewallet.com:18081).
 */
import { moneroApiFromEnv } from '../monero-api';

async function main(): Promise<void> {
  const api = moneroApiFromEnv();

  const info = await api.getInfo();
  console.log('info:', {
    height: info.height,
    difficulty: info.difficulty,
    tx_pool_size: info.tx_pool_size,
    nettype: info.nettype,
    version: info.version,
    status: info.status,
  });

  const count = await api.getBlockCount();
  console.log('block_count:', count);

  const fees = await api.getFeeEstimate();
  console.log('fees:', { fee: fees.fee, fees: fees.fees, quantization_mask: fees.quantization_mask });

  const pool = await api.getTransactionPool();
  console.log('mempool_size:', pool.transactions?.length ?? 0);
  if (pool.transactions?.length) {
    const sample = pool.transactions[0];
    console.log('mempool_sample:', {
      id_hash: sample.id_hash,
      weight: sample.weight,
      fee: sample.fee,
      receive_time_age_s: sample.receive_time
        ? Math.floor(Date.now() / 1000) - sample.receive_time
        : 'n/a (daemon did not report receive_time)',
    });
  }

  const head = await api.getBlockByHeight(count - 1);
  console.log('head_block:', {
    height: head.block_header.height,
    hash: head.block_header.hash,
    num_txes: head.block_header.num_txes,
    block_weight: head.block_header.block_weight,
    miner_tx_hash: head.miner_tx_hash,
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('smoke failed:', err);
    process.exit(1);
  });
