# EVM support for `nagara-indexer`'s `/activity` endpoint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/activity` return correct data for `testnet` (now a Frontier/EVM chain) by porting `nagara-evm-explorer`'s viem-based ingestion into `nagara-indexer`, without breaking `/activity` for `mainnet` (still the old ink! chain).

**Architecture:** Two independent ingestion pipelines selected per network by a new `chainType` config field (`"substrate"` = existing `@polkadot/api` pipeline, untouched; `"evm"` = new `viem`-based pipeline, ported from `nagara-evm-explorer`). New `evm_*` Postgres tables hold EVM chain data, scoped by a `network` column (the source app was one deployment per network; this repo is multi-network in one database). `/activity` branches its query function by the requesting network's `chainType`; the response shape the wallet sees is identical either way.

**Tech Stack:** TypeScript (ESM, `tsx`), `viem` (new dependency), `@polkadot/api` (existing, substrate path only), `pg`, Node's built-in test runner (`node --test` — no new test framework dependency).

**Spec:** `docs/superpowers/specs/2026-09-02-evm-activity-feed-design.md`

## Global Constraints

- `blockNumber`, `amountRaw`, `feeRaw` in every `/activity` response item are strings, never numbers — 10^18-scale raw units exceed JS safe-integer precision. Never wrap a `pg` NUMERIC/BIGINT result in `Number()` on this path.
- `token` is a contract address (or the literal `"native"`), never a symbol.
- Failed transactions are included in `/activity`, never filtered out.
- No `decimals` field in the `/activity` response (the wallet reads it from the token contract directly).
- Branch on `NETWORKS[network].chainType`, never on the network's name (`"testnet"`/`"mainnet"` literals) — `mainnet` will become an `evm` network later and every branch point must pick that up from config alone.
- The existing `substrate` ingestion path, its tables (`block`, `tx`, `token_transfer`, `contract`, `indexer_state`, `indexer_gap`), and the other existing endpoints (`/blocks`, `/daily`, `/contracts`, `/tokens`, `/price`) are not modified by this plan.
- `nagara-indexer` must not depend on `@nusameta/nagara-chain` by the end of this plan.

---

### Task 1: Add `viem` and a test runner script

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `npm test` runs Node's built-in test runner over `test/*.test.ts`.

- [ ] **Step 1: Add the dependency and script**

In `package.json`, add `"viem": "^2.21.0"` under `"dependencies"` (alphabetical order, matching the existing list), and add a `"test"` entry to `"scripts"`:

```json
{
  "scripts": {
    "dev": "NODE_OPTIONS='--preserve-symlinks' dotenv -e .env -- tsx watch src/index.ts",
    "start": "NODE_OPTIONS='--preserve-symlinks' dotenv -e .env -- tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "node --env-file-if-exists=.env --import tsx --test test/*.test.ts"
  },
  "dependencies": {
    "@nusameta/nagara-chain": "github:dapsverse/nagara-chain-core#v0.1.1",
    "@polkadot/api": "16.4.9",
    "@polkadot/util": "^13.5.7",
    "@polkadot/util-crypto": "^13.5.7",
    "pg": "^8.13.1",
    "viem": "^2.21.0"
  }
}
```

(`@nusameta/nagara-chain` is removed in Task 2 — leave it for now, this step only adds `viem` and the test script.)

- [ ] **Step 2: Create the test directory and install**

```bash
mkdir -p test/fixtures
npm install
```

- [ ] **Step 3: Verify**

