import type { ApiPromise } from "@polkadot/api";
import type { NetworkId } from "./config.js";
import {
  decodeBlockExtrinsics,
  isListedTransaction,
  readBlockTimestamp,
  readWeight,
} from "./decode.js";
import type { ChainExtrinsic } from "./types.js";
import { getPool } from "./db.js";

type WeightLike = { refTime: { toBigInt: () => bigint } };
type BlockWeightsConst = { maxBlock: WeightLike };

type BlockRow = {
  number: number;
  hash: string;
  parentHash: string;
  stateRoot: string;
  extrinsicsRoot: string;
  ts: Date;
  extrinsicsCount: number;
  author: string | null;
  weightUsed: number;
  weightMax: number;
};

export type FetchedBlock = { block: BlockRow; transactions: ChainExtrinsic[] };

/**
 * Reads one block and decodes it with the very same functions the UI uses, so an
 * indexed row can never disagree with what the explorer shows live.
 */
export async function fetchBlock(
  api: ApiPromise,
  number: number
): Promise<FetchedBlock | null> {
  const hash = (await api.rpc.chain.getBlockHash(number)).toHex();
  const derived = await api.derive.chain.getBlock(hash);
  if (!derived) return null;

  const header = derived.block.header;
  const timestampMs = readBlockTimestamp(derived.extrinsics);
  const timestamp = new Date(timestampMs);

  const weightUsed = derived.extrinsics.reduce(
    (total, tx) => total + readWeight(tx.dispatchInfo),
    0
  );
  const weightMax = Number(
    (
      api.consts.system.blockWeights as unknown as BlockWeightsConst
    ).maxBlock.refTime.toBigInt()
  );

  const decoded = decodeBlockExtrinsics({
    api,
    txs: derived.extrinsics,
    blockNumber: number,
    blockHash: hash,
    timestamp: timestamp.toISOString(),
  });

  return {
    block: {
      number,
      hash,
      parentHash: header.parentHash.toHex(),
      stateRoot: header.stateRoot.toHex(),
      extrinsicsRoot: header.extrinsicsRoot.toHex(),
      ts: timestamp,
      extrinsicsCount: derived.extrinsics.length,
      author: derived.author?.toString() ?? null,
      weightUsed,
      weightMax,
    },
    // Only listable activity is stored; inherents would be 99% of the rows and
    // the block's own extrinsics_count already records them.
    transactions: decoded.filter(isListedTransaction),
  };
}

/**
 * Writes a batch of blocks and their transactions.
 *
 * Every statement is an upsert keyed on the primary key, so replaying a range —
 * after a crash, a restart, or overlapping tip and backfill work — is a no-op
 * rather than a duplicate.
 */
export async function persistBlocks(
  network: NetworkId,
  fetched: FetchedBlock[]
): Promise<{ blocks: number; transactions: number }> {
  if (fetched.length === 0) return { blocks: 0, transactions: 0 };

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const blockValues: unknown[] = [];
    const blockRows = fetched.map(({ block }, i) => {
      const o = i * 11;
      blockValues.push(
        network,
        block.number,
        block.hash,
        block.parentHash,
        block.stateRoot,
        block.extrinsicsRoot,
        block.ts,
        block.extrinsicsCount,
        block.author,
        block.weightUsed,
        block.weightMax
      );
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11})`;
    });

    await client.query(
      `INSERT INTO block (network, block_number, hash, parent_hash, state_root,
                          extrinsics_root, ts, extrinsics_count, author,
                          weight_used, weight_max)
       VALUES ${blockRows.join(",")}
       ON CONFLICT (network, block_number) DO NOTHING`,
      blockValues
    );

    const transactions = fetched.flatMap((entry) => entry.transactions);
    if (transactions.length > 0) {
      const txValues: unknown[] = [];
      const txRows = transactions.map((tx, i) => {
        const o = i * 16;
        txValues.push(
          network,
          tx.blockNumber,
          tx.extrinsicIndex,
          tx.blockHash,
          tx.extrinsicHash,
          new Date(tx.timestamp),
          tx.kind,
          tx.section,
          tx.method,
          tx.signer,
          tx.dest,
          tx.contract,
          tx.amountRaw,
          tx.feeRaw,
          tx.success,
          tx.error
        );
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11},$${o + 12},$${o + 13},$${o + 14},$${o + 15},$${o + 16})`;
      });

      await client.query(
        `INSERT INTO tx (network, block_number, extrinsic_index, block_hash,
                         extrinsic_hash, ts, kind, section, method, signer, dest,
                         contract, amount_raw, fee_raw, success, error)
         VALUES ${txRows.join(",")}
         ON CONFLICT (network, block_number, extrinsic_index) DO NOTHING`,
        txValues
      );
    }

    await client.query("COMMIT");
    return { blocks: fetched.length, transactions: transactions.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Fetches a range with bounded concurrency, preserving order. */
export type RangeResult = {
  fetched: FetchedBlock[];
  /** Blocks the node would not serve, e.g. because their data is pruned. */
  missing: number[];
};

/**
 * Fetches a range with bounded concurrency.
 *
 * Unreadable blocks are reported rather than silently dropped — the caller must
 * know, because advancing a cursor past a block that was never written would
 * skip it forever.
 */
export async function fetchRange(
  api: ApiPromise,
  from: number,
  to: number,
  concurrency: number
): Promise<RangeResult> {
  const numbers: number[] = [];
  for (let n = from; n <= to; n += 1) numbers.push(n);

  const fetched: FetchedBlock[] = [];
  const missing: number[] = [];

  for (let i = 0; i < numbers.length; i += concurrency) {
    const slice = numbers.slice(i, i + concurrency);
    const results = await Promise.all(
      slice.map(async (number) => {
        try {
          const block = await fetchBlock(api, number);
          return block ?? { missing: number };
        } catch {
          return { missing: number };
        }
      })
    );

    for (const entry of results) {
      if ("missing" in entry) missing.push(entry.missing);
      else fetched.push(entry);
    }
  }

  return { fetched, missing };
}
