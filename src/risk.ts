/**
 * risk.ts - the deterministic half of every decision.
 *
 * The judge proposes. These rules dispose. Nothing here calls a model or the
 * network: given the recorded evidence, the recorded ruling, the recorded
 * balances and the recorded open position, applyRules() returns the same
 * action and size every time. verify.ts replays it on every receipt.
 *
 * Every limit below is part of policyDocument(), whose sha256 is committed on
 * chain as the agent's policy_hash. Loosen a limit and the agent has to call
 * update_policy, which the on-chain head records forever.
 *
 * Entry, size and exit are one decision: a trade that opens a position carries
 * its stop, target and horizon, and later cycles close it by rule when Pyth
 * crosses one of them. No model is consulted while a position is open.
 */
import type { ActionName } from "./program.js";
import type { Ruling } from "./debate.js";
import type { Json } from "./canonical.js";

export const LIMITS = {
  pyth_max_age_s: 900,
  pyth_max_conf_bps: 100,
  max_source_divergence_bps: 150,
  min_conviction_to_trade: 60,
  min_decisive_citations: 2,
  max_usdc_in_units: 1_000_000n, // 1.00 devUSDC per BUY
  min_usdc_in_units: 100_000n, // 0.10 devUSDC
  max_sol_in_lamports: 50_000_000n, // 0.05 SOL per SELL
  min_sol_in_lamports: 5_000_000n, // 0.005 SOL
  sol_reserve_lamports: 100_000_000n, // 0.10 SOL kept back for fees, never traded
  stop_loss_bps_range: [50, 1000] as [number, number],
  take_profit_bps_range: [50, 2000] as [number, number],
  horizon_minutes_range: [30, 1440] as [number, number],
};

export type EvidenceView = {
  ids: string[];
  pythPriceE8: bigint; // Pyth price scaled to 1e-8 USD
  pythAgeS: number;
  pythConfBps: number;
  /** other sources' USD prices as 1e-8 integers, by evidence id */
  crossPricesE8: { [id: string]: bigint };
};

export type Position = {
  side: "LONG" | "SHORT"; // LONG = bought SOL, SHORT = sold SOL out of inventory
  opened_seq: string;
  entry_price_e8: string;
  stop_loss_bps: number;
  take_profit_bps: number;
  opened_at: number; // unix seconds
  horizon_minutes: number;
  /** what the exit trade spends: lamports for a LONG exit, devUSDC units for a SHORT exit */
  exit_input_amount: string;
};

export type Inventory = { lamports: bigint; usdcUnits: bigint };

export type RuleCheck = { rule: string; pass: boolean; detail: string };

export type Outcome = {
  action: ActionName;
  inputAmount: bigint;
  kind: "ENTRY" | "EXIT" | "HOLD";
  reason: string;
  trace: RuleCheck[];
  /** set when this trade opens a position */
  opens?: Omit<Position, "opened_seq" | "exit_input_amount">;
  /** set when this trade closes one */
  closes?: { opened_seq: string; trigger: string; entry_price_e8: string; exit_price_e8: string; move_bps: number };
};

export function policyDocument(promptsSha256: string, model: string): { [k: string]: Json } {
  const out: { [k: string]: Json } = { model, prompts_sha256: promptsSha256, rules_file: "src/risk.ts" };
  for (const [k, v] of Object.entries(LIMITS)) out[k] = Array.isArray(v) ? v.map(Number) : typeof v === "bigint" ? v.toString() : v;
  return out;
}

