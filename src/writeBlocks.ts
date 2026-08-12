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
import { SS58_FORMAT } from "./config.js";
import { decodeStandardTransfer } from "./standard.js";

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

export type FetchedBlock = {
  block: BlockRow;
  transactions: ChainExtrinsic[];
  /** Contract address -> code hash, for every contract this block touched. */
  contracts: Map<string, string | null>;
};

/**
 * Code hashes change only on upgrade, so one lookup per address per process is
 * enough — and it keeps the backfill from re-querying the same token thousands
 * of times.
 */
const codeHashCache = new Map<string, string | null>();

async function codeHashOf(
  api: ApiPromise,
  address: string
): Promise<string | null> {
  const cached = codeHashCache.get(address);
  if (cached !== undefined) return cached;

  let hash: string | null = null;
  try {
    const info = (await api.query.contracts.contractInfoOf(address)) as unknown as {
      isSome: boolean;
      unwrap: () => { codeHash: { toHex: () => string } };
    };
    hash = info.isSome ? info.unwrap().codeHash.toHex() : null;
  } catch {
    // A terminated contract has no info; the address is still worth recording.
    hash = null;
  }
  codeHashCache.set(address, hash);
  return hash;
}

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

  const decodedListed = decoded.filter(isListedTransaction);

  // Every contract this block interacted with, whether it was the call target or
  // merely emitted an event.
  const addresses = new Set<string>();
  for (const tx of decodedListed) {
    if (tx.contract) addresses.add(tx.contract);
    for (const emitted of tx.contractEmitted) addresses.add(emitted.contract);
  }
  const contracts = new Map<string, string | null>();
  for (const address of addresses) {
    contracts.set(address, await codeHashOf(api, address));
  }

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
    transactions: decodedListed,
    contracts,
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

    // Raw contract event payloads. Undecodable today without the emitting
    // contract's ABI, which is exactly why the bytes are kept.
    const events = fetched.flatMap((entry) =>
      entry.transactions.flatMap((tx) =>
        tx.contractEmitted.map((emitted, eventIndex) => ({
          blockNumber: tx.blockNumber,
          extrinsicIndex: tx.extrinsicIndex,
          eventIndex,
          contract: emitted.contract,
          data: Buffer.from(emitted.data.replace(/^0x/, ""), "hex"),
        }))
      )
    );

    if (events.length > 0) {
      const values: unknown[] = [];
      const rows = events.map((event, i) => {
        const o = i * 6;
        values.push(
          network,
          event.blockNumber,
          event.extrinsicIndex,
          event.eventIndex,
          event.contract,
          event.data
        );
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`;
      });

      await client.query(
        `INSERT INTO tx_event (network, block_number, extrinsic_index,
                               event_index, contract, data)
         VALUES ${rows.join(",")}
         ON CONFLICT (network, block_number, extrinsic_index, event_index)
           DO NOTHING`,
        values
      );
    }

    // Contract registry. first_seen_block only ever moves backwards, so the
    // backfill filling in older blocks corrects it rather than overwriting it.
    const contractRows = new Map<string, { codeHash: string | null; block: number }>();
    for (const entry of fetched) {
      for (const [address, codeHash] of entry.contracts) {
        const existing = contractRows.get(address);
        if (!existing || entry.block.number < existing.block) {
          contractRows.set(address, { codeHash, block: entry.block.number });
        }
      }
    }

    if (contractRows.size > 0) {
      const values: unknown[] = [];
      const rows = [...contractRows.entries()].map(([address, row], i) => {
        const o = i * 4;
        values.push(network, address, row.codeHash, row.block);
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4})`;
      });

      await client.query(
        `INSERT INTO contract (network, address, code_hash, first_seen_block)
         VALUES ${rows.join(",")}
         ON CONFLICT (network, address) DO UPDATE SET
           code_hash        = COALESCE(EXCLUDED.code_hash, contract.code_hash),
           first_seen_block = LEAST(contract.first_seen_block,
                                    EXCLUDED.first_seen_block)`,
        values
      );
    }

    // NKRI08 transfers, read straight from the call selector. No ABI needed:
    // the selector is derived from the message name, so any contract that spells
    // its message `transfer` is decodable. Flagged 'inferred' because a matching
    // name and layout is not proof the contract means the same thing.
    const transfers = fetched.flatMap((entry) =>
      entry.transactions.flatMap((tx) => {
        if (tx.kind !== "contractCall" || !tx.callData || !tx.contract) return [];
        const decoded = decodeStandardTransfer(tx.callData, SS58_FORMAT);
        if (!decoded) return [];
        return [{ tx, decoded }];
      })
    );

    if (transfers.length > 0) {
      const values: unknown[] = [];
      const rows = transfers.map(({ tx, decoded }, i) => {
        const o = i * 9;
        values.push(
          network,
          tx.blockNumber,
          tx.extrinsicIndex,
          tx.contract,
          decoded.message,
          decoded.from,
          decoded.to,
          decoded.amountRaw,
          tx.success
        );
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},'inferred',$${o + 9})`;
      });

      await client.query(
        `INSERT INTO token_transfer (network, block_number, extrinsic_index, token,
                                     message, from_address, to_address, amount_raw,
                                     provenance, success)
         VALUES ${rows.join(",")}
         ON CONFLICT (network, block_number, extrinsic_index) DO NOTHING`,
        values
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
