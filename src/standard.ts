import { blake2AsHex, blake2AsU8a } from "@polkadot/util-crypto";
import { encodeAddress, decodeAddress } from "@polkadot/util-crypto";
import { u8aToHex, hexToU8a } from "@polkadot/util";

/**
 * NKRI08 — the fungible token standard on Nagara.
 *
 * Defined as an **interface**, not as a binary: any contract whose messages carry
 * these names conforms, whoever deployed it. That works because an ink! message
 * selector is `blake2b_256(message_label)[0..4]` — derived from the name alone —
 * so `transfer` is 0x84a15da1 in every contract that spells it that way. The
 * selector sits in the front of `contracts.call` data, which makes it the Nagara
 * analogue of an Ethereum function selector.
 *
 * Names follow PSP22 in snake_case, matching MINAR, which is the reference
 * implementation already live on mainnet.
 */

/** Selector for a message name. Deterministic, no ABI required. */
export function selectorOf(messageName: string): string {
  return blake2AsHex(messageName, 256).slice(0, 10);
}

/** Read-only messages a conforming token must answer. */
export const NKRI08_READS = [
  "name",
  "symbol",
  "total_supply",
  "balance_of",
] as const;

/** State-changing messages a conforming token must expose. */
export const NKRI08_WRITES = [
  "transfer",
  "transfer_from",
  "approve",
  "allowance",
] as const;

/** Optional, but expected of Nusameta's own contracts. */
export const NKRI08_OPTIONAL = ["get_version"] as const;

export const NKRI08_SELECTORS: Record<string, string> = Object.fromEntries(
  [...NKRI08_READS, ...NKRI08_WRITES, ...NKRI08_OPTIONAL].map((name) => [
    name,
    selectorOf(name),
  ])
);

export type StandardTransfer = {
  message: "transfer" | "transfer_from";
  from: string | null;
  to: string;
  amountRaw: string;
};

/**
 * Reads a token transfer out of raw `contracts.call` data without any ABI.
 *
 * ink! encodes message arguments as plain SCALE after the 4-byte selector, so a
 * conforming call has a fixed layout:
 *   transfer(to: AccountId, amount: Balance)              → 4 + 32 + 16 bytes
 *   transfer_from(from, to: AccountId, amount: Balance)   → 4 + 32 + 32 + 16
 * Balance is u128 little-endian and **not** compact-encoded here — that applies
 * to extrinsic call args, not to ink message args.
 *
 * Returns null unless the length matches exactly. A shorter or longer payload
 * means the contract named a message `transfer` with a different signature, and
 * guessing at it would produce a plausible-looking wrong amount.
 */
export function decodeStandardTransfer(
  data: string | Uint8Array,
  ss58Format: number
): StandardTransfer | null {
  const bytes = typeof data === "string" ? hexToU8a(data) : data;
  if (bytes.length < 4) return null;

  const selector = u8aToHex(bytes.subarray(0, 4));
  const body = bytes.subarray(4);

  const readAccount = (offset: number) =>
    encodeAddress(bytes.subarray(4 + offset, 4 + offset + 32), ss58Format);

  const readU128 = (offset: number) => {
    let value = 0n;
    // little-endian
    for (let i = 15; i >= 0; i -= 1) {
      value = (value << 8n) | BigInt(body[offset + i]);
    }
    return value.toString();
  };

  if (selector === NKRI08_SELECTORS.transfer && body.length === 48) {
    return {
      message: "transfer",
      from: null,
      to: readAccount(0),
      amountRaw: readU128(32),
    };
  }

  if (selector === NKRI08_SELECTORS.transfer_from && body.length === 80) {
    return {
      message: "transfer_from",
      from: readAccount(0),
      to: readAccount(32),
      amountRaw: readU128(64),
    };
  }

  return null;
}

/** Builds the same layout, so the decoder can be checked against a known input. */
export function encodeStandardTransfer(
  to: string,
  amountRaw: bigint
): Uint8Array {
  const selector = hexToU8a(NKRI08_SELECTORS.transfer);
  const account = decodeAddress(to);
  const amount = new Uint8Array(16);
  let value = amountRaw;
  for (let i = 0; i < 16; i += 1) {
    amount[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  const out = new Uint8Array(selector.length + account.length + amount.length);
  out.set(selector, 0);
  out.set(account, selector.length);
  out.set(amount, selector.length + account.length);
  return out;
}

/** Kept for callers that want the raw hash helper rather than the hex prefix. */
export const rawSelector = (name: string) => blake2AsU8a(name, 256).subarray(0, 4);
