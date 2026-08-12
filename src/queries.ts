import { DAILY_TIMEZONE, type NetworkId } from "./config.js";
import { getPool } from "./db.js";

export type DailyPoint = { date: string; count: number };

export type IndexerStatus = {
  network: NetworkId;
  lastIndexedBlock: number | null;
  oldestIndexedBlock: number | null;
  historyComplete: boolean;
  updatedAt: string | null;
  indexedBlocks: number;
  indexedTransactions: number;
};

/**
 * Daily counts derived straight from the `tx` rows.
 *
 * Not kept as separate counters on purpose: one source of truth means the chart
 * can never drift from the transaction lists. `generate_series` fills days with
 * no activity as 0 rather than letting them vanish and skew the x axis.
 */
export async function dailyTransactions(
  network: NetworkId,
  days: number
): Promise<DailyPoint[]> {
  const { rows } = await getPool().query<{ day: string; count: string }>(
    `WITH days AS (
       SELECT generate_series(
         (now() AT TIME ZONE $2)::date - ($3::int - 1),
         (now() AT TIME ZONE $2)::date,
         interval '1 day'
       )::date AS day
     )
     SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
            count(tx.block_number)          AS count
       FROM days
       LEFT JOIN tx
         ON tx.network = $1
        AND (tx.ts AT TIME ZONE $2)::date = days.day
      GROUP BY days.day
      ORDER BY days.day`,
    [network, DAILY_TIMEZONE, days]
  );
  return rows.map((row) => ({ date: row.day, count: Number(row.count) }));
}

export async function indexerStatus(
  network: NetworkId
): Promise<IndexerStatus> {
  const pool = getPool();
  const [state, counts] = await Promise.all([
    pool.query<{
      last_block: string;
      backfill_block: string | null;
      updated_at: Date;
    }>(
      `SELECT last_block, backfill_block, updated_at
         FROM indexer_state WHERE network = $1`,
      [network]
    ),
    pool.query<{ blocks: string; txns: string }>(
      `SELECT (SELECT count(*) FROM block WHERE network = $1) AS blocks,
              (SELECT count(*) FROM tx    WHERE network = $1) AS txns`,
      [network]
    ),
  ]);

  const row = state.rows[0];
  return {
    network,
    lastIndexedBlock: row ? Number(row.last_block) : null,
    oldestIndexedBlock:
      row?.backfill_block == null ? null : Number(row.backfill_block),
    historyComplete: row?.backfill_block === "0",
    updatedAt: row ? row.updated_at.toISOString() : null,
    indexedBlocks: Number(counts.rows[0].blocks),
    indexedTransactions: Number(counts.rows[0].txns),
  };
}

/** Newest blocks first, keyset-paginated by block number. */
export async function listBlocks(
  network: NetworkId,
  limit: number,
  before?: number
) {
  const { rows } = await getPool().query(
    `SELECT block_number, hash, parent_hash, state_root, extrinsics_root, ts,
            extrinsics_count, author, weight_used, weight_max
       FROM block
      WHERE network = $1
        AND ($3::bigint IS NULL OR block_number < $3)
      ORDER BY block_number DESC
      LIMIT $2`,
    [network, limit, before ?? null]
  );
  return rows.map((row) => ({
    blockNumber: Number(row.block_number),
    hash: row.hash,
    parentHash: row.parent_hash,
    stateRoot: row.state_root,
    extrinsicsRoot: row.extrinsics_root,
    timestamp: row.ts.toISOString(),
    extrinsicsCount: Number(row.extrinsics_count),
    author: row.author,
    weightUsed: Number(row.weight_used),
    weightMax: Number(row.weight_max),
  }));
}

/**
 * Newest transactions first, optionally narrowed to one address (either side of
 * a transfer) or one contract.
 */
export async function listTransactions(
  network: NetworkId,
  limit: number,
  filters: { before?: number; address?: string; contract?: string }
) {
  const { rows } = await getPool().query(
    `SELECT block_number, extrinsic_index, block_hash, extrinsic_hash, ts, kind,
            section, method, signer, dest, contract, amount_raw, fee_raw,
            success, error
       FROM tx
      WHERE network = $1
        AND ($3::bigint IS NULL OR block_number < $3)
        AND ($4::text IS NULL OR signer = $4 OR dest = $4)
        AND ($5::text IS NULL OR contract = $5)
      ORDER BY block_number DESC, extrinsic_index DESC
      LIMIT $2`,
    [
      network,
      limit,
      filters.before ?? null,
      filters.address ?? null,
      filters.contract ?? null,
    ]
  );
  return rows.map((row) => ({
    id: `${row.block_number}-${row.extrinsic_index}`,
    blockNumber: Number(row.block_number),
    extrinsicIndex: Number(row.extrinsic_index),
    blockHash: row.block_hash,
    extrinsicHash: row.extrinsic_hash,
    timestamp: row.ts.toISOString(),
    kind: row.kind,
    section: row.section,
    method: row.method,
    methodFull: `${row.section}.${row.method}`,
    signer: row.signer,
    dest: row.dest,
    contract: row.contract,
    amountRaw: row.amount_raw,
    feeRaw: row.fee_raw,
    success: row.success,
    error: row.error,
  }));
}