```bash
npm run typecheck
```
Expected: passes with no errors (nothing imports `viem` yet, so this only confirms the install didn't break anything).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add viem dependency and a node --test script"
```

---

### Task 2: Vendor the chain-core decode logic, drop the package dependency

**Files:**
- Create: `src/types.ts`, `src/format.ts`, `src/standard.ts`, `src/decode.ts`
- Modify: `src/writeBlocks.ts`, `src/detectToken.ts`, `package.json`

**Interfaces:**
- Produces: `decodeBlockExtrinsics`, `isListedTransaction`, `readBlockTimestamp`, `readWeight`, `decodeExtrinsic`, `describeExtrinsic`, `isValueTransfer` (from `./decode.js`); `ChainExtrinsic`, `ExtrinsicKind`, `ChainBlock` (types, from `./types.js`); `decodeStandardTransfer`, `encodeStandardTransfer`, `NKRI08_SELECTORS`, `NKRI08_READS`, `NKRI08_WRITES`, `NKRI08_EXTENSIONS`, `selectorOf`, `rawSelector` (from `./standard.js`); `formatAmount`, `formatTokenAmount`, `shortenHash`, `formatWeight` (from `./format.js`).

This is a mechanical copy — the four files' content is unchanged from the package version except two import paths that need an explicit `.js` extension to match this repo's convention (every other local import in this codebase writes `./config.js`, `./db.js`, etc.).

- [ ] **Step 1: Copy the four files out of the installed package**

```bash
cp node_modules/@nusameta/nagara-chain/src/types.ts src/types.ts
cp node_modules/@nusameta/nagara-chain/src/format.ts src/format.ts
cp node_modules/@nusameta/nagara-chain/src/standard.ts src/standard.ts
cp node_modules/@nusameta/nagara-chain/src/decode.ts src/decode.ts
```

- [ ] **Step 2: Fix the two internal import paths in `src/decode.ts`**

Find these two lines near the top of `src/decode.ts`:

```ts
import { formatAmount } from "./format";
import type { ChainExtrinsic, ExtrinsicKind } from "./types";
```

Replace with:

```ts
import { formatAmount } from "./format.js";
import type { ChainExtrinsic, ExtrinsicKind } from "./types.js";
```

- [ ] **Step 3: Find every remaining reference to the package**

```bash
grep -rn "@nusameta/nagara-chain" src/
```

Expected output (two files, matching what was found during design):

```
src/writeBlocks.ts:...
src/detectToken.ts:...
```

- [ ] **Step 4: Update `src/writeBlocks.ts`**

Replace:

```ts
import {
  decodeBlockExtrinsics,
  isListedTransaction,
  readBlockTimestamp,
  readWeight,
} from "@nusameta/nagara-chain";
import type { ChainExtrinsic } from "@nusameta/nagara-chain";
```

with:

```ts
import {
  decodeBlockExtrinsics,
  isListedTransaction,
  readBlockTimestamp,
  readWeight,
} from "./decode.js";
import type { ChainExtrinsic } from "./types.js";
```

And replace:

```ts
import { decodeStandardTransfer } from "@nusameta/nagara-chain";
```

with:

```ts
import { decodeStandardTransfer } from "./standard.js";
```

- [ ] **Step 5: Update `src/detectToken.ts`**

Replace:

```ts
import { NKRI08_SELECTORS } from "@nusameta/nagara-chain";
```

with:

```ts
import { NKRI08_SELECTORS } from "./standard.js";
```

- [ ] **Step 6: Remove the package dependency**

In `package.json`, delete the line:

```json
    "@nusameta/nagara-chain": "github:dapsverse/nagara-chain-core#v0.1.1",
```

Then:

```bash
npm install
```

- [ ] **Step 7: Verify**

```bash
grep -rn "@nusameta/nagara-chain" src/ package.json
```
Expected: no output (nothing found).

```bash
npm run typecheck
```
Expected: passes with no errors. This confirms the vendored copies type-check identically to the package version — no logic changed, only where the code lives.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/format.ts src/standard.ts src/decode.ts src/writeBlocks.ts src/detectToken.ts package.json package-lock.json
git commit -m "build: vendor chain-core decode logic, drop @nusameta/nagara-chain dependency"
```

---

### Task 3: Config — add `chainType` per network

**Files:**
- Modify: `src/config.ts`

**Interfaces:**
- Produces: `ChainType`, `NETWORKS: Record<NetworkId, NetworkConfig>` where `NetworkConfig` is a discriminated union on `chainType`.
- Consumes (later tasks read these): `NETWORKS[network].chainType`, and for `evm` networks, `NETWORKS[network].rpcHttpUrl` / `.chainId`.

- [ ] **Step 1: Replace the `NetworkConfig` type and `NETWORKS` map**

In `src/config.ts`, replace:

```ts
export type NetworkId = "mainnet" | "testnet";

export type NetworkConfig = {
  id: NetworkId;
  label: string;
  /** Live node — always reachable, but prunes old blocks. */
  wsUrl: string;
  /**
   * Archive node, when one exists. The live endpoints discard old block bodies
   * *and* state, so history below their pruning window is only reachable here.
   * Left undefined until an archive node is available; the backfill then stops
   * at the wall and resumes from its cursor once this is set.
   */
  archiveWsUrl?: string;
};

const env = (name: string): string | undefined =>
  process.env[name]?.trim() || undefined;

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    wsUrl: env("MAINNET_WS_URL") ?? "wss://bootnode.nagara.network",
    archiveWsUrl: env("MAINNET_ARCHIVE_WS_URL"),
  },
  testnet: {
    id: "testnet",
    label: "Testnet",
    wsUrl: env("TESTNET_WS_URL") ?? "wss://testnet.nagara.network",
    archiveWsUrl: env("TESTNET_ARCHIVE_WS_URL"),
  },
};
```

with:

```ts
export type NetworkId = "mainnet" | "testnet";

/**
 * Which protocol a network speaks. `mainnet` is still the old ink!/
 * pallet-contracts chain; `testnet` migrated to a sovereign Substrate chain
 * with pallet-ethereum/pallet-evm (Frontier) bolted on. `mainnet` will make
 * the same jump later, as a brand-new genesis chain, not an in-place upgrade.
 *
 * Every branch point in this codebase (which ingestion pipeline runs, which
 * tables `/activity` reads) switches on this field, never on the network's
 * name — so migrating mainnet is flipping this value plus its connection
 * fields, not a code change.
 */
export type ChainType = "substrate" | "evm";

export type SubstrateNetworkConfig = {
  id: NetworkId;
  label: string;
  chainType: "substrate";
  /** Live node — always reachable, but prunes old blocks. */
  wsUrl: string;
  /**
   * Archive node, when one exists. The live endpoints discard old block bodies
   * *and* state, so history below their pruning window is only reachable here.
   * Left undefined until an archive node is available; the backfill then stops
   * at the wall and resumes from its cursor once this is set.
   */
  archiveWsUrl?: string;
};

export type EvmNetworkConfig = {
  id: NetworkId;
  label: string;
  chainType: "evm";
  /** JSON-RPC HTTP endpoint — Frontier's Ethereum-compatible RPC. */
  rpcHttpUrl: string;
  chainId: number;
};

export type NetworkConfig = SubstrateNetworkConfig | EvmNetworkConfig;

const env = (name: string): string | undefined =>
  process.env[name]?.trim() || undefined;

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    chainType: "substrate",
    wsUrl: env("MAINNET_WS_URL") ?? "wss://bootnode.nagara.network",
    archiveWsUrl: env("MAINNET_ARCHIVE_WS_URL"),
  },
  testnet: {
    id: "testnet",
    label: "Testnet",
    chainType: "evm",
    rpcHttpUrl: env("TESTNET_RPC_HTTP_URL") ?? "https://testnet.nagara.network",
    chainId: Number(env("TESTNET_CHAIN_ID") ?? "16869"),
  },
};
```

- [ ] **Step 2: Fix the two functions that assumed every network is substrate-shaped**

Replace:

```ts
/** Which endpoint history should be read from: archive if configured. */
export function backfillWsUrl(network: NetworkId): string {
  const config = NETWORKS[network];
  return config.archiveWsUrl ?? config.wsUrl;
}

export function hasArchive(network: NetworkId): boolean {
  return Boolean(NETWORKS[network].archiveWsUrl);
}
```

with:

```ts
/** Which endpoint history should be read from: archive if configured. */
export function backfillWsUrl(network: NetworkId): string {
  const config = NETWORKS[network];
  if (config.chainType !== "substrate") {
    throw new Error(`${network} is not a substrate network`);
  }
  return config.archiveWsUrl ?? config.wsUrl;
}

export function hasArchive(network: NetworkId): boolean {
  const config = NETWORKS[network];
  return config.chainType === "substrate" && Boolean(config.archiveWsUrl);
}
```

(Both functions are only ever called from the substrate-only code path in `runIndexer.ts`, which is only invoked for `chainType: "substrate"` networks after Task 10 — the thrown error is a defensive guard against a future caller getting that wrong, not an expected runtime path.)

- [ ] **Step 3: Verify**

```bash
npm run typecheck
```
Expected: passes. (`chainApi.ts`, `writeBlocks.ts`, `runIndexer.ts` all read `config.wsUrl` on a value now typed as the union `NetworkConfig` — if any of them fail to narrow, typecheck will point at the exact line. Task 10 addresses `runIndexer.ts`'s own narrowing; if typecheck fails there before Task 10 is done, that specific failure is expected and resolved by that task, not a mistake here.)

- [ ] **Step 4: Add a config shape test**

Create `test/config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { NETWORKS } from "../src/config.js";

test("mainnet is still the substrate chain type", () => {
  assert.equal(NETWORKS.mainnet.chainType, "substrate");
});

test("testnet is the evm chain type", () => {
  assert.equal(NETWORKS.testnet.chainType, "evm");
});

test("testnet has a chain id", () => {
  assert.equal(NETWORKS.testnet.chainType, "evm");
  if (NETWORKS.testnet.chainType === "evm") {
    assert.equal(typeof NETWORKS.testnet.chainId, "number");
    assert.ok(NETWORKS.testnet.chainId > 0);
  }
});
```

- [ ] **Step 5: Run it**

```bash
npm test
```
Expected: 3 passing tests (plus nothing else yet — this is the first test file).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: add chainType to network config"
```

---

### Task 4: Schema — append the EVM tables

**Files:**
- Modify: `src/schema.sql`

**Interfaces:**
- Produces: tables `evm_block`, `evm_tx`, `evm_log`, `evm_token`, `evm_token_transfer`, `evm_cursor` — all `network`-scoped.

- [ ] **Step 1: Append to `src/schema.sql`**

Add at the end of the file:

```sql

-- ═══════════════════════════════════════════════════════════════════════
-- EVM chain support (pallet-ethereum / pallet-evm networks).
--
-- Ported from nagara-evm-explorer's schema, which indexed one network per
-- deployment. This indexer is multi-network in one database, so every table
-- here carries a `network` column that the source schema did not need.
--
-- All uint256 values are NUMERIC(78,0): BIGINT overflows at 2^63 and wei
-- values routinely exceed it. Addresses and hashes are stored lowercase.
-- ═══════════════════════════════════════════════════════════════════════

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
CREATE INDEX IF NOT EXISTS evm_tx_block_idx ON evm_tx (network, block_number DESC, tx_index);

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
  decimals   SMALLINT,            -- NULL for 721/1155
  first_seen BIGINT NOT NULL,     -- block_number
  PRIMARY KEY (network, address)
);

CREATE TABLE IF NOT EXISTS evm_token_transfer (
  network      TEXT NOT NULL,
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  -- One ERC-1155 TransferBatch log carries many transfers. They share a
  -- log_index, so sub_index separates them; everything else is 0.
  sub_index    INTEGER NOT NULL DEFAULT 0,
  block_number BIGINT NOT NULL,
  token        TEXT NOT NULL,
  from_addr    TEXT NOT NULL,
  to_addr      TEXT NOT NULL,
  value        NUMERIC(78,0),     -- NULL for ERC-721
  token_id     NUMERIC(78,0),     -- NULL for ERC-20
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

- [ ] **Step 2: Verify it applies cleanly**

This requires a reachable Postgres (`DATABASE_URL` set in `.env`, per the existing `README.md` quick-start). If one is available:

```bash
node --env-file-if-exists=.env -e "
import('./src/db.ts').then(async ({ ensureSchema, getPool }) => {
  await ensureSchema();
  const { rows } = await getPool().query(
    \"SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'evm_%' ORDER BY 1\"
  );
  console.log(rows.map(r => r.table_name));
  process.exit(0);
});
" --import tsx
```
Expected output: `[ 'evm_block', 'evm_cursor', 'evm_log', 'evm_token', 'evm_token_transfer', 'evm_tx' ]`

If no local Postgres is available yet, this step is deferred to Task 8's integration test, which applies the same file against a throwaway schema and will fail loudly if the DDL has a syntax error.

- [ ] **Step 3: Commit**

```bash
git add src/schema.sql
git commit -m "feat: add evm_* tables for EVM-chain indexing"
```

---

### Task 5: `evm/numeric.ts` — bigint/NUMERIC string round-trip

**Files:**
- Create: `src/evm/numeric.ts`
- Test: `test/numeric.test.ts`

**Interfaces:**
- Produces: `toNumeric(v: bigint): string`, `fromNumeric(v: string | null): bigint`

- [ ] **Step 1: Write the failing test**

Create `test/numeric.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toNumeric, fromNumeric } from "../src/evm/numeric.js";

test("uint256 max survives a round trip through NUMERIC(78,0)", () => {
  const max = 2n ** 256n - 1n;
  assert.equal(fromNumeric(toNumeric(max)), max);
});

test("zero and one round trip", () => {
  for (const v of [0n, 1n]) assert.equal(fromNumeric(toNumeric(v)), v);
});

test("a value above 2^63 is not truncated", () => {
  const v = 2n ** 64n + 12345n;
  assert.equal(fromNumeric(toNumeric(v)), v);
});

test("fromNumeric(null) is zero", () => {
  assert.equal(fromNumeric(null), 0n);
});
```

- [ ] **Step 2: Run it, confirm it fails**

```bash
npm test
```
Expected: FAIL — `Cannot find module '../src/evm/numeric.js'`.

- [ ] **Step 3: Implement**

Create `src/evm/numeric.ts`:

```ts
// `pg` returns NUMERIC as a string to avoid float precision loss. These two
// helpers are the only place a NUMERIC column should be converted to/from a
// JS bigint in the EVM ingestion path.

export function toNumeric(v: bigint): string {
  return v.toString();
}

export function fromNumeric(v: string | null): bigint {
  return v === null ? 0n : BigInt(v);
}
```

- [ ] **Step 4: Run tests, confirm they pass**

```bash
npm test
```
Expected: all tests pass (config tests from Task 3 + these 4).

- [ ] **Step 5: Commit**

```bash
git add src/evm/numeric.ts test/numeric.test.ts
git commit -m "feat: add bigint/NUMERIC round-trip helpers for the EVM path"
```

---

### Task 6: `evm/tokens.ts` — ERC-20/721/1155 log classification and metadata probe

**Files:**
- Create: `src/evm/tokens.ts`
- Test: `test/tokens.test.ts`

**Interfaces:**
- Produces: `classifyTransferLog(log): ClassifiedTransfer[] | null`, `detectToken(client, address, type): Promise<{name, symbol, decimals}>`, `TRANSFER_TOPIC0`, `TRANSFER_SINGLE_TOPIC0`, `TRANSFER_BATCH_TOPIC0`, `type ClassifiedTransfer`.
- Consumes: `PublicClient` type from `viem` (installed in Task 1).

`classifyTransferLog` is pure (no chain access) — ported verbatim. `detectToken` is adapted to take a `client` parameter instead of importing a module-level singleton, because this repo runs more than one EVM network (and more than one client) in one process, unlike the source app.

- [ ] **Step 1: Write the failing test**

Create `test/tokens.test.ts` (ported verbatim from `nagara-evm-explorer/test/tokens.test.ts`, only the import path changes):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTransferLog,
  TRANSFER_TOPIC0,
  TRANSFER_SINGLE_TOPIC0,
  TRANSFER_BATCH_TOPIC0,
} from "../src/evm/tokens.js";

const A = "0x" + "11".repeat(20);
const B = "0x" + "22".repeat(20);
const pad = (h: string) => "0x" + h.slice(2).padStart(64, "0");
const u256 = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");

test("three topics means ERC-20, value comes from data", () => {
  const out = classifyTransferLog({
    topics: [TRANSFER_TOPIC0, pad(A), pad(B)],
    data: u256(1000n),
  });
  assert.deepEqual(out, [{ standard: "erc20", from: A, to: B, value: 1000n, tokenId: null }]);
});

test("four topics means ERC-721, tokenId comes from topic3", () => {
  const out = classifyTransferLog({
    topics: [TRANSFER_TOPIC0, pad(A), pad(B), u256(7n)],
    data: "0x",
  });
  assert.deepEqual(out, [{ standard: "erc721", from: A, to: B, value: null, tokenId: 7n }]);
});

test("an ERC-721 transfer is never recorded as an ERC-20 value", () => {
  const out = classifyTransferLog({
    topics: [
      TRANSFER_TOPIC0,
      pad(A),
      pad(B),
      u256(115792089237316195423570985008687907853269984665640564039457584007913129639935n),
    ],
    data: "0x",
  });
  assert.equal(out![0].standard, "erc721");
  assert.equal(out![0].value, null);
});

test("TransferSingle is ERC-1155 with id and value", () => {
  const out = classifyTransferLog({
    topics: [TRANSFER_SINGLE_TOPIC0, pad(A), pad(A), pad(B)],
    data: "0x" + u256(5n).slice(2) + u256(9n).slice(2),
  });
  assert.deepEqual(out, [{ standard: "erc1155", from: A, to: B, value: 9n, tokenId: 5n }]);
});

test("a Transfer log with two topics is ignored", () => {
  assert.equal(classifyTransferLog({ topics: [TRANSFER_TOPIC0, pad(A)], data: "0x" }), null);
});

test("an unrelated topic0 is ignored", () => {
  assert.equal(classifyTransferLog({ topics: ["0x" + "de".repeat(32)], data: "0x" }), null);
});

test("an ERC-20 Transfer with truncated data is ignored, not read as zero", () => {
  assert.equal(
    classifyTransferLog({ topics: [TRANSFER_TOPIC0, pad(A), pad(B)], data: "0x" }),
    null,
  );
});

test("TransferBatch expands into one entry per id", () => {
  const w = (n: bigint) => n.toString(16).padStart(64, "0");
  // ids at offset 0x40, values after them at 0xa0; two entries each.
  const data =
    "0x" + w(0x40n) + w(0xa0n) + w(2n) + w(7n) + w(9n) + w(2n) + w(100n) + w(200n);

  const out = classifyTransferLog({
    topics: [TRANSFER_BATCH_TOPIC0, pad(A), pad(A), pad(B)],
    data,
  });

  assert.equal(out?.length, 2);
  assert.deepEqual(out, [
    { standard: "erc1155", from: A, to: B, value: 100n, tokenId: 7n },
    { standard: "erc1155", from: A, to: B, value: 200n, tokenId: 9n },
  ]);
});
```

- [ ] **Step 2: Run it, confirm it fails**

```bash
npm test
```
Expected: FAIL — `Cannot find module '../src/evm/tokens.js'`.

- [ ] **Step 3: Implement**

Create `src/evm/tokens.ts` (ported from `nagara-evm-explorer/src/indexer/tokens.ts`; `client` is now a parameter of `detectToken` instead of a module import):

```ts
import type { PublicClient } from "viem";

export const TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const TRANSFER_SINGLE_TOPIC0 =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
export const TRANSFER_BATCH_TOPIC0 =
  "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

export type ClassifiedTransfer = {
  standard: "erc20" | "erc721" | "erc1155";
  from: string;
  to: string;
  value: bigint | null;
  tokenId: bigint | null;
};

const addr = (topic: string) => ("0x" + topic.slice(-40)).toLowerCase();

/**
 * Reads the i-th 32-byte word of a log's data, or null when the data is too
 * short to contain it. Malformed data means the log is ignored — fabricating a
 * zero there would record a transfer that never happened.
 */
function word(data: string, i: number): bigint | null {
  const w = data.slice(2 + i * 64, 2 + (i + 1) * 64);
  return w.length === 64 ? BigInt("0x" + w) : null;
}

export function classifyTransferLog(log: {
  topics: string[];
  data: string;
}): ClassifiedTransfer[] | null {
  const [t0, t1, t2, t3] = log.topics;

  if (t0 === TRANSFER_TOPIC0) {
    // ERC-20 and ERC-721 share this topic0. Topic count is the only reliable
    // discriminator: it is fixed by `indexed` in the event definition.
    // supportsInterface is not reliable — many contracts do not implement it.
    if (log.topics.length === 3) {
      const value = word(log.data, 0);
      if (value === null) return null;
      return [{ standard: "erc20", from: addr(t1), to: addr(t2), value, tokenId: null }];
    }
    if (log.topics.length === 4) {
      return [{ standard: "erc721", from: addr(t1), to: addr(t2), value: null, tokenId: BigInt(t3) }];
    }
    return null;
  }

  if (t0 === TRANSFER_SINGLE_TOPIC0) {
    if (log.topics.length !== 4) return null;
    const tokenId = word(log.data, 0);
    const value = word(log.data, 1);
    if (tokenId === null || value === null) return null;
    return [{ standard: "erc1155", from: addr(t2), to: addr(t3), value, tokenId }];
  }

  if (t0 === TRANSFER_BATCH_TOPIC0) {
    if (log.topics.length !== 4) return null;
    // data: offset(ids), offset(values), len(ids), ids…, len(values), values…
    const available = BigInt(Math.floor((log.data.length - 2) / 64));
    const len = word(log.data, 2);
    // Bounding len by the data actually present stops a crafted log from
    // claiming a 2^256-long array.
    if (len === null || len > available) return null;
    const out: ClassifiedTransfer[] = [];
    for (let i = 0; i < Number(len); i++) {
      const tokenId = word(log.data, 3 + i);
      const value = word(log.data, 3 + Number(len) + 1 + i);
      if (tokenId === null || value === null) return null;
      out.push({ standard: "erc1155", from: addr(t2), to: addr(t3), tokenId, value });
    }
    return out.length ? out : null;
  }

  return null;
}

const ERC20_METADATA_ABI = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/**
 * Called once per address, the first time a token is seen. A failure on any
 * single call must not discard the transfer — a token without `name()` is
 * still a token, and dropping it would lose a legitimate transfer.
 */
export async function detectToken(
  client: PublicClient,
  address: string,
  type: "erc20" | "erc721" | "erc1155",
): Promise<{ name: string | null; symbol: string | null; decimals: number | null }> {
  const call = async <T>(fn: "name" | "symbol" | "decimals"): Promise<T | null> => {
    try {
      return (await client.readContract({
        address: address as `0x${string}`,
        abi: ERC20_METADATA_ABI,
        functionName: fn,
      })) as T;
    } catch {
      return null;
    }
  };
  return {
    name: await call<string>("name"),
    symbol: await call<string>("symbol"),
    decimals: type === "erc20" ? await call<number>("decimals") : null,
  };
}
```

- [ ] **Step 4: Run tests, confirm they pass**

```bash
npm test
```
Expected: all tests pass (9 new + the ones from Tasks 3 and 5).

- [ ] **Step 5: Commit**

```bash
git add src/evm/tokens.ts test/tokens.test.ts
git commit -m "feat: port ERC-20/721/1155 log classification and metadata probe"
```

---

### Task 7: `evm/minar.ts` — MINAR selector/topic decoding

**Files:**
- Create: `src/evm/minar.ts`
- Test: `test/minar.test.ts`

**Interfaces:**
- Produces: `MINAR_SELECTORS`, `MINAR_TOPICS`, `isForcedTransfer(input)`, `decodeForcedTransfer(input)`, `decodeUpgraded(topics, data)`, `decodeAdminStatus(topics, data)`, `decodeMintBurn(data)`, `word`, `wordToAddress`, `topicToAddress`.

Not consumed by `/activity` yet — the wallet doesn't ask for forced-transfer detection. Ported because it already exists, is fully tested, and would otherwise be lost when `nagara-evm-explorer` is deleted (Task 13). No consumer today; it becomes available the moment one is needed.

- [ ] **Step 1: Write the failing test**

Create `test/minar.test.ts` (ported verbatim from `nagara-evm-explorer/test/minar.test.ts`, only the import path changes):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeForcedTransfer,
  decodeUpgraded,
  isForcedTransfer,
  MINAR_SELECTORS,
  MINAR_TOPICS,
} from "../src/evm/minar.js";

test("the transferAdminTransfer selector is correct", () => {
  assert.equal(MINAR_SELECTORS.transferAdminTransfer, "0xd8af5545");
});

test("input calling transferAdminTransfer is a forced transfer", () => {
  const input = "0xd8af5545" + "00".repeat(96);
  assert.equal(isForcedTransfer(input), true);
});

test("an ordinary ERC-20 transfer is not a forced transfer", () => {
  // transfer(address,uint256)
  assert.equal(isForcedTransfer("0xa9059cbb" + "00".repeat(64)), false);
});

test("mintToken is not a forced transfer", () => {
  assert.equal(isForcedTransfer("0xbd89d13e" + "00".repeat(96)), false);
});

test("empty and short input are not forced transfers", () => {
  assert.equal(isForcedTransfer("0x"), false);
  assert.equal(isForcedTransfer("0xd8af55"), false);
  assert.equal(isForcedTransfer(""), false);
});

test("the selector match is case-insensitive", () => {
  assert.equal(isForcedTransfer("0xD8AF5545" + "00".repeat(96)), true);
});

test("MINAR event topics are correct", () => {
  assert.equal(
    MINAR_TOPICS.TokenMinted,
    "0xdb46291eeab68fcfa6a0570a911e537b015a3d512c427d17f9343e4edbf1838f",
  );
  assert.equal(
    MINAR_TOPICS.TokenBurned,
    "0x17578694434a68c8a307780ffcc2e7e69ebb61cb954ab23a8e9b0383b937a37d",
  );
  assert.equal(
    MINAR_TOPICS.MintingAdminStatus,
    "0xac21ac7706a1a42078d5e0f77b24b27808133ae5616daba665fb793a7eb3cc5b",
  );
  assert.equal(
    MINAR_TOPICS.MinarUpgraded,
    "0x5eefffe1eb9cc71568cf8cd37d4a6dd8dd6f3c73d5019745b03ec3f7657976a2",
  );
});

test("decodeForcedTransfer reads from, to and amount from the calldata", () => {
  const pad = (h: string) => h.slice(2).padStart(64, "0");
  const from = "0x" + "11".repeat(20);
  const to = "0x" + "22".repeat(20);
  const input =
    "0xd8af5545" + pad(from) + pad(to) + (1234n).toString(16).padStart(64, "0");

  assert.deepEqual(decodeForcedTransfer(input), { from, to, amount: 1234n });
});

test("decodeForcedTransfer returns null for truncated calldata", () => {
  assert.equal(decodeForcedTransfer("0xd8af5545" + "00".repeat(10)), null);
});

test("decodeUpgraded reads an indexed implementation and its version string", () => {
  const impl = "0x" + "33".repeat(20);
  const version = "v1.2.0";
  const body =
    (32n).toString(16).padStart(64, "0") +
    BigInt(version.length).toString(16).padStart(64, "0") +
    Buffer.from(version, "ascii").toString("hex").padEnd(64, "0");

  assert.deepEqual(
    decodeUpgraded([MINAR_TOPICS.MinarUpgraded, "0x" + impl.slice(2).padStart(64, "0")], "0x" + body),
    { implementation: impl, version },
  );
});

test("decodeUpgraded refuses a version string that is not printable", () => {
  const body =
    (32n).toString(16).padStart(64, "0") +
    (4n).toString(16).padStart(64, "0") +
    "deadbeef".padEnd(64, "0");
  assert.equal(decodeUpgraded(["0x00", "0x" + "0".repeat(64)], "0x" + body).version, null);
});
```

- [ ] **Step 2: Run it, confirm it fails**

```bash
npm test
```
Expected: FAIL — `Cannot find module '../src/evm/minar.js'`.

- [ ] **Step 3: Implement**

Create `src/evm/minar.ts` (ported verbatim from `nagara-evm-explorer/src/lib/minar.ts` — no adaptation needed, it has no chain/db dependency):

```ts
// MINAR-specific selectors, topics and calldata decoding.
//
// A false positive here accuses an operator of seizing funds; a false negative
// hides a use of that power. Both are worse than a crash, so every function
// below is exact-match and total.

export const MINAR_SELECTORS = {
  transferAdminTransfer: "0xd8af5545",
  mintToken: "0xbd89d13e",
  burnToken: "0xad193fab",
} as const;

export const MINAR_TOPICS = {
  TokenMinted: "0xdb46291eeab68fcfa6a0570a911e537b015a3d512c427d17f9343e4edbf1838f",
  TokenBurned: "0x17578694434a68c8a307780ffcc2e7e69ebb61cb954ab23a8e9b0383b937a37d",
  MintingAdminStatus: "0xac21ac7706a1a42078d5e0f77b24b27808133ae5616daba665fb793a7eb3cc5b",
  MinarUpgraded: "0x5eefffe1eb9cc71568cf8cd37d4a6dd8dd6f3c73d5019745b03ec3f7657976a2",
} as const;

/**
 * A forced transfer emits an ordinary ERC-20 `Transfer` event, so events alone
 * cannot distinguish it from a voluntary one. The transaction input selector
 * is the only reliable signal.
 */
export function isForcedTransfer(input: string): boolean {
  if (!input || input.length < 10) return false;
  return input.slice(0, 10).toLowerCase() === MINAR_SELECTORS.transferAdminTransfer;
}

/** The 32-byte word at `i`, or null when the calldata is too short. */
export function word(hexBody: string, i: number): bigint | null {
  const slice = hexBody.slice(i * 64, (i + 1) * 64);
  if (slice.length !== 64) return null;
  try {
    return BigInt("0x" + slice);
  } catch {
    return null;
  }
}

/** The low 20 bytes of a 32-byte word, as a lowercase address. */
export function wordToAddress(hexBody: string, i: number): string | null {
  const slice = hexBody.slice(i * 64, (i + 1) * 64);
  if (slice.length !== 64) return null;
  return ("0x" + slice.slice(-40)).toLowerCase();
}

export type ForcedTransfer = { from: string; to: string; amount: bigint };

/**
 * `transferAdminTransfer(address from, address to, uint256 amount)`.
 * Returns null unless the calldata is that call and carries all three
 * arguments — never a partially decoded row.
 */
export function decodeForcedTransfer(input: string): ForcedTransfer | null {
  if (!isForcedTransfer(input)) return null;
  const body = input.slice(10);
  const from = wordToAddress(body, 0);
  const to = wordToAddress(body, 1);
  const amount = word(body, 2);
  if (from === null || to === null || amount === null) return null;
  return { from, to, amount };
}

const strip = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);

/** The low 20 bytes of an indexed topic, as a lowercase address. */
export function topicToAddress(topic: string | null | undefined): string | null {
  if (!topic) return null;
  const h = strip(topic);
  return h.length >= 40 ? ("0x" + h.slice(-40)).toLowerCase() : null;
}

/**
 * A dynamic `string` at head word `headIndex`. Returns null unless the offset,
 * length and bytes are all present and the bytes are printable ASCII — a
 * half-decoded version string is worse than none.
 */
function readString(body: string, headIndex: number): string | null {
  const off = word(body, headIndex);
  if (off === null) return null;
  const at = Number(off) * 2;
  if (!Number.isSafeInteger(at) || at < 0) return null;

  const len = word(body.slice(at), 0);
  if (len === null || len === 0n || len > 256n) return null;

  const raw = body.slice(at + 64, at + 64 + Number(len) * 2);
  if (raw.length !== Number(len) * 2) return null;

  let s = "";
  for (let i = 0; i < raw.length; i += 2) {
    const c = Number.parseInt(raw.slice(i, i + 2), 16);
    if (!Number.isInteger(c) || c < 0x20 || c > 0x7e) return null;
    s += String.fromCharCode(c);
  }
  return s;
}

export type Upgraded = { implementation: string | null; version: string | null };

/**
 * `MinarUpgraded`. The implementation may be indexed or not depending on the
 * deployed event definition, so both layouts are tried rather than assumed.
 */
export function decodeUpgraded(topics: string[], data: string): Upgraded {
  const body = strip(data);
  const indexed = topics.length > 1;
  return {
    implementation: indexed ? topicToAddress(topics[1]) : wordToAddress(body, 0),
    version: readString(body, indexed ? 0 : 1),
  };
}

export type AdminStatus = { admin: string | null; granted: boolean | null };

/** `MintingAdminStatus`: the admin address and whether it was granted or revoked. */
export function decodeAdminStatus(topics: string[], data: string): AdminStatus {
  const body = strip(data);
  const indexed = topics.length > 1;
  const flag = word(body, indexed ? 0 : 1);
  return {
    admin: indexed ? topicToAddress(topics[1]) : wordToAddress(body, 0),
    granted: flag === null ? null : flag !== 0n,
  };
}

export type MintBurn = { amount: bigint; isOperator: boolean | null };

/**
 * `TokenMinted` / `TokenBurned` carry `amount` in data word 0 and the
 * `isOperator` flag in word 1.
 */
export function decodeMintBurn(data: string): MintBurn | null {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  const amount = word(body, 0);
  if (amount === null) return null;
  const flag = word(body, 1);
  return { amount, isOperator: flag === null ? null : flag !== 0n };
}
```

- [ ] **Step 4: Run tests, confirm they pass**

```bash
npm test
```
Expected: all tests pass (12 new + everything from earlier tasks).

- [ ] **Step 5: Commit**

```bash
git add src/evm/minar.ts test/minar.test.ts
git commit -m "feat: port MINAR selector/topic decoding"
```

---

### Task 8: `evm/rpc.ts` + `evm/ingest.ts` — the ingestion pipeline

**Files:**
- Modify: `src/db.ts` (add a `tx()` transaction helper)
- Create: `src/evm/rpc.ts`, `src/evm/ingest.ts`
- Test: `test/ingest.test.ts`, `test/fixtures/erc20-creation.hex`, `test/fixtures/Tok.sol`

**Interfaces:**
- Consumes: `getPool()` from `./db.js` (existing); `classifyTransferLog`, `detectToken` from `./tokens.js` (Task 6); `toNumeric` from `./numeric.js` (Task 5); `NetworkId` from `../config.js` (Task 3).
- Produces: `createEvmClient(rpcHttpUrl, chainId): PublicClient`, `getBlockReceipts(client, blockNumber): Promise<RpcReceipt[]>`, `tx<T>(fn): Promise<T>` (added to `db.ts`), `ingestBlock(client, network, blockNumber): Promise<void>`.

This is the core of the port. It requires a real EVM chain to test against — using the live testnet is unworkable for a test suite (its public RPC only serves the last ~1,000 blocks, per `apps/evm`'s `CLAUDE.md`, so any hardcoded block becomes unreachable within the hour). `nagara-evm-explorer` already solved this by testing against a disposable `anvil` (Foundry's local EVM node) instance with a throwaway Postgres schema — that whole test is ported here, adapted for the `network`-scoped schema and the new client-per-network signature. `anvil`/`forge`/`cast` (Foundry) must be installed and on `PATH` for this task's test to run — confirmed present in this environment at `~/.foundry/bin/`.

- [ ] **Step 1: Add a transaction helper to `src/db.ts`**

Add this function to `src/db.ts` (after `ensureSchema`):

```ts
import type { PoolClient } from "pg";
```

(add this import at the top, alongside the existing `pg` import)

```ts
/**
 * Runs `fn` inside BEGIN/COMMIT, rolling back on any thrown error. The
 * connection is always released back to the pool, success or failure.
 */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 2: Copy the test fixtures**

```bash
cp ~/Documents/nagara/apps/evm-explorer/test/fixtures/erc20-creation.hex test/fixtures/erc20-creation.hex
cp ~/Documents/nagara/apps/evm-explorer/test/fixtures/Tok.sol test/fixtures/Tok.sol
```

(`Tok.sol` is the human-readable source the bytecode fixture was compiled from — not read by the test, kept for anyone who needs to regenerate the fixture.)

- [ ] **Step 3: Write the failing test**

Create `test/ingest.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { Pool } from "pg";

/**
 * Ingestion is tested against a disposable anvil, not against the Nagara
 * testnet: the testnet's public RPC serves only the last ~1,000 blocks, so any
 * hardcoded historical block becomes unreachable within the hour — useless as
 * a gate. anvil gives a chain under the test's control: a contract deployment,
 * a mint from the zero address, and an ordinary transfer, all in known blocks.
 * Deterministic, offline and fast.
 */

const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const NETWORK = "test_ingest_network";

const creationBytecode = readFileSync(
  new URL("./fixtures/erc20-creation.hex", import.meta.url),
  "utf8",
).trim() as `0x${string}`;

const schemaSql = readFileSync(new URL("../src/schema.sql", import.meta.url), "utf8");

let anvil: ChildProcess | undefined;
let pool: Pool;
let createEvmClient: typeof import("../src/evm/rpc.js")["createEvmClient"];
let ingestBlock: typeof import("../src/evm/ingest.js")["ingestBlock"];
let client: ReturnType<typeof import("../src/evm/rpc.js")["createEvmClient"]>;
let db = "";
let usr = "";
let tokenAddress = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

async function waitForRpc(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (r.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`anvil did not come up at ${url}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

before(async () => {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;

  anvil = spawn("anvil", ["--port", String(port), "--silent"], {
    stdio: "ignore",
    env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` },
  });
  await waitForRpc(rpcUrl);

  ({ createEvmClient } = await import("../src/evm/rpc.js"));
  ({ ingestBlock } = await import("../src/evm/ingest.js"));
  client = createEvmClient(rpcUrl, 31337);

  const { createWalletClient, createPublicClient, http, parseEther } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");

  const account = privateKeyToAccount(ANVIL_KEY);
  const chain = {
    id: 31337,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });

  // Block 1: deploy. The constructor mints, emitting Transfer from address(0).
  const deployHash = await wallet.deployContract({ abi: [], bytecode: creationBytecode });
  const receipt = await pub.waitForTransactionReceipt({ hash: deployHash });
  tokenAddress = receipt.contractAddress!.toLowerCase();

  // Block 2: an ordinary ERC-20 transfer.
  await wallet.writeContract({
    address: receipt.contractAddress!,
    abi: [
      {
        name: "transfer",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "v", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
      },
    ] as const,
    functionName: "transfer",
    args: [RECIPIENT as `0x${string}`, parseEther("1")],
  });

  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query<{ db: string; usr: string }>(
    "SELECT current_database() AS db, current_user AS usr",
  );
  db = rows[0].db;
  usr = rows[0].usr;
  // A pool hands out whichever connection is idle and opens new ones when it
  // needs to, so `SET search_path` on one connection is not enough: an ingest
  // could land on a fresh connection and write into the real tables. Setting it
  // at the role level covers every connection this test will ever get. Both
  // identifiers come from the server itself, so quoting them is sufficient.
  await pool.query(`ALTER ROLE "${usr}" IN DATABASE "${db}" SET search_path TO test_ingest`);
  await pool.query("SET search_path TO test_ingest");
  await pool.query("DROP SCHEMA IF EXISTS test_ingest CASCADE");
  await pool.query("CREATE SCHEMA test_ingest");
  await pool.query(schemaSql);
});

