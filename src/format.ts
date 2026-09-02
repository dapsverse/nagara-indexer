import { formatBalance } from "@polkadot/util";

/**
 * Plain-unit amount, no SI prefix — table cells read better as
 * "1.2345 NGRX" than "1.2345 mNGRX".
 *
 * The unit is appended by hand: formatBalance ignores `withUnit` whenever
 * `withSi` is false, and it returns a bare "0" for zero regardless of options,
 * so relying on it would silently drop the symbol.
 */
export function formatAmount(raw: string | number | bigint): string {
  const { unit } = formatBalance.getDefaults();
  const value = formatBalance(raw.toString(), {
    withSi: false,
    forceUnit: "-",
    withUnit: false,
  });
  return unit ? `${value} ${unit}` : value;
}

/**
 * Amount of an ink! token, with its own symbol.
 *
 * MINAR uses the same decimals as the chain itself, and its ABI exposes no
 * `decimals()` message, so the chain default is the scale for these too.
 */
export function formatTokenAmount(
  raw: string | number | bigint,
  symbol?: string | null
): string {
  const { decimals } = formatBalance.getDefaults();
  // toHuman() groups digits with commas; formatBalance needs the bare integer.
  const digits = raw.toString().replace(/[,\s]/g, "");
  const value = formatBalance(digits, {
    withSi: false,
    forceUnit: "-",
    withUnit: false,
    decimals,
  });
  return symbol ? `${value} ${symbol}` : value;
}

export function shortenHash(hash: string, head = 10, tail = 6): string {
  if (hash.length <= head + tail + 1) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

/** Weight numbers are huge; the tables show them grouped like gas figures. */
export function formatWeight(weight: number): string {
  return Math.round(weight).toLocaleString("en-US");
}
