/**
 * site.ts - render the public record to docs/index.html (served by GitHub Pages).
 *
 *   npx tsx src/site.ts
 *
 * Reads only what is committed: data/ledger.jsonl, data/evidence/, data/transcripts/.
 * Every number on the page comes from a receipt whose hash is on chain.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_NAME, CLUSTER, DATA_DIR, PROGRAM_ID, REPO_ROOT, explorerAddress, explorerTx } from "./config.js";
import type { Json } from "./canonical.js";
import { readLedger, type LedgerRow } from "./desk.js";

type Obj = { [k: string]: any };
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const short = (h: string, n = 10) => `${h.slice(0, n)}...`;
const usd = (e8: string | bigint) => (Number(BigInt(e8)) / 1e8).toFixed(2);

function load(rel: string): Obj | null {
  const p = join(DATA_DIR, rel);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function cites(ids: string[]) {
  return ids.map((id) => `<a class="cite" href="#ev-${esc(id)}">${esc(id)}</a>`).join(" ");
}

function sideBlock(role: "BULL" | "BEAR", t: Obj | null) {
  if (!t) return `<div class="side ${role.toLowerCase()}"><h4>${role}</h4><p class="muted">transcript missing</p></div>`;
  const c = t.parsed as Obj;
  return `<div class="side ${role.toLowerCase()}">
    <h4>${role} <span class="conf">confidence ${esc(c.confidence)}</span></h4>
    <p class="thesis">${esc(c.thesis)}</p>
    <ol>${(c.points as Obj[]).map((p) => `<li>${esc(p.claim)} ${cites(p.evidence_ids)}<div class="ce">${esc(p.cause_effect)}</div></li>`).join("")}</ol>
    <p class="muted">Would change my mind: ${esc(c.what_would_change_my_mind)}</p>
  </div>`;
}

function card(row: LedgerRow): string {
  const r = row.receipt as Obj;
  const items = (r.evidence.items as Obj[]).map((ref) => ({ ref, item: load(`evidence/${ref.sha256}.json`) }));
  const deb = r.debate as Obj | null;
  const tr: { [role: string]: Obj | null } = {};
  for (const t of (deb?.transcripts ?? []) as Obj[]) tr[t.role] = load(`transcripts/${t.sha256}.json`);
  const ruling = deb?.ruling as Obj | undefined;
  const swap = r.swap as Obj;
  const evList = items
    .map(({ ref, item }) => {
      const d = item?.data ?? {};
      const label = d.headline ?? (d.price_usd ? `$${d.price_usd}` : "");
      const extra = ref.id === "PYTH" ? ` - EMA $${d.ema_price_usd}, ${d.deviation_from_ema_bps} bps from EMA, ${d.age_s}s old` : ref.id === "CG" ? ` - 1h ${d.change_1h_bps} bps, 24h ${d.change_24h_bps} bps, 7d ${d.change_7d_bps} bps` : ref.id === "CB" ? ` - 24h ${d.change_24h_bps} bps` : ref.id === "KR" ? ` - ${d.price_vs_vwap_bps} bps vs 24h VWAP` : "";
      const href = String(ref.url).startsWith("http") ? ` href="${esc(ref.url)}" target="_blank" rel="noopener"` : "";
      return `<li id="ev-${esc(ref.id)}-${row.seq}"><b>${esc(ref.id)}</b> <a${href}>${esc(label)}</a>${esc(extra)} <code title="${esc(ref.sha256)}">${short(ref.sha256, 8)}</code></li>`;
    })
    .join("");
  const rules = (r.rules as Obj[]).map((c) => `<li class="${c.pass ? "pass" : "fail"}"><span>${c.pass ? "PASS" : "FAIL"}</span> <code>${esc(c.rule)}</code> ${esc(c.detail)}</li>`).join("");
  const judge = ruling
    ? `<div class="judge"><h4>JUDGE <span class="conf">${esc(ruling.winner)} wins - ${esc(ruling.verdict)} at conviction ${esc(ruling.conviction)}</span></h4>
        <p>${esc(ruling.rationale)}</p>
        <p class="muted">Decisive: ${cites(ruling.decisive_evidence_ids)} - stop ${esc(ruling.stop_loss_bps)} bps, target ${esc(ruling.take_profit_bps)} bps, horizon ${esc(ruling.horizon_minutes)} min, size ${esc(ruling.size_pct_of_max)}% of max</p>
        ${(ruling.rejected_points as Obj[]).length ? `<p class="muted">Rejected:</p><ul>${(ruling.rejected_points as Obj[]).map((x) => `<li><b>${esc(x.side)}</b>: ${esc(x.claim)} - ${esc(x.why)}</li>`).join("")}</ul>` : ""}
      </div>`
    : `<div class="judge"><h4>NO DEBATE</h4><p>A position was open, so the exit rules ran alone. No model was asked.</p></div>`;
  const pos = r.position_after as Obj | null;
  const closes = r.closes as Obj | null;
  return `<article class="card" id="r${row.seq}">
  <header>
    <span class="badge ${esc(r.action).toLowerCase()}">${esc(r.action)}</span>
    <span class="kind">${esc(r.kind)}</span>
    <span class="seq">receipt #${esc(row.seq)}</span>
    <time>${esc(r.timestamp)}</time>
    <span class="px">SOL $${usd(r.market_price_e8)}</span>
  </header>
  <p class="reason">${esc(r.reason)}</p>
  <details ${Number(row.seq) === 0 ? "" : ""}><summary>Evidence (${items.length}) - pack <code>${short(r.evidence.pack_hash, 8)}</code></summary><ul class="ev">${evList.replace(/id="ev-([^"]+)-\d+"/g, (_m, id) => `id="ev-${id}-${row.seq}"`)}</ul></details>
  ${deb ? `<div class="debate">${sideBlock("BULL", tr.BULL)}${sideBlock("BEAR", tr.BEAR)}</div>` : ""}
  ${judge}
  <details><summary>Rules (${(r.rules as Obj[]).filter((c) => c.pass).length}/${(r.rules as Obj[]).length} passed)</summary><ul class="rules">${rules}</ul></details>
  <footer>
    ${swap.input_amount ? `<span>swap in ${esc(swap.input_amount)} -> est out ${esc(swap.quote_est_out)} (min ${esc(swap.quote_min_out)})</span>` : ""}
    ${closes ? `<span>closed #${esc(closes.opened_seq)} on ${esc(closes.trigger)} at ${esc(closes.move_bps)} bps</span>` : ""}
    ${pos ? `<span>open ${esc(pos.side)} from #${esc(pos.opened_seq)} at $${usd(pos.entry_price_e8)}</span>` : ""}
    <a href="${explorerTx(row.signature)}" target="_blank" rel="noopener">transaction</a>
    <code title="${esc(row.receipt_hash)}">receipt ${short(row.receipt_hash, 12)}</code>
  </footer>
</article>`.replace(/href="#ev-([^"]+)"/g, (_m, id) => `href="#ev-${id}-${row.seq}"`);
}

function stats(rows: LedgerRow[]) {
  const rs = rows.map((r) => r.receipt as Obj);
  const debates = rs.filter((r) => r.debate).length;
  const entries = rs.filter((r) => r.kind === "ENTRY").length;
  const exits = rs.filter((r) => r.kind === "EXIT").length;
  const closed = rs.filter((r) => r.closes).map((r) => Number(r.closes.move_bps));
  const blocked = rs.filter((r) => r.debate && r.debate.ruling.verdict !== "HOLD" && r.action === "HOLD").length;
  return { receipts: rows.length, debates, entries, exits, blocked, closed: closed.length, net_bps: closed.reduce((a, b) => a + b, 0) };
}

const rows = readLedger();
const s = stats(rows);
const first = rows[0]?.receipt as Obj | undefined;
const desk = first?.agent_address ?? "";
const log = first?.agent_log ?? "";
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Debate Desk</title>
<meta name="description" content="Bull and bear agents argue from the same market evidence, a judge decides, and every practice trade lands on Solana with its reasoning trail committed on chain.">
<style>
:root{--bg:#0d0f12;--fg:#e8e6e1;--mut:#8b8f97;--card:#15181d;--line:#262a31;--bull:#3ecf8e;--bear:#ff6b6b;--hold:#a0a6b0;--acc:#f2c14e}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f6f4ef;--fg:#1b1d21;--mut:#5d636c;--card:#fff;--line:#e3dfd6;--bull:#14864f;--bear:#c0392b;--hold:#6b7280;--acc:#9a6b00}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 80px}
h1{font-size:30px;margin:0 0 4px;letter-spacing:-.02em}h1 span{color:var(--acc)}
.lede{color:var(--mut);max-width:720px;margin:0 0 18px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:18px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.stat b{display:block;font-size:22px}.stat span{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.how{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:14px 0 26px}
.how ol{margin:6px 0 0;padding-left:20px}
code{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--mut);word-break:break-all}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;overflow-x:auto;font:12px ui-monospace,Menlo,Consolas,monospace}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 16px}
.card header{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:13px;color:var(--mut)}
.badge{font-weight:700;color:#000;border-radius:6px;padding:2px 9px;font-size:12px;letter-spacing:.05em}.badge.buy{background:var(--bull)}.badge.sell{background:var(--bear)}.badge.hold{background:var(--hold)}
.px{margin-left:auto;color:var(--fg)}
.reason{font-size:16px;margin:10px 0}
.debate{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}
@media (max-width:720px){.debate{grid-template-columns:1fr}}
.side{border-left:3px solid var(--line);padding:4px 0 4px 12px}.side.bull{border-color:var(--bull)}.side.bear{border-color:var(--bear)}
.side h4,.judge h4{margin:0 0 6px;font-size:13px;letter-spacing:.08em}.conf{color:var(--mut);font-weight:400;letter-spacing:0}
.side ol{padding-left:18px;margin:6px 0}.side li{margin:0 0 6px}.ce{color:var(--mut);font-size:13px}
.thesis{margin:0 0 6px}
.judge{border-left:3px solid var(--acc);padding:4px 0 4px 12px;margin:12px 0}
.cite{font:11px ui-monospace,Menlo,Consolas,monospace;border:1px solid var(--line);border-radius:4px;padding:0 4px;text-decoration:none;color:var(--acc)}
.muted{color:var(--mut);font-size:13px}
details{margin:8px 0}summary{cursor:pointer;color:var(--mut);font-size:13px}
.ev,.rules{list-style:none;padding:0;margin:8px 0;font-size:13px}.ev li,.rules li{padding:3px 0;border-bottom:1px dashed var(--line)}
.rules span{font:700 11px ui-monospace,Menlo,Consolas,monospace}.rules .pass span{color:var(--bull)}.rules .fail span{color:var(--bear)}
.card footer{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--mut);border-top:1px solid var(--line);padding-top:10px;margin-top:10px}
a{color:var(--acc)}
</style></head><body><main>
<h1>Debate <span>Desk</span></h1>
<p class="lede">Two agents argue about SOL from the same evidence. A third judges. Fixed rules decide whether the ruling may trade, and every decision lands on Solana ${esc(CLUSTER)} as a receipt in the same transaction as its trade. The reasoning trail cannot be edited after the fact.</p>
<div class="stats">
  <div class="stat"><b>${s.receipts}</b><span>receipts on chain</span></div>
  <div class="stat"><b>${s.debates}</b><span>debates</span></div>
  <div class="stat"><b>${s.entries}</b><span>entries</span></div>
  <div class="stat"><b>${s.exits}</b><span>rule exits</span></div>
  <div class="stat"><b>${s.blocked}</b><span>rulings blocked by rules</span></div>
  <div class="stat"><b>${s.closed ? (s.net_bps > 0 ? "+" : "") + s.net_bps : "-"}</b><span>bps on closed trades (market price)</span></div>
</div>
<div class="how">
  <b>How to check every word on this page</b>
  <ol>
    <li>Each card's receipt hash is committed by program <a href="${explorerAddress(String(PROGRAM_ID))}" target="_blank" rel="noopener"><code>${esc(PROGRAM_ID)}</code></a> into the desk's on-chain log <a href="${explorerAddress(log)}" target="_blank" rel="noopener"><code>${esc(short(log, 12))}</code></a>.</li>
    <li>The receipt names the hashes of every evidence item and every model transcript. Those files are in the repo under <code>data/</code>.</li>
    <li>Run the verifier. It re-hashes everything, proves bull and bear saw the identical evidence, replays the risk rules to the same action and size, and replays the on-chain head.</li>
  </ol>
  <pre>git clone https://github.com/NoBanks/debate-desk && cd debate-desk && npm install
npx tsx src/verify.ts --tx all</pre>
  <span class="muted">Desk ${esc(AGENT_NAME)} <code>${esc(desk)}</code>. Devnet: trades are real transactions on devnet liquidity, the signal is the real SOL/USD market. This is practice trading, not a performance claim.</span>
</div>
${rows.slice().reverse().map(card).join("\n")}
</main></body></html>`;

mkdirSync(join(REPO_ROOT, "docs"), { recursive: true });
writeFileSync(join(REPO_ROOT, "docs", "index.html"), html);
writeFileSync(join(REPO_ROOT, "docs", ".nojekyll"), "");
console.log(`docs/index.html: ${rows.length} receipts, ${(html.length / 1024).toFixed(0)} KB`);
void (null as unknown as Json);
