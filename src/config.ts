export type NetworkId = "mainnet" | "testnet";

export type NetworkConfig = {
  id: NetworkId;
  label: string;
  /** Live node — always reachable, but prunes old blocks. */
  wsUrl: string;
  /**
   * Archive node, when one exists. The live endpoints discard old block bodies
   * *and* state, so history below their pruning window is only reachable here.
   * Left undefined until an archive node is available; the backfill then stops
   * at the wall and resumes from its cursor once this is set.
   */
  archiveWsUrl?: string;
};

const env = (name: string): string | undefined =>
  process.env[name]?.trim() || undefined;

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    wsUrl: env("MAINNET_WS_URL") ?? "wss://bootnode.nagara.network",
    archiveWsUrl: env("MAINNET_ARCHIVE_WS_URL"),
  },
  testnet: {
    id: "testnet",
    label: "Testnet",
    wsUrl: env("TESTNET_WS_URL") ?? "wss://testnet.nagara.network",
    archiveWsUrl: env("TESTNET_ARCHIVE_WS_URL"),
  },
};

/** Which endpoint history should be read from: archive if configured. */
export function backfillWsUrl(network: NetworkId): string {
  const config = NETWORKS[network];
  return config.archiveWsUrl ?? config.wsUrl;
}

export function hasArchive(network: NetworkId): boolean {
  return Boolean(NETWORKS[network].archiveWsUrl);
}

/**
 * Daily buckets are cut in Jakarta time, not UTC: these are read as calendar
 * days by an Indonesian audience and prices are quoted in rupiah.
 */
export const DAILY_TIMEZONE = "Asia/Jakarta";

/** How many days of history the API will serve in one call. */
export const MAX_DAILY_RANGE = 365;

/** Rows per page for the block and transaction endpoints. */
export const MAX_PAGE_SIZE = 100;

/** Blocks fetched in parallel. Each costs ~3 RPC round trips. */
export const FETCH_CONCURRENCY = Number(env("FETCH_CONCURRENCY") ?? 25);

/** Blocks per forward batch. Small, so the live tip is written promptly. */
export const TIP_BATCH = 50;

/** Blocks per history batch. Larger — throughput matters more than latency. */
export const BACKFILL_BATCH = 250;

export const HTTP_PORT = Number(env("PORT") ?? 8787);
