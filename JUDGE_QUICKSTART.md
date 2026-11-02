# Judge quickstart (under 3 minutes)

Debate Desk: a bull agent and a bear agent argue about SOL from the same evidence, a judge rules, fixed code rules decide whether the ruling may trade, and the full reasoning trail is committed on chain in the same transaction as the trade. Nothing here needs a key, a wallet or an account.

## Live URLs

| What | URL |
|---|---|
| Public record (all decisions) | https://nobanks.github.io/debate-desk/ |
| Printable Decision Record for one receipt | https://nobanks.github.io/debate-desk/record.html?seq=1018 |
| Live desk behind a tunnel (PM2 on the author's laptop) | [NEED] URL not named in the README or code. The laptop can be offline, so use the two links above first. |

## Path A: browser only (about 2 minutes)

1. Open https://nobanks.github.io/debate-desk/. Each card is one decision (BUY, SELL or HOLD) with its evidence, bull and bear cases, judge ruling and rule trace.
2. On any card, click its **Decision Record** link, or open https://nobanks.github.io/debate-desk/record.html?seq=1018 directly. Receipt #1018 is a full debate that ended in a SELL entry, with public-voice (KOL) evidence.
3. Wait a few seconds. The page re-checks the record in your browser and stamps it **VERIFIED**, **FAILED** or **INCOMPLETE**. You should see **VERIFIED**. The checks are: receipt hash, every evidence file and transcript, identical bull and bear prompts, the judge's own output, the link to the previous record, and the Solana transaction itself.
4. Click the Solana transaction link on the record. On the explorer you should see a successful devnet transaction that holds both the Orca swap and the receipts program's attest instruction.

## Path B: re-check it yourself from the repo (about 2 minutes)

Needs Node 22 or newer. No keys.

```bash
git clone https://github.com/NoBanks/debate-desk && cd debate-desk
npm install
npm test                                       # 43 unit tests, no network
npx tsx src/verify.ts data --offline           # re-derives every recorded claim, no network
npx tsx src/verify.ts --tx all                 # also checks every transaction on Solana devnet (needs network)
```

Expected from the offline verifier (as of receipt #1025): `"ok": true` and `"problems": []`.

## Where the on-chain records can be verified

There are two chains, and they hold different things:

- **Decision records: Solana devnet.** Every receipt hash is committed by the Agent Receipts program, in the same transaction as the trade. Desk log account: [Ahw9K3YcVcaKZTKyx7u5QBCfoMKLLjhZz5ZFDqm3Y5gR](https://explorer.solana.com/address/Ahw9K3YcVcaKZTKyx7u5QBCfoMKLLjhZz5ZFDqm3Y5gR?cluster=devnet). Per-receipt transaction link pattern: `https://explorer.solana.com/tx/<signature>?cluster=devnet`. For example, receipt #1018: [transaction](https://explorer.solana.com/tx/2Yac2XQNQi85LzMzXp6MA967ioJzctusGyt4NuEkJvj5aZVpsJC3fbsZje4YAXSJNeK38iyA81ydoqNGGMfDKMsP?cluster=devnet).
- **Chainlink CRE evidence anchor: Ethereum Sepolia.** The CRE workflow in `cre/` reads the Chainlink SOL/USD feed and writes a signed digest of its evidence report to the `EvidenceReceiver` contract. Contract: [0xf917e04fec9dba42c485cd2d3425d7c7dbc94566](https://sepolia.etherscan.io/address/0xf917e04fec9dba42c485cd2d3425d7c7dbc94566). Per-receipt link pattern: `https://sepolia.etherscan.io/tx/<anchor_tx>`, where `anchor_tx` is stored in the receipt's `CL` evidence item (the record page shows it as "anchored on Ethereum Sepolia"). For example, the anchor used by receipt #1018: [0x0fac1aa2...50ea](https://sepolia.etherscan.io/tx/0x0fac1aa2b842abf982a3315226d7537ca18e059505cead938f4f1057d81750ea). On the transaction page, the `EvidenceAnchored` event carries the report hash `0xb31e3f28...0cd0`. The first verified anchor is [0xe493538a...73fc](https://sepolia.etherscan.io/tx/0xe493538aa8d6293b647a8fe22a40f8ebf1c398d7285dd3ce28504047a4b673fc).

## What this is not

Trades are practice money on Solana devnet, and execution happens in an Orca devnet pool whose price is set by devnet liquidity, not the market. This is evidence that the mechanism works, not a trading performance claim.