after(async () => {
  try {
    if (usr) await pool?.query(`ALTER ROLE "${usr}" IN DATABASE "${db}" RESET search_path`);
    await pool?.query("DROP SCHEMA IF EXISTS test_ingest CASCADE");
  } finally {
    await pool?.end();
    anvil?.kill();
  }
});

test("the throwaway schema is really the one being written to", async () => {
  const { rows } = await pool.query<{ schema: string }>("SELECT current_schema() AS schema");
  assert.equal(rows[0].schema, "test_ingest");
});

test("an empty block is ingested without a transaction or a log", async () => {
  await ingestBlock(client, NETWORK, 0n);
  const { rows } = await pool.query<{ tx_count: number }>(
    "SELECT tx_count FROM evm_block WHERE network = $1 AND number = 0",
    [NETWORK],
  );
  assert.equal(rows[0].tx_count, 0);
  const txs = await pool.query("SELECT * FROM evm_tx WHERE network = $1", [NETWORK]);
  assert.equal(txs.rows.length, 0);
});

test("a contract creation records its deployed address", async () => {
  await ingestBlock(client, NETWORK, 1n);
  const { rows } = await pool.query<{
    contract_address: string | null;
    status: number;
    from_addr: string;
  }>(
    "SELECT contract_address, status, from_addr FROM evm_tx WHERE network = $1 AND block_number = 1",
    [NETWORK],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contract_address, tokenAddress);
  assert.equal(rows[0].status, 1);
  assert.equal(rows[0].from_addr, ANVIL_ADDR);
});

