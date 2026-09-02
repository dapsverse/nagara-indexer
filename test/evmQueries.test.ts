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
