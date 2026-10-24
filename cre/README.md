# evidence-oracle (Chainlink CRE workflow)

A Chainlink Runtime Environment (CRE) workflow, written with the CRE TypeScript SDK, that serves as the orchestration layer for Debate Desk evidence. On a cron schedule it combines one blockchain read with two external APIs, returns one evidence report, and **writes a signed digest of that report on-chain to Ethereum Sepolia**.

- Receiver contract: [`0xf917e04fec9dba42c485cd2d3425d7c7dbc94566`](https://sepolia.etherscan.io/address/0xf917e04fec9dba42c485cd2d3425d7c7dbc94566) (`contracts/EvidenceReceiver.sol`, details in `receiver.json`)
- First verified anchor: [`0xe493538a...73fc`](https://sepolia.etherscan.io/tx/0xe493538aa8d6293b647a8fe22a40f8ebf1c398d7285dd3ce28504047a4b673fc). The contract's stored `lastReportHash` equalled the keccak256 of the report the workflow built.
- The desk broadcasts on every cycle (every 15 minutes), and from receipt #281 each receipt's `CL` evidence item names its anchor transaction.

## What it does

On every cron tick (every 5 minutes, `0 */5 * * * *`):

1. **Blockchain read (EVM capability):** calls `decimals()` and `latestRoundData()` on the Chainlink SOL/USD Data Feed proxy `0x4ffC43a60e009B551865A93d232E33Fce9f01507` on Ethereum mainnet (finalized block). Ethereum Sepolia has no SOL/USD feed, so mainnet is used (read-only, no wallet, no gas).
2. **External API (HTTP capability):** GET Coinbase Exchange `products/SOL-USD/stats` (last price, 24h change, 24h volume). Each value is scaled to an integer and aggregated with median consensus per field. Up to 3 attempts, because a cold first connection can hit the simulator's 10s HTTP limit.
3. **External data source (HTTP capability):** GET the CoinDesk RSS feed and keep the top 5 headlines (title + link), identical consensus. If this fails, the report is still produced with an empty list.
4. **Compute:** divergence between the Chainlink price and the Coinbase price in basis points (integer math on 1e8-scaled values).
5. **On-chain write (EVM capability):** ABI-encodes `(int256 chainlinkAnswer, uint8 decimals, uint64 updatedAt, uint256 coinbaseUsdE8, uint32 divergenceBps, uint64 generatedAt, bytes32 reportHash)`, where `reportHash` is the keccak256 of the report JSON. `runtime.report()` signs it (ecdsa, keccak256), and `EVMClient.writeReport()` delivers it through the Keystone forwarder to `EvidenceReceiver` on `ethereum-testnet-sepolia`. The receiver accepts reports only from the forwarder, stores the latest values and emits `EvidenceAnchored`. A failed write is recorded in the report's `anchor` field and never drops the evidence.
6. **Output:** logs one line `EVIDENCE_REPORT {json}` and returns the same JSON as the workflow result, including `anchor` (`status`, `tx_hash`, `report_keccak256`). The JSON contains only integers and strings (prices are decimal strings).

Feed address source: Chainlink feed directory (the data behind docs.chain.link/data-feeds/price-feeds/addresses), file `https://reference-data-directory.vercel.app/feeds-mainnet.json`, entry "SOL / USD", proxy `0x4ffC43a60e009B551865A93d232E33Fce9f01507`, 8 decimals, heartbeat 86400s. Also checked onchain with `eth_call` against a public RPC.

## Layout

```
cre/
  project.yaml               RPCs (public Ethereum mainnet + Sepolia RPCs, no keys)
  simulate.mjs               runs the simulator (with --broadcast when cre/.env has a key), prints only the EVIDENCE_REPORT JSON
  contracts/                 EvidenceReceiver.sol (IReceiver) and its ABI
  deploy-receiver.mjs        compiles with solc-js and deploys to Sepolia, writes receiver.json
  check-anchor.mjs           reads the receiver: report count, latest stored values, event in a given tx
  receiver.json              deployed address, forwarder, deploy tx
  evidence-oracle/
    main.ts                  the workflow
    config.json              schedule, feed address, API URLs
    workflow.yaml            CRE workflow targets
    package.json             @chainlink/cre-sdk, viem, zod
```

## Requirements

- Bun 1.2.21 or newer (tested with 1.4.3). Older Bun compiles fine but the simulator then fails with `failed to execute subscribe ... wasm trap: unreachable`.
- CRE CLI (tested with v1.38.0)
- A CRE account. Every CRE CLI command except build/hash needs auth, including `simulate`. Either run `cre login` once (opens a browser) or set `CRE_API_KEY`.

## Install and run

1. Install the CRE CLI (PowerShell):
   ```powershell
   irm https://app.chain.link/cre/install.ps1 | iex
   ```
   It installs to `%LOCALAPPDATA%\Programs\cre\cre.exe`. Open a new terminal, then run `cre version`.
2. Create a CRE account at https://app.chain.link/cre/discover, then log in the CLI:
   ```
   cre login
   ```
3. Install workflow dependencies:
   ```
   cd evidence-oracle
   bun install
   cd ..
   ```
4. Run the simulation:
   ```
   node simulate.mjs           # prints only the EVIDENCE_REPORT JSON line
   node simulate.mjs --save    # also writes the full output to SIMULATION_OUTPUT.txt
   ```
   Or call the CLI directly (from a path without spaces, see note below):
   ```
   cre workflow simulate ./evidence-oracle --target staging-settings --trigger-index 0 --non-interactive
   ```

**Windows note:** CRE CLI v1.38 with Bun's `node_modules/.bin` shims fails with "Too many positional arguments" when the project path contains spaces. `simulate.mjs` works around this automatically: it runs through a directory junction at `%TEMP%\debate-desk-cre-link` and puts the real `bun.exe` from `%USERPROFILE%\.bun\bin` first on PATH.

## On-chain broadcast

1. Put a Sepolia test wallet key in `cre/.env` (gitignored): `CRE_ETH_PRIVATE_KEY=<64 hex chars, no 0x>`.
2. Deploy the receiver once: `node deploy-receiver.mjs`. It is constructed with the CRE `MockKeystoneForwarder` on Sepolia, `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` (from the [forwarder directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts)). Put the address in `evidence-oracle/config.json` as `receiverAddress`.
3. `node simulate.mjs --broadcast --save` runs `cre workflow simulate ... --broadcast`, and the write becomes a real Sepolia transaction.
4. `node check-anchor.mjs <txHash> <reportKeccak256>` proves the receiver really stored it.

**Gas note, learned the hard way:** with `gasLimit` 500000 the forwarder transaction showed success, but the receiver ran out of gas inside it and stored nothing (count stayed 0, no event). Sepolia now charges far more for new storage. The workflow uses 3000000, and `check-anchor.mjs` reads the contract instead of trusting the transaction status. At current Sepolia gas prices each anchor costs a tiny fraction of a cent in test ETH.

## Result

Simulation succeeds (CRE CLI v1.38.0, Bun 1.4.3, Windows, 2026-10-21). Full output: [`SIMULATION_OUTPUT.txt`](SIMULATION_OUTPUT.txt). The key lines:

```
[USER LOG] Chainlink SOL/USD: answer=10675944278 decimals=8 roundId=36893488147419106566 updatedAt=1792505279
[USER LOG] Coinbase SOL-USD: usdE8=10593000000 change24hBps=69 vol24hUsd=69416672
[USER LOG] EVIDENCE_REPORT {"type":"cre_evidence_report","version":1,"chainlink":{...,"answer_decimal":"106.75944278",...},"coinbase":{...,"usd":"105.93",...},"divergence_bps":78,"headlines":[5 CoinDesk headlines],...}
Simulation complete!
```

(The simulator prints local time with a `Z` suffix; the run was at 03:40 UTC.)

Debate Desk runs this simulation every cycle (`src/evidence.ts`, `creItem`). The Chainlink price becomes evidence item `CL`, which the bull, bear and judge all read, and which the risk rules cross-check against Pyth, Coinbase and Kraken before any trade.
