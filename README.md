# nagara-indexer

Indexes the [Nagara](https://nagara.network) Substrate chain into Postgres and
serves it back over a small read-only HTTP API.

It exists because a browser cannot answer questions that span history. The
explorer frontend talks to a node directly for live data — the newest block
arrives over a websocket in a few seconds — but "how many transactions happened
on each of the last 14 days" or "page back through blocks" needs data that
outlives a page load. That is this service.

```
   Nagara nodes ──ws──▶  nagara-indexer  ──▶  Postgres
                              │
                              └── HTTP :8787 ──▶  nagara-web (server-side)
```

The frontend never connects to Postgres. It reads this API server-side and
proxies it, so database credentials live in exactly one place.

## Quick start

```bash
cp .env.example .env      # set DATABASE_URL at minimum
npm install
npm start
```

The schema is applied automatically on first start — every statement in
`src/schema.sql` is `IF NOT EXISTS`, so there is no separate migration step.

```bash
curl localhost:8787/health   # {"ok":true}
curl localhost:8787/status   # cursors and row counts per network
```

For server deployment, see **[DEPLOYMENT.md](./DEPLOYMENT.md)** — it is written to
be followed step by step, with a check after each one.

## How it indexes

Each network gets two independent loops:

- **Tip follower** — subscribes to new heads and writes forward. Small batches, so
  the newest block lands within seconds.
- **Backfiller** — walks *downwards* from where it started, towards block 0.
  Large batches, because throughput matters more than latency here.

They are deliberately independent: history is millions of blocks, and it must
never hold up the live tip. A visitor sees current data on the first run while
history is still filling in behind them.

Progress is two cursors in `indexer_state` (`last_block`, `backfill_block`).
Every write is an upsert keyed on `(network, block_number, extrinsic_index)`, so
restarting, retrying, or overlapping the two loops is a no-op rather than a
duplicate. Neither cursor advances past a block that was not actually stored.

### Pruned nodes limit how far back you can go

The public endpoints discard old block bodies **and** state. Measured 2026-08-12:

| Network | History served         |
| ------- | ---------------------- |
| Mainnet | ~250 blocks (~12 min)  |
| Testnet | ~1,000 blocks (~50 min)|

Below that, requests fail with `-32000: Api called for an unknown Block: State
already discarded`. The backfiller recognises this, logs it plainly, and stops —
it does not spin, and it does not skip ahead:

```
history unavailable below #4,427,561: these blocks are pruned. Backfill paused.
Set MAINNET_ARCHIVE_WS_URL to an archive node and restart to continue from here.
```

Point `MAINNET_ARCHIVE_WS_URL` / `TESTNET_ARCHIVE_WS_URL` at an archive node
(`--state-pruning archive --blocks-pruning archive`, synced from genesis) and
restart; it resumes from the stored cursor. Measured throughput is 26–42
blocks/sec at `FETCH_CONCURRENCY=25`.

## What gets stored

- `block` — one row per block: hash, parent, roots, timestamp, author, weight
  used/max, and the full extrinsic count.
- `tx` — one row per **listed** transaction: value transfers and contract
  activity (deploys, calls, code uploads). Inherents like `timestamp.set` are
  deliberately not stored as rows — they are ~99% of all extrinsics and carry no
  user-visible meaning. They are still reflected in `block.extrinsics_count`.

Amounts are kept as raw chain units in `NUMERIC(39,0)` — a `u128` does not fit in
a `BIGINT`, and formatting is a display concern.

## API

All `GET`, all JSON, all accept `?network=mainnet|testnet` (default `mainnet`).

| Endpoint        | Parameters                               |
| --------------- | ---------------------------------------- |
| `/health`       | —                                        |
| `/status`       | —                                        |
| `/daily`        | `days` (1–365, default 14)               |
| `/blocks`       | `limit` (1–100), `before`                |
| `/transactions` | `limit`, `before`, `address`, `contract` |

Paging is keyset: pass `before=<lowest blockNumber you have>` for the next page.

`/daily` counts by calendar day in **Asia/Jakarta**, derived from the `tx` rows
with a `GROUP BY` rather than kept as separate counters — one source of truth, so
the chart cannot drift from the transaction lists. Days with no activity are
returned as `0` rather than omitted, so a chart's x axis stays honest.

## Development

```bash
npm run dev        # tsx watch
npm run typecheck  # tsc --noEmit
```

## ⚠️ The decoder is duplicated

`src/decode.ts`, `src/format.ts` and `src/types.ts` are copies of the frontend's
chain-decoding modules. Sharing them is what guarantees an indexed row agrees
with what the explorer shows live — the same function decides whether an
extrinsic counts as a transaction in both places.

Because they are copies across two repositories, **they can drift**. If you change
how an extrinsic is classified here, change it in `nagara-web` too, or promote
these three files into a package both repos depend on.
