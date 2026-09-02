import type { ApiPromise } from "@polkadot/api";
import { TypeRegistry } from "@polkadot/types";
import { hexToU8a } from "@polkadot/util";
import { NKRI08_SELECTORS } from "./standard.js";

const registry = new TypeRegistry();

/** Any account works as the caller for a read-only dry run. */
const PROBE_ORIGIN = "5EfNd8G65v4FGXrLAv7LnRWx3NjgVvLCfgEV9zEJhjNje4bB";

export type TokenInfo = {
  name: string | null;
  symbol: string | null;
  totalSupplyRaw: string | null;
};

/**
 * ink! messages return `Result<T, LangError>`. The Ok variant is a leading 0x00,
 * so the payload can be read without the contract's ABI as long as the standard
 * fixes the type — which is the whole point of NKRI08.
 */
function decodeOk(data: string, type: "Text" | "u128"): string | null {
  try {
    const bytes = hexToU8a(data);
    if (bytes.length < 1 || bytes[0] !== 0) return null;
    return registry.createType(type, bytes.subarray(1)).toString();
  } catch {
    return null;
  }
}

async function callMessage(
  api: ApiPromise,
  address: string,
  message: string
): Promise<string | null> {
  try {
    // ContractsApi_call takes gasLimit as Option<WeightV2>; passing a bare
    // WeightV2 shifts every later argument and the node fails decoding the
    // input. null lets the node apply its own block limit, which is what a
    // read-only dry run wants anyway.
    const result = await api.call.contractsApi.call(
      PROBE_ORIGIN,
      address,
      0,
      null,
      null,
      // Passed as hex, not as a Uint8Array: a Vec<u8> parameter treats raw bytes
      // as already-SCALE-encoded and reads the first byte as a length prefix.
      NKRI08_SELECTORS[message]
    );

    const json = result.toJSON() as {
      result?: { ok?: { data?: string }; err?: unknown };
    };
    return json.result?.ok?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Is this contract a fungible token, and what does it call itself?
 *
 * Detection is by **interface**, exactly like Etherscan treating anything with
 * the ERC-20 event signature as a token: an ink! selector is derived from the
 * message name, so probing `name` / `symbol` / `total_supply` needs no ABI and
 * works for a contract nobody has ever verified.
 *
 * Returns null when the contract does not answer all three — a contract that
 * answers only some of them is not one this explorer will call a token.
 */
export async function detectToken(
  api: ApiPromise,
  address: string
): Promise<TokenInfo | null> {
  const [nameData, symbolData, supplyData] = await Promise.all([
    callMessage(api, address, "name"),
    callMessage(api, address, "symbol"),
    callMessage(api, address, "total_supply"),
  ]);

  if (!nameData || !symbolData || !supplyData) return null;

  const name = decodeOk(nameData, "Text");
  const symbol = decodeOk(symbolData, "Text");
  const totalSupplyRaw = decodeOk(supplyData, "u128");

  if (name === null || symbol === null || totalSupplyRaw === null) return null;

  return { name, symbol, totalSupplyRaw };
}

