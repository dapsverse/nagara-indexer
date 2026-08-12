import { ApiPromise, WsProvider } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import {
  BACKFILL_BATCH,
  FETCH_CONCURRENCY,
  NETWORKS,
  TIP_BATCH,
  backfillWsUrl,
  hasArchive,
  type NetworkId,
} from "./config.js";
import { ensureSchema, getPool } from "./db.js";
import { fetchRange, persistBlocks } from "./writeBlocks.js";

type Cursors = { lastBlock: number | null; backfillBlock: number | null };

const log = (network: NetworkId, message: string) =>
  console.log(`[${new Date().toISOString()}] [${network}] ${message}`);

const n = (value: number) => value.toLocaleString("en-US");

async function connect(url: string): Promise<ApiPromise> {
  const api = await ApiPromise.create({
    provider: new WsProvider(url),
    noInitWarn: true,
  });
  await api.isReady;
  return api;
}

async function readCursors(network: NetworkId): Promise<Cursors> {
  const { rows } = await getPool().query<{
    last_block: string;
    backfill_block: string | null;
  }>(
    "SELECT last_block, backfill_block FROM indexer_state WHERE network = $1",
    [network]
  );
  if (rows.length === 0) return { lastBlock: null, backfillBlock: null };
  return {
    lastBlock: Number(rows[0].last_block),
    backfillBlock:
      rows[0].backfill_block === null ? null : Number(rows[0].backfill_block),
  };
}

async function writeCursors(
  network: NetworkId,
  cursors: { lastBlock?: number; backfillBlock?: number }
): Promise<void> {
  await getPool().query(
    `INSERT INTO indexer_state (network, last_block, backfill_block, updated_at)
     VALUES ($1, COALESCE($2, 0), $3, now())
     ON CONFLICT (network) DO UPDATE SET
       last_block     = GREATEST(indexer_state.last_block,
                                 COALESCE($2, indexer_state.last_block)),
       backfill_block = COALESCE($3, indexer_state.backfill_block),
       updated_at     = now()`,
    [network, cursors.lastBlock ?? null, cursors.backfillBlock ?? null]
  );
}

/** Forward loop: keep the newest blocks written, in near real time. */
async function followTip(api: ApiPromise, network: NetworkId): Promise<void> {
  let busy = false;

  const catchUp = async () => {
    if (busy) return;
    busy = true;
    try {
      const head = (await api.rpc.chain.getHeader()).number.toNumber();
      let { lastBlock } = await readCursors(network);
      if (lastBlock === null) lastBlock = head;

      while (lastBlock < head) {
        const from = lastBlock + 1;
        const to = Math.min(head, from + TIP_BATCH - 1);
        const { fetched, missing } = await fetchRange(
          api,
          from,
          to,
          FETCH_CONCURRENCY
        );
        const written = await persistBlocks(network, fetched);

        // Only advance past what was actually stored: skipping a block the node
        // failed to serve would lose it permanently.
        const advanceTo = missing.length === 0 ? to : Math.min(...missing) - 1;
        if (advanceTo >= from) await writeCursors(network, { lastBlock: advanceTo });

        if (missing.length > 0) {
          log(
            network,
            `tip stalled at #${n(Math.min(...missing))} — node did not serve ` +
              `${missing.length} block(s); will retry`
          );
          break;
        }

        lastBlock = advanceTo;
        log(
          network,
          `tip → #${n(to)} (+${written.blocks} blocks, ${written.transactions} txns)`
        );
      }
    } catch (error) {
      log(network, `tip error: ${(error as Error).message}`);
    } finally {
      busy = false;
    }
  };

  await catchUp();
  // The head number is unused: catchUp re-reads it, which also picks up heads
  // that arrive while a batch is still being written.
  await api.rpc.chain.subscribeNewHeads(() => void catchUp());

  // Never resolves; the subscription keeps this worker alive.
  return new Promise(() => {});
}

/**
 * Backward loop: fill history from the cursor down to block 0.
 *
 * Reads from the archive endpoint when one is configured. Against a pruned node
 * it stops at the wall rather than spinning, keeping its cursor so that pointing
 * `*_ARCHIVE_WS_URL` at an archive node and restarting resumes exactly there.
 */
async function backfill(network: NetworkId): Promise<void> {
  const url = backfillWsUrl(network);
  const api = await connect(url);
  log(
    network,
    `backfill reading from ${url}${hasArchive(network) ? " (archive)" : " (pruned live node — limited history)"}`
  );

  try {
    for (;;) {
      const { backfillBlock } = await readCursors(network);

      if (backfillBlock === null) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      if (backfillBlock <= 0) {
        log(network, "history complete — backfill reached block 0");
        return;
      }

      const to = backfillBlock - 1;
      const from = Math.max(0, to - BACKFILL_BATCH + 1);

      try {
        const started = Date.now();
        const { fetched, missing } = await fetchRange(
          api,
          from,
          to,
          FETCH_CONCURRENCY
        );
        const written = await persistBlocks(network, fetched);

        if (fetched.length === 0 && missing.length > 0) {
          log(
            network,
            `history unavailable below #${n(to)}: these blocks are pruned. ` +
              (hasArchive(network)
                ? "Even the archive endpoint refused them — check that it synced from genesis."
                : `Backfill paused. Set ${network.toUpperCase()}_ARCHIVE_WS_URL to an archive node and restart to continue from here.`)
          );
          return;
        }

        // Partial batch: park the cursor just above the first hole so nothing
        // is silently skipped.
        const nextCursor =
          missing.length === 0 ? from : Math.max(...missing) + 1;
        await writeCursors(network, { backfillBlock: nextCursor });

        const seconds = (Date.now() - started) / 1000;
        const rate = seconds > 0 ? Math.round(written.blocks / seconds) : 0;
        log(
          network,
          `history ← #${n(nextCursor)} (${written.blocks} blocks, ` +
            `${written.transactions} txns, ${rate}/s, ${n(nextCursor)} remaining)`
        );
      } catch (error) {
        log(network, `backfill error: ${(error as Error).message} — retrying`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  } finally {
    await api.disconnect();
  }
}

/** Indexes one network: tip forwards on the live node, history backwards. */
export async function runNetworkIndexer(network: NetworkId): Promise<void> {
  const config = NETWORKS[network];
  const api = await connect(config.wsUrl);

  const chain = (await api.rpc.system.chain()).toString();
  const head = (await api.rpc.chain.getHeader()).number.toNumber();
  log(network, `connected to ${chain} at ${config.wsUrl}, head #${n(head)}`);

  // First ever run: anchor both cursors at the head. Forward work starts there
  // and history has the whole chain below it to work through.
  if ((await readCursors(network)).lastBlock === null) {
    await writeCursors(network, { lastBlock: head, backfillBlock: head });
    log(network, `initialised cursors at head #${n(head)}`);
  }

  await Promise.all([followTip(api, network), backfill(network)]);
}

/** Starts every configured network. One bad chain must not stop the others. */
export async function runIndexer(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

  await cryptoWaitReady();
  await ensureSchema();

  const networks = Object.keys(NETWORKS) as NetworkId[];
  await Promise.all(
    networks.map((network) =>
      runNetworkIndexer(network).catch((error: unknown) => {
        log(network, `worker stopped: ${(error as Error).message}`);
      })
    )
  );
}
