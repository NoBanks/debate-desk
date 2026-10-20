# Debate Desk

**Two agents argue about SOL from the same evidence. A third judges. Fixed rules decide whether the ruling may trade. Every decision lands on Solana with its whole reasoning trail committed on chain, in the same transaction as the trade.**

Built for the BLI Legal Tech Hackathon 2 (RYO-CHAN Autonomous Agents bounty, Chainlink CRE bounty).

- Live record: https://nobanks.github.io/debate-desk/
- Desk wallet (Solana devnet): [`FHLgLhiFimjkjP34cuGHQZTfy9DvY4QphskxPMsSk14B`](https://explorer.solana.com/address/FHLgLhiFimjkjP34cuGHQZTfy9DvY4QphskxPMsSk14B?cluster=devnet)
- Desk's on-chain log: [`Ahw9K3YcVcaKZTKyx7u5QBCfoMKLLjhZz5ZFDqm3Y5gR`](https://explorer.solana.com/address/Ahw9K3YcVcaKZTKyx7u5QBCfoMKLLjhZz5ZFDqm3Y5gR?cluster=devnet)
- Receipts program: `GkCqpfzoMVSCMw4muiKAXoo4kcHFRiYjjAHBQjmhMwmU` (devnet)

Everything the desk wallet did before its log existed, so nothing is off the record:
1. received 2 devnet SOL from a test wallet: [tx](https://explorer.solana.com/tx/3zUC1V5ZaH46uUzwyWQuFpNvv5kDZhdbQmpBeUShsWQ4dRQT8t7w49BPE36t65KMPZFv2PgiRZcMnrfHwze1BpVe?cluster=devnet)
2. one seed swap, 0.4 SOL to devUSDC, so it could act on a BUY (`scripts/seed.ts`, refuses to run once registered): [tx](https://explorer.solana.com/tx/2jt2TpmtWneyRj1JRL8qSj3c3dHzS73gvBUdXYkBjHbHHjA4zvwCh6HYjLR1yTwGKEgTLCir8SuGMwhi9h2ESL1C?cluster=devnet)
3. registered with the receipts program, committing its policy hash: [tx](https://explorer.solana.com/tx/4MeZZSCrbjSe5pnkciDpssqyMWA3Ur3P5kqMPXiBBsZuVFaKTvCYnVbr2p3ZrtYXQcmbYRWp4zzWTq1Y6Qsbrf2i?cluster=devnet)

From then on, every action is a receipt.

## The problem

An agent that trades gives you a log file its operator controls. "It bought because the news was bullish" is a claim written after the fact. You cannot tell whether the evidence existed, whether the agent read it, whether the reasoning came before the trade, or whether the losing calls were quietly deleted.

## What Debate Desk does

Every cycle:

1. **Evidence.** The desk gathers one evidence pack: Pyth SOL/USD read straight from its Solana account, the Chainlink SOL/USD Data Feed (delivered by a Chainlink CRE workflow, see `cre/`), a CoinGecko market snapshot, and recent crypto headlines. Each item is normalised, hashed and saved under `data/evidence/`.
2. **Debate.** BULL and BEAR each build the strongest honest case for their side. They run independently and read the exact same evidence text. Every claim must cite evidence ids and state cause and effect.
3. **Ruling.** The JUDGE weighs both cases against the evidence itself, lists the points it rejects and why, and makes one decision covering entry, size and exit: BUY, SELL or HOLD, conviction, stop loss, take profit, horizon.
4. **Rules.** Plain code (`src/risk.ts`) decides whether the ruling may trade. It holds if the price is stale, if price sources disagree by more than 150 bps, if the judge cites evidence that is not in the pack, if the ruling contradicts itself, or if conviction is under 60. It clamps the exit plan to policy and sizes the ticket. Every check is written into the receipt, pass or fail.
5. **Receipt and trade, one transaction.** The receipt holds evidence hashes, transcript hashes, the ruling, the rule trace, the position and the Orca quote. Its sha256 goes to the Agent Receipts program in the **same transaction** as the Orca swap. The program rejects a BUY/SELL receipt without the desk's own swap beside it, and a HOLD receipt with one. A trade and its reasoning land together or not at all.
6. **Exit by rule.** While a position is open, no model is consulted. Later cycles close it when Pyth crosses the stop or the target, or when the horizon passes, and the closing receipt names the receipt that opened it.

Every model call runs at temperature 0 with a JSON schema. The full prompt and the raw response are saved under `data/transcripts/` and hashed into the receipt. The sha256 of the prompts, the model id and every risk limit forms the desk's `policy_hash`, committed on chain at registration. Changing a prompt or loosening a limit is an on-chain event.

## A repeatable reasoning trail

| Claim | How anyone checks it |
|---|---|
| The evidence existed and is unedited | each `data/evidence/*.json` re-hashes to the id in the receipt |
| Bull and bear argued from the same evidence | their recorded prompts are byte-identical and contain that evidence text |
| The ruling is the judge's own output | the ruling in the receipt equals the parsed response in the judge's transcript |
| The rules, not the model, decided the trade | replaying `risk.ts` on the recorded inputs gives the same action, size and trace |
| Entry, size and exit were one decision | the opening receipt carries the stop, target and horizon; the closing receipt cites it |
| Nothing was dropped, edited, reordered or backfilled | replaying the rolling head over every receipt equals the head stored on chain |
| The trade happened with the reasoning, not after | the attest instruction and the swap are in the same transaction |

```bash
git clone https://github.com/NoBanks/debate-desk && cd debate-desk && npm install
npx tsx src/verify.ts --tx all                 # everything, against devnet
npx tsx src/verify.ts https://raw.githubusercontent.com/NoBanks/debate-desk/main/data --tx all   # same, reading the data straight from GitHub
npx tsx src/verify.ts data --offline           # reasoning checks only, no network
```

The verifier needs no keys. Change one letter of one transcript and it fails.

## Layout

```
src/evidence.ts   evidence pack: Pyth (on chain), Chainlink via CRE, CoinGecko, RSS headlines
src/debate.ts     BULL, BEAR, JUDGE on Gemini, temperature 0, schema-bound, transcripts saved
src/risk.ts       the deterministic rules: entry gates, sizing, exit plan, exits
src/desk.ts       the cycle: evidence -> debate or exit check -> rules -> Orca quote -> receipt + swap in one tx
src/verify.ts     re-derives every claim from public data
src/site.ts       renders the public record to docs/index.html
cre/              Chainlink CRE workflow "evidence-oracle" (Chainlink feed + CoinGecko + news)
test/             rule tests
data/             the public record: ledger.jsonl, evidence/, transcripts/
```

## Run it

```bash
npm install
export GEMINI_API_KEY=...                       # never committed
npx tsx src/desk.ts keygen                      # key goes to ~/.config/debate-desk/, outside the repo
npx tsx src/desk.ts register                    # registers with the Agent Receipts program, commits policy_hash
npx tsx src/desk.ts once                        # one cycle
npx tsx src/desk.ts loop                        # forever, every CYCLE_SECONDS (default 900)
npx tsx src/site.ts                             # rebuild the public page
npm test                                        # rule tests
```

Dry run with no chain writes: `npx tsx scripts/dry_run.ts`.

## What was built for this hackathon, and what was not

**Pre-existing, reused as-is:** the Agent Receipts Solana program (Anchor/Rust) and its client code (`src/program.ts`, `src/canonical.ts`, `src/pyth.ts`), from [solana-agent-receipts](https://github.com/NoBanks/solana-agent-receipts), MIT, by the same author, built Sept 26-27 2026. Debate Desk uses the already deployed program and does not modify it.

**New for this hackathon (Oct 2026):** everything else. The evidence pack, the bull/bear/judge debate, the transcript commitments, the deterministic risk and exit rules, the position lifecycle, the reasoning verifier, the public page, and the Chainlink CRE workflow. See the git history.

## Day one: receipts #5 to #23

On 2026-10-20, about 23:08 UTC, receipts #5 to #23 landed seconds apart instead of 15 minutes apart. The cause was ours: the step that rebuilds the public page runs `site.ts` in a child process, `site.ts` imports `desk.ts`, and the child inherited the setting that tells the desk to loop. Each child ran a cycle and spawned another.

Every one of those receipts is true: a position was open, so each is a HOLD with its rule trace, and the chain and the verifier agree on all of them. The log is append-only, so they stay. The fix (commit "Fix runaway publish loop") makes the desk start only when its own file is the process entry, gives the publish child a clean environment, and refuses any cycle within 60 seconds of the last receipt, so even a second desk process cannot flood the log.

## What the numbers mean

The signal is the real SOL/USD market (Pyth, Chainlink, CoinGecko). Execution happens in an Orca devnet pool whose price is set by devnet liquidity, not the market. Trades are real devnet transactions with practice money. Profit and loss is measured at the market price, from receipt to receipt. This is evidence that the mechanism works, not a trading performance claim.

## License

MIT
