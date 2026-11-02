import { test } from "node:test";
import assert from "node:assert/strict";
import { confBps, deviationBps, type PythPrice } from "../src/pyth.js";

const p = (over: Partial<PythPrice>): PythPrice => ({
  account: "A", feedId: "f", verification: "full", price: 10_000_000_000n, conf: 0n, exponent: -8,
  publishTime: 0, emaPrice: 10_000_000_000n, emaConf: 0n, postedSlot: 0n, contextSlot: 0n, accountSha256: "", ...over,
});

test("deviationBps: spot vs EMA in basis points, truncating toward zero", () => {
  assert.equal(deviationBps(p({})), 0);
  assert.equal(deviationBps(p({ price: 10_100_000_000n })), 100);
  assert.equal(deviationBps(p({ price: 9_900_000_000n })), -100);
  assert.equal(deviationBps(p({ price: 10_000_099_999n })), 0);
});

test("confBps: confidence interval as bps of price, never negative", () => {
  assert.equal(confBps(p({ conf: 5_000_000n })), 5);
  assert.equal(confBps(p({ conf: 5_000_000n, price: -10_000_000_000n })), 5);
});
