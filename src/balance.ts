import type { ApiPromise } from "@polkadot/api";
import { decodeAddress } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
import { NKRI08_SELECTORS } from "./standard.js";
import { callContract, decodeOk } from "./detectToken.js";
import { getPool } from "./db.js";
import type { NetworkId } from "./config.js";

export type TokenBalance = {
  token: string;
  symbol: string;
  decimals: number;
  balanceRaw: string;
};

/**
 * `balance_of(AccountId) -> Result<Balance, LangError>` — same response shape
 * `detectToken`'s `total_supply` probe decodes, just with the target account
 * SCALE-encoded (32 raw bytes, no length prefix — that's how a fixed-size
 * AccountId32 argument is laid out after the selector) appended to the call.
 */
async function ink08BalanceOf(api: ApiPromise, contract: string, wallet: string): Promise<string | null> {
  const argHex = u8aToHex(decodeAddress(wallet)).slice(2);
  const data = await callContract(api, contract, NKRI08_SELECTORS.balance_of + argHex);
  return data ? decodeOk(data, "u128") : null;
}

async function ink08Symbol(api: ApiPromise, contract: string): Promise<string | null> {
  const data = await callContract(api, contract, NKRI08_SELECTORS.symbol);
  return data ? decodeOk(data, "Text") : null;
}

/**
 * Native NGRX plus every NKRI08 token this wallet has ever moved, read live
 * from chain state — never from indexed history, which lags behind the real
 * balance by however long the indexer takes to catch up.
 *
 * Candidate contracts come from the already-indexed `token_transfer` table
 * (a wallet has no cheap way to ask "which contracts have ever sent me
 * tokens" on its own); the balance itself is always a fresh `balance_of`
 * call. Symbol is read from `contract.token_symbol` when the ingest-time
 * probe already cached it, live-probed only as a fallback. Decimals is
 * always the chain's own scale — NKRI08 tokens expose no `decimals()`
 * message, MINAR included (see format.ts).
 */
export async function getSubstrateBalances(
  api: ApiPromise,
  network: NetworkId,
  walletAddress: string,
  minarAddress: string | undefined,
): Promise<TokenBalance[]> {
  const decimals = api.registry.chainDecimals[0] ?? 12;
  const nativeSymbol = api.registry.chainTokens[0] ?? "NGRX";

  const account = await api.query.system.account(walletAddress);
  const native: TokenBalance = {
    token: "native",
    symbol: nativeSymbol,
    decimals,
    balanceRaw: (account as unknown as { data: { free: { toString(): string } } }).data.free.toString(),
  };

  const { rows } = await getPool().query<{ token: string; token_symbol: string | null }>(
    `SELECT DISTINCT tt.token, c.token_symbol
       FROM token_transfer tt
       LEFT JOIN contract c ON c.network = tt.network AND c.address = tt.token
      WHERE tt.network = $1 AND (tt.from_address = $2 OR tt.to_address = $2)`,
    [network, walletAddress],
  );

  // MINAR always gets a row, even before this wallet's first transfer —
  // known-important tokens shouldn't wait for indexed history to appear.
  const known = new Map(rows.map((r) => [r.token, r.token_symbol]));
  if (minarAddress && !known.has(minarAddress)) known.set(minarAddress, null);

  const tokens = await Promise.all(
    [...known.entries()].map(async ([contract, cachedSymbol]) => {
      const raw = await ink08BalanceOf(api, contract, walletAddress);
      if (raw === null) return null;
      const symbol = cachedSymbol ?? (await ink08Symbol(api, contract)) ?? contract;
      return { token: contract, symbol, decimals, balanceRaw: raw };
    }),
  );

  return [native, ...tokens.filter((t): t is TokenBalance => t !== null)];
}
