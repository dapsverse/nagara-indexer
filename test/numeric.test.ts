import { test } from "node:test";
import assert from "node:assert/strict";
import { toNumeric, fromNumeric } from "../src/evm/numeric.js";

test("uint256 max survives a round trip through NUMERIC(78,0)", () => {
  const max = 2n ** 256n - 1n;
  assert.equal(fromNumeric(toNumeric(max)), max);
});

test("zero and one round trip", () => {
  for (const v of [0n, 1n]) assert.equal(fromNumeric(toNumeric(v)), v);
});

test("a value above 2^63 is not truncated", () => {
  const v = 2n ** 64n + 12345n;
  assert.equal(fromNumeric(toNumeric(v)), v);
});

test("fromNumeric(null) is zero", () => {
  assert.equal(fromNumeric(null), 0n);
});
