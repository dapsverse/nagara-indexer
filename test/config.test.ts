import { test } from "node:test";
import assert from "node:assert/strict";
import { NETWORKS } from "../src/config.js";

test("mainnet is still the substrate chain type", () => {
  assert.equal(NETWORKS.mainnet.chainType, "substrate");
});

test("testnet is the evm chain type", () => {
  assert.equal(NETWORKS.testnet.chainType, "evm");
});

test("testnet has a chain id", () => {
  assert.equal(NETWORKS.testnet.chainType, "evm");
  if (NETWORKS.testnet.chainType === "evm") {
    assert.equal(typeof NETWORKS.testnet.chainId, "number");
    assert.ok(NETWORKS.testnet.chainId > 0);
  }
});
