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
