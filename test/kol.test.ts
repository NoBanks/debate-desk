import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSignals, classify, convergence, kolData, parseChannelPage, recheckKol, solSummary, type Signal } from "../src/kol.js";
import { LIMITS, applyRules, type EvidenceView } from "../src/risk.js";
import type { Ruling } from "../src/debate.js";
import { canonicalBytes, type Json } from "../src/canonical.js";

test("classify: a bullish SOL headline with a big move and urgency", () => {
  const c = classify("BREAKING: Solana surges 8% as ETF inflows hit a record high");
  assert.deepEqual(c.tokens, ["SOL"]);
  assert.equal(c.stance, "BULL");
  assert.equal(c.urgency, "HIGH");
  assert.ok(c.matched.includes("+surge") && c.matched.includes("+inflow") && c.matched.includes("+all-time high"));
  assert.equal(c.conviction, 100); // 40 + 15*2 + 15 (8% move) + 15 (urgent), capped
});

test("classify: bearish, and lower-case 'sol' is not SOL", () => {
  const c = classify("$BTC plunges after exchange hack; el sol sale");
  assert.deepEqual(c.tokens, ["BTC"]);
  assert.equal(c.stance, "BEAR");
  assert.equal(c.urgency, "NORMAL");
});

test("classify: 'drops a case' is not a price drop; 'dropped 22%' is", () => {
  assert.equal(classify("Argentina drops the $LIBRA case").stance, "NEUTRAL");
  assert.equal(classify("$HYPE has dropped 22% from its peak").stance, "BEAR");
  assert.deepEqual(classify("706 $BTC transferred from #OKEX to unknown wallet").tokens, ["BTC"]);
  assert.equal(classify("706 $BTC transferred from #OKEX to unknown wallet").stance, "BULL");
});

test("classify: whale moves read as flows, mixed words net out to NEUTRAL", () => {
  assert.equal(classify("50,000 #SOL transferred from unknown wallet to #Binance").stance, "BEAR");
  assert.equal(classify("50,000 #SOL transferred from #Coinbase to unknown new wallet").stance, "BULL");
  assert.equal(classify("SOL gains then dumps").stance, "NEUTRAL");
  assert.equal(classify("SOL gains then dumps").conviction, 0);
});

const sig = (voice: string, quote: string, posted_at = "2026-10-24T10:00:00Z"): Signal => ({ voice, post: `https://t.me/${voice}/1`, posted_at, quote, ...classify(quote) });

test("convergence needs 2+ distinct voices; one loud voice is not a narrative", () => {
  const one = [sig("a", "Solana rallies"), sig("a", "SOL jumps 3%")];
  assert.deepEqual(convergence(one), []);
  const two = [...one, sig("b", "Solana surges")];
  assert.deepEqual(convergence(two), [{ token: "SOL", stance: "BULL", voices: ["a", "b"], n: 2 }]);
  assert.deepEqual(solSummary(two), { bull_voices: 2, bear_voices: 0, converged: "BULL" });
});

test("a voice's net stance counts once per token", () => {
  const s = [sig("a", "Solana rallies"), sig("a", "Solana plunges"), sig("a", "Solana crashes"), sig("b", "SOL dumps")];
  assert.deepEqual(solSummary(s), { bull_voices: 0, bear_voices: 2, converged: "BEAR" });
});

const PAGE = `<div data-post="whale_alert_io/7" x><div class="tgme_widget_message_text js-message_text" dir="auto"><i class="emoji"><b>X</b></i> 50,000 <a>#SOL</a> transferred from unknown wallet to <a>#Binance</a></div>
<a class="tgme_widget_message_date"><time datetime="2026-10-24T09:00:00+00:00" class="time">09:00</time></a></div>
<div data-post="whale_alert_io/8" x><div class="tgme_widget_message_text js-message_text" dir="auto">Weather is nice &amp; calm</div><time datetime="2026-10-24T09:30:00+00:00"></time></div>
<div data-post="whale_alert_io/9" x><div class="tgme_widget_message_text js-message_text" dir="auto">old: Solana pumps</div><time datetime="2026-10-22T09:30:00+00:00"></time></div>`;

test("parse a t.me/s page and keep only token-naming posts inside the window", () => {
  const posts = parseChannelPage("whale_alert_io", PAGE);
  assert.equal(posts.length, 3);
  assert.equal(posts[1].quote, "Weather is nice & calm");
  const signals = buildSignals(posts, ["whale_alert_io"], Date.parse("2026-10-24T12:00:00Z"));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].post, "https://t.me/whale_alert_io/7");
  assert.equal(signals[0].stance, "BEAR");
});

test("verify re-derives every signal; editing a stance or a quote is caught", () => {
  const signals = [sig("a", "Solana rallies"), sig("b", "SOL surges 6%")];
  // round-trip through canonical bytes, as the saved evidence file does
  const data = JSON.parse(canonicalBytes(kolData([], signals) as Json).toString("utf8"));
  assert.deepEqual(recheckKol(data, "2026-10-24T12:00:00Z"), []);
  const forged = JSON.parse(JSON.stringify(data));
  forged.signals[0].stance = "BEAR";
  assert.ok(recheckKol(forged, "2026-10-24T12:00:00Z").length > 0);
  const edited = JSON.parse(JSON.stringify(data));
  edited.signals[1].quote = "SOL crashes 6%";
  assert.ok(recheckKol(edited, "2026-10-24T12:00:00Z").length > 0);
  assert.ok(recheckKol(data, "2026-10-26T12:00:00Z").length > 0, "stale signals fail the window check");
});

// ---- the bounded rule in risk.ts
const ev = (kol?: EvidenceView["kol"]): EvidenceView => ({
  ids: ["PYTH", "CG", "KOL"], pythPriceE8: 10_000_000_000n, pythAgeS: 60, pythConfBps: 5, crossPricesE8: { CG: 10_010_000_000n }, ...(kol ? { kol } : {}),
});
const inv = { lamports: 1_000_000_000n, usdcUnits: 2_000_000n };
const buy: Ruling = {
  winner: "BULL", verdict: "BUY", conviction: 80, rationale: "x", decisive_evidence_ids: ["PYTH", "KOL"], rejected_points: [],
  size_pct_of_max: 50, stop_loss_bps: 200, take_profit_bps: 300, horizon_minutes: 120,
};
const full = (LIMITS.max_usdc_in_units * 50n * 80n) / 10_000n;

test("KOL converging against a BUY cuts the size; the trade still happens", () => {
  const o = applyRules(buy, ev({ bullVoices: 0, bearVoices: 2 }), inv);
  assert.equal(o.action, "BUY");
  assert.equal(o.inputAmount, (full * BigInt(LIMITS.kol_counter_size_pct)) / 100n);
  assert.equal(o.trace.find((c) => c.rule === "kol.no_counter_narrative")?.pass, false);
});

test("KOL agreeing with the verdict never adds size", () => {
  const o = applyRules(buy, ev({ bullVoices: 8, bearVoices: 0 }), inv);
  assert.equal(o.inputAmount, full);
  assert.equal(o.trace.find((c) => c.rule === "kol.no_counter_narrative")?.pass, true);
});

test("no KOL item: no KOL rule in the trace, so pre-KOL receipts replay unchanged", () => {
  const o = applyRules(buy, ev(), inv);
  assert.equal(o.inputAmount, full);
  assert.ok(!o.trace.some((c) => c.rule.startsWith("kol.")));
});
