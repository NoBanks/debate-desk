/**
 * config.ts - every on-chain address here was read from a live source, never guessed.
 *
 *   PROGRAM_ID     the deployed Agent Receipts program (idl/, from solana-agent-receipts)
 *   POOL           Orca Whirlpool SOL/devUSDC on devnet, tick spacing 64
 *   PYTH_SOL_USD   Pyth's sponsored SOL/USD PriceUpdateV2 account on devnet
 *
 * Anything that differs per deployment comes from the environment.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { address, type Address } from "@solana/kit";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Secrets come from the environment or a gitignored .env next to package.json. Never committed.
const envFile = join(REPO_ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
export const IDL = JSON.parse(readFileSync(join(REPO_ROOT, "idl", "solana_agent_receipts.json"), "utf8"));

export const PROGRAM_ID: Address = address(process.env.RECEIPTS_PROGRAM_ID ?? IDL.address);
export const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
export const CLUSTER = process.env.CLUSTER ?? "devnet";

export const ORCA_WHIRLPOOL_PROGRAM: Address = address("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
export const POOL: Address = address(process.env.POOL ?? "3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt");
export const WSOL_MINT: Address = address("So11111111111111111111111111111111111111112");
export const DEV_USDC_MINT: Address = address("BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k");
export const PYTH_SOL_USD: Address = address(process.env.PYTH_ACCOUNT ?? "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export const KEY_DIR = process.env.DESK_KEY_DIR ?? join(homedir(), ".config", "debate-desk");
/** Committed to git on purpose: the ledger, transcripts and evidence are the public record. */
export const DATA_DIR = process.env.DATA_DIR ?? join(REPO_ROOT, "data");

/** The one agent that signs. Bull, bear and judge are roles inside its decision, not separate keys. */
export const AGENT_NAME = "DEBATE_DESK";

export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
export const CYCLE_SECONDS = Number(process.env.CYCLE_SECONDS ?? 900);
export const SLIPPAGE_BPS = 100;

export function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
}
export function explorerAddress(a: string): string {
  return `https://explorer.solana.com/address/${a}?cluster=${CLUSTER}`;
}
