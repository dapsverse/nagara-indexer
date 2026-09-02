import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTransferLog,
  TRANSFER_TOPIC0,
  TRANSFER_SINGLE_TOPIC0,
  TRANSFER_BATCH_TOPIC0,
} from "../src/evm/tokens.js";

const A = "0x" + "11".repeat(20);
const B = "0x" + "22".repeat(20);
const pad = (h: string) => "0x" + h.slice(2).padStart(64, "0");
const u256 = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");

test("three topics means ERC-20, value comes from data", () => {
  const out = classifyTransferLog({
    topics: [TRANSFER_TOPIC0, pad(A), pad(B)],
    data: u256(1000n),
  });
  assert.deepEqual(out, [{ standard: "erc20", from: A, to: B, value: 1000n, tokenId: null }]);
});

test("four topics means ERC-721, tokenId comes from topic3", () => {
  const out = classifyTransferLog({
    topics: [TRANSFER_TOPIC0, pad(A), pad(B), u256(7n)],
    data: "0x",
  });
  assert.deepEqual(out, [{ standard: "erc721", from: A, to: B, value: null, tokenId: 7n }]);
});

test("an ERC-721 transfer is never recorded as an ERC-20 value", () => {
  const out = classifyTransferLog({
    topics: [
      TRANSFER_TOPIC0,
      pad(A),
      pad(B),
      u256(115792089237316195423570985008687907853269984665640564039457584007913129639935n),
    ],
    data: "0x",
  });
  assert.equal(out![0].standard, "erc721");
  assert.equal(out![0].value, null);
});

test("TransferSingle is ERC-1155 with id and value", () => {
  const out = classifyTransferLog({
    topics: [TRANSFER_SINGLE_TOPIC0, pad(A), pad(A), pad(B)],
    data: "0x" + u256(5n).slice(2) + u256(9n).slice(2),
  });
  assert.deepEqual(out, [{ standard: "erc1155", from: A, to: B, value: 9n, tokenId: 5n }]);
});

test("a Transfer log with two topics is ignored", () => {
  assert.equal(classifyTransferLog({ topics: [TRANSFER_TOPIC0, pad(A)], data: "0x" }), null);
});

test("an unrelated topic0 is ignored", () => {
  assert.equal(classifyTransferLog({ topics: ["0x" + "de".repeat(32)], data: "0x" }), null);
});

test("an ERC-20 Transfer with truncated data is ignored, not read as zero", () => {
  assert.equal(
    classifyTransferLog({ topics: [TRANSFER_TOPIC0, pad(A), pad(B)], data: "0x" }),
    null,
  );
});

test("TransferBatch expands into one entry per id", () => {
  const w = (n: bigint) => n.toString(16).padStart(64, "0");
  // ids at offset 0x40, values after them at 0xa0; two entries each.
  const data =
    "0x" + w(0x40n) + w(0xa0n) + w(2n) + w(7n) + w(9n) + w(2n) + w(100n) + w(200n);

  const out = classifyTransferLog({
    topics: [TRANSFER_BATCH_TOPIC0, pad(A), pad(A), pad(B)],
    data,
  });

  assert.equal(out?.length, 2);
  assert.deepEqual(out, [
    { standard: "erc1155", from: A, to: B, value: 100n, tokenId: 7n },
    { standard: "erc1155", from: A, to: B, value: 200n, tokenId: 9n },
  ]);
});