test("a mint from the zero address is recorded as a token transfer", async () => {
  const { rows } = await pool.query<{
    from_addr: string;
    to_addr: string;
    value: string;
    token: string;
  }>(
    "SELECT from_addr, to_addr, value, token FROM evm_token_transfer WHERE network = $1 AND block_number = 1",
    [NETWORK],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from_addr, "0x0000000000000000000000000000000000000000");
  assert.equal(rows[0].to_addr, ANVIL_ADDR);
  assert.equal(rows[0].value, (1000n * 10n ** 18n).toString());
  assert.equal(rows[0].token, tokenAddress);
});

test("token metadata is detected over RPC on first sight", async () => {
  const { rows } = await pool.query<{
    type: string;
    name: string;
    symbol: string;
    decimals: number;
  }>("SELECT type, name, symbol, decimals FROM evm_token WHERE network = $1 AND address = $2", [
    NETWORK,
    tokenAddress,
  ]);
  assert.equal(rows[0].type, "erc20");
  assert.equal(rows[0].name, "Test Token");
  assert.equal(rows[0].symbol, "TT");
  assert.equal(rows[0].decimals, 18);
});

test("an ordinary transfer is recorded with its value", async () => {
  await ingestBlock(client, NETWORK, 2n);
  const { rows } = await pool.query<{ from_addr: string; to_addr: string; value: string }>(
    "SELECT from_addr, to_addr, value FROM evm_token_transfer WHERE network = $1 AND block_number = 2",
    [NETWORK],
  );
  assert.equal(rows[0].from_addr, ANVIL_ADDR);
  assert.equal(rows[0].to_addr, RECIPIENT);
  assert.equal(rows[0].value, (10n ** 18n).toString());
});

