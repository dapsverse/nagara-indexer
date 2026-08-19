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

/**
 * How many times the tip follower retries a block the node refused before
 * declaring it permanently gone. Blocks pruned during downtime never come back,
 * and retrying one forever would freeze the tip.
 */
export const TIP_STALL_RETRIES = 3;

/** Nagara ss58 prefix, from the chain properties. */
export const SS58_FORMAT = 42;

/**
 * NGRX's market cap, pegged by policy at Rp 500 billion.
 *
 * The token has no market; its price is defined as this figure divided by
 * circulating supply. Every transaction burns part of the supply, so the price
 * per token rises as supply falls. Changing this number reprices the token
 * everywhere it is quoted.
 */
export const MARKET_CAP_IDR = 500_000_000_000n;

/** How long a price quote is reused before issuance is read again. */
export const PRICE_CACHE_MS = 10_000;

/**
 * Keys accepted on the `x-api-key` header, comma-separated so a key can be
 * rotated by running old and new side by side.
 *
 * Empty disables the check — that is the local-development default. Anything
 * reachable from the internet must set this.
 */
export const API_KEYS: string[] = (env("API_KEYS") ?? "")
  .split(",")
  .map((key) => key.trim())
  .filter((key) => key.length > 0);

export const AUTH_ENABLED = API_KEYS.length > 0;
