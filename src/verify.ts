/**
 * verify.ts - re-derive every claim the desk makes from public data. No keys.
 *
 *   npx tsx src/verify.ts [data dir or https base URL] [--tx all|N] [--offline]
 *
 * Default data source is ./data. A judge can point it at the public repo instead:
 *   npx tsx src/verify.ts https://raw.githubusercontent.com/NoBanks/debate-desk/main/data
 *
 * Reasoning checks (what was decided, and why):
 *   R1  every evidence item re-hashes to the hash in the receipt, and the pack hash matches
 *   R2  every transcript re-hashes; BULL and BEAR got the identical prompt; the JUDGE's
 *       prompt contains that same evidence; the ruling in the receipt is the judge's own output
 *   R3  replaying risk.ts on the recorded evidence, ruling, balances and position gives the
 *       same action, the same size, the same rule trace and the same resulting position
 * Chain checks (that it happened, in this order, unedited):
 *   C1  every receipt re-hashes to its receipt_hash; rows are numbered and linked
 *   C2  replaying the head over registration, policy changes and rows equals the on-chain head
 *   C3  each checked transaction succeeded, emitted ReceiptAttested with the same hash, seq and
 *       action, and a BUY or SELL carries the desk's own Orca swap in that same transaction
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSolanaRpc, getBase58Encoder, signature as toSig, type Address } from "@solana/kit";
import { DATA_DIR, IDL, RPC_URL, explorerTx } from "./config.js";
import { documentHash, receiptHash, type Json } from "./canonical.js";
import { ACTION, ZERO32, agentLogAddress, decodeReceiptAttested, fetchAgentLog, nextPolicyHead, nextReceiptHead, type ActionName } from "./program.js";
import { applyRules, checkExit, type Position } from "./risk.js";
import type { Ruling } from "./debate.js";
import type { EvidenceItem } from "./evidence.js";
import { evidenceText } from "./evidence.js";
import { evidenceView, type LedgerRow } from "./desk.js";

const rpc = createSolanaRpc(RPC_URL);
type Obj = { [k: string]: Json };

async function withRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await call();
    } catch (e) {
      if (i >= 7 || !/429|Too Many|fetch failed|ECONNRESET/i.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

function makeLoader(base: string) {
  return async (rel: string): Promise<string> => {
    if (base.startsWith("http")) {
      const res = await fetch(`${base.replace(/\/$/, "")}/${rel}`);
      if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
      return res.text();
    }
    return readFileSync(join(base, rel), "utf8");
  };
}

const b58 = getBase58Encoder();
const bytes = (s: string) => Buffer.from(Uint8Array.from(b58.encode(s)));
const eventDisc = (name: string) => Buffer.from(IDL.events.find((e: { name: string }) => e.name === name).discriminator);

async function policyHistory(logAddr: Address, receiptSigs: Set<string>) {
  const out: { version: number; policyHash: string; atSeq: bigint }[] = [];
  const reg = eventDisc("AgentRegistered");
  const pol = eventDisc("PolicyUpdated");
  let before: string | undefined;
  for (;;) {
    const sigs = await withRetry(() => rpc.getSignaturesForAddress(logAddr, { limit: 1000, ...(before ? { before: toSig(before) } : {}) }).send());
    if (!sigs.length) break;
    for (const s of sigs) {
      if (s.err || receiptSigs.has(String(s.signature))) continue;
      const tx = await withRetry(() => rpc.getTransaction(s.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send());
      for (const inner of tx?.meta?.innerInstructions ?? []) {
        for (const ix of inner.instructions) {
          const d = bytes(ix.data as string);
          if (d.length < 16) continue;
          if (d.subarray(8, 16).equals(reg)) out.push({ version: 1, policyHash: d.subarray(144, 176).toString("hex"), atSeq: 0n });
          else if (d.subarray(8, 16).equals(pol)) out.push({ version: d.readUInt32LE(80), policyHash: d.subarray(48, 80).toString("hex"), atSeq: d.readBigUInt64LE(84) });
        }
      }
    }
    before = String(sigs[sigs.length - 1].signature);
    if (sigs.length < 1000) break;
  }
  return out.sort((a, b) => a.version - b.version);
}

async function checkTx(row: LedgerRow, logAddr: string, venue: string, authority: string): Promise<string | null> {
  const tx = await withRetry(() => rpc.getTransaction(toSig(row.signature), { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send());
  if (!tx) return "transaction not found";
  if (tx.meta?.err) return `transaction failed: ${JSON.stringify(tx.meta.err)}`;
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])].map(String);
  let ev: ReturnType<typeof decodeReceiptAttested> = null;
  for (const inner of tx.meta?.innerInstructions ?? []) for (const ix of inner.instructions) {
    const e = decodeReceiptAttested(bytes(ix.data as string));
    if (e && e.agentLog === logAddr) ev = e;
  }
  if (!ev) return "no ReceiptAttested event for this desk";
  if (ev.receiptHash !== row.receipt_hash) return `event hash ${ev.receiptHash} != ledger ${row.receipt_hash}`;
  if (ev.seq.toString() !== row.seq) return `event seq ${ev.seq} != ledger ${row.seq}`;
  if (ev.action !== ACTION[row.action as ActionName]) return `event action ${ev.action} != ledger ${row.action}`;
  const venueCalls = tx.transaction.message.instructions.filter((ix) => keys[ix.programIdIndex] === venue);
  const signed = keys.slice(0, tx.transaction.message.header.numRequiredSignatures).includes(authority);
  if (row.action === "HOLD" && venueCalls.length) return "HOLD transaction contains a venue call";
  if (row.action !== "HOLD" && (!venueCalls.length || !signed)) return "trade receipt without the desk's own swap";
  return null;
}

/** Stable comparison for rule traces and positions. */
const same = (a: unknown, b: unknown) => receiptHash((a ?? null) as Json) === receiptHash((b ?? null) as Json);

