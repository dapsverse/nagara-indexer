import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeForcedTransfer,
  decodeUpgraded,
  isForcedTransfer,
  MINAR_SELECTORS,
  MINAR_TOPICS,
} from "../src/evm/minar.js";

test("the transferAdminTransfer selector is correct", () => {
  assert.equal(MINAR_SELECTORS.transferAdminTransfer, "0xd8af5545");
});

test("input calling transferAdminTransfer is a forced transfer", () => {
  const input = "0xd8af5545" + "00".repeat(96);
  assert.equal(isForcedTransfer(input), true);
});

test("an ordinary ERC-20 transfer is not a forced transfer", () => {
  // transfer(address,uint256)
  assert.equal(isForcedTransfer("0xa9059cbb" + "00".repeat(64)), false);
});

test("mintToken is not a forced transfer", () => {
  assert.equal(isForcedTransfer("0xbd89d13e" + "00".repeat(96)), false);
});

test("empty and short input are not forced transfers", () => {
  assert.equal(isForcedTransfer("0x"), false);
  assert.equal(isForcedTransfer("0xd8af55"), false);
  assert.equal(isForcedTransfer(""), false);
});

test("the selector match is case-insensitive", () => {
  assert.equal(isForcedTransfer("0xD8AF5545" + "00".repeat(96)), true);
});

test("MINAR event topics are correct", () => {
  assert.equal(
    MINAR_TOPICS.TokenMinted,
    "0xdb46291eeab68fcfa6a0570a911e537b015a3d512c427d17f9343e4edbf1838f",
  );
  assert.equal(
    MINAR_TOPICS.TokenBurned,
    "0x17578694434a68c8a307780ffcc2e7e69ebb61cb954ab23a8e9b0383b937a37d",
  );
  assert.equal(
    MINAR_TOPICS.MintingAdminStatus,
    "0xac21ac7706a1a42078d5e0f77b24b27808133ae5616daba665fb793a7eb3cc5b",
  );
  assert.equal(
    MINAR_TOPICS.MinarUpgraded,
    "0x5eefffe1eb9cc71568cf8cd37d4a6dd8dd6f3c73d5019745b03ec3f7657976a2",
  );
});

test("decodeForcedTransfer reads from, to and amount from the calldata", () => {
  const pad = (h: string) => h.slice(2).padStart(64, "0");
  const from = "0x" + "11".repeat(20);
  const to = "0x" + "22".repeat(20);
  const input =
    "0xd8af5545" + pad(from) + pad(to) + (1234n).toString(16).padStart(64, "0");

  assert.deepEqual(decodeForcedTransfer(input), { from, to, amount: 1234n });
});

test("decodeForcedTransfer returns null for truncated calldata", () => {
  assert.equal(decodeForcedTransfer("0xd8af5545" + "00".repeat(10)), null);
});

test("decodeUpgraded reads an indexed implementation and its version string", () => {
  const impl = "0x" + "33".repeat(20);
  const version = "v1.2.0";
  const body =
    (32n).toString(16).padStart(64, "0") +
    BigInt(version.length).toString(16).padStart(64, "0") +
    Buffer.from(version, "ascii").toString("hex").padEnd(64, "0");

  assert.deepEqual(
    decodeUpgraded([MINAR_TOPICS.MinarUpgraded, "0x" + impl.slice(2).padStart(64, "0")], "0x" + body),
    { implementation: impl, version },
  );
});

test("decodeUpgraded refuses a version string that is not printable", () => {
  const body =
    (32n).toString(16).padStart(64, "0") +
    (4n).toString(16).padStart(64, "0") +
    "deadbeef".padEnd(64, "0");
  assert.equal(decodeUpgraded(["0x00", "0x" + "0".repeat(64)], "0x" + body).version, null);
});