test("ingesting a block twice does not duplicate rows", async () => {
  const count = async () => {
    const [blocks, txs, logs, tokens, transfers] = await Promise.all([
      pool.query("SELECT * FROM evm_block WHERE network = $1", [NETWORK]),
      pool.query("SELECT * FROM evm_tx WHERE network = $1", [NETWORK]),
      pool.query("SELECT * FROM evm_log WHERE network = $1", [NETWORK]),
      pool.query("SELECT * FROM evm_token WHERE network = $1", [NETWORK]),
      pool.query("SELECT * FROM evm_token_transfer WHERE network = $1", [NETWORK]),
    ]);
    return {
      blocks: blocks.rows.length,
      txs: txs.rows.length,
      logs: logs.rows.length,
      tokens: tokens.rows.length,
      transfers: transfers.rows.length,
    };
  };

  const beforeCounts = await count();
  for (const n of [0n, 1n, 2n]) await ingestBlock(client, NETWORK, n);
  assert.deepEqual(await count(), beforeCounts);
});

test("the cursor advances to the highest ingested block", async () => {
  const { rows } = await pool.query<{ last_indexed_block: string }>(
    "SELECT last_indexed_block FROM evm_cursor WHERE network = $1",
    [NETWORK],
  );
  assert.equal(BigInt(rows[0].last_indexed_block), 2n);
});
```

- [ ] **Step 4: Run it, confirm it fails**

```bash
npm test
```
Expected: FAIL — `Cannot find module '../src/evm/rpc.js'` (and/or `../src/evm/ingest.js`).

- [ ] **Step 5: Implement `src/evm/rpc.ts`**

```ts
import { createPublicClient, http, defineChain, type PublicClient } from "viem";

