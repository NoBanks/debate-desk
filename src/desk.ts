/**
 * desk.ts - one debate per cycle, one receipt per decision, on chain.
 *
 *   npx tsx src/desk.ts keygen        create the desk key (once, outside the repo)
 *   npx tsx src/desk.ts airdrop       ask the devnet faucet for SOL
 *   npx tsx src/desk.ts register      register the desk with the Agent Receipts program
 *   npx tsx src/desk.ts once          run one cycle
 *   npx tsx src/desk.ts loop          run forever, CYCLE_SECONDS apart
 *   npx tsx src/desk.ts status        print the on-chain log and balances
 *
 * A cycle:
 *   1. gather the evidence pack (Pyth on chain, Chainlink via CRE, CoinGecko, news)
 *   2. if a position is open, check its stop / target / horizon by rule, no model
 *      otherwise BULL and BEAR argue, JUDGE rules, risk.ts turns the ruling into an action
 *   3. if the action is a trade, quote it on Orca
 *   4. build the receipt (evidence hashes, transcript hashes, rule trace, position, quote)
 *   5. send ONE transaction holding the swap and the attest instruction
 * The Agent Receipts program rejects a BUY/SELL receipt without the agent's own swap in
 * the same transaction, and a HOLD receipt with one. A trade and its reasoning land
 * together or not at all.
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  signature as toSig,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { swapInstructions } from "@orca-so/whirlpools";
import { WhirlpoolDeployment, fetchWhirlpool } from "@orca-so/whirlpools-client";
import {
  AGENT_NAME, CLUSTER, REPO_ROOT, CYCLE_SECONDS, DATA_DIR, DEV_USDC_MINT, GEMINI_MODEL, KEY_DIR, ORCA_WHIRLPOOL_PROGRAM,
  POOL, PROGRAM_ID, RPC_URL, SLIPPAGE_BPS, WSOL_MINT, explorerAddress, explorerTx,
} from "./config.js";
import { canonicalBytes, receiptHash, sha256Hex, type Json } from "./canonical.js";
import { gatherEvidence, withRetry, type EvidencePack } from "./evidence.js";
import { promptsSha256, runDebate, type Debate } from "./debate.js";
import { LIMITS, applyRules, checkExit, policyDocument, type EvidenceView, type Inventory, type Outcome, type Position } from "./risk.js";
import { attestIx, fetchAgentLog, registerAgentIx, updatePolicyIx, type AgentLog } from "./program.js";

const MIN_GAP_SECONDS = 60;
const RECEIPT_TYPE = "debate_desk_decision";
const ENGINE = "debate-desk";
const ENGINE_VERSION = "0.1.0";

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(process.env.WS_URL ?? RPC_URL.replace(/^http/, "ws"));
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

export type LedgerRow = {
  seq: string;
  action: string;
  receipt_hash: string;
  prev_receipt_hash: string;
  signature: string;
  receipt: Json;
};

export const LEDGER = join(DATA_DIR, "ledger.jsonl");
const PENDING = join(DATA_DIR, "ledger.pending.json");
const KEY_FILE = join(KEY_DIR, "desk.json");

export function readLedger(path = LEDGER): LedgerRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as LedgerRow);
}
function appendLedger(row: LedgerRow): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(LEDGER, JSON.stringify(row) + "\n");
}

export function policyHash(): Buffer {
  return Buffer.from(sha256Hex(canonicalBytes({ agent: AGENT_NAME, ...policyDocument(promptsSha256(), GEMINI_MODEL) } as Json)), "hex");
}

async function loadDesk(): Promise<KeyPairSigner> {
  const raw = JSON.parse(readFileSync(KEY_FILE, "utf8")) as number[];
  return createKeyPairSignerFromBytes(Uint8Array.from(raw));
}

async function signTx(feePayer: KeyPairSigner, ixs: Instruction[]) {
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  return { tx, sig: String(getSignatureFromTransaction(tx)) };
}

async function send(feePayer: KeyPairSigner, ixs: Instruction[]): Promise<string> {
  const { tx, sig } = await signTx(feePayer, ixs);
  await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], { commitment: "confirmed" });
  return sig;
}

/** What the chain says about a signature. A send error does not mean the tx failed. */
async function chainOutcome(sig: string): Promise<"ok" | "failed" | "unknown"> {
  for (let i = 0; i < 12; i++) {
    try {
      const { value } = await rpc.getSignatureStatuses([toSig(sig)], { searchTransactionHistory: true }).send();
      const st = value[0];
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return st.err ? "failed" : "ok";
    } catch {
      // rate limited: keep asking, never guess
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return "unknown";
}

/** Settle a write-ahead receipt left by an earlier cycle, using the chain as the source of truth. */
async function reconcile(log: AgentLog): Promise<void> {
  if (!existsSync(PENDING)) return;
  const row = JSON.parse(readFileSync(PENDING, "utf8")) as LedgerRow;
  if (log.count > BigInt(row.seq)) {
    const outcome = await chainOutcome(row.signature);
    if (outcome !== "ok") throw new Error(`chain count ${log.count} passed pending #${row.seq} but its tx is ${outcome}; stopping for a human`);
    appendLedger(row);
    console.log(`#${row.seq} recovered from pending: it landed on chain`);
  } else {
    appendFileSync(join(DATA_DIR, "failed_attempts.jsonl"), JSON.stringify({ at: new Date().toISOString(), seq: row.seq, signature: row.signature, error: "pending receipt never landed" }) + "\n");
  }
  unlinkSync(PENDING);
}

async function inventory(owner: KeyPairSigner): Promise<Inventory> {
  const { value: lam } = await rpc.getBalance(owner.address, { commitment: "confirmed" }).send();
  const { value: accts } = await rpc
    .getTokenAccountsByOwner(owner.address, { mint: DEV_USDC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" })
    .send();
  let usdcUnits = 0n;
  for (const a of accts) usdcUnits += BigInt((a.account.data as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed.info.tokenAmount.amount);
  return { lamports: BigInt(lam), usdcUnits };
}

/** USD decimal string -> integer at 1e-8 USD. */
function e8(usd: string): bigint {
  const [w, f = ""] = usd.split(".");
  return BigInt(w) * 100_000_000n + BigInt((f + "00000000").slice(0, 8));
}

export function evidenceView(items: { id: string; data: { [k: string]: Json } }[]): EvidenceView {
  const p = items.find((i) => i.id === "PYTH")!.data;
  const exp = Number(p.exponent);
  const price = BigInt(String(p.price));
  const shift = exp + 8;
  const pythPriceE8 = shift >= 0 ? price * 10n ** BigInt(shift) : price / 10n ** BigInt(-shift);
  const crossPricesE8: { [id: string]: bigint } = {};
  for (const it of items) {
    if (["CL", "CB", "KR", "CG"].includes(it.id)) crossPricesE8[it.id] = e8(String(it.data.price_usd));
  }
  const view: EvidenceView = { ids: items.map((i) => i.id), pythPriceE8, pythAgeS: Number(p.age_s), pythConfBps: Number(p.conf_bps), crossPricesE8 };
  const sol = items.find((i) => i.id === "KOL")?.data.sol as { bull_voices: number; bear_voices: number } | undefined;
  if (sol) view.kol = { bullVoices: Number(sol.bull_voices), bearVoices: Number(sol.bear_voices) };
  return view;
}

function openPosition(rows: LedgerRow[]): Position | null {
  const last = rows.at(-1);
  return last ? (((last.receipt as { [k: string]: Json }).position_after as unknown as Position) ?? null) : null;
}

function deskContext(inv: Inventory, pos: Position | null): string {
  return [
    `Instrument: SOL/USD. Practice desk on Solana devnet; trades are small and real on devnet, never on mainnet.`,
    `Desk balances: ${inv.lamports} lamports SOL (reserve ${LIMITS.sol_reserve_lamports} never traded), ${inv.usdcUnits} devUSDC units (6 decimals).`,
    `Open position: ${pos ? `${pos.side} since receipt #${pos.opened_seq}` : "none"}.`,
    `Desk rules the judge cannot override: conviction below ${LIMITS.min_conviction_to_trade} means no trade; at least ${LIMITS.min_decisive_citations} decisive evidence ids required; price sources must agree within ${LIMITS.max_source_divergence_bps} bps; stop ${LIMITS.stop_loss_bps_range.join("-")} bps, target ${LIMITS.take_profit_bps_range.join("-")} bps, horizon ${LIMITS.horizon_minutes_range.join("-")} minutes; if ${LIMITS.kol_min_voices}+ public voices in KOL converge against the verdict on SOL, size is cut to ${LIMITS.kol_counter_size_pct}%.`,
  ].join("\n");
}

function debateSummary(d: Debate): Json {
  const side = (c: Debate["bull"]) => ({
    thesis: c.thesis,
    confidence: c.confidence,
    citations: [...new Set(c.points.flatMap((p) => p.evidence_ids))].sort(),
  });
  return {
    transcripts: d.transcripts as unknown as Json,
    bull: side(d.bull),
    bear: side(d.bear),
    ruling: d.judge as unknown as Json,
  };
}

async function cycle(n: number): Promise<void> {
  const signer = await loadDesk();
  let log = await withRetry(() => fetchAgentLog(rpc, signer.address));
  if (!log) throw new Error("desk is not registered; run: npx tsx src/desk.ts register");
  if (existsSync(PENDING)) {
    await reconcile(log);
    log = (await fetchAgentLog(rpc, signer.address))!;
  }
  const rows = readLedger();
  if (BigInt(rows.length) !== log.count) throw new Error(`ledger has ${rows.length} rows but chain count is ${log.count}; refusing to write past a gap`);
  // Hard floor between receipts. A second desk process, or any runaway loop, cannot spam the log.
  const last = rows.at(-1);
  const sinceLast = last ? Math.floor(Date.now() / 1000) - Math.floor(Date.parse(String((last.receipt as { timestamp: string }).timestamp)) / 1000) : Infinity;
  if (sinceLast < MIN_GAP_SECONDS) throw new Error(`last receipt is only ${sinceLast}s old (minimum ${MIN_GAP_SECONDS}s); is another desk process running?`);
  if (log.policyHash !== policyHash().toString("hex")) throw new Error("on-chain policy_hash is out of date; run: npx tsx src/desk.ts sync-policy");

  const { receipt, out, swapIxs } = await decide(signer, log, rows, n);
  const seq = log.count;
  const h = receiptHash(receipt);
  const { tx, sig } = await signTx(signer, [...swapIxs, await attestIx(signer, h, seq, out.action)]);
  const row: LedgerRow = { seq: seq.toString(), action: out.action, receipt_hash: h, prev_receipt_hash: log.lastReceipt, signature: sig, receipt };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PENDING, JSON.stringify(row));

  let outcome: "ok" | "failed" | "unknown";
  try {
    await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], { commitment: "confirmed" });
    outcome = "ok";
  } catch (e) {
    outcome = await chainOutcome(sig);
    if (outcome !== "ok") console.error(`#${seq} send error: ${String(e).slice(0, 300)}`);
  }
  if (outcome === "ok") {
    appendLedger(row);
    unlinkSync(PENDING);
    console.log(`#${seq} ${out.action} (${out.kind}) ${h.slice(0, 12)} ${explorerTx(sig)}\n    ${out.reason}`);
  } else if (outcome === "failed") {
    appendFileSync(join(DATA_DIR, "failed_attempts.jsonl"), JSON.stringify({ at: new Date().toISOString(), seq: row.seq, signature: sig, error: "tx failed on chain" }) + "\n");
    unlinkSync(PENDING);
    console.error(`#${seq} ${out.action} failed on chain; nothing attested`);
  } else {
    console.error(`#${seq} outcome unknown; left pending for the next cycle`);
  }
}

/**
 * Everything up to the signature: evidence, debate or exit check, rules, quote, receipt.
 * Exported so the offline end-to-end test exercises the exact code the live desk runs.
 */
export async function decide(
  signer: KeyPairSigner,
  log: Pick<AgentLog, "address" | "policyHash" | "policyVersion" | "count">,
  rows: LedgerRow[],
  n: number,
  invOverride?: Inventory,
): Promise<{ receipt: Json; out: Outcome; swapIxs: Instruction[] }> {
  const nowS = Math.floor(Date.now() / 1000);
  const pack: EvidencePack = await gatherEvidence(rpc);
  const ev = evidenceView(pack.items);
  const inv = invOverride ?? (await withRetry(() => inventory(signer)));
  const before = openPosition(rows);

  let debate: Debate | null = null;
  let out: Outcome;
  if (before) {
    out = checkExit(before, ev, inv, nowS);
  } else {
    debate = await runDebate(pack, deskContext(inv, before));
    out = applyRules(debate.judge, ev, inv);
  }

  const pool = await withRetry(() => fetchWhirlpool(rpc, POOL));
  const sqrt = pool.data.sqrtPrice;
  const usdcUnitsPerSol = (sqrt * sqrt * 1_000_000_000n) >> 128n;

  let swapIxs: Instruction[] = [];
  let swap: Json = {};
  let minOut = 0n;
  if (out.action !== "HOLD") {
    const inputMint = out.action === "SELL" ? WSOL_MINT : DEV_USDC_MINT;
    const res = await withRetry(() => swapInstructions(rpc, { inputAmount: out.inputAmount, mint: inputMint }, POOL, {
      slippageToleranceBps: SLIPPAGE_BPS,
      signer,
      whirlpoolDeployment: WhirlpoolDeployment.devnet,
    }));
    swapIxs = res.instructions;
    minOut = res.quote.tokenMinOut;
    swap = {
      venue: String(ORCA_WHIRLPOOL_PROGRAM),
      pool: String(POOL),
      input_mint: String(inputMint),
      output_mint: String(inputMint === WSOL_MINT ? DEV_USDC_MINT : WSOL_MINT),
      input_amount: res.quote.tokenIn.toString(),
      quote_est_out: res.quote.tokenEstOut.toString(),
      quote_min_out: res.quote.tokenMinOut.toString(),
      slippage_bps: SLIPPAGE_BPS,
    };
  }

  const seq = log.count;
  let after: Position | null = before;
  if (out.kind === "EXIT" || out.closes) after = null;
  if (out.kind === "ENTRY" && out.opens) after = { ...out.opens, opened_at: nowS, opened_seq: seq.toString(), exit_input_amount: minOut.toString() };

  const receipt: Json = {
    type: RECEIPT_TYPE,
    engine: ENGINE,
    engine_version: ENGINE_VERSION,
    cluster: CLUSTER,
    program: String(PROGRAM_ID),
    agent: AGENT_NAME,
    agent_address: String(signer.address),
    agent_log: log.address,
    policy_hash: log.policyHash,
    policy_version: log.policyVersion,
    seq: seq.toString(),
    cycle: n,
    action: out.action,
    kind: out.kind,
    reason: out.reason,
    evidence: {
      pack_hash: pack.pack_hash,
      items: pack.items.map((i) => ({ id: i.id, sha256: pack.hashes[i.id], source: i.source, url: i.url })) as unknown as Json,
    },
    debate: debate ? debateSummary(debate) : null,
    rules: out.trace as unknown as Json,
    closes: (out.closes ?? null) as unknown as Json,
    position_before: before as unknown as Json,
    position_after: after as unknown as Json,
    market_price_e8: ev.pythPriceE8.toString(),
    pool: { address: String(POOL), sqrt_price_x64: sqrt.toString(), usdc_units_per_sol: usdcUnitsPerSol.toString() },
    balances: { lamports: inv.lamports.toString(), dev_usdc_units: inv.usdcUnits.toString() },
    swap,
    timestamp: new Date(nowS * 1000).toISOString().replace(".000Z", "Z"),
  };
  return { receipt, out, swapIxs };
}

/**
 * DESK_AUTOPUBLISH=1: after each cycle, rebuild docs/ and push data/ + docs/ to the public repo,
 * so the GitHub Pages record and the verifier's raw data follow the chain within one cycle.
 */
function publish(): void {
  if (process.env.DESK_AUTOPUBLISH !== "1") return;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: REPO_ROOT, stdio: "pipe" }).toString();
  try {
    // clean env: the child must never inherit anything that says "you are the desk"
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "DESK_CMD" && !/^pm_|^PM2/i.test(k)));
    execFileSync(process.execPath, [join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(REPO_ROOT, "src", "site.ts")], { cwd: REPO_ROOT, stdio: "pipe", env });
    git("add", "data", "docs");
    if (!git("status", "--porcelain", "data", "docs").trim()) return;
    git("-c", "user.name=Debate Desk", "-c", "user.email=nobanksnearby@gmail.com", "commit", "-q", "-m", `record: ${readLedger().length} receipts`);
    // code changes may have been pushed from this same checkout; data/ and docs/ are only ever written here
    git("pull", "-q", "--rebase", "--autostash", "origin", "main");
    git("push", "-q", "origin", "main");
  } catch (e) {
    console.error(`publish failed (will retry next cycle): ${String(e).slice(0, 200)}`);
  }
}

