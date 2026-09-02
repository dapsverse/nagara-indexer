// MINAR-specific selectors, topics and calldata decoding.
//
// A false positive here accuses an operator of seizing funds; a false negative
// hides a use of that power. Both are worse than a crash, so every function
// below is exact-match and total.

export const MINAR_SELECTORS = {
  transferAdminTransfer: "0xd8af5545",
  mintToken: "0xbd89d13e",
  burnToken: "0xad193fab",
} as const;

export const MINAR_TOPICS = {
  TokenMinted: "0xdb46291eeab68fcfa6a0570a911e537b015a3d512c427d17f9343e4edbf1838f",
  TokenBurned: "0x17578694434a68c8a307780ffcc2e7e69ebb61cb954ab23a8e9b0383b937a37d",
  MintingAdminStatus: "0xac21ac7706a1a42078d5e0f77b24b27808133ae5616daba665fb793a7eb3cc5b",
  MinarUpgraded: "0x5eefffe1eb9cc71568cf8cd37d4a6dd8dd6f3c73d5019745b03ec3f7657976a2",
} as const;

/**
 * A forced transfer emits an ordinary ERC-20 `Transfer` event, so events alone
 * cannot distinguish it from a voluntary one. The transaction input selector
 * is the only reliable signal.
 */
export function isForcedTransfer(input: string): boolean {
  if (!input || input.length < 10) return false;
  return input.slice(0, 10).toLowerCase() === MINAR_SELECTORS.transferAdminTransfer;
}

/** The 32-byte word at `i`, or null when the calldata is too short. */
export function word(hexBody: string, i: number): bigint | null {
  const slice = hexBody.slice(i * 64, (i + 1) * 64);
  if (slice.length !== 64) return null;
  try {
    return BigInt("0x" + slice);
  } catch {
    return null;
  }
}

/** The low 20 bytes of a 32-byte word, as a lowercase address. */
export function wordToAddress(hexBody: string, i: number): string | null {
  const slice = hexBody.slice(i * 64, (i + 1) * 64);
  if (slice.length !== 64) return null;
  return ("0x" + slice.slice(-40)).toLowerCase();
}

export type ForcedTransfer = { from: string; to: string; amount: bigint };

/**
 * `transferAdminTransfer(address from, address to, uint256 amount)`.
 * Returns null unless the calldata is that call and carries all three
 * arguments — never a partially decoded row.
 */
export function decodeForcedTransfer(input: string): ForcedTransfer | null {
  if (!isForcedTransfer(input)) return null;
  const body = input.slice(10);
  const from = wordToAddress(body, 0);
  const to = wordToAddress(body, 1);
  const amount = word(body, 2);
  if (from === null || to === null || amount === null) return null;
  return { from, to, amount };
}

const strip = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);

/** The low 20 bytes of an indexed topic, as a lowercase address. */
export function topicToAddress(topic: string | null | undefined): string | null {
  if (!topic) return null;
  const h = strip(topic);
  return h.length >= 40 ? ("0x" + h.slice(-40)).toLowerCase() : null;
}

/**
 * A dynamic `string` at head word `headIndex`. Returns null unless the offset,
 * length and bytes are all present and the bytes are printable ASCII — a
 * half-decoded version string is worse than none.
 */
function readString(body: string, headIndex: number): string | null {
  const off = word(body, headIndex);
  if (off === null) return null;
  const at = Number(off) * 2;
  if (!Number.isSafeInteger(at) || at < 0) return null;

  const len = word(body.slice(at), 0);
  if (len === null || len === 0n || len > 256n) return null;

  const raw = body.slice(at + 64, at + 64 + Number(len) * 2);
  if (raw.length !== Number(len) * 2) return null;

  let s = "";
  for (let i = 0; i < raw.length; i += 2) {
    const c = Number.parseInt(raw.slice(i, i + 2), 16);
    if (!Number.isInteger(c) || c < 0x20 || c > 0x7e) return null;
    s += String.fromCharCode(c);
  }
  return s;
}

export type Upgraded = { implementation: string | null; version: string | null };

/**
 * `MinarUpgraded`. The implementation may be indexed or not depending on the
 * deployed event definition, so both layouts are tried rather than assumed.
 */
export function decodeUpgraded(topics: string[], data: string): Upgraded {
  const body = strip(data);
  const indexed = topics.length > 1;
  return {
    implementation: indexed ? topicToAddress(topics[1]) : wordToAddress(body, 0),
    version: readString(body, indexed ? 0 : 1),
  };
}

export type AdminStatus = { admin: string | null; granted: boolean | null };

/** `MintingAdminStatus`: the admin address and whether it was granted or revoked. */
export function decodeAdminStatus(topics: string[], data: string): AdminStatus {
  const body = strip(data);
  const indexed = topics.length > 1;
  const flag = word(body, indexed ? 0 : 1);
  return {
    admin: indexed ? topicToAddress(topics[1]) : wordToAddress(body, 0),
    granted: flag === null ? null : flag !== 0n,
  };
}

export type MintBurn = { amount: bigint; isOperator: boolean | null };

/**
 * `TokenMinted` / `TokenBurned` carry `amount` in data word 0 and the
 * `isOperator` flag in word 1.
 */
export function decodeMintBurn(data: string): MintBurn | null {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  const amount = word(body, 0);
  if (amount === null) return null;
  const flag = word(body, 1);
  return { amount, isOperator: flag === null ? null : flag !== 0n };
}
