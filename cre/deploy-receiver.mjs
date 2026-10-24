#!/usr/bin/env node
// Compile contracts/EvidenceReceiver.sol with solc-js and deploy it to Ethereum Sepolia.
//
//   node deploy-receiver.mjs            compile + deploy, writes receiver.json
//   node deploy-receiver.mjs --compile  compile only
//
// Key: CRE_ETH_PRIVATE_KEY in cre/.env (gitignored), the same wallet `cre workflow simulate
// --broadcast` signs with. The receiver accepts reports only from FORWARDER: the CRE
// MockKeystoneForwarder on Sepolia, from
// https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, 'evidence-oracle', 'package.json'))
const solc = require('solc')
const { createPublicClient, createWalletClient, http } = require('viem')
const { privateKeyToAccount } = require('viem/accounts')
const { sepolia } = require('viem/chains')

const FORWARDER = '0x15fC6ae953E024d975e77382eEeC56A9101f9F88'
const RPC = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'

const source = readFileSync(path.join(here, 'contracts', 'EvidenceReceiver.sol'), 'utf8')
const out = JSON.parse(
	solc.compile(
		JSON.stringify({
			language: 'Solidity',
			sources: { 'EvidenceReceiver.sol': { content: source } },
			settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
		}),
	),
)
const errors = (out.errors || []).filter((e) => e.severity === 'error')
if (errors.length) {
	console.error(errors.map((e) => e.formattedMessage).join('\n'))
	process.exit(1)
}
const c = out.contracts['EvidenceReceiver.sol'].EvidenceReceiver
const abi = c.abi
const bytecode = `0x${c.evm.bytecode.object}`
writeFileSync(path.join(here, 'contracts', 'EvidenceReceiver.abi.json'), JSON.stringify(abi, null, 2) + '\n')
console.log(`compiled EvidenceReceiver: ${(bytecode.length - 2) / 2} bytes, solc ${solc.version()}`)
if (process.argv.includes('--compile')) process.exit(0)

const env = readFileSync(path.join(here, '.env'), 'utf8')
const raw = /^\s*CRE_ETH_PRIVATE_KEY\s*=\s*["']?([0-9a-fA-Fx]+)/m.exec(env)?.[1]
if (!raw) throw new Error('CRE_ETH_PRIVATE_KEY missing from cre/.env')
const account = privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`)
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) })
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) })

console.log(`deployer ${account.address}, balance ${await pub.getBalance({ address: account.address })} wei`)
const hash = await wallet.deployContract({ abi, bytecode, args: [FORWARDER] })
console.log(`deploy tx ${hash}`)
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`deploy failed: ${receipt.status}`)
const info = {
	chain: 'ethereum-testnet-sepolia',
	chain_id: 11155111,
	address: receipt.contractAddress,
	forwarder: FORWARDER,
	forwarder_kind: 'MockKeystoneForwarder (cre workflow simulate --broadcast)',
	deploy_tx: hash,
	deployer: account.address,
	block: Number(receipt.blockNumber),
	gas_used: Number(receipt.gasUsed),
	deployed_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
	explorer: `https://sepolia.etherscan.io/address/${receipt.contractAddress}`,
}
writeFileSync(path.join(here, 'receiver.json'), JSON.stringify(info, null, 2) + '\n')
console.log(JSON.stringify(info, null, 2))
