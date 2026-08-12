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
    `SELECT t.block_number, t.extrinsic_index, t.block_hash, t.extrinsic_hash,
            t.ts, t.kind, t.section, t.method, t.signer, t.dest, t.contract,
            t.amount_raw, t.fee_raw, t.success, t.error,
            c.code_hash, c.token_symbol, c.is_token,
            tt.message AS transfer_message, tt.from_address AS transfer_from,
            tt.to_address AS transfer_to, tt.amount_raw AS transfer_amount,
            tt.provenance AS transfer_provenance,
            COALESCE(
              (SELECT json_agg(json_build_object(
                        'eventIndex', e.event_index,
                        'contract',   e.contract,
                        'data',       '0x' || encode(e.data, 'hex'))
                      ORDER BY e.event_index)
                 FROM tx_event e
                WHERE e.network = t.network
                  AND e.block_number = t.block_number
                  AND e.extrinsic_index = t.extrinsic_index),
              '[]'::json) AS events
       FROM tx t
       LEFT JOIN contract c
         ON c.network = t.network AND c.address = t.contract
       LEFT JOIN token_transfer tt
         ON tt.network = t.network
        AND tt.block_number = t.block_number
        AND tt.extrinsic_index = t.extrinsic_index
      WHERE t.network = $1
        AND ($3::bigint IS NULL OR t.block_number < $3)
        AND ($4::text IS NULL OR t.signer = $4 OR t.dest = $4)
        AND ($5::text IS NULL OR t.contract = $5)
      ORDER BY t.block_number DESC, t.extrinsic_index DESC
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
    /** Which ABI applies to `contract`, when the contract is known. */
    codeHash: row.code_hash ?? null,
    /** Token identity of `contract`, probed by interface. */
    tokenSymbol: row.token_symbol ?? null,
    isToken: row.is_token ?? null,
    /**
     * The NKRI08 transfer this call performed, when it made one. `provenance`
     * says how it was established — 'inferred' means selector-matched with no
     * ABI, so the amount is a reading, not a receipt.
     */
    tokenTransfer: row.transfer_message
      ? {
          message: row.transfer_message as string,
          from: (row.transfer_from as string | null) ?? null,
          to: row.transfer_to as string,
          amountRaw: row.transfer_amount as string,
          provenance: row.transfer_provenance as string,
        }
      : null,
    amountRaw: row.amount_raw,
    feeRaw: row.fee_raw,
    success: row.success,
    error: row.error,
    /**
     * Raw ink! event payloads emitted by this extrinsic. Decoding needs the
     * emitting contract's ABI — see the tx_event comment in schema.sql.
     */
    events: row.events as {
      eventIndex: number;
      contract: string;
      data: string;
    }[],
  }));
}

/** Contracts seen on chain, optionally narrowed to one code hash. */
export async function listContracts(
  network: NetworkId,
  filters: { codeHash?: string }
) {
  const { rows } = await getPool().query(
    `SELECT address, code_hash, first_seen_block
       FROM contract
      WHERE network = $1
        AND ($2::text IS NULL OR code_hash = $2)
      ORDER BY first_seen_block DESC`,
    [network, filters.codeHash ?? null]
  );
  return rows.map((row) => ({
    address: row.address,
    codeHash: row.code_hash ?? null,
    firstSeenBlock: Number(row.first_seen_block),
  }));
}

export type TokenTransferRow = {
  blockNumber: number;
  extrinsicIndex: number;
  token: string;
  message: string;
  from: string | null;
  to: string;
  amountRaw: string;
  provenance: string;
  success: boolean;
  timestamp: string;
  tokenSymbol: string | null;
  tokenName: string | null;
};

/**
 * Decoded NKRI08 transfers, newest first. `provenance` travels with every row so
 * a caller can tell a standard-inferred amount from an ABI-verified one.
 */
export async function listTokenTransfers(
  network: NetworkId,
  limit: number,
  filters: { before?: number; token?: string; address?: string }
): Promise<TokenTransferRow[]> {
  const { rows } = await getPool().query(
    `SELECT tt.block_number, tt.extrinsic_index, tt.token, tt.message,
            tt.from_address, tt.to_address, tt.amount_raw, tt.provenance,
            tt.success, b.ts, c.token_symbol, c.token_name
       FROM token_transfer tt
       JOIN block b
         ON b.network = tt.network AND b.block_number = tt.block_number
       LEFT JOIN contract c
         ON c.network = tt.network AND c.address = tt.token
      WHERE tt.network = $1
        AND ($3::bigint IS NULL OR tt.block_number < $3)
        AND ($4::text IS NULL OR tt.token = $4)
        AND ($5::text IS NULL OR tt.from_address = $5 OR tt.to_address = $5)
      ORDER BY tt.block_number DESC, tt.extrinsic_index DESC
      LIMIT $2`,
    [
      network,
      limit,
      filters.before ?? null,
      filters.token ?? null,
      filters.address ?? null,
    ]
  );
  return rows.map((row) => ({
    blockNumber: Number(row.block_number),
    extrinsicIndex: Number(row.extrinsic_index),
    token: row.token,
    message: row.message,
    from: row.from_address,
    to: row.to_address,
    amountRaw: row.amount_raw,
    provenance: row.provenance,
    success: row.success,
    timestamp: row.ts.toISOString(),
    tokenSymbol: row.token_symbol ?? null,
    tokenName: row.token_name ?? null,
  }));
}

/** Contracts that answered the NKRI08 read interface. */
export async function listTokens(network: NetworkId) {
  const { rows } = await getPool().query(
    `SELECT address, code_hash, token_name, token_symbol, first_seen_block
       FROM contract
      WHERE network = $1 AND is_token
      ORDER BY first_seen_block ASC`,
    [network]
  );
  return rows.map((row) => ({
    address: row.address,
    codeHash: row.code_hash ?? null,
    name: row.token_name ?? null,
    symbol: row.token_symbol ?? null,
    firstSeenBlock: Number(row.first_seen_block),
  }));
}
