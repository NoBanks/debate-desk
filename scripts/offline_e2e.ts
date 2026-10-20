/**
 * Offline end-to-end: N real cycles (live evidence, live Gemini, the desk's own decide()),
 * written to a scratch DATA_DIR with placeholder signatures, then checked by
 *   npx tsx src/verify.ts <DATA_DIR> --offline
 * Nothing is sent to any chain. Set DATA_DIR to a scratch folder before running.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSigner } from "@solana/kit";
import { DATA_DIR } from "../src/config.js";
import { receiptHash } from "../src/canonical.js";
import { ZERO32 } from "../src/program.js";
import { decide, policyHash, readLedger, type LedgerRow } from "../src/desk.js";

const N = Number(process.argv[2] ?? 3);
const signer = await generateKeyPairSigner();
mkdirSync(DATA_DIR, { recursive: true });
let inv = { lamports: 1_000_000_000n, usdcUnits: 3_000_000n };
for (let n = 0; n < N; n++) {
  const rows = readLedger();
  const log = { address: "OFFLINE_LOG", policyHash: policyHash().toString("hex"), policyVersion: 1, count: BigInt(rows.length) };
  const { receipt, out } = await decide(signer, log, rows, n, inv);
  const h = receiptHash(receipt);
  const row: LedgerRow = { seq: String(rows.length), action: out.action, receipt_hash: h, prev_receipt_hash: rows.at(-1)?.receipt_hash ?? ZERO32, signature: "OFFLINE", receipt };
  appendFileSync(join(DATA_DIR, "ledger.jsonl"), JSON.stringify(row) + "\n");
  console.log(`#${row.seq} ${out.action} (${out.kind}) ${out.reason}`);
  // pretend the swap filled at its quote so the next cycle sees moved balances
  const sw = (receipt as any).swap;
  if (out.action === "BUY") inv = { lamports: inv.lamports + BigInt(sw.quote_est_out), usdcUnits: inv.usdcUnits - BigInt(sw.input_amount) };
  if (out.action === "SELL") inv = { lamports: inv.lamports - BigInt(sw.input_amount), usdcUnits: inv.usdcUnits + BigInt(sw.quote_est_out) };
}
