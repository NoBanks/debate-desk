# evidence-oracle (Chainlink CRE workflow)

A Chainlink Runtime Environment (CRE) workflow, written with the CRE TypeScript SDK, that serves as the orchestration layer for Debate Desk evidence. On a cron schedule it combines one blockchain read with two external APIs and returns one evidence report.

## What it does

On every cron tick (every 5 minutes, `0 */5 * * * *`):

1. **Blockchain read (EVM capability):** calls `decimals()` and `latestRoundData()` on the Chainlink SOL/USD Data Feed proxy `0x4ffC43a60e009B551865A93d232E33Fce9f01507` on Ethereum mainnet (finalized block). Ethereum Sepolia has no SOL/USD feed, so mainnet is used (read-only, no wallet, no gas).
2. **External API (HTTP capability):** GET CoinGecko `simple/price` for SOL (price, 24h change, 24h volume). Each value is scaled to an integer and aggregated with median consensus per field.
3. **External data source (HTTP capability):** GET the CoinDesk RSS feed and keep the top 5 headlines (title + link), identical consensus. If this fails, the report is still produced with an empty list.
4. **Compute:** divergence between the Chainlink price and the CoinGecko price in basis points (integer math on 1e8-scaled values).
5. **Output:** logs one line `EVIDENCE_REPORT {json}` and returns the same JSON as the workflow result. The JSON contains only integers and strings (prices are decimal strings).

Feed address source: Chainlink feed directory (the data behind docs.chain.link/data-feeds/price-feeds/addresses), file `https://reference-data-directory.vercel.app/feeds-mainnet.json`, entry "SOL / USD", proxy `0x4ffC43a60e009B551865A93d232E33Fce9f01507`, 8 decimals, heartbeat 86400s. Also checked onchain with `eth_call` against a public RPC.

## Layout

```
cre/
  project.yaml               RPCs (public Ethereum mainnet RPC, no keys)
  simulate.mjs               runs the simulator, prints only the EVIDENCE_REPORT JSON
  evidence-oracle/
    main.ts                  the workflow
    config.json              schedule, feed address, API URLs
    workflow.yaml            CRE workflow targets
    package.json             @chainlink/cre-sdk, viem, zod
```

## Requirements

- Bun 1.x (TypeScript workflows compile with Bun)
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

## Result

Compilation to WASM succeeds (`cre workflow build ./evidence-oracle -T staging-settings`, about 20s).

Simulation status: PENDING. It is blocked only on CRE account login (see Requirements). Once logged in, run `node simulate.mjs --save` and paste the result here.
