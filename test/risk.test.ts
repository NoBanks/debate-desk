import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, applyRules, checkExit, type EvidenceView, type Position } from "../src/risk.js";
import type { Ruling } from "../src/debate.js";

const ev = (over: Partial<EvidenceView> = {}): EvidenceView => ({
  ids: ["PYTH", "CG", "NEWS-1"],
  pythPriceE8: 10_000_000_000n, // $100
  pythAgeS: 60,
  pythConfBps: 5,
  crossPricesE8: { CG: 10_010_000_000n }, // 10 bps away
  ...over,
});
const inv = { lamports: 1_000_000_000n, usdcUnits: 2_000_000n };
const ruling = (over: Partial<Ruling> = {}): Ruling => ({
  winner: "BULL",
  verdict: "BUY",
  conviction: 80,
  rationale: "x",
  decisive_evidence_ids: ["PYTH", "CG"],
  rejected_points: [],
  size_pct_of_max: 50,
  stop_loss_bps: 200,
  take_profit_bps: 300,
  horizon_minutes: 120,
  ...over,
});

test("a grounded, confident BUY becomes a sized entry with its exit plan", () => {
  const o = applyRules(ruling(), ev(), inv);
  assert.equal(o.action, "BUY");
  assert.equal(o.kind, "ENTRY");
  assert.equal(o.inputAmount, (LIMITS.max_usdc_in_units * 50n * 80n) / 10_000n);
  assert.equal(o.opens?.side, "LONG");
  assert.equal(o.opens?.stop_loss_bps, 200);
  assert.ok(o.trace.every((c) => c.pass));
});

test("same inputs always give the same outcome (replayable)", () => {
  assert.deepEqual(applyRules(ruling(), ev(), inv), applyRules(ruling(), ev(), inv));
});

test("low conviction holds", () => {
  const o = applyRules(ruling({ conviction: 59 }), ev(), inv);
  assert.equal(o.action, "HOLD");
  assert.equal(o.trace.at(-1)?.rule, "ruling.conviction");
});

test("citing evidence that is not in the pack holds", () => {
  const o = applyRules(ruling({ decisive_evidence_ids: ["PYTH", "TWITTER"] }), ev(), inv);
  assert.equal(o.action, "HOLD");
  assert.equal(o.trace.at(-1)?.rule, "ruling.citations_valid");
});

test("a ruling that contradicts itself holds", () => {
  const o = applyRules(ruling({ winner: "BEAR", verdict: "BUY" }), ev(), inv);
  assert.equal(o.action, "HOLD");
  assert.equal(o.trace.at(-1)?.rule, "ruling.coherent");
});

test("price sources that disagree hold, whatever the judge says", () => {
  const o = applyRules(ruling(), ev({ crossPricesE8: { CG: 10_300_000_000n } }), inv);
  assert.equal(o.action, "HOLD");
  assert.equal(o.trace.at(-1)?.rule, "evidence.sources_agree");
});

test("a stale price holds", () => {
  const o = applyRules(ruling(), ev({ pythAgeS: LIMITS.pyth_max_age_s + 1 }), inv);
  assert.equal(o.action, "HOLD");
});

test("judge's exit plan is clamped to policy", () => {
  const o = applyRules(ruling({ stop_loss_bps: 5, take_profit_bps: 99_999, horizon_minutes: 1 }), ev(), inv);
  assert.equal(o.opens?.stop_loss_bps, LIMITS.stop_loss_bps_range[0]);
  assert.equal(o.opens?.take_profit_bps, LIMITS.take_profit_bps_range[1]);
  assert.equal(o.opens?.horizon_minutes, LIMITS.horizon_minutes_range[0]);
});

test("SELL never touches the SOL reserve", () => {
  const o = applyRules(ruling({ winner: "BEAR", verdict: "SELL", size_pct_of_max: 100, conviction: 100 }), ev(), { lamports: LIMITS.sol_reserve_lamports + 1_000n, usdcUnits: 0n });
  assert.equal(o.action, "HOLD");
  assert.equal(o.trace.at(-1)?.rule, "risk.funded");
});

const long: Position = {
  side: "LONG", opened_seq: "3", entry_price_e8: "10000000000", stop_loss_bps: 200, take_profit_bps: 300,
  opened_at: 1_000_000, horizon_minutes: 60, exit_input_amount: "20000000",
};

test("open LONG: stop loss closes it with a SELL of what the entry bought", () => {
  const o = checkExit(long, ev({ pythPriceE8: 9_790_000_000n }), inv, 1_000_100);
  assert.equal(o.action, "SELL");
  assert.equal(o.kind, "EXIT");
  assert.equal(o.inputAmount, 20_000_000n);
  assert.equal(o.closes?.trigger, "STOP_LOSS");
  assert.equal(o.closes?.move_bps, -210);
});

test("open LONG: take profit", () => {
  const o = checkExit(long, ev({ pythPriceE8: 10_300_000_000n }), inv, 1_000_100);
  assert.equal(o.closes?.trigger, "TAKE_PROFIT");
});

test("open LONG: inside the band holds without asking any model", () => {
  const o = checkExit(long, ev({ pythPriceE8: 10_050_000_000n }), inv, 1_000_100);
  assert.equal(o.action, "HOLD");
  assert.equal(o.closes, undefined);
});

test("open LONG: horizon closes it", () => {
  const o = checkExit(long, ev(), inv, 1_000_000 + 3600);
  assert.equal(o.closes?.trigger, "HORIZON");
});

test("open SHORT: price up past stop buys back", () => {
  const short: Position = { ...long, side: "SHORT", exit_input_amount: "500000" };
  const o = checkExit(short, ev({ pythPriceE8: 10_250_000_000n }), inv, 1_000_100);
  assert.equal(o.action, "BUY");
  assert.equal(o.closes?.trigger, "STOP_LOSS");
});
