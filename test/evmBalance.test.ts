import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { getPool } from "../src/db.js";
import { NETWORKS } from "../src/config.js";

/**
 * `getEvmBalances` mixes two things that must never come from the same
 * source: which contracts to check (from indexed history — the reason this
 * needs the indexer at all) and what the balance actually is right now
 * (always a live call). Both halves are exercised here against a real
 * deployed ERC-20 on a disposable anvil, plus a hand-inserted `evm_token`
 * row standing in for what ingestion would have cached.
 */

const NETWORK = "testnet"; // getEvmBalances reads NETWORKS[network] directly
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const UNTOUCHED_WALLET = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc";

const creationBytecode = readFileSync(
  new URL("./fixtures/erc20-creation.hex", import.meta.url),
  "utf8",
).trim() as `0x${string}`;

const schemaSql = readFileSync(new URL("../src/schema.sql", import.meta.url), "utf8");

let anvil: ChildProcess | undefined;
let pool: ReturnType<typeof getPool>;
let getEvmBalances: typeof import("../src/evm/balance.js")["getEvmBalances"];
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

  anvil = spawn("anvil", ["--port", String(port), "--chain-id", "16869", "--silent"], {
    stdio: "ignore",
    env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` },
  });
  await waitForRpc(rpcUrl);

  // getEvmBalances resolves its client from NETWORKS[network] via
  // getEvmClient()'s cache — point the testnet config at anvil before that
  // cache is ever populated, and force a MINAR address that this test's
  // deployer wallet has never touched.
  NETWORKS.testnet = {
    ...NETWORKS.testnet,
    chainType: "evm",
    rpcHttpUrl: rpcUrl,
    chainId: 16869,
    minarAddress: undefined, // set per-test below, after the token deploys
  };

  const { createWalletClient, createPublicClient, http, parseEther } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");

  const account = privateKeyToAccount(ANVIL_KEY);
  const chain = {
    id: 16869,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });

  const deployHash = await wallet.deployContract({ abi: [], bytecode: creationBytecode });
  const receipt = await pub.waitForTransactionReceipt({ hash: deployHash });
  tokenAddress = receipt.contractAddress!.toLowerCase();
  NETWORKS.testnet.minarAddress = tokenAddress; // stand in for MINAR in this test

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

  pool = getPool();
  pool.on("connect", (client) => {
    client.query("SET search_path TO test_evm_balance").catch(() => {});
  });
  // One held client, not pool.query() — guarantees these statements queue
  // strictly after the 'connect' handler's SET search_path on the same
  // connection, no race between the two.
  const setup = await pool.connect();
  try {
    await setup.query("DROP SCHEMA IF EXISTS test_evm_balance CASCADE");
    await setup.query("CREATE SCHEMA test_evm_balance");
    await setup.query(schemaSql);
  } finally {
    setup.release();
  }

  // Stand-in for what `ingestBlock` would have written: the token is known
  // (with cached metadata) and RECIPIENT's incoming transfer is indexed.
  // ANVIL_ADDR (the deployer) deliberately gets NO evm_token_transfer row —
  // its balance still has to be found some other way (the minarAddress
  // force-include path) to prove discovery isn't the only path in.
  await pool.query(
    `INSERT INTO evm_token (network, address, type, name, symbol, decimals, first_seen)
     VALUES ($1,$2,'erc20','Test Token','TT',18,1)`,
    [NETWORK, tokenAddress],
  );
  await pool.query(
    `INSERT INTO evm_log (network, tx_hash, log_index, block_number, address, topic0, data)
     VALUES ($1,'0xdeadbeef',0,1,$2,'0xtransfer',decode('','hex'))`,
    [NETWORK, tokenAddress],
  );
  await pool.query(
    `INSERT INTO evm_token_transfer (network, tx_hash, log_index, sub_index, block_number, token, from_addr, to_addr, value)
     VALUES ($1,'0xdeadbeef',0,0,1,$2,$3,$4,$5)`,
    [NETWORK, tokenAddress, ANVIL_ADDR, RECIPIENT, (10n ** 18n).toString()],
  );

  ({ getEvmBalances } = await import("../src/evm/balance.js"));
});

after(async () => {
  try {
    await pool?.query("DROP SCHEMA IF EXISTS test_evm_balance CASCADE");
  } finally {
    await pool?.end();
    anvil?.kill();
  }
});

test("a wallet with an indexed incoming transfer sees the token, live balance and cached metadata", async () => {
  const balances = await getEvmBalances(NETWORK, RECIPIENT);

  const native = balances.find((b) => b.token === "native")!;
  assert.equal(native.symbol, "NGRX");
  // anvil funds every default account with 10000 ETH.
  assert.equal(BigInt(native.balanceRaw) > 9000n * 10n ** 18n, true);

  const token = balances.find((b) => b.token === tokenAddress)!;
  assert.ok(token, "discovered token missing from balance list");
  assert.equal(token.symbol, "TT"); // from the cached evm_token row, not a live call
  assert.equal(token.decimals, 18);
  assert.equal(token.balanceRaw, (10n ** 18n).toString()); // live balanceOf — the 1 token it received
});

test("a wallet with zero indexed history still sees a configured MINAR row", async () => {
  const balances = await getEvmBalances(NETWORK, UNTOUCHED_WALLET);
  const token = balances.find((b) => b.token === tokenAddress)!;
  assert.ok(token, "minarAddress-forced token missing despite no transfer history");
  assert.equal(token.balanceRaw, "0");
});

test("the deployer's balance is found via the forced MINAR address, not discovery", async () => {
  // ANVIL_ADDR deliberately has no evm_token_transfer row (see before()) —
  // it only shows up because minarAddress forces this contract's inclusion.
  const balances = await getEvmBalances(NETWORK, ANVIL_ADDR);
  const token = balances.find((b) => b.token === tokenAddress)!;
  assert.ok(token);
  assert.equal(token.balanceRaw, (999n * 10n ** 18n).toString());
});
