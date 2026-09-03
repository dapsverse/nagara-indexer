import type { PublicClient } from "viem";
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

export type Cursors = { lastBlock: bigint | null; backfillBlock: bigint | null };

export async function readCursors(network: NetworkId): Promise<Cursors> {
  const { rows } = await getPool().query<{
    last_indexed_block: string;
    backfill_block: string | null;
  }>(
    "SELECT last_indexed_block, backfill_block FROM evm_cursor WHERE network = $1",
    [network],
  );
  if (!rows.length) return { lastBlock: null, backfillBlock: null };
  return {
    lastBlock: BigInt(rows[0].last_indexed_block),
    backfillBlock: rows[0].backfill_block === null ? null : BigInt(rows[0].backfill_block),
  };
}

/** First-ever run for this network: seed both cursors at the current head. */
export async function initCursors(network: NetworkId, head: bigint): Promise<void> {
  await getPool().query(
    `INSERT INTO evm_cursor (network, last_indexed_block, backfill_block)
     VALUES ($1, $2, $2)
     ON CONFLICT (network) DO NOTHING`,
    [network, head.toString()],
  );
}

export async function advanceLastBlock(network: NetworkId, n: bigint): Promise<void> {
  await getPool().query(
    `UPDATE evm_cursor SET last_indexed_block = GREATEST(last_indexed_block, $2)
       WHERE network = $1`,
    [network, n.toString()],
  );
}

export async function advanceBackfillBlock(network: NetworkId, n: bigint): Promise<void> {
  await getPool().query(
    `UPDATE evm_cursor SET backfill_block = $2 WHERE network = $1`,
    [network, n.toString()],
  );
}

/**
 * Ingests one block, retrying once on a transient RPC miss. `onGap` decides
 * what a block that never becomes available means for the caller's cursor —
 * the forward and backward loops disagree about that, so it's a parameter
 * rather than a fixed behavior here.
 */
async function ingestOrGap(
  client: PublicClient,
  network: NetworkId,
  n: bigint,
  onGap: (n: bigint) => Promise<void>,
): Promise<void> {
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
    await onGap(n);
  }
}

/**
 * Forward loop: keeps the newest blocks indexed, in near real time. Starts
 * above whatever `last_indexed_block` already covers — on a fresh network
 * that's the head at startup, so new activity shows up within one poll
 * interval regardless of how much history is still being backfilled.
 */
async function followTip(client: PublicClient, network: NetworkId): Promise<void> {
  for (;;) {
    try {
      const head = (await client.getBlock({ blockTag: "finalized" })).number;
      const { lastBlock } = await readCursors(network);
      let next = (lastBlock ?? head) + 1n;

      if (next > head) {
        await sleep(POLL_MS);
        continue;
      }

      const end = next + BigInt(BATCH) - 1n > head ? head : next + BigInt(BATCH) - 1n;
      for (; next <= end; next++) {
        await ingestOrGap(client, network, next, async (n) => {
          // A gap in the live tip is unusual (the finalized head shouldn't be
          // pruned), but skipping past it is still correct: never blocking
          // the tip forever on one unreachable block.
          log(network, `tip: block ${n} unavailable — skipping, gap is permanent`);
        });
      }
      await advanceLastBlock(network, end);
      log(network, `tip → #${end}`);
    } catch (error) {
      log(network, `tip error, retrying: ${(error as Error).message}`);
      await sleep(POLL_MS);
    }
  }
}

/**
 * Backward loop: fills history from the cursor down to block 0, independent
 * of the tip. Stops (rather than skipping ahead) the moment a block is
 * unavailable — below that point the RPC node has no data at all, so there is
 * nothing further back worth attempting.
 */
async function backfill(client: PublicClient, network: NetworkId): Promise<void> {
  for (;;) {
    try {
      const { backfillBlock } = await readCursors(network);
      if (backfillBlock === null) {
        await sleep(1000);
        continue;
      }
      if (backfillBlock <= 0n) {
        log(network, "history complete — backfill reached block 0");
        return;
      }

      const to = backfillBlock - 1n;
      const wanted = to - BigInt(BATCH) + 1n;
      const from = wanted > 0n ? wanted : 0n;

      let stopped = false;
      for (let n = to; n >= from; n--) {
        if (stopped) break;
        await ingestOrGap(client, network, n, async (gapN) => {
          log(
            network,
            `history unavailable below #${gapN + 1n}: RPC node has no data ` +
              "further back. Backfill stopped here.",
          );
          stopped = true;
        });
        if (!stopped) await advanceBackfillBlock(network, n);
      }
      if (stopped) return;

      log(network, `history ← #${from} (${to - from + 1n} blocks)`);
    } catch (error) {
      log(network, `backfill error, retrying: ${(error as Error).message}`);
      await sleep(5000);
    }
  }
}

/**
 * Indexes one EVM-typed network: tip forwards from wherever it started,
 * history backwards from the same starting point. The two run concurrently
 * and never block each other, mirroring the substrate path's design — recent
 * activity is visible immediately, old history fills in behind it.
 */
export async function runEvmNetworkIndexer(network: NetworkId): Promise<void> {
  const config = NETWORKS[network];
  if (config.chainType !== "evm") {
    throw new Error(`${network} is not an evm network`);
  }

  // The caller (runIndexer) invokes this once per process lifetime and only
  // logs a rejection, it never retries — so a transient failure anywhere in
  // here (a slow RPC response, Postgres not yet accepting connections right
  // after boot, a DNS blip) must not permanently disable this network's
  // indexing until the next deploy restarts the process. followTip/backfill
  // already retry forever once started; this loop covers the startup step
  // itself, which previously ran exactly once with no way back in.
  for (;;) {
    try {
      const client = createEvmClient(config.rpcHttpUrl, config.chainId);
      const head = (await client.getBlock({ blockTag: "finalized" })).number;
      await initCursors(network, head);
      log(network, `connected, head #${head}`);

      // Resolves only if followTip or backfill throws past its own internal
      // retry — shouldn't happen, but if it does, fall through and restart
      // clean rather than leaving the network silently unindexed.
      await Promise.all([followTip(client, network), backfill(client, network)]);
    } catch (error) {
      log(network, `startup error, retrying: ${(error as Error).message}`);
      await sleep(POLL_MS);
    }
  }
}
