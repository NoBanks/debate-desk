#!/usr/bin/env node
// Read the Sepolia EvidenceReceiver: how many reports it accepted, the latest stored values, and
// (optionally) whether a given anchor tx emitted EvidenceAnchored with the expected report hash.
//
//   node check-anchor.mjs [txHash] [expectedReportKeccak256]

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, 'evidence-oracle', 'package.json'))
const { createPublicClient, http, parseEventLogs } = require('viem')
const { sepolia } = require('viem/chains')

const info = JSON.parse(readFileSync(path.join(here, 'receiver.json'), 'utf8'))
const abi = JSON.parse(readFileSync(path.join(here, 'contracts', 'EvidenceReceiver.abi.json'), 'utf8'))
const pub = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com') })
const read = (functionName) => pub.readContract({ address: info.address, abi, functionName })

const out = {
	receiver: info.address,
	count: String(await read('count')),
	lastReportHash: await read('lastReportHash'),
	lastChainlinkAnswer: String(await read('lastChainlinkAnswer')),
	lastCoinbaseUsdE8: String(await read('lastCoinbaseUsdE8')),
	lastDivergenceBps: Number(await read('lastDivergenceBps')),
	lastGeneratedAt: Number(await read('lastGeneratedAt')),
}
const [tx, want] = process.argv.slice(2)
if (tx) {
	const r = await pub.getTransactionReceipt({ hash: tx })
	const ev = parseEventLogs({ abi, logs: r.logs, eventName: 'EvidenceAnchored' })
	out.tx = { hash: tx, status: r.status, to: r.to, gasUsed: String(r.gasUsed), evidenceAnchoredEvents: ev.length, reportHash: ev[0]?.args.reportHash ?? null }
	if (want) out.tx.matches = (ev[0]?.args.reportHash ?? '').toLowerCase() === want.toLowerCase()
}
console.log(JSON.stringify(out, null, 2))