/**
 * One client per network — this process may run more than one EVM network
 * (testnet today, mainnet after it migrates), so the client cannot be a
 * module-level singleton the way the source app had it.
 */
export function createEvmClient(rpcHttpUrl: string, chainId: number): PublicClient {
  const chain = defineChain({
    id: chainId,
    name: "Nagara",
    nativeCurrency: { name: "Nagara", symbol: "NGRX", decimals: 18 },
    rpcUrls: { default: { http: [rpcHttpUrl] } },
  });
  return createPublicClient({ chain, transport: http() });
}

export type RpcReceipt = {
  transactionHash: string;
  gasUsed: string;
  effectiveGasPrice: string | null;
  status: string;
  contractAddress: string | null;
  logs: { address: string; topics: string[]; data: string; logIndex: string }[];
};

/** One call per block instead of one per transaction. Frontier supports this. */
export async function getBlockReceipts(
  client: PublicClient,
  blockNumber: bigint,
): Promise<RpcReceipt[]> {
  return client.request({
    method: "eth_getBlockReceipts" as never,
    params: [`0x${blockNumber.toString(16)}`] as never,
  }) as Promise<RpcReceipt[]>;
}
```

- [ ] **Step 6: Implement `src/evm/ingest.ts`**

```ts
import type { PublicClient } from "viem";
import { getBlockReceipts } from "./rpc.js";
import { classifyTransferLog, detectToken } from "./tokens.js";
import { toNumeric } from "./numeric.js";
import { getPool, tx } from "../db.js";
import type { NetworkId } from "../config.js";

const lower = (s: string | null | undefined) => (s ? s.toLowerCase() : null);
/** BYTEA columns are written through decode(…, 'hex'), which wants bare hex. */
const bare = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);

/**
 * Writes one finalized block and everything in it — transactions, logs, token
 * transfers and the cursor — in a single Postgres transaction. Every insert is
 * idempotent, so re-ingesting a block is a no-op rather than a duplicate.
 *
 * All RPC happens before the transaction opens: a database transaction must
 * never be held open across network I/O.
 */