async function main() {
  const args = process.argv.slice(2);
  const base = args[0] && !args[0].startsWith("--") ? args[0] : DATA_DIR;
  const txWant = args.includes("--tx") ? args[args.indexOf("--tx") + 1] : "20";
  const load = makeLoader(base);

  const rows: LedgerRow[] = (await load("ledger.jsonl")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  if (!rows.length) throw new Error("ledger is empty");
  const authority = String((rows[0].receipt as Obj).agent_address) as Address;
  const problems: string[] = [];
  const counts = { evidence_files: 0, transcripts: 0, rule_replays: 0, debates: 0, entries: 0, exits: 0, holds: 0 };

  // ---- reasoning
  for (const [i, row] of rows.entries()) {
    const r = row.receipt as Obj;
    const tag = `row ${i}`;
    const evRef = r.evidence as { pack_hash: string; items: { id: string; sha256: string }[] };
    const items: EvidenceItem[] = [];
    for (const ref of evRef.items) {
      const item = JSON.parse(await load(`evidence/${ref.sha256}.json`)) as EvidenceItem;
      counts.evidence_files++;
      if (receiptHash(item as unknown as Json) !== ref.sha256 || item.id !== ref.id) problems.push(`${tag} R1: evidence ${ref.id} does not match its hash`);
      items.push(item);
    }
    if (receiptHash(evRef.items.map((x) => x.sha256) as Json) !== evRef.pack_hash) problems.push(`${tag} R1: pack hash mismatch`);

    const deb = r.debate as { transcripts: { role: string; sha256: string }[]; ruling: Json } | null;
    let ruling: Ruling | null = null;
    if (deb) {
      counts.debates++;
      const ts: { [role: string]: Obj } = {};
      for (const t of deb.transcripts) {
        const doc = JSON.parse(await load(`transcripts/${t.sha256}.json`)) as Obj;
        counts.transcripts++;
        if (documentHash(doc as Json) !== t.sha256 || doc.role !== t.role) problems.push(`${tag} R2: transcript ${t.role} does not match its hash`);
        ts[t.role] = doc;
      }
      const text = evidenceText({ items } as never);
      if (ts.BULL?.prompt !== ts.BEAR?.prompt) problems.push(`${tag} R2: BULL and BEAR were not given the same prompt`);
      if (!String(ts.BULL?.prompt ?? "").includes(text)) problems.push(`${tag} R2: advocates' prompt does not contain the recorded evidence`);
      if (!String(ts.JUDGE?.prompt ?? "").includes(text)) problems.push(`${tag} R2: judge's prompt does not contain the recorded evidence`);
      if (!same(ts.JUDGE?.parsed, deb.ruling)) problems.push(`${tag} R2: ruling in receipt is not the judge's recorded output`);
      ruling = deb.ruling as unknown as Ruling;
    }

    const ev = evidenceView(items);
    const bal = r.balances as { lamports: string; dev_usdc_units: string };
    const inv = { lamports: BigInt(bal.lamports), usdcUnits: BigInt(bal.dev_usdc_units) };
    const before = r.position_before as unknown as Position | null;
    const prevAfter = i ? (((rows[i - 1].receipt as Obj).position_after ?? null) as unknown as Position | null) : null;
    if (!same(before, prevAfter)) problems.push(`${tag} R3: position_before does not continue from the previous receipt`);
    const nowS = Math.floor(Date.parse(String(r.timestamp)) / 1000);
    const out = before ? checkExit(before, ev, inv, nowS) : ruling ? applyRules(ruling, ev, inv) : null;
    counts.rule_replays++;
    if (!out) problems.push(`${tag} R3: no position and no debate; nothing to replay`);
    else {
      if (out.action !== row.action || out.action !== r.action) problems.push(`${tag} R3: rules replay to ${out.action}, receipt says ${r.action}`);
      if (!same(out.trace, r.rules)) problems.push(`${tag} R3: rule trace does not replay`);
      const swapIn = (r.swap as Obj).input_amount;
      if (out.action !== "HOLD" && String(out.inputAmount) !== String(swapIn)) problems.push(`${tag} R3: size replays to ${out.inputAmount}, swap spent ${swapIn}`);
      if (out.kind === "ENTRY") counts.entries++;
      else if (out.kind === "EXIT") counts.exits++;
      else counts.holds++;
      const after = r.position_after as unknown as Position | null;
      if (out.kind === "ENTRY" && (!after || after.opened_seq !== row.seq || after.entry_price_e8 !== out.opens!.entry_price_e8 || after.stop_loss_bps !== out.opens!.stop_loss_bps)) problems.push(`${tag} R3: opened position does not match the rules`);
      if ((out.kind === "EXIT" || out.closes) && after) problems.push(`${tag} R3: exit left a position open`);
      if (out.kind === "HOLD" && !out.closes && !same(after, before)) problems.push(`${tag} R3: HOLD changed the position`);
    }
  }

  if (args.includes("--offline")) {
    console.log(JSON.stringify({ mode: "offline (reasoning checks only)", receipts: rows.length, ...counts, problems, ok: problems.length === 0 }, null, 2));
    process.exit(problems.length ? 1 : 0);
  }

  // ---- chain
  let log = await withRetry(() => fetchAgentLog(rpc, authority));
  if (!log) throw new Error(`no AgentLog for ${authority}`);
  const logAddr = String(await agentLogAddress(authority));
  let prev = ZERO32;
  rows.forEach((row, i) => {
    if (receiptHash(row.receipt) !== row.receipt_hash) problems.push(`row ${i} C1: receipt does not hash to receipt_hash`);
    if (row.seq !== String(i) || (row.receipt as Obj).seq !== row.seq) problems.push(`row ${i} C1: seq out of order`);
    if (row.prev_receipt_hash !== prev) problems.push(`row ${i} C1: prev_receipt_hash does not link`);
    prev = row.receipt_hash;
  });
  // a live desk can land a receipt between the ledger download and the chain read
  if (log.count > BigInt(rows.length)) {
    await new Promise((r) => setTimeout(r, 4000));
    log = (await withRetry(() => fetchAgentLog(rpc, authority)))!;
  }
  const policies = await policyHistory(logAddr as Address, new Set(rows.map((r) => r.signature)));
  let head = ZERO32;
  let p = 0;
  const applyPolicies = (upTo: bigint) => {
    while (p < policies.length && policies[p].atSeq <= upTo) head = nextPolicyHead(head, policies[p].policyHash, policies[p++].version);
  };
  rows.forEach((row, i) => {
    applyPolicies(BigInt(i));
    head = nextReceiptHead(head, row.receipt_hash, BigInt(i), row.action as ActionName);
  });
  applyPolicies(BigInt(rows.length));
  if (head !== log.head) problems.push(`C2: replayed head ${head} != on-chain head ${log.head}`);
  if (log.count !== BigInt(rows.length)) problems.push(`C2: on-chain count ${log.count} != ledger rows ${rows.length}`);

  const idx = rows.map((_, i) => i);
  const pick = txWant === "all" ? idx : idx.slice(-Number(txWant));
  for (const i of pick) {
    const err = await checkTx(rows[i], logAddr, log.venue, String(authority));
    if (err) problems.push(`row ${i} C3 (${explorerTx(rows[i].signature)}): ${err}`);
  }

  const report = {
    desk: log.name,
    agent_log: logAddr,
    receipts: rows.length,
    ...counts,
    policy_versions: policies.length,
    onchain_head: log.head,
    replayed_head: head,
    transactions_checked: pick.length,
    problems,
    ok: problems.length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

await main();
