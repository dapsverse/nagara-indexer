import { getApi } from "./chainApi.js";
import { MARKET_CAP_IDR, PRICE_CACHE_MS, type NetworkId } from "./config.js";

export type PriceQuote = {
  network: NetworkId;
  symbol: string;
  decimals: number;
  /** The pegged market cap, in whole rupiah. Fixed by policy, not by a market. */
  marketCapIdr: number;
  /** Total issuance in raw chain units, the figure the price is derived from. */
  totalIssuanceRaw: string;
  /** Same figure as whole tokens, for display. */
  totalIssuance: number;
  /** Rupiah per whole token. */
  priceIdr: number;
  /** When the issuance behind this quote was read. */
  asOf: string;
};

const MICRO = 1_000_000n;

/**
 * Rupiah per token from a raw issuance figure.
 *
 * Done in BigInt because the raw issuance of a billion tokens at 18 decimals is
 * ~1e27, well past the point where float64 holds every digit. The division is
 * carried to micro-rupiah and only then converted, so the rounding lands far
 * below the last digit anyone reads.
 */
export function priceIdrFromIssuance(
  totalIssuanceRaw: bigint,
  decimals: number
): number {
  if (totalIssuanceRaw <= 0n) {
    throw new Error("total issuance is zero — no price can be derived");
  }
  const scale = 10n ** BigInt(decimals);
  const micro = (MARKET_CAP_IDR * scale * MICRO) / totalIssuanceRaw;
  return Number(micro) / Number(MICRO);
}

/**
 * The price is a pure function of supply — market cap is pegged, so every token
 * burned raises what the rest are worth. Nothing here is a market quote.
 */
async function readQuote(network: NetworkId): Promise<PriceQuote> {
  const api = await getApi(network);
  if (!api) throw new Error(`no chain connection for ${network}`);

  const issuance = await api.query.balances.totalIssuance();
  const totalIssuanceRaw = BigInt(issuance.toString());
  const decimals = api.registry.chainDecimals[0] ?? 12;
  const symbol = api.registry.chainTokens[0] ?? "NGRX";

  return {
    network,
    symbol,
    decimals,
    marketCapIdr: Number(MARKET_CAP_IDR),
    totalIssuanceRaw: totalIssuanceRaw.toString(),
    totalIssuance: Number(totalIssuanceRaw) / 10 ** decimals,
    priceIdr: priceIdrFromIssuance(totalIssuanceRaw, decimals),
    asOf: new Date().toISOString(),
  };
}

type CacheEntry = { quote: PriceQuote; expiresAt: number };
const cache = new Map<NetworkId, CacheEntry>();

/**
 * Issuance only moves when a block is authored, so a short cache costs nothing
 * in freshness and keeps a busy explorer from querying state on every request.
 */
export async function getPriceQuote(network: NetworkId): Promise<PriceQuote> {
  const cached = cache.get(network);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.quote;

  const quote = await readQuote(network);
  cache.set(network, { quote, expiresAt: now + PRICE_CACHE_MS });
  return quote;
}
