import type { ApiPromise } from "@polkadot/api";
import type { NetworkId } from "./config.js";

/**
 * The live chain connections, shared between the indexer workers and the HTTP
 * API.
 *
 * The workers already hold one long-lived ApiPromise per network; the read API
 * needs the same connection to answer /price and would otherwise have to open a
 * second socket per request. Registration happens once, when a worker connects.
 */
const connections = new Map<NetworkId, ApiPromise>();

export function registerApi(network: NetworkId, api: ApiPromise): void {
  connections.set(network, api);
  // A worker that reconnects registers again, so a dead handle is never served.
  api.on("disconnected", () => {
    if (connections.get(network) === api) connections.delete(network);
  });
  api.on("connected", () => connections.set(network, api));
}

/**
 * The connection for a network, or null while its worker is still connecting.
 * Callers answer 503 rather than guessing — a stale price is worse than none.
 */
export function getApi(network: NetworkId): ApiPromise | null {
  const api = connections.get(network);
  return api?.isConnected ? api : null;
}
