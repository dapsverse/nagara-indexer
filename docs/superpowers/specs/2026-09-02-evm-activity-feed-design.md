# EVM support for `nagara-indexer`: serving `/activity` to the wallet

Date: 2026-09-02
Status: implemented & merged 2026-09-02. nagara-evm-explorer deleted same day (no remote, working tree was clean).

## Context

`nagara-indexer` currently indexes one Substrate chain (`apps/pos`, ink!/
`pallet-contracts`) for two networks, `mainnet` and `testnet`, both read via
`@polkadot/api` WS + SCALE decoding (shared decode logic lives in the external
package `@nusameta/nagara-chain`, aka the `chain-core` repo).

Two things changed since that architecture was built:

1. **`testnet` migrated chains.** It now runs `apps/evm` — a sovereign
   Substrate chain with `pallet-ethereum`/`pallet-evm` (Frontier) bolted on.
   Every transaction is now wrapped in a single `ethereum.transact` extrinsic;
   the indexer's existing decoder does not recognize this shape at all
   (`section !== "balances"` and `section !== "contracts"`, so `kind` resolves
   to `"other"` and `isListedTransaction` filters every row out — confirmed by
   reading `chain-core`'s `decode.ts`). **Testnet has been indexing zero
   transactions since the migration.**
2. **`mainnet` will migrate the same way later** — but as a brand-new genesis
   chain (chain id 16868, `apps/evm`), not an in-place runtime upgrade. There
   is no in-between state where one chain speaks both protocols at once.

A separate app, `nagara-evm-explorer`, was built in the meantime as a
purpose-built EVM indexer (viem + JSON-RPC, Postgres, a Next.js UI). Per
Irsan's decision, **it is being retired in favor of Blockscout** for the
explorer UI. Its indexing code is well-built and is not being thrown away
uselessly — the useful parts are ported into this repo per the plan below,
then the app is deleted.

**`nagara-indexer`'s reason to exist, going forward, narrows to one thing:
serve `/activity` to the NusaMeta wallet extension.** The wallet's full API
contract (from the FE team) is reproduced here for reference:

```
GET /activity?network=testnet&address=0x…&limit=50&cursor=…
```

Each item:

```json
{
  "hash": "0x…",
  "blockNumber": "87519",
  "timestamp": "2026-09-02T04:12:33Z",
  "from": "0x…",
  "to": "0x…",
  "token": "native",
  "amountRaw": "1500000000000000000",
  "status": "success",
  "feeRaw": "99999999999999"
}
```

Hard requirements (unchanged from the original `/activity` design, restated
because they apply equally to the EVM path):

- `blockNumber`, `amountRaw`, `feeRaw` are strings, never numbers (10^18
  exceeds JS safe-integer precision).
- Token identified by contract address, never by symbol.
- Failed transactions are included, not filtered out.
- Data comes from block/transaction bodies, not solely from emitted events —
  a plain value transfer emits no log.
- `decimals` is deliberately **not** in the response — the wallet already
  reads it from the token contract directly. (This was also fixed as a bug in
  the first, Substrate-only version of this endpoint, which had it hardcoded
  to `18`.)

## Goals

- `/activity` returns correct, complete data for `testnet` (EVM) starting
  from this work landing.
- The same endpoint, same response shape, keeps working for `mainnet` (still
  the old ink! chain) until it migrates — no wallet-visible difference.
- When `mainnet` migrates to `apps/evm`, enabling it here is a config change,
  not a rewrite.
- `nagara-evm-explorer`'s ingestion logic (viem pipeline, ERC-20/721/1155 log
  classification, MINAR selector decoding) is reused, not rewritten.

## Non-goals

- Rewriting or fixing `/blocks`, `/daily`, `/contracts`, `/tokens`, `/price` —
  they stay exactly as they are. They were built for the old explorer's needs
  and nothing currently depends on them working for an EVM network, but
  Irsan expects the wallet may need some of them later, so they are not
  deleted either. This is a deliberate "leave it inert" choice, not an
  oversight.
