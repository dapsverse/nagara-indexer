import type { NetworkId } from "../config.js";
import { getPool } from "../db.js";
import type { IndexerStatus } from "../queries.js";

/**
 * The EVM-chain equivalent of `indexerStatus()` — same shape, read from
 * `evm_cursor`/`evm_block`/`evm_tx` instead of `indexer_state`/`block`/`tx`.
 * `evm_cursor` has no `updated_at` column, so that field is always null here;
 * polling this twice and comparing `lastIndexedBlock` answers "is it moving"
 * just as well.
 */
export async function evmIndexerStatus(network: NetworkId): Promise<IndexerStatus> {
  const pool = getPool();
  const [cursor, counts] = await Promise.all([
    pool.query<{ last_indexed_block: string; backfill_block: string | null }>(
      `SELECT last_indexed_block, backfill_block FROM evm_cursor WHERE network = $1`,
      [network],
    ),
    pool.query<{ blocks: string; txns: string }>(
      `SELECT (SELECT count(*) FROM evm_block WHERE network = $1) AS blocks,
              (SELECT count(*) FROM evm_tx    WHERE network = $1) AS txns`,
      [network],
    ),
  ]);

  const row = cursor.rows[0];
  return {
    network,
    lastIndexedBlock: row ? Number(row.last_indexed_block) : null,
    oldestIndexedBlock: row?.backfill_block == null ? null : Number(row.backfill_block),
    historyComplete: row?.backfill_block === "0",
    updatedAt: null,
    indexedBlocks: Number(counts.rows[0].blocks),
    indexedTransactions: Number(counts.rows[0].txns),
  };
}

export type EvmBlockRow = {
  blockNumber: string;
  hash: string;
  parentHash: string;
  timestamp: string;
  author: string | null;
  gasUsed: string;
  gasLimit: string;
  baseFee: string | null;
  txCount: number;
};

/**
 * Newest blocks first, keyset-paginated by block number — the EVM-chain
 * equivalent of `listBlocks()`. Field names follow the chain's own shape
 * (gas, not weight; no state/extrinsics roots) rather than forcing the
 * substrate response's fields onto data that doesn't have them.
 */
export async function listEvmBlocks(
  network: NetworkId,
  limit: number,
  before?: number,
): Promise<EvmBlockRow[]> {
  const { rows } = await getPool().query(
    `SELECT number, hash, parent_hash, timestamp, author, gas_used, gas_limit,
            base_fee, tx_count
       FROM evm_block
      WHERE network = $1
        AND ($3::bigint IS NULL OR number < $3)
      ORDER BY number DESC
      LIMIT $2`,
    [network, limit, before ?? null],
  );
  return rows.map((row) => ({
    blockNumber: row.number,
    hash: row.hash,
    parentHash: row.parent_hash,
    timestamp: row.timestamp.toISOString(),
    author: row.author,
    gasUsed: row.gas_used,
    gasLimit: row.gas_limit,
    baseFee: row.base_fee,
    txCount: Number(row.tx_count),
  }));
}

export type EvmActivityCursor = {
  blockNumber: number;
  txIndex: number;
  kind: 0 | 1;
  logIndex: number;
  subIndex: number;
};

export type EvmActivityRow = {
  hash: string;
  blockNumber: string;
  txIndex: number;
  kind: 0 | 1;
  logIndex: number;
  subIndex: number;
  timestamp: string;
  from: string | null;
  to: string | null;
  token: string;
  amountRaw: string;
  status: "success" | "failed";
  feeRaw: string;
};

/**
 * Native transfers and ERC-20 token transfers touching one address, merged
 * into a single time-sorted feed for the wallet activity view.
 *
 * `kind` (0 = native, 1 = token) plus the token branch's own `log_index`/
 * `sub_index` break ties: one transaction can be BOTH a native value transfer
 * AND trigger a token transfer (a payable contract call), and one transaction
 * can contain several token transfers (a multi-hop call). Without these in
 * the sort key and the cursor, a page boundary landing between tied rows
 * would drop one of them forever.
 *
 * All amounts stay as the strings `pg` returns — `Number()` loses precision
 * above 2^53, and token amounts routinely exceed it.
 */
export async function listEvmActivity(
  network: NetworkId,
  limit: number,
  filters: { address: string; cursor?: EvmActivityCursor },
): Promise<EvmActivityRow[]> {
  const address = filters.address.toLowerCase();
  const c = filters.cursor;
  const { rows } = await getPool().query(
    `SELECT * FROM (
       SELECT t.hash, t.block_number, t.tx_index, 0::int AS kind, -1::int AS log_index, -1::int AS sub_index,
              b.timestamp, t.from_addr, t.to_addr, 'native'::text AS token, t.value AS amount_raw,
              t.status, (t.gas_used * COALESCE(t.effective_gas_price, t.gas_price, 0)) AS fee_raw
         FROM evm_tx t
         JOIN evm_block b ON b.network = t.network AND b.number = t.block_number
        WHERE t.network = $1
          AND t.value > 0
          AND (t.from_addr = $2 OR t.to_addr = $2)
          AND ($4::bigint IS NULL
               OR (t.block_number, t.tx_index, 0, -1, -1)
                  < ($4::bigint, $5::int, $6::int, $7::int, $8::int))
       UNION ALL
       SELECT t.hash, t.block_number, t.tx_index, 1::int AS kind, tt.log_index, tt.sub_index,
              b.timestamp, tt.from_addr, tt.to_addr, tt.token, tt.value AS amount_raw,
              t.status, (t.gas_used * COALESCE(t.effective_gas_price, t.gas_price, 0)) AS fee_raw
         FROM evm_tx t
         JOIN evm_block b ON b.network = t.network AND b.number = t.block_number
         JOIN evm_token_transfer tt ON tt.network = t.network AND tt.tx_hash = t.hash
         JOIN evm_token tok ON tok.network = t.network AND tok.address = tt.token AND tok.type = 'erc20'
        WHERE t.network = $1
          AND (tt.from_addr = $2 OR tt.to_addr = $2)
          AND ($4::bigint IS NULL
               OR (t.block_number, t.tx_index, 1, tt.log_index, tt.sub_index)
                  < ($4::bigint, $5::int, $6::int, $7::int, $8::int))
     ) activity
     ORDER BY block_number DESC, tx_index DESC, kind DESC, log_index DESC, sub_index DESC
     LIMIT $3`,
    [
      network,
      address,
      limit,
      c?.blockNumber ?? null,
      c?.txIndex ?? null,
      c?.kind ?? null,
      c?.logIndex ?? null,
      c?.subIndex ?? null,
    ],
  );
  return rows.map((row) => ({
    hash: row.hash,
    blockNumber: row.block_number,
    txIndex: Number(row.tx_index),
    kind: row.kind,
    logIndex: Number(row.log_index),
    subIndex: Number(row.sub_index),
    timestamp: row.timestamp.toISOString(),
    from: row.from_addr,
    to: row.to_addr,
    token: row.token,
    amountRaw: row.amount_raw,
    status: row.status === 1 ? "success" : "failed",
    feeRaw: row.fee_raw,
  }));
}