function clampInt(v: number, [lo, hi]: [number, number]): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
function minB(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
function absB(a: bigint): bigint {
  return a < 0n ? -a : a;
}
function hold(reason: string, trace: RuleCheck[]): Outcome {
  return { action: "HOLD", inputAmount: 0n, kind: "HOLD", reason, trace };
}
function moveBps(from: bigint, to: bigint): number {
  return Number(((to - from) * 10_000n) / from);
}

/** While a position is open: close it if stop, target or horizon is hit, otherwise hold. */
export function checkExit(pos: Position, ev: EvidenceView, inv: Inventory, nowS: number): Outcome {
  const trace: RuleCheck[] = [];
  const entry = BigInt(pos.entry_price_e8);
  const fresh = ev.pythAgeS <= LIMITS.pyth_max_age_s;
  trace.push({ rule: "exit.pyth_fresh", pass: fresh, detail: `Pyth age ${ev.pythAgeS}s, limit ${LIMITS.pyth_max_age_s}s` });
  const mv = moveBps(entry, ev.pythPriceE8);
  const pnlBps = pos.side === "LONG" ? mv : -mv;
  const expired = nowS >= pos.opened_at + pos.horizon_minutes * 60;
  let trigger = "";
  if (fresh && pnlBps <= -pos.stop_loss_bps) trigger = "STOP_LOSS";
  else if (fresh && pnlBps >= pos.take_profit_bps) trigger = "TAKE_PROFIT";
  else if (expired) trigger = "HORIZON";
  trace.push({
    rule: "exit.trigger",
    pass: trigger !== "",
    detail: `${pos.side} from #${pos.opened_seq}: market moved ${mv} bps (position ${pnlBps} bps), stop -${pos.stop_loss_bps}, target +${pos.take_profit_bps}, horizon ${expired ? "passed" : "not reached"}`,
  });
  if (!trigger) return hold(`position from #${pos.opened_seq} open at ${pnlBps} bps; no exit condition met`, trace);

  const want = BigInt(pos.exit_input_amount);
  const action: ActionName = pos.side === "LONG" ? "SELL" : "BUY";
  const have = action === "SELL" ? (inv.lamports > LIMITS.sol_reserve_lamports ? inv.lamports - LIMITS.sol_reserve_lamports : 0n) : inv.usdcUnits;
  const amount = minB(want, have);
  const floor = action === "SELL" ? LIMITS.min_sol_in_lamports : LIMITS.min_usdc_in_units;
  trace.push({ rule: "exit.funded", pass: amount >= floor, detail: `exit wants ${want}, available ${have}, minimum ${floor}` });
  const closes = { opened_seq: pos.opened_seq, trigger, entry_price_e8: pos.entry_price_e8, exit_price_e8: ev.pythPriceE8.toString(), move_bps: pnlBps };
  if (amount < floor) return { ...hold(`${trigger} on #${pos.opened_seq} but balance too small to exit; position written off`, trace), closes };
  return { action, inputAmount: amount, kind: "EXIT", reason: `${trigger}: close ${pos.side} from #${pos.opened_seq} at ${pnlBps} bps`, trace, closes };
}

/** No open position: turn the judge's ruling into an entry, or a HOLD, by fixed rules. */
export function applyRules(r: Ruling, ev: EvidenceView, inv: Inventory): Outcome {
  const trace: RuleCheck[] = [];
  const check = (rule: string, pass: boolean, detail: string) => (trace.push({ rule, pass, detail }), pass);

  if (!check("evidence.pyth_fresh", ev.pythAgeS <= LIMITS.pyth_max_age_s, `Pyth age ${ev.pythAgeS}s, limit ${LIMITS.pyth_max_age_s}s`))
    return hold("market price is stale; refusing to trade on it", trace);
  if (!check("evidence.pyth_tight", ev.pythConfBps <= LIMITS.pyth_max_conf_bps, `Pyth confidence ${ev.pythConfBps} bps, limit ${LIMITS.pyth_max_conf_bps}`))
    return hold("market price too uncertain", trace);

  const crosses = Object.entries(ev.crossPricesE8);
  let worst = 0;
  for (const [, p] of crosses) worst = Math.max(worst, Number((absB(p - ev.pythPriceE8) * 10_000n) / ev.pythPriceE8));
  const crossDetail = crosses.length ? crosses.map(([id, p]) => `${id} ${moveBps(ev.pythPriceE8, p)} bps vs PYTH`).join(", ") : "no second price source in pack";
  if (!check("evidence.sources_agree", crosses.length > 0 && worst <= LIMITS.max_source_divergence_bps, `${crossDetail}; limit ${LIMITS.max_source_divergence_bps} bps`))
    return hold(crosses.length ? "price sources disagree; evidence is not trustworthy" : "only one price source; cannot cross-check", trace);

  const known = new Set(ev.ids);
  const cited = [...new Set(r.decisive_evidence_ids ?? [])];
  const unknown = cited.filter((id) => !known.has(id));
  if (!check("ruling.citations_valid", unknown.length === 0 && cited.length >= LIMITS.min_decisive_citations, `cited [${cited.join(", ")}]; unknown [${unknown.join(", ")}]; need ${LIMITS.min_decisive_citations}+`))
    return hold("judge's ruling is not grounded in the evidence pack", trace);

  const coherent = (r.verdict === "BUY" && r.winner === "BULL") || (r.verdict === "SELL" && r.winner === "BEAR") || (r.verdict === "HOLD");
  if (!check("ruling.coherent", coherent, `winner ${r.winner}, verdict ${r.verdict}`)) return hold("ruling contradicts itself", trace);
  if (r.verdict === "HOLD") {
    check("ruling.verdict", false, "judge ruled HOLD");
    return hold(`judge ruled HOLD (conviction ${r.conviction})`, trace);
  }
  if (!check("ruling.conviction", r.conviction >= LIMITS.min_conviction_to_trade, `conviction ${r.conviction}, minimum ${LIMITS.min_conviction_to_trade}`))
    return hold(`judge ruled ${r.verdict} but conviction ${r.conviction} is below ${LIMITS.min_conviction_to_trade}`, trace);

  const sl = clampInt(r.stop_loss_bps, LIMITS.stop_loss_bps_range);
  const tp = clampInt(r.take_profit_bps, LIMITS.take_profit_bps_range);
  const hz = clampInt(r.horizon_minutes, LIMITS.horizon_minutes_range);
  check("ruling.exit_plan", true, `stop ${sl} bps, target ${tp} bps, horizon ${hz} min (judge asked ${r.stop_loss_bps}/${r.take_profit_bps}/${r.horizon_minutes}, clamped to policy)`);

  // size = max * size_pct * conviction, both as percentages, floored at the minimum ticket
  const pct = BigInt(Math.max(0, Math.min(100, Math.round(r.size_pct_of_max))));
  const conv = BigInt(Math.max(0, Math.min(100, Math.round(r.conviction))));
  const isBuy = r.verdict === "BUY";
  const max = isBuy ? LIMITS.max_usdc_in_units : LIMITS.max_sol_in_lamports;
  const min = isBuy ? LIMITS.min_usdc_in_units : LIMITS.min_sol_in_lamports;
  let size = (max * pct * conv) / 10_000n;
  if (size < min) size = min;
  const have = isBuy ? inv.usdcUnits : inv.lamports > LIMITS.sol_reserve_lamports ? inv.lamports - LIMITS.sol_reserve_lamports : 0n;
  size = minB(size, have);
  const unit = isBuy ? "devUSDC units" : "lamports";
  if (!check("risk.funded", size >= min, `size ${size} ${unit} (max ${max} x ${pct}% x conviction ${conv}%), available ${have}, minimum ${min}`))
    return hold(`judge ruled ${r.verdict} but the desk cannot fund the minimum ticket`, trace);

  return {
    action: r.verdict,
    inputAmount: size,
    kind: "ENTRY",
    reason: `${r.winner} won: ${r.verdict} ${size} ${unit} at conviction ${r.conviction}, stop ${sl} bps, target ${tp} bps, ${hz} min`,
    trace,
    opens: { side: isBuy ? "LONG" : "SHORT", entry_price_e8: ev.pythPriceE8.toString(), stop_loss_bps: sl, take_profit_bps: tp, opened_at: 0, horizon_minutes: hz },
  };
}
