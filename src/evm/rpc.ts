import { createPublicClient, http, defineChain, type PublicClient } from "viem";
import { NETWORKS, type NetworkId } from "../config.js";

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

const clients = new Map<NetworkId, PublicClient>();

/**
 * The shared client for an EVM network — created once, reused by both the
 * indexer loop and the HTTP API (e.g. `/balance`). Cheap to cache: an HTTP
 * transport has no persistent connection to keep alive, just config to avoid
 * rebuilding on every call.
 */
export function getEvmClient(network: NetworkId): PublicClient {
  let client = clients.get(network);
  if (!client) {
    const config = NETWORKS[network];
    if (config.chainType !== "evm") {
      throw new Error(`${network} is not an evm network`);
    }
    client = createEvmClient(config.rpcHttpUrl, config.chainId);
    clients.set(network, client);
  }
  return client;
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
