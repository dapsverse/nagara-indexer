import http from "node:http";
import {
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
  listBlocks,
  listContracts,
  listTransactions,
} from "./queries.js";

/** Read-only public data, so any origin may read it. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function send(
  response: http.ServerResponse,
  status: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=5",
    ...CORS,
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
    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const params = url.searchParams;

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
  });
  return server;
}