export async function ingestBlock(
  client: PublicClient,
  network: NetworkId,
  blockNumber: bigint,
): Promise<void> {
  const block = await client.getBlock({ blockNumber, includeTransactions: true });
  const receipts = (await getBlockReceipts(client, blockNumber)) ?? [];

  // Metadata for tokens seen for the first time. Fetched here, before BEGIN,
  // and only for addresses not already recorded — a token row never changes.
  const seen = new Map<string, "erc20" | "erc721" | "erc1155">();
  for (const r of receipts) {
    for (const log of r.logs) {
      const cls = classifyTransferLog(log);
      const address = lower(log.address);
      if (cls && address && !seen.has(address)) seen.set(address, cls[0].standard);
    }
  }
  const metadata = new Map<string, Awaited<ReturnType<typeof detectToken>>>();
  if (seen.size) {
    const { rows: known } = await getPool().query<{ address: string }>(
      "SELECT address FROM evm_token WHERE network = $1 AND address = ANY($2)",
      [network, [...seen.keys()]],
    );
    for (const k of known) seen.delete(k.address);
    for (const [address, type] of seen) {
      metadata.set(address, await detectToken(client, address, type));
    }
  }

  await tx(async (c) => {
    await c.query(
      `INSERT INTO evm_block (network, number, hash, parent_hash, timestamp, author,
                              gas_used, gas_limit, base_fee, tx_count)
       VALUES ($1,$2,$3,$4,to_timestamp($5),$6,$7,$8,$9,$10)
       ON CONFLICT (network, number) DO UPDATE SET hash = EXCLUDED.hash`,
      [
        network,
        toNumeric(block.number),
        lower(block.hash),
        lower(block.parentHash),
        Number(block.timestamp),
        lower(block.miner),
        toNumeric(block.gasUsed),
        toNumeric(block.gasLimit),
        block.baseFeePerGas != null ? toNumeric(block.baseFeePerGas) : null,
        block.transactions.length,
      ],
    );

    const byHash = new Map(receipts.map((r) => [r.transactionHash.toLowerCase(), r]));

    for (const [i, t] of block.transactions.entries()) {
      const r = byHash.get(t.hash.toLowerCase());
      await c.query(
        `INSERT INTO evm_tx (network, hash, block_number, tx_index, from_addr, to_addr,
           value, gas_used, gas_price, effective_gas_price, status, nonce, input, contract_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,decode($13,'hex'),$14)
         ON CONFLICT (network, hash) DO NOTHING`,
        [
          network,
          lower(t.hash),
          toNumeric(block.number),
          t.transactionIndex ?? i,
          lower(t.from),
          lower(t.to),
          toNumeric(t.value),
          r ? toNumeric(BigInt(r.gasUsed)) : "0",
          t.gasPrice != null ? toNumeric(t.gasPrice) : null,
          r?.effectiveGasPrice ? toNumeric(BigInt(r.effectiveGasPrice)) : null,
          r ? Number(BigInt(r.status)) : 0,
          toNumeric(BigInt(t.nonce)),
          bare(t.input),
          lower(r?.contractAddress),
        ],
      );
    }

    for (const r of receipts) {
      for (const log of r.logs) {
        const [t0, t1, t2, t3] = log.topics;
        const logIndex = Number(BigInt(log.logIndex));
        await c.query(
          `INSERT INTO evm_log (network, tx_hash, log_index, block_number, address,
                                topic0, topic1, topic2, topic3, data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,decode($10,'hex'))
           ON CONFLICT (network, tx_hash, log_index) DO NOTHING`,
          [
            network,
            lower(r.transactionHash),
            logIndex,
            toNumeric(block.number),
            lower(log.address),
            lower(t0),
            lower(t1),
            lower(t2),
            lower(t3),
            bare(log.data),
          ],
        );

        const cls = classifyTransferLog(log);
        if (!cls) continue;
        const address = lower(log.address)!;

        const md = metadata.get(address);
        await c.query(
          `INSERT INTO evm_token (network, address, type, name, symbol, decimals, first_seen)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (network, address) DO NOTHING`,
          [
            network,
            address,
            cls[0].standard,
            md?.name ?? null,
            md?.symbol ?? null,
            md?.decimals ?? null,
            toNumeric(block.number),
          ],
        );

        // One ERC-1155 TransferBatch log expands into several transfers that
        // all share a log_index, so sub_index separates them. Every other
        // standard produces exactly one entry, at sub_index 0.
        for (const [subIndex, x] of cls.entries()) {
          await c.query(
            `INSERT INTO evm_token_transfer (network, tx_hash, log_index, sub_index, block_number,
               token, from_addr, to_addr, value, token_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (network, tx_hash, log_index, sub_index) DO NOTHING`,
            [
              network,
              lower(r.transactionHash),
              logIndex,
              subIndex,
              toNumeric(block.number),
              address,
              x.from,
              x.to,
              x.value != null ? toNumeric(x.value) : null,
              x.tokenId != null ? toNumeric(x.tokenId) : null,
            ],
          );
        }
      }
    }

    await c.query(
      `INSERT INTO evm_cursor (network, last_indexed_block) VALUES ($1,$2)
       ON CONFLICT (network) DO UPDATE
         SET last_indexed_block = GREATEST(evm_cursor.last_indexed_block, EXCLUDED.last_indexed_block)`,
      [network, toNumeric(blockNumber)],
    );
  });
}
```

- [ ] **Step 7: Run tests, confirm they pass**

Requires `DATABASE_URL` set (in `.env` or the environment) pointing at a reachable Postgres, and `anvil` on `PATH`.

```bash
npm test
```
Expected: all tests pass, including the 8 new `ingest.test.ts` tests. If `anvil: command not found`, add `~/.foundry/bin` to `PATH` (Foundry's install location) before retrying.

- [ ] **Step 8: Commit**

```bash
git add src/db.ts src/evm/rpc.ts src/evm/ingest.ts test/ingest.test.ts test/fixtures/erc20-creation.hex test/fixtures/Tok.sol
git commit -m "feat: port the viem-based EVM block ingestion pipeline"
```

---

### Task 9: `evm/runEvmIndexer.ts` — the poll loop

**Files:**
- Create: `src/evm/runEvmIndexer.ts`

**Interfaces:**
- Consumes: `createEvmClient` from `./rpc.js` (Task 8); `ingestBlock` from `./ingest.js` (Task 8); `getPool` from `../db.js`; `NETWORKS`, `NetworkId` from `../config.js` (Task 3).
- Produces: `runEvmNetworkIndexer(network: NetworkId): Promise<void>` — never resolves under normal operation (same contract as the existing `runNetworkIndexer` in `runIndexer.ts`).

No automated test for this file: it is an orchestration loop (poll, sleep, retry) with no meaningful assertion beyond "it calls `ingestBlock` in sequence and advances the cursor" — which `ingest.test.ts` already covers at the unit it actually matters (`ingestBlock` itself). This matches the existing codebase's convention: `runIndexer.ts`'s own `followTip`/`backfill` loops have no automated tests either. Verified manually in Step 3.

- [ ] **Step 1: Implement**

Create `src/evm/runEvmIndexer.ts`:

```ts
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
```

- [ ] **Step 2: Verify**

```bash
npm run typecheck
```
Expected: passes.

- [ ] **Step 3: Manual verification (deferred to Task 10)**

This file has no caller until Task 10 wires it into `runIndexer()` — actually running it against testnet is verified there.

- [ ] **Step 4: Commit**

```bash
git add src/evm/runEvmIndexer.ts
git commit -m "feat: port the EVM poll loop"
```

---

### Task 10: Wire `runIndexer.ts` to branch per `chainType`

**Files:**
- Modify: `src/runIndexer.ts`

**Interfaces:**
- Consumes: `runEvmNetworkIndexer` from `./evm/runEvmIndexer.js` (Task 9).

- [ ] **Step 1: Rename the existing per-network function and branch in `runIndexer()`**

In `src/runIndexer.ts`, rename `runNetworkIndexer` to `runSubstrateNetworkIndexer` and give it a guard, matching the pattern used in `backfillWsUrl`/`runEvmNetworkIndexer`:

Replace:

```ts
/** Indexes one network: tip forwards on the live node, history backwards. */
export async function runNetworkIndexer(network: NetworkId): Promise<void> {
  const config = NETWORKS[network];
  const api = await connect(config.wsUrl);
```

with:

```ts
/** Indexes one substrate network: tip forwards on the live node, history backwards. */
async function runSubstrateNetworkIndexer(network: NetworkId): Promise<void> {
  const config = NETWORKS[network];
  if (config.chainType !== "substrate") {
    throw new Error(`${network} is not a substrate network`);
  }
  const api = await connect(config.wsUrl);
```

- [ ] **Step 2: Add the import and branch in `runIndexer()`**

Add to the top of `src/runIndexer.ts`:

```ts
import { runEvmNetworkIndexer } from "./evm/runEvmIndexer.js";
```

Replace:

```ts
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
```

with:

```ts
/** Starts every configured network. One bad chain must not stop the others. */
export async function runIndexer(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

  await cryptoWaitReady();
  await ensureSchema();

  const networks = Object.keys(NETWORKS) as NetworkId[];
  await Promise.all(
    networks.map((network) => {
      const worker =
        NETWORKS[network].chainType === "evm"
          ? runEvmNetworkIndexer(network)
          : runSubstrateNetworkIndexer(network);
      return worker.catch((error: unknown) => {
        log(network, `worker stopped: ${(error as Error).message}`);
      });
    })
  );
}
```

- [ ] **Step 3: Verify**

```bash
npm run typecheck
```
Expected: passes.

- [ ] **Step 4: Manual end-to-end verification against testnet**

This is the first point where the whole EVM pipeline runs against the real chain. Requires `DATABASE_URL` set.

```bash
npm run dev
```

Watch the log output for lines like:
```
[2026-09-02T...] [testnet] indexed up to #<N> / #<N>
```
(not `[testnet] tip → ...` — that log line belongs to the substrate path and should now only appear for `[mainnet]`).

Let it run for a minute or two, then check data landed:

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM evm_tx WHERE network = 'testnet';"
psql "$DATABASE_URL" -c "SELECT count(*) FROM evm_token_transfer WHERE network = 'testnet';"
```
Expected: both non-zero (the testnet chain has been producing blocks since 2026-08-26; some are ordinary NGRX transfers).

Stop the process (Ctrl-C) once confirmed.

- [ ] **Step 5: Commit**

```bash
git add src/runIndexer.ts
git commit -m "feat: branch runIndexer per network chainType"
```

---

### Task 11: `evm/queries.ts` — `listEvmActivity()`

**Files:**
- Create: `src/evm/queries.ts`
- Test: `test/evmQueries.test.ts`

**Interfaces:**
- Consumes: `getPool` from `../db.js`; `NetworkId` from `../config.js`.
- Produces: `EvmActivityCursor`, `EvmActivityRow`, `listEvmActivity(network, limit, filters): Promise<EvmActivityRow[]>`.

Mirrors `listActivity()` in `src/queries.ts` (the substrate path, built and reviewed in earlier work) — same tiebreak problem, same fix. One transaction can be *both* a native value transfer *and* trigger a token transfer (e.g. a payable contract call), and one transaction can contain *multiple* token transfers (a multi-hop call) — so the sort key is `(block_number, tx_index, kind, log_index, sub_index)`, not just `(block_number, tx_index)`. `kind` is 0 for the native branch and 1 for the token branch; native rows use `log_index = -1, sub_index = -1` as sentinels since real values are never negative.

- [ ] **Step 1: Write the failing test**

Create `test/evmQueries.test.ts`. This test inserts fixture rows directly (no RPC, no anvil — it exercises the query logic against a throwaway schema) and specifically exercises the tiebreak case, which is easy to get wrong and hard to notice by inspection.

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

const NETWORK = "test_evm_activity";
const ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN = "0xcccccccccccccccccccccccccccccccccccccccc".slice(0, 42);

const schemaSql = readFileSync(new URL("../src/schema.sql", import.meta.url), "utf8");

let pool: Pool;
let listEvmActivity: typeof import("../src/evm/queries.js")["listEvmActivity"];
let db = "";
let usr = "";

async function insertBlock(number: number, tsSeconds: number) {
  await pool.query(
    `INSERT INTO evm_block (network, number, hash, parent_hash, timestamp, gas_used, gas_limit, tx_count)
     VALUES ($1,$2,$3,'0x00',to_timestamp($4),0,0,1)`,
    [NETWORK, number, `0xblock${number}`, tsSeconds],
  );
}

async function insertTx(opts: {
  hash: string;
  blockNumber: number;
  txIndex: number;
  from: string;
  to: string | null;
  value: bigint;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  status?: number;
}) {
  await pool.query(
    `INSERT INTO evm_tx (network, hash, block_number, tx_index, from_addr, to_addr,
       value, gas_used, effective_gas_price, status, nonce, input)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,decode('',  'hex'))`,
    [
      NETWORK,
      opts.hash,
      opts.blockNumber,
      opts.txIndex,
      opts.from,
      opts.to,
      opts.value.toString(),
      (opts.gasUsed ?? 21000n).toString(),
      (opts.effectiveGasPrice ?? 1n).toString(),
      opts.status ?? 1,
    ],
  );
}

async function insertTokenTransfer(opts: {
  txHash: string;
  logIndex: number;
  subIndex?: number;
  blockNumber: number;
  token: string;
  from: string;
  to: string;
  value: bigint;
}) {
  await pool.query(
    `INSERT INTO evm_log (network, tx_hash, log_index, block_number, address, topic0, data)
     VALUES ($1,$2,$3,$4,$5,'0xtransfer',decode('','hex'))`,
    [NETWORK, opts.txHash, opts.logIndex, opts.blockNumber, opts.token],
  );
  await pool.query(
    `INSERT INTO evm_token (network, address, type, first_seen) VALUES ($1,$2,'erc20',$3)
     ON CONFLICT (network, address) DO NOTHING`,
    [NETWORK, opts.token, opts.blockNumber],
  );
  await pool.query(
    `INSERT INTO evm_token_transfer (network, tx_hash, log_index, sub_index, block_number, token, from_addr, to_addr, value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      NETWORK,
      opts.txHash,
      opts.logIndex,
      opts.subIndex ?? 0,
      opts.blockNumber,
      opts.token,
      opts.from,
      opts.to,
      opts.value.toString(),
    ],
  );
}

before(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query<{ db: string; usr: string }>(
    "SELECT current_database() AS db, current_user AS usr",
  );
  db = rows[0].db;
  usr = rows[0].usr;
  await pool.query(`ALTER ROLE "${usr}" IN DATABASE "${db}" SET search_path TO test_evm_activity`);
  await pool.query("SET search_path TO test_evm_activity");
  await pool.query("DROP SCHEMA IF EXISTS test_evm_activity CASCADE");
  await pool.query("CREATE SCHEMA test_evm_activity");
  await pool.query(schemaSql);

  ({ listEvmActivity } = await import("../src/evm/queries.js"));

  // Block 1: an ordinary native transfer to ADDR.
  await insertBlock(1, 1_000);
  await insertTx({ hash: "0xaaa1", blockNumber: 1, txIndex: 0, from: OTHER, to: ADDR, value: 500n });

  // Block 2: one transaction that is BOTH a native transfer to ADDR AND emits
  // a token transfer to ADDR — the tiebreak case.
  await insertBlock(2, 2_000);
  await insertTx({ hash: "0xaaa2", blockNumber: 2, txIndex: 0, from: OTHER, to: ADDR, value: 10n });
  await insertTokenTransfer({
    txHash: "0xaaa2",
    logIndex: 0,
    blockNumber: 2,
    token: TOKEN,
    from: OTHER,
    to: ADDR,
    value: 999n,
  });

  // Block 3: a failed transaction (status 0) — must still show up.
  await insertBlock(3, 3_000);
  await insertTx({
    hash: "0xaaa3",
    blockNumber: 3,
    txIndex: 0,
    from: ADDR,
    to: OTHER,
    value: 42n,
    status: 0,
  });

  // Block 4: an unrelated transaction that must NOT show up.
  await insertBlock(4, 4_000);
  await insertTx({ hash: "0xaaa4", blockNumber: 4, txIndex: 0, from: OTHER, to: OTHER, value: 1n });
});

after(async () => {
  try {
    if (usr) await pool?.query(`ALTER ROLE "${usr}" IN DATABASE "${db}" RESET search_path`);
    await pool?.query("DROP SCHEMA IF EXISTS test_evm_activity CASCADE");
  } finally {
    await pool?.end();
  }
});

test("returns native and token activity for the address, newest first", async () => {
  const rows = await listEvmActivity(NETWORK, 10, { address: ADDR });
  // Newest block first: block 3 (failed), then block 2's two rows (tie broken
  // by kind DESC — token row before native row), then block 1.
  assert.equal(rows.length, 4);
  assert.equal(rows[0].hash, "0xaaa3");
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[1].hash, "0xaaa2");
  assert.equal(rows[1].token, TOKEN);
  assert.equal(rows[1].amountRaw, "999");
  assert.equal(rows[2].hash, "0xaaa2");
  assert.equal(rows[2].token, "native");
  assert.equal(rows[2].amountRaw, "10");
  assert.equal(rows[3].hash, "0xaaa1");
});

test("blockNumber, amountRaw and feeRaw are strings", async () => {
  const [row] = await listEvmActivity(NETWORK, 1, { address: ADDR });
  assert.equal(typeof row.blockNumber, "string");
  assert.equal(typeof row.amountRaw, "string");
  assert.equal(typeof row.feeRaw, "string");
});

test("feeRaw is gas_used * effective_gas_price", async () => {
  const rows = await listEvmActivity(NETWORK, 10, { address: ADDR });
  const block1Row = rows.find((r) => r.hash === "0xaaa1")!;
  assert.equal(block1Row.feeRaw, (21000n * 1n).toString());
});

test("an unrelated transaction is excluded", async () => {
  const rows = await listEvmActivity(NETWORK, 10, { address: ADDR });
  assert.ok(!rows.some((r) => r.hash === "0xaaa4"));
});

test("cursor pagination does not skip or duplicate the tied pair at block 2", async () => {
  const page1 = await listEvmActivity(NETWORK, 2, { address: ADDR });
  assert.equal(page1.length, 2);
  assert.equal(page1[0].hash, "0xaaa3");
  assert.equal(page1[1].hash, "0xaaa2");
  assert.equal(page1[1].token, TOKEN);

  const page2 = await listEvmActivity(NETWORK, 2, {
    address: ADDR,
    cursor: {
      blockNumber: 2,
      txIndex: 0,
      kind: 1,
      logIndex: 0,
      subIndex: 0,
    },
  });
  assert.equal(page2.length, 2);
  assert.equal(page2[0].hash, "0xaaa2");
  assert.equal(page2[0].token, "native");
  assert.equal(page2[1].hash, "0xaaa1");
});
```

- [ ] **Step 2: Run it, confirm it fails**

```bash
npm test
```
Expected: FAIL — `Cannot find module '../src/evm/queries.js'`.

- [ ] **Step 3: Implement**

Create `src/evm/queries.ts`:

```ts
import type { NetworkId } from "../config.js";
import { getPool } from "../db.js";

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
```

- [ ] **Step 4: Run tests, confirm they pass**

```bash
npm test
```
Expected: all tests pass, including the 5 new `evmQueries.test.ts` tests.

- [ ] **Step 5: Commit**

```bash
git add src/evm/queries.ts test/evmQueries.test.ts
git commit -m "feat: add listEvmActivity() with native/token tiebreak pagination"
```

---

### Task 12: `server.ts` — branch `/activity` per `chainType`

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `listEvmActivity`, `EvmActivityCursor` from `./evm/queries.js` (Task 11); existing `listActivity` from `./queries.js`.

- [ ] **Step 1: Add the import**

Add to the imports at the top of `src/server.ts`:

```ts
import { listEvmActivity } from "./evm/queries.js";
```

- [ ] **Step 2: Replace the `/activity` case**

Find the existing `case "/activity":` block (added in earlier work) and replace it entirely with:

```ts
        case "/activity": {
          const network = readNetwork(params);
          const limit = readInt(params, "limit", 25, MAX_PAGE_SIZE);
          const address = params.get("address");
          if (!address) {
            send(response, 400, { error: "address is required" });
            return;
          }
          const rawCursor = params.get("cursor");
          const isEvm = NETWORKS[network].chainType === "evm";

          if (isEvm) {
            let cursor: import("./evm/queries.js").EvmActivityCursor | undefined;
            if (rawCursor) {
              const parts = rawCursor.split(":");
              const pattern = /^\d+:\d+:[01]:-?\d+:-?\d+$/;
              if (
                !pattern.test(rawCursor) ||
                !parts.slice(0, 2).every((p) => Number.isSafeInteger(Number(p)))
              ) {
                send(response, 400, { error: "invalid cursor" });
                return;
              }
              const [blockNumber, txIndex, kind, logIndex, subIndex] = parts.map(Number);
              cursor = { blockNumber, txIndex, kind: kind as 0 | 1, logIndex, subIndex };
            }
            const items = await listEvmActivity(network, limit, { address, cursor });
            const last = items[items.length - 1];
            send(response, 200, {
              network,
              items: items.map(({ txIndex, kind, logIndex, subIndex, ...item }) => item),
              nextCursor:
                items.length < limit || !last
                  ? null
                  : `${last.blockNumber}:${last.txIndex}:${last.kind}:${last.logIndex}:${last.subIndex}`,
            });
            return;
          }

          let cursor:
            | { blockNumber: number; extrinsicIndex: number; kind: 0 | 1 }
            | undefined;
          if (rawCursor) {
            if (
              !CURSOR_PATTERN.test(rawCursor) ||
              !rawCursor
                .split(":")
                .slice(0, 2)
                .every((part) => Number.isSafeInteger(Number(part)))
            ) {
              send(response, 400, { error: "invalid cursor" });
              return;
            }
            const [blockNumber, extrinsicIndex, kind] = rawCursor
              .split(":")
              .map(Number);
            cursor = { blockNumber, extrinsicIndex, kind: kind as 0 | 1 };
          }
          const items = await listActivity(network, limit, { address, cursor });
          const last = items[items.length - 1];
          send(response, 200, {
            network,
            items: items.map(({ extrinsicIndex, kind, ...item }) => item),
            nextCursor:
              items.length < limit || !last
                ? null
                : `${last.blockNumber}:${last.extrinsicIndex}:${last.kind}`,
          });
          return;
        }
```

(The substrate branch — everything from `let cursor:` through the final `return;` — is the existing code, unchanged; only the new `if (isEvm) { ... }` block above it and the `const isEvm = ...` line are new.)

- [ ] **Step 3: Verify**

```bash
npm run typecheck
```
Expected: passes.

- [ ] **Step 4: Manual end-to-end verification**

Requires `npm run dev` running with `DATABASE_URL` set and Task 10's manual verification already having populated some `evm_tx`/`evm_token_transfer` rows for testnet.

```bash
curl -s "http://localhost:8787/activity?network=testnet&address=<some address seen in evm_tx>&limit=5" | jq .
```
Expected: `200`, a JSON body shaped like:
```json
{
  "network": "testnet",
  "items": [
    { "hash": "0x...", "blockNumber": "12345", "timestamp": "...", "from": "0x...", "to": "0x...", "token": "native", "amountRaw": "...", "status": "success", "feeRaw": "..." }
  ],
  "nextCursor": "12345:0:0:-1:-1"
}
```
Confirm `blockNumber`, `amountRaw`, `feeRaw` are JSON strings (quoted), not bare numbers.

```bash
curl -s "http://localhost:8787/activity?network=mainnet&address=<some address seen in the old tx table>&limit=5" | jq .
```
Expected: same response shape, still working via the untouched substrate path.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat: branch /activity per network chainType"
```

---

### Task 13: Delete `nagara-evm-explorer`

**Files:** none in this repo — this is a separate repository at `~/Documents/nagara/apps/evm-explorer`.

This is intentionally the last task and is not bundled into any commit in `nagara-indexer` — it happens only once Task 12's manual verification has confirmed `/activity` answers correctly for `testnet` end to end.

- [ ] **Step 1: Confirm it's safe**

```bash
git -C ~/Documents/nagara/apps/evm-explorer status
git -C ~/Documents/nagara/apps/evm-explorer log --oneline -5
```
Read the output — if anyone has uncommitted or unpushed work there, stop and check with them before deleting anything.

- [ ] **Step 2: Delete**

If it's a standalone repository (has its own `.git`), delete the whole directory. If it's tracked inside a parent monorepo, remove it the way that repo expects (`git rm -r`, then commit in that repo). Determine which from Step 1's output before acting.

- [ ] **Step 3: Note in the design spec**

Update `docs/superpowers/specs/2026-09-02-evm-activity-feed-design.md`'s "Status" line to record the date `nagara-evm-explorer` was deleted, so the spec stays an accurate record of what happened.

---

## Self-Review Notes

- **Spec coverage:** config `chainType` (Task 3), schema (Task 4), ingestion port (Tasks 5–9), `runIndexer` branching (Task 10), `/activity` branching (Tasks 11–12), chain-core de-dependency (Task 2), `nagara-evm-explorer` deletion (Task 13) — every section of the design spec has a task.
- **Type consistency checked:** `EvmActivityCursor`/`EvmActivityRow` field names match between Task 11's `queries.ts` and Task 12's `server.ts` destructuring (`txIndex`, `kind`, `logIndex`, `subIndex`, `blockNumber`). `createEvmClient`/`getBlockReceipts`/`ingestBlock`/`runEvmNetworkIndexer` signatures match across Tasks 8–10. `NetworkConfig`'s discriminated union field names (`chainType`, `rpcHttpUrl`, `chainId`, `wsUrl`, `archiveWsUrl`) match between Task 3's definition and every later task that reads them (8, 9, 10).
- **No placeholders:** every task has complete, runnable code — nothing marked TBD or "similar to Task N".
