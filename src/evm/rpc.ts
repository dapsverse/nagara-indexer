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
