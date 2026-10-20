/**
 * One-time seed, BEFORE registration: swap some SOL into devUSDC so the desk can act on a BUY.
 * It is not a desk decision and carries no receipt; the on-chain log starts after it.
 * The transaction is listed in the README.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createSolanaRpc, createSolanaRpcSubscriptions,
  createTransactionMessage, getSignatureFromTransaction, pipe, sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
} from "@solana/kit";
import { swapInstructions } from "@orca-so/whirlpools";
import { WhirlpoolDeployment } from "@orca-so/whirlpools-client";
import { KEY_DIR, POOL, RPC_URL, WSOL_MINT, explorerTx } from "../src/config.js";
import { fetchAgentLog } from "../src/program.js";

const rpc = createSolanaRpc(RPC_URL);
const send = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(RPC_URL.replace(/^http/, "ws")) });
const desk = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(KEY_DIR, "desk.json"), "utf8"))));
if (await fetchAgentLog(rpc, desk.address)) throw new Error("desk is already registered; seeding now would be an unreceipted trade");
const amount = BigInt(process.argv[2] ?? 400_000_000);
const res = await swapInstructions(rpc, { inputAmount: amount, mint: WSOL_MINT }, POOL, { slippageToleranceBps: 100, signer: desk, whirlpoolDeployment: WhirlpoolDeployment.devnet });
const { value: bh } = await rpc.getLatestBlockhash().send();
const msg = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(desk, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions(res.instructions, m));
const tx = await signTransactionMessageWithSigners(msg);
await send(tx as Parameters<typeof send>[0], { commitment: "confirmed" });
console.log(`seed swap ${amount} lamports -> est ${res.quote.tokenEstOut} devUSDC units: ${explorerTx(getSignatureFromTransaction(tx))}`);
