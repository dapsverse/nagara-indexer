import { test } from "node:test";
import assert from "node:assert/strict";
import { readNetwork } from "../src/server.js";

test("network param matches regardless of case", () => {
  assert.equal(readNetwork(new URLSearchParams("network=testnet")), "testnet");
  assert.equal(readNetwork(new URLSearchParams("network=Testnet")), "testnet");
  assert.equal(readNetwork(new URLSearchParams("network=TESTNET")), "testnet");
  assert.equal(readNetwork(new URLSearchParams("network=Mainnet")), "mainnet");
});

test("an unknown network falls back to mainnet", () => {
  assert.equal(readNetwork(new URLSearchParams("network=nope")), "mainnet");
  assert.equal(readNetwork(new URLSearchParams()), "mainnet");
});