- General-purpose EVM explorer features (contract verification, ERC-721/1155
  browsing, daily stats). That is Blockscout's job now.
- Deleting or modifying the `chain-core` repo/package itself. `apps/web`
  still declares it as a dependency and this work does not touch `apps/web`.
  What this work *does* do is stop `nagara-indexer` from depending on it (see
  below) — the repo's fate is a decision for whoever owns `apps/web`.
- A tip/backfill split for the EVM ingestion path (see "Known limitations").

## Decisions made during design (log)

1. **No permanent dual decoder.** Rather than teach the existing Substrate
   SCALE decoder about `ethereum.transact` (technically possible — the call's
   `args[0]` carries `to`/`value`/`input` directly, and `pallet_ethereum`'s
   `Executed` event carries the ecrecovered `from` and `exit_reason` for
   status — verified by reading `frame/ethereum/src/lib.rs` in `apps/evm`,
   pinned commit `baf505d8`), the EVM path is ported wholesale from
   `nagara-evm-explorer`, which already talks to the chain over JSON-RPC via
   `viem` and reads real transaction receipts (`gasUsed`,
   `effectiveGasPrice`, `status`) instead of reconstructing them from events.
   Higher fidelity, and the code already exists.
2. **Branch by network's chain type, not by network name.** Hardcoding
   `network === "testnet"` anywhere would silently break the day `mainnet`
   migrates. A `chainType: "substrate" | "evm"` field is added per network in
   `config.ts`; every branch point (ingestion, `/activity` query) reads that
   field. Migrating `mainnet` later is flipping one config value plus
   pointing `rpcHttpUrl` at the new chain — no code change.
3. **The old (`substrate`) ingestion path and its tables are untouched.**
   They keep serving `mainnet` until it migrates, then simply stop being
   exercised. Nothing is deleted preemptively.
4. **`nagara-indexer` stops depending on `@nusameta/nagara-chain`.** The
   decode functions it still needs for the `substrate` path
   (`decodeBlockExtrinsics`, `isListedTransaction`, `decodeStandardTransfer`,
   plus the `format`/`types` helpers they need) are vendored directly into
   this repo's `src/`, replacing the GitHub package dependency. Behavior is
   unchanged — this is a dependency-ownership change, not a logic change.
5. **`nagara-evm-explorer` is deleted once its ingestion code has been
   ported and is running here.** Not before — the code must have a working
   home first.
