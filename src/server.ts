import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  API_KEYS,
  AUTH_ENABLED,
  DAILY_TIMEZONE,
  HTTP_PORT,
  MAX_DAILY_RANGE,
  MAX_PAGE_SIZE,
  NETWORKS,
  type NetworkId,
} from "./config.js";
import {
  dailyTransactions,
  indexerStatus,
  listActivity,
  listBlocks,
  listContracts,
  listTokenTransfers,
  listTokens,
  listTransactions,
} from "./queries.js";
import { listEvmActivity } from "./evm/queries.js";
import { getPriceQuote } from "./price.js";

/**
 * Endpoints reachable without a key. Only the liveness probe: a load balancer
 * has to be able to ask whether the process is up without holding a credential.
 */
const PUBLIC_PATHS = new Set(["/health"]);

/**
 * Opaque `/activity` pagination cursor: "<blockNumber>:<extrinsicIndex>:<kind>".
 * `kind` (0|1) breaks ties between a native row and a token row that share the
 * same block/extrinsic — see the comment on `listActivity`.
 */
const CURSOR_PATTERN = /^\d+:\d+:[01]$/;

/**
 * Constant-time key comparison, so a wrong key cannot be narrowed down by
 * timing the response.
 */
function keyMatches(candidate: string, known: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(known);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Whether a request carries an accepted key.
 *
 * The only consumer is the explorer's server-side proxy, which holds the key in
 * its own environment — the key never reaches a browser, and no CORS headers are
 * sent because nothing is meant to call this from one.
 */
function isAuthorised(request: http.IncomingMessage): boolean {
  if (!AUTH_ENABLED) return true;
  const header = request.headers["x-api-key"];
  const presented = Array.isArray(header) ? header[0] : header;
  if (!presented) return false;
  return API_KEYS.some((known) => keyMatches(presented, known));
}

function send(
  response: http.ServerResponse,
  status: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    // Answers are proxied by a server that caches on its own terms, and the key
    // that unlocked them must not pin a copy in any shared cache.
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

function readNetwork(params: URLSearchParams): NetworkId {
  const requested = params.get("network");
  return requested && requested in NETWORKS
    ? (requested as NetworkId)
    : "mainnet";
}

function readInt(
  params: URLSearchParams,
  name: string,
  fallback: number,
  max: number
): number {
  const raw = Number(params.get(name));
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(Math.trunc(raw), 1), max);
}

/**
 * The indexer's read API. Deliberately tiny and framework-free: it serves a
 * handful of read-only queries, and the frontend never touches the database.
 */
export function createServer(): http.Server {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const params = url.searchParams;

    if (!PUBLIC_PATHS.has(url.pathname) && !isAuthorised(request)) {
      send(response, 401, { error: "unauthorized" });
      return;
    }

    try {
      switch (url.pathname) {
        case "/health":
          send(response, 200, { ok: true });
          return;

        case "/status": {
          const networks = Object.keys(NETWORKS) as NetworkId[];
          send(response, 200, {
            networks: await Promise.all(networks.map(indexerStatus)),
          });
          return;
        }

        case "/daily": {
          const network = readNetwork(params);
          const days = readInt(params, "days", 14, MAX_DAILY_RANGE);
          const [series, status] = await Promise.all([
            dailyTransactions(network, days),
            indexerStatus(network),
          ]);
          send(response, 200, {
            network,
            timezone: DAILY_TIMEZONE,
            lastIndexedBlock: status.lastIndexedBlock,
            oldestIndexedBlock: status.oldestIndexedBlock,
            historyComplete: status.historyComplete,
            series,
          });
          return;
        }

        case "/blocks": {
          const network = readNetwork(params);
          const limit = readInt(params, "limit", 25, MAX_PAGE_SIZE);
          const before = params.get("before");
          send(response, 200, {
            network,
            items: await listBlocks(
              network,
              limit,
              before ? Number(before) : undefined
            ),
          });
          return;
        }

        case "/transactions": {
          const network = readNetwork(params);
          const limit = readInt(params, "limit", 25, MAX_PAGE_SIZE);
          send(response, 200, {
            network,
            items: await listTransactions(network, limit, {
              before: params.get("before")
                ? Number(params.get("before"))
                : undefined,
              address: params.get("address") ?? undefined,
              contract: params.get("contract") ?? undefined,
            }),
          });
          return;
        }

        case "/token-transfers": {
          const network = readNetwork(params);
          const limit = readInt(params, "limit", 25, MAX_PAGE_SIZE);
          send(response, 200, {
            network,
            items: await listTokenTransfers(network, limit, {
              before: params.get("before")
                ? Number(params.get("before"))
                : undefined,
              token: params.get("token") ?? undefined,
              address: params.get("address") ?? undefined,
            }),
          });
          return;
        }

        case "/activity": {
          const network = readNetwork(params);
          const limit = readInt(params, "limit", 25, MAX_PAGE_SIZE);
          const address = params.get("address");
          if (!address) {
            send(response, 400, { error: "address is required" });
            return;
          }
          const rawCursor = params.get("cursor");
          const isEvm = NETWORKS[network].chainType === "evm";

          if (isEvm) {
            let cursor: import("./evm/queries.js").EvmActivityCursor | undefined;
            if (rawCursor) {
              const parts = rawCursor.split(":");
              const pattern = /^\d+:\d+:[01]:-?\d+:-?\d+$/;
              if (
                !pattern.test(rawCursor) ||
                !parts.slice(0, 2).every((p) => Number.isSafeInteger(Number(p)))
              ) {
                send(response, 400, { error: "invalid cursor" });
                return;
              }
              const [blockNumber, txIndex, kind, logIndex, subIndex] = parts.map(Number);
              cursor = { blockNumber, txIndex, kind: kind as 0 | 1, logIndex, subIndex };
            }
            const items = await listEvmActivity(network, limit, { address, cursor });
            const last = items[items.length - 1];
            send(response, 200, {
              network,
              items: items.map(({ txIndex, kind, logIndex, subIndex, ...item }) => item),
              nextCursor:
                items.length < limit || !last
                  ? null
                  : `${last.blockNumber}:${last.txIndex}:${last.kind}:${last.logIndex}:${last.subIndex}`,
            });
            return;
          }

          let cursor:
            | { blockNumber: number; extrinsicIndex: number; kind: 0 | 1 }
            | undefined;
          if (rawCursor) {
            if (
              !CURSOR_PATTERN.test(rawCursor) ||
              // Regex only bounds the shape; a huge digit string still parses
              // (as Infinity or a lossy float) and blows up `::bigint` in
              // Postgres as an unhandled 500. Reject anything outside the
              // range a real block number could ever reach.
              !rawCursor
                .split(":")
                .slice(0, 2)
                .every((part) => Number.isSafeInteger(Number(part)))
            ) {
              send(response, 400, { error: "invalid cursor" });
              return;
            }
            const [blockNumber, extrinsicIndex, kind] = rawCursor
              .split(":")
              .map(Number);
            cursor = { blockNumber, extrinsicIndex, kind: kind as 0 | 1 };
          }
          const items = await listActivity(network, limit, { address, cursor });
          const last = items[items.length - 1];
          send(response, 200, {
            network,
            items: items.map(({ extrinsicIndex, kind, ...item }) => item),
            nextCursor:
              items.length < limit || !last
                ? null
                : `${last.blockNumber}:${last.extrinsicIndex}:${last.kind}`,
          });
          return;
        }

        case "/price": {
          const network = readNetwork(params);
          try {
            send(response, 200, await getPriceQuote(network));
          } catch (error) {
            // No connection, or an issuance of zero. Either way there is no
            // honest number to return, and a stale one would be quoted as real.
            send(response, 503, {
              error: `price unavailable: ${(error as Error).message}`,
            });
          }
          return;
        }

        case "/tokens": {
          const network = readNetwork(params);
          send(response, 200, { network, items: await listTokens(network) });
          return;
        }

        case "/contracts": {
          const network = readNetwork(params);
          send(response, 200, {
            network,
            items: await listContracts(network, {
              codeHash: params.get("codeHash") ?? undefined,
            }),
          });
          return;
        }

        default:
          send(response, 404, { error: "not found" });
      }
    } catch (error) {
      console.error("[http]", error);
      send(response, 500, { error: (error as Error).message });
    }
  });
}

export function startServer(): http.Server {
  const server = createServer();
  server.listen(HTTP_PORT, () => {
    console.log(`[http] listening on :${HTTP_PORT}`);
    if (!AUTH_ENABLED) {
      console.warn(
        "[http] API_KEYS is empty — every endpoint is open. Set it before exposing this port."
      );
    }
  });
  return server;
}
