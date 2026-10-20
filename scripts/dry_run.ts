/** Dry run: real evidence, real debate, real rules, NO transaction. Writes nothing to the ledger. */
import { createSolanaRpc } from "@solana/kit";
import { RPC_URL } from "../src/config.js";
import { gatherEvidence } from "../src/evidence.js";
import { runDebate } from "../src/debate.js";
import { applyRules } from "../src/risk.js";
import { evidenceView } from "../src/desk.js";

const rpc = createSolanaRpc(RPC_URL);
const t0 = Date.now();
const pack = await gatherEvidence(rpc);
console.log(`evidence: ${pack.items.map((i) => i.id).join(", ")} (pack ${pack.pack_hash.slice(0, 16)}) in ${Date.now() - t0} ms`);
for (const i of pack.items) console.log(`  [${i.id}] ${JSON.stringify(i.data).slice(0, 160)}`);
const inv = { lamports: 1_000_000_000n, usdcUnits: 2_000_000n };
const d = await runDebate(pack, "DRY RUN. Desk balances: 1 SOL, 2 devUSDC. Open position: none.");
console.log(`\nBULL (${d.bull.confidence}): ${d.bull.thesis}`);
for (const p of d.bull.points) console.log(`  - ${p.claim} [${p.evidence_ids}] => ${p.cause_effect}`);
console.log(`\nBEAR (${d.bear.confidence}): ${d.bear.thesis}`);
for (const p of d.bear.points) console.log(`  - ${p.claim} [${p.evidence_ids}] => ${p.cause_effect}`);
console.log(`\nJUDGE: ${JSON.stringify(d.judge, null, 1)}`);
const out = applyRules(d.judge, evidenceView(pack.items), inv);
console.log(`\nRULES -> ${out.action} ${out.inputAmount} (${out.kind}): ${out.reason}`);
for (const c of out.trace) console.log(`  ${c.pass ? "PASS" : "FAIL"} ${c.rule}: ${c.detail}`);
console.log(`\ntranscripts: ${d.transcripts.map((t) => t.role + "=" + t.sha256.slice(0, 12)).join(" ")}  total ${Date.now() - t0} ms`);