6. **Token scope for `/activity` is fungible tokens only.** The wallet only
   ever asks about NGRX (native) and MINAR (ERC-20). The merged EVM query
   filters to `tokens.type = 'erc20'`; ERC-721/1155 transfers (which
   `nagara-evm-explorer`'s schema also tracks, generically) are excluded from
   this feed. The tables still store them — only the `/activity` query
   narrows.

## Architecture

### 1. Config

`src/config.ts` gains a `chainType` field on `NetworkConfig`:

```ts
export type ChainType = "substrate" | "evm";

export type NetworkConfig = {
  id: NetworkId;
  label: string;
  chainType: ChainType;
  // substrate fields (existing): wsUrl, archiveWsUrl
  // evm fields (new): rpcHttpUrl, chainId
};

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  mainnet: { id: "mainnet", label: "Mainnet", chainType: "substrate", wsUrl: … },
  testnet: { id: "testnet", label: "Testnet", chainType: "evm", rpcHttpUrl: …, chainId: 16869 },
};
```

`wsUrl`/`archiveWsUrl` become optional (only meaningful for `chainType:
"substrate"`); `rpcHttpUrl`/`chainId` are new and only meaningful for
`chainType: "evm"`. Reading the wrong field for a network's chain type is a
programmer error the type system should catch where practical (a discriminated
union on `chainType` is worth it here — two shapes, and reading the wrong one
means calling `WsProvider` on a value that doesn't exist for an EVM network).

### 2. Ingestion — two independent pipelines, selected per network

`runIndexer()` in `runIndexer.ts` picks a pipeline per network by
`NETWORKS[network].chainType`:

- `"substrate"` → today's code path, unchanged (`runNetworkIndexer`, tip
  follower + backfiller, `@polkadot/api`).
- `"evm"` → a new, ported pipeline in `src/evm/`:
  - `src/evm/rpc.ts` — viem client + `getBlockReceipts` (ported from
    `nagara-evm-explorer/src/lib/rpc.ts`, chain id from config).
  - `src/evm/tokens.ts` — `classifyTransferLog`, `detectToken` (ported
    verbatim from `nagara-evm-explorer/src/indexer/tokens.ts`).
  - `src/evm/minar.ts` — MINAR selectors/topics/decoders (ported verbatim
    from `nagara-evm-explorer/src/lib/minar.ts`). Not consumed by `/activity`
    yet (the wallet doesn't need forced-transfer detection), kept because
    it's already written and free to carry over; a genuinely unused file
    would not be worth porting on its own.
  - `src/evm/ingest.ts` — `ingestBlock()`, ported from
    `nagara-evm-explorer/src/indexer/ingest.ts`, adapted to add a `network`
    column to every insert (the source app was one deployment per network;
    this repo is multi-network in one database).
  - `src/evm/runEvmIndexer.ts` — the poll loop from
    `nagara-evm-explorer/src/indexer/index.ts` (finalized-height polling,
    batch of 50, 6s interval), adapted to loop per `evm`-typed network
    instead of assuming one.

The two pipelines share nothing at runtime except the Postgres pool
(`db.ts`) — this is deliberate; forcing a shared abstraction over two
protocols this different is exactly the kind of premature unification that
makes both harder to read.

### 3. Schema — new tables for the EVM path, existing tables untouched

Ported from `nagara-evm-explorer/src/db/schema.sql` (`blocks`, `transactions`,
`logs`, `tokens`, `token_transfers`), renamed with an `evm_` prefix to avoid
collision with the existing `block`/`contract` tables and to make which path
owns which table unambiguous at a glance, and with `network TEXT NOT NULL`
added to every table (and to every primary key / index that identified a row
by hash alone):

```sql
CREATE TABLE IF NOT EXISTS evm_block (
  network      TEXT NOT NULL,
  number       BIGINT NOT NULL,
  hash         TEXT NOT NULL,
  parent_hash  TEXT NOT NULL,
  timestamp    TIMESTAMPTZ NOT NULL,
  author       TEXT,
  gas_used     NUMERIC(78,0) NOT NULL,
  gas_limit    NUMERIC(78,0) NOT NULL,
  base_fee     NUMERIC(78,0),
  tx_count     INTEGER NOT NULL,
  PRIMARY KEY (network, number)
);

CREATE TABLE IF NOT EXISTS evm_tx (
  network              TEXT NOT NULL,
  hash                 TEXT NOT NULL,
  block_number         BIGINT NOT NULL,
  tx_index             INTEGER NOT NULL,
  from_addr            TEXT NOT NULL,
  to_addr              TEXT,
  value                NUMERIC(78,0) NOT NULL,
  gas_used             NUMERIC(78,0) NOT NULL,
  gas_price            NUMERIC(78,0),
  effective_gas_price  NUMERIC(78,0),
  status               SMALLINT NOT NULL,
  nonce                BIGINT NOT NULL,
  input                BYTEA NOT NULL,
  contract_address     TEXT,
  PRIMARY KEY (network, hash)
);
CREATE INDEX IF NOT EXISTS evm_tx_from_idx  ON evm_tx (network, from_addr, block_number DESC);
CREATE INDEX IF NOT EXISTS evm_tx_to_idx    ON evm_tx (network, to_addr, block_number DESC);

CREATE TABLE IF NOT EXISTS evm_log (
  network      TEXT NOT NULL,
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  address      TEXT NOT NULL,
  topic0       TEXT,
  topic1       TEXT,
  topic2       TEXT,
  topic3       TEXT,
  data         BYTEA NOT NULL,
  PRIMARY KEY (network, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS evm_log_topic0_idx ON evm_log (network, topic0, block_number DESC);

CREATE TABLE IF NOT EXISTS evm_token (
  network    TEXT NOT NULL,
  address    TEXT NOT NULL,
  type       TEXT NOT NULL,       -- 'erc20' | 'erc721' | 'erc1155'
  name       TEXT,
  symbol     TEXT,
  decimals   SMALLINT,
  first_seen BIGINT NOT NULL,
  PRIMARY KEY (network, address)
);

CREATE TABLE IF NOT EXISTS evm_token_transfer (
  network      TEXT NOT NULL,
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  sub_index    INTEGER NOT NULL DEFAULT 0,
  block_number BIGINT NOT NULL,
  token        TEXT NOT NULL,
  from_addr    TEXT NOT NULL,
  to_addr      TEXT NOT NULL,
  value        NUMERIC(78,0),
  token_id     NUMERIC(78,0),
  PRIMARY KEY (network, tx_hash, log_index, sub_index),
  FOREIGN KEY (network, tx_hash, log_index)
    REFERENCES evm_log (network, tx_hash, log_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS evm_tt_token_idx ON evm_token_transfer (network, token, block_number DESC);
CREATE INDEX IF NOT EXISTS evm_tt_from_idx  ON evm_token_transfer (network, from_addr, block_number DESC);
CREATE INDEX IF NOT EXISTS evm_tt_to_idx    ON evm_token_transfer (network, to_addr, block_number DESC);

CREATE TABLE IF NOT EXISTS evm_cursor (
  network            TEXT PRIMARY KEY,
  last_indexed_block BIGINT NOT NULL
);
```

`contracts` and `verify_jobs` from `nagara-evm-explorer`'s schema are **not**
ported — they exist to support contract verification and Blockscout (or
whatever replaces it) owns that job now.

### 4. `/activity` — one route, branches internally

`server.ts`'s `case "/activity"` reads `NETWORKS[network].chainType` and
calls one of two query functions, both returning the same `ActivityRow`
shape the wallet already sees:

- `chainType === "substrate"` → `listActivity()` (already built and reviewed
  in the previous piece of this work — untouched).
- `chainType === "evm"` → new `listEvmActivity()` in `src/evm/queries.ts`.

**`listEvmActivity()` design** — a `UNION ALL` of two branches over
`evm_tx`, mirroring the tiebreak problem already solved for the Substrate
path (one transaction can be *both* a value transfer *and* trigger a token
transfer — e.g. a payable contract call): each row carries a `kind` (0 =
native, 1 = token) and, for token rows, the log's own `log_index`/`sub_index`
so multiple token transfers inside one transaction (a multi-hop call) sort
and paginate deterministically instead of colliding on the transaction hash
alone.

- **Native branch**: `evm_tx` where `value > 0` and (`from_addr = $address`
  or `to_addr = $address`). `token = 'native'`, `amountRaw = value`,
  `log_index = -1`, `sub_index = -1` (sentinel — natural values are always
  ≥ 0, so these never collide with a real token row).
- **Token branch**: `evm_tx JOIN evm_token_transfer ON (network, tx_hash) =
  (network, hash) JOIN evm_token ON evm_token.address = evm_token_transfer.token
  AND evm_token.type = 'erc20'` where (`from_addr = $address` or `to_addr =
  $address`). `token = evm_token_transfer.token`, `amountRaw =
  evm_token_transfer.value`.
- Both branches select `hash`, `block_number`, `tx_index`, `kind`,
  `log_index`, `sub_index`, and compute
  `fee_raw = gas_used * COALESCE(effective_gas_price, gas_price, 0)` from the
  **transaction** row (shared by both branches of the same tx).
- `status = evm_tx.status = 1 ? "success" : "failed"`.
- Sort: `block_number DESC, tx_index DESC, kind DESC, log_index DESC,
  sub_index DESC`. Cursor carries all five components, opaque string
  `"<blockNumber>:<txIndex>:<kind>:<logIndex>:<subIndex>"`, compared as a
  Postgres row-value tuple exactly like the Substrate path's cursor — same
  reasoning, same failure mode avoided (a page boundary landing mid-tie must
  not silently drop the other half of the tie).
- `blockNumber`/`amountRaw`/`feeRaw` stay as the raw `pg` strings — same
  precision rule as everywhere else in this codebase.

### 5. Deleting `nagara-evm-explorer`

Once `src/evm/*` is running against testnet and `/activity` answers
correctly for it, `nagara-evm-explorer` is deleted as a separate, final step
— not bundled into the same commit as the port, so the port can be reviewed
and verified against a still-running reference implementation if anything
looks wrong.

## Known limitations (accepted, not blocking)

- **No tip/backfill split for the EVM path.** `nagara-evm-explorer`'s loop
  walks strictly forward from its cursor to the finalized head; it has no
  equivalent of the Substrate path's "show the live tip now, fill in history
  behind it" split, and no pruned-node gap recovery. Acceptable today because
  the EVM testnet is young (~85k blocks) and full sync is fast. Revisit if
  `mainnet`'s EVM chain accumulates enough history that a fresh indexer's
  first sync becomes slow, or if the RPC node prunes history.
- **`/price`, `/blocks`, `/daily`, `/contracts`, `/tokens` do not work for an
  `evm`-typed network.** They read the old `block`/`tx`/`contract`/
  `token_transfer` tables and, for `/price`, a live `registerApi()`
  connection that only exists for `substrate` networks. Left as-is per the
  non-goals above.
- **ERC-20 metadata probe failures store `NULL`, not a retry.** Matches the
  ported behavior (`detectToken` in `nagara-evm-explorer` already treats a
  failed `name()`/`symbol()`/`decimals()` call as "unknown", not fatal) — a
  token missing metadata still gets its transfers recorded.

## File-level change summary

| Path | Change |
|---|---|
| `src/config.ts` | add `ChainType`, `chainType` per network, `rpcHttpUrl`/`chainId` fields |
| `src/schema.sql` | append `evm_block`/`evm_tx`/`evm_log`/`evm_token`/`evm_token_transfer`/`evm_cursor` |
| `src/evm/rpc.ts` | new — ported from `nagara-evm-explorer/src/lib/rpc.ts` |
| `src/evm/tokens.ts` | new — ported from `nagara-evm-explorer/src/indexer/tokens.ts` |
| `src/evm/minar.ts` | new — ported from `nagara-evm-explorer/src/lib/minar.ts` |
| `src/evm/ingest.ts` | new — ported from `nagara-evm-explorer/src/indexer/ingest.ts`, `network`-scoped |
| `src/evm/runEvmIndexer.ts` | new — ported poll loop from `nagara-evm-explorer/src/indexer/index.ts` |
| `src/evm/queries.ts` | new — `listEvmActivity()` |
| `src/runIndexer.ts` | branch `runIndexer()` per `chainType` |
| `src/server.ts` | `/activity` branches to `listEvmActivity()` for `evm` networks |
| `src/decode.ts`, `src/types.ts`, `src/format.ts`, `src/standard.ts` | new — vendored in from `@nusameta/nagara-chain`, replacing the package |
| `src/writeBlocks.ts` | update imports from `@nusameta/nagara-chain` to the vendored local files — no logic change |
| `package.json` | add `viem`; remove `@nusameta/nagara-chain` |
| `nagara-evm-explorer` (separate repo) | deleted, last step |

## Open items for the implementation plan

- Exact TypeScript shape reused/adapted from `nagara-evm-explorer`'s
  `db/types.ts` (`toNumeric`/`fromNumeric` helpers) — port or reuse the
  existing pattern already in `nagara-indexer`'s `queries.ts` (raw pg strings
  passed through, no BigInt round-trip needed since nothing here does
  arithmetic on the values before sending them to the wallet, unlike
  `evm_tx`'s `fee_raw` computation which happens in SQL, not JS).
- Whether `ensureSchema()`/`db.ts` needs any change beyond appending the new
  `CREATE TABLE IF NOT EXISTS` statements (expected: no, it already applies
  `schema.sql` verbatim on startup).