async function keygen(): Promise<void> {
  if (existsSync(KEY_FILE)) {
    console.log(`key already exists: ${KEY_FILE}`);
  } else {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
    const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    mkdirSync(KEY_DIR, { recursive: true });
    writeFileSync(KEY_FILE, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
  }
  console.log(`desk address: ${(await loadDesk()).address}`);
}

async function airdrop(): Promise<void> {
  const desk = await loadDesk();
  const sig = await rpc.requestAirdrop(desk.address, lamports(1_000_000_000n), { commitment: "confirmed" }).send();
  console.log(`airdrop requested: ${explorerTx(String(sig))}`);
  console.log(`outcome: ${await chainOutcome(String(sig))}`);
}

async function register(): Promise<void> {
  const desk = await loadDesk();
  const existing = await fetchAgentLog(rpc, desk.address);
  if (existing) return console.log(`already registered: ${existing.address} (count ${existing.count})`);
  const sig = await send(desk, [await registerAgentIx(desk, desk, AGENT_NAME, ORCA_WHIRLPOOL_PROGRAM, policyHash())]);
  console.log(`registered: ${explorerTx(sig)}`);
}

async function syncPolicy(): Promise<void> {
  const desk = await loadDesk();
  const log = await fetchAgentLog(rpc, desk.address);
  if (!log) throw new Error("not registered");
  const want = policyHash();
  if (log.policyHash === want.toString("hex")) return console.log(`policy v${log.policyVersion} is current`);
  const sig = await send(desk, [await updatePolicyIx(desk, want)]);
  console.log(`policy v${log.policyVersion} -> v${log.policyVersion + 1}: ${explorerTx(sig)}`);
}

async function status(): Promise<void> {
  const desk = await loadDesk();
  const log = await fetchAgentLog(rpc, desk.address);
  const inv = await inventory(desk);
  console.log(`desk ${desk.address}  ${explorerAddress(String(desk.address))}`);
  console.log(`balances: ${inv.lamports} lamports, ${inv.usdcUnits} devUSDC units`);
  console.log(log ? `log ${log.address}: count ${log.count}, policy v${log.policyVersion}, head ${log.head}` : "not registered");
  console.log(`ledger rows: ${readLedger().length}`);
}

// Run the CLI only when THIS file is the process entry: run directly, or as the script PM2 launched
// (PM2 puts its own container in argv[1] and the real script in pm_exec_path). Never because of an
// inherited env var: on 2026-10-20 that made every publish child re-run the loop (see README).
const norm = (p: string) => resolve(p).replace(/\\/g, "/").toLowerCase();
const self = norm(fileURLToPath(import.meta.url));
const entry = process.argv[1] ? norm(process.argv[1]) : "";
const pm2Entry = /processcontainer/.test(entry) && process.env.pm_exec_path ? norm(process.env.pm_exec_path) : "";
const isMain = entry === self || pm2Entry === self;
if (isMain) {
  // PM2 on Windows can drop script args on `pm2 restart`; DESK_CMD (set in ecosystem.config.cjs) survives it
  const cmd = process.env.DESK_CMD ?? process.argv[2] ?? "status";
  if (cmd === "loop") console.log(`desk loop starting: cycle every ${CYCLE_SECONDS}s, autopublish ${process.env.DESK_AUTOPUBLISH === "1" ? "on" : "off"}`);
  if (cmd === "keygen") await keygen();
  else if (cmd === "airdrop") await airdrop();
  else if (cmd === "register") await register();
  else if (cmd === "sync-policy") await syncPolicy();
  else if (cmd === "status") await status();
  else if (cmd === "once") {
    await cycle(0);
    publish();
  } else if (cmd === "publish") publish();
  else if (cmd === "loop") {
    for (let n = 0; ; n++) {
      try {
        await cycle(n);
      } catch (e) {
        console.error(`cycle ${n} error: ${String(e).slice(0, 400)}`);
      }
      publish();
      await new Promise((r) => setTimeout(r, CYCLE_SECONDS * 1000));
    }
  } else {
    console.error("usage: desk.ts keygen | airdrop | register | sync-policy | once | loop | status");
    process.exit(2);
  }
  process.exit(0);
}
