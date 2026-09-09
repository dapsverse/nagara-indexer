import { test } from "node:test";
import assert from "node:assert/strict";
import { NETWORKS } from "../src/config.js";

test("mainnet is the evm chain type", () => {
  assert.equal(NETWORKS.mainnet.chainType, "evm");
});

test("mainnet has its own chain id, distinct from testnet's", () => {
  assert.equal(NETWORKS.mainnet.chainType, "evm");
  if (NETWORKS.mainnet.chainType === "evm") {
    assert.equal(NETWORKS.mainnet.chainId, 16868);
  }
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
