import type { Address, PublicClient } from "viem";
import { getEvmClient } from "./rpc.js";
import { NETWORKS, type NetworkId } from "../config.js";
import { getPool } from "../db.js";

export type TokenBalance = {
  token: string;
  symbol: string;
  decimals: number;
  balanceRaw: string;
};

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

async function liveMetadata(client: PublicClient, token: Address): Promise<{ symbol: string; decimals: number }> {
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_BALANCE_ABI, functionName: "symbol" }),
    client.readContract({ address: token, abi: ERC20_BALANCE_ABI, functionName: "decimals" }),
  ]);
  return { symbol, decimals };
}

/**
 * Native NGRX plus every ERC-20 this wallet has ever moved, read live from
 * the chain — never derived from indexed history, which lags behind the real
 * balance by however long the indexer takes to catch up, and a wallet
 * balance is exactly the number that must never be shown stale.
 *
 * History IS used, but only to answer the one question a wallet has no cheap
 * way to answer on its own — "which contracts have ever sent or received
 * tokens for this address" — via the already-indexed `evm_token_transfer`
 * table. Token symbol/decimals also come from there (`evm_token`, cached at
 * ingest time — immutable once a contract is deployed, no reason to re-probe
 * it live); only the balance number itself is fetched fresh every request.
 */
export async function getEvmBalances(network: NetworkId, walletAddress: string): Promise<TokenBalance[]> {
  const config = NETWORKS[network];
  if (config.chainType !== "evm") {
    throw new Error(`${network} is not an evm network`);
  }
  const client = getEvmClient(network);
  const address = walletAddress.toLowerCase() as Address;

  const nativeRaw = await client.getBalance({ address });
  const native: TokenBalance = { token: "native", symbol: "NGRX", decimals: 18, balanceRaw: nativeRaw.toString() };

  const { rows } = await getPool().query<{
    address: string;
    symbol: string | null;
    decimals: number | null;
  }>(
    `SELECT DISTINCT tok.address, tok.symbol, tok.decimals
       FROM evm_token_transfer tt
       JOIN evm_token tok ON tok.network = tt.network AND tok.address = tt.token AND tok.type = 'erc20'
      WHERE tt.network = $1 AND (tt.from_addr = $2 OR tt.to_addr = $2)`,
    [network, address],
  );

  // MINAR always gets a row, even before this wallet's first transfer —
  // known-important tokens shouldn't wait for indexed history to appear.
  const known = new Map(rows.map((r) => [r.address, r]));
  const minar = config.minarAddress?.toLowerCase();
  if (minar && !known.has(minar)) {
    known.set(minar, { address: minar, symbol: null, decimals: null });
  }

  const tokens = await Promise.all(
    [...known.values()].map(async (row) => {
      const token = row.address as Address;
      try {
        const [balanceOfRaw, meta] = await Promise.all([
          client.readContract({ address: token, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [address] }),
          row.symbol !== null && row.decimals !== null
            ? Promise.resolve({ symbol: row.symbol, decimals: row.decimals })
            : liveMetadata(client, token),
        ]);
        return { token: row.address, symbol: meta.symbol, decimals: meta.decimals, balanceRaw: balanceOfRaw.toString() };
      } catch {
        // A token that no longer answers (selfdestructed, a broken proxy)
        // shouldn't take the whole balance list down with it.
        return null;
      }
    }),
  );

  return [native, ...tokens.filter((t): t is TokenBalance => t !== null)];
}
