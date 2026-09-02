import { ApiPromise, HttpProvider } from "@polkadot/api";
import { NETWORKS, type NetworkId } from "./config.js";

/**
 * The live chain connections, shared between the indexer workers and the HTTP
 * API.
 *
 * Substrate workers already hold one long-lived ApiPromise per network; the
 * read API reuses that connection via registerApi() rather than opening a
 * second socket per request. EVM networks have no such worker — ingestion
 * there is viem/JSON-RPC only — so getApi() opens one itself, lazily, the
 * first time a price is requested.
 */
const connections = new Map<NetworkId, ApiPromise>();
const connecting = new Map<NetworkId, Promise<ApiPromise>>();

export function registerApi(network: NetworkId, api: ApiPromise): void {
  connections.set(network, api);
  // A worker that reconnects registers again, so a dead handle is never served.
  api.on("disconnected", () => {
    if (connections.get(network) === api) connections.delete(network);
  });
  api.on("connected", () => connections.set(network, api));
}

/**
 * The connection for a network.
 *
 * Substrate: whatever the indexer worker registered, or null while it's still
 * connecting — callers answer 503 rather than guessing, a stale price is
 * worse than none.
 *
 * EVM: opened on demand over plain HTTP (no persistent socket needed for an
 * occasional query) and cached for reuse. The chain's single RPC port answers
 * both `eth_*` and the Substrate `state_*`/`system_*` methods this needs —
 * the native currency is still a plain `pallet_balances` under the EVM layer.
 */
export async function getApi(network: NetworkId): Promise<ApiPromise | null> {
  const existing = connections.get(network);
  if (existing?.isConnected) return existing;

  const config = NETWORKS[network];
  if (config.chainType !== "evm") return null;

  let pending = connecting.get(network);
  if (!pending) {
    pending = ApiPromise.create({
      provider: new HttpProvider(config.rpcHttpUrl),
      noInitWarn: true,
    })
      .then((api) => {
        connections.set(network, api);
        return api;
      })
      .finally(() => connecting.delete(network));
    connecting.set(network, pending);
  }
  return pending;
}
