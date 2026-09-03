import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getPool } from "../src/db.js";

// Regression coverage for the incident that motivated the tip/backfill
// split: a stray cursor value from an earlier chain incarnation left
// `last_indexed_block` far above the real (new, much shorter) chain's head,
// so the old single-loop indexer computed `next > head` forever and never
// indexed a single block. These tests pin the cursor read/write semantics
// directly against a throwaway schema — no RPC needed, `ingest.test.ts`
// already covers the RPC-facing half of this pipeline.

const NETWORK = "test_evm_cursor";
const schemaSql = readFileSync(new URL("../src/schema.sql", import.meta.url), "utf8");

let pool: ReturnType<typeof getPool>;
let readCursors: typeof import("../src/evm/runEvmIndexer.js")["readCursors"];
let initCursors: typeof import("../src/evm/runEvmIndexer.js")["initCursors"];
let advanceLastBlock: typeof import("../src/evm/runEvmIndexer.js")["advanceLastBlock"];
let advanceBackfillBlock: typeof import("../src/evm/runEvmIndexer.js")["advanceBackfillBlock"];

before(async () => {
  // getPool() is the same pool readCursors()/advanceLastBlock()/etc use —
  // scoped to this schema via its own 'connect' event, not a role-level
  // default (which would race against every other test file's pool setting
  // its own default concurrently — see test/ingest.test.ts for the incident
  // this caused).
  pool = getPool();
  pool.on("connect", (client) => {
    client.query("SET search_path TO test_evm_cursor").catch(() => {});
  });
  // One held client, not pool.query() — guarantees these statements queue
  // strictly after the 'connect' handler's SET search_path on the same
  // connection, no race between the two.
  const setup = await pool.connect();
  try {
    await setup.query("DROP SCHEMA IF EXISTS test_evm_cursor CASCADE");
    await setup.query("CREATE SCHEMA test_evm_cursor");
    await setup.query(schemaSql);
  } finally {
    setup.release();
  }

  ({ readCursors, initCursors, advanceLastBlock, advanceBackfillBlock } = await import(
    "../src/evm/runEvmIndexer.js"
  ));
});

after(async () => {
  try {
    await pool?.query("DROP SCHEMA IF EXISTS test_evm_cursor CASCADE");
  } finally {
    await pool?.end();
  }
});

test("a network with no cursor row reads as null/null", async () => {
  const cursors = await readCursors(NETWORK);
  assert.deepEqual(cursors, { lastBlock: null, backfillBlock: null });
});

test("initCursors seeds both cursors at the same head", async () => {
  await initCursors(NETWORK, 100n);
  const cursors = await readCursors(NETWORK);
  assert.deepEqual(cursors, { lastBlock: 100n, backfillBlock: 100n });
});

test("initCursors is a no-op once a row exists — never resets progress", async () => {
  await advanceLastBlock(NETWORK, 150n);
  await advanceBackfillBlock(NETWORK, 40n);
  await initCursors(NETWORK, 999n); // must not overwrite either cursor
  const cursors = await readCursors(NETWORK);
  assert.deepEqual(cursors, { lastBlock: 150n, backfillBlock: 40n });
});

test("advanceLastBlock never moves the tip cursor backwards", async () => {
  await advanceLastBlock(NETWORK, 120n); // lower than the 150n set above
  const { lastBlock } = await readCursors(NETWORK);
  assert.equal(lastBlock, 150n);
});

test("advanceBackfillBlock sets exactly the given value, moving down freely", async () => {
  await advanceBackfillBlock(NETWORK, 10n);
  const { backfillBlock } = await readCursors(NETWORK);
  assert.equal(backfillBlock, 10n);
});

test("the tip and backfill cursors advance independently of each other", async () => {
  await advanceLastBlock(NETWORK, 500n);
  const { backfillBlock } = await readCursors(NETWORK);
  // Only the tip cursor moved — a stuck/reset tip cursor must never make the
  // backfill cursor jump too, and vice versa. This is the exact property
  // that failed before the split: one cursor value governed both directions.
  assert.equal(backfillBlock, 10n);
});
