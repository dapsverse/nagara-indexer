import { BlockNotFoundError } from "viem";
import { createEvmClient } from "./rpc.js";
import { ingestBlock } from "./ingest.js";
import { getPool } from "../db.js";
import { NETWORKS, type NetworkId } from "../config.js";

const BATCH = 50;
const POLL_MS = 6000;

const log = (network: NetworkId, message: string) =>
  console.log(`[${new Date().toISOString()}] [${network}] ${message}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readCursor(network: NetworkId): Promise<bigint | null> {
  const { rows } = await getPool().query<{ last_indexed_block: string }>(
    "SELECT last_indexed_block FROM evm_cursor WHERE network = $1",
    [network],
  );
  return rows.length ? BigInt(rows[0].last_indexed_block) : null;
}

/**
 * Moves the cursor past a block whose body the RPC node no longer has. The
 * gap is permanent — that block can never be indexed from this node — so it
 * is logged rather than swallowed.
 */
async function skipBlock(network: NetworkId, n: bigint): Promise<void> {
  await getPool().query(
    `INSERT INTO evm_cursor (network, last_indexed_block) VALUES ($1,$2)
     ON CONFLICT (network) DO UPDATE
       SET last_indexed_block = GREATEST(evm_cursor.last_indexed_block, EXCLUDED.last_indexed_block)`,
    [network, n.toString()],
  );
}

/**
 * Indexes one EVM-typed network: a single sequential walk from its cursor to
 * the finalized head, polling for new blocks once caught up.
 *
 * Unlike the substrate path's tip-follower/backfiller split, there is no
 * "show the live tip now, fill in history behind it" behavior here — accepted
 * for now because the EVM chains this indexes are young. See the design
 * spec's "Known limitations" section.
 */
export async function runEvmNetworkIndexer(network: NetworkId): Promise<void> {
  const config = NETWORKS[network];
  if (config.chainType !== "evm") {
    throw new Error(`${network} is not an evm network`);
  }
  const client = createEvmClient(config.rpcHttpUrl, config.chainId);

  async function ingestOrSkip(n: bigint): Promise<void> {
    try {
      await ingestBlock(client, network, n);
    } catch (error) {
      if (!(error instanceof BlockNotFoundError)) throw error;
      // Retried once before giving up: a finalized block that is briefly
      // absent is an RPC hiccup, one that is still absent has been pruned.
      await sleep(POLL_MS);
      try {
        await ingestBlock(client, network, n);
        return;
      } catch (again) {
        if (!(again instanceof BlockNotFoundError)) throw again;
      }
      log(network, `block ${n} is not available from the RPC node (pruned) — skipping, gap is permanent`);
      await skipBlock(network, n);
    }
  }

  for (;;) {
    try {
      const cursor = await readCursor(network);
      let next = cursor === null ? 0n : cursor + 1n;
      const head = (await client.getBlock({ blockTag: "finalized" })).number;

      if (next > head) {
        await sleep(POLL_MS);
        continue;
      }

      const end = next + BigInt(BATCH) - 1n > head ? head : next + BigInt(BATCH) - 1n;
      for (; next <= end; next++) await ingestOrSkip(next);
      log(network, `indexed up to ${end} / ${head}`);
    } catch (error) {
      // Never exit on a transient RPC failure — the cursor is durable, so the
      // next pass resumes exactly where this one stopped.
      log(network, `indexer error, retrying: ${(error as Error).message}`);
      await sleep(POLL_MS);
    }
  }
}
