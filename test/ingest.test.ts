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
