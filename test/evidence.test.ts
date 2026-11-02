import { test } from "node:test";
import assert from "node:assert/strict";
import { ascii, withRetry } from "../src/evidence.js";
import { evidenceView } from "../src/desk.js";

test("ascii folds typography and strips what receipts cannot hold", () => {
  assert.equal(ascii("\u201CSOL\u201D \u2018up\u2019 \u2013 now\u2026"), "\"SOL\" 'up' - now...");
  assert.equal(ascii("  a b \n\t c  "), "a b c");
  assert.equal(ascii("café"), "cafe");
  assert.equal(ascii("\u{1F680} moon"), "moon");
  assert.equal(ascii(""), "");
});

test("withRetry returns the value, and rethrows when tries run out (no network, no sleep)", async () => {
  assert.equal(await withRetry(async () => 7), 7);
  let calls = 0;
  await assert.rejects(() => withRetry(async () => { calls++; throw new Error("boom"); }, 1), /boom/);
  assert.equal(calls, 1);
});

test("evidenceView converts Pyth to e8 and collects cross prices and KOL counts", () => {
  const v = evidenceView([
    { id: "PYTH", data: { exponent: -8, price: "10376836558", age_s: 31, conf_bps: 4 } },
    { id: "CL", data: { price_usd: "104.1984" } },
    { id: "CB", data: { price_usd: "103.74" } },
    { id: "NEWS-1", data: {} },
    { id: "KOL", data: { sol: { bull_voices: 1, bear_voices: 2, converged: "BEAR" } } },
  ]);
  assert.equal(v.pythPriceE8, 10376836558n);
  assert.equal(v.pythAgeS, 31);
  assert.equal(v.pythConfBps, 4);
  assert.deepEqual(v.crossPricesE8, { CL: 10419840000n, CB: 10374000000n });
  assert.deepEqual(v.ids, ["PYTH", "CL", "CB", "NEWS-1", "KOL"]);
  assert.deepEqual(v.kol, { bullVoices: 1, bearVoices: 2 });
});

test("evidenceView rescales other Pyth exponents to e8 and omits KOL when absent", () => {
  const v = evidenceView([{ id: "PYTH", data: { exponent: -6, price: "103713000", age_s: 1, conf_bps: 1 } }]);
  assert.equal(v.pythPriceE8, 10371300000n);
  assert.equal(v.kol, undefined);
});
