#!/usr/bin/env node
// Runs `cre workflow simulate` for the evidence-oracle workflow non-interactively and prints
// ONLY the EVIDENCE_REPORT JSON (one line) to stdout. Exits nonzero on any failure.
//
// Usage:
//   node simulate.mjs              -> prints the JSON line
//   node simulate.mjs --save       -> also writes the full simulator output to SIMULATION_OUTPUT.txt
//   node simulate.mjs --verbose    -> streams the simulator output to stderr while it runs
//
// Auth: the CRE CLI requires `cre login` (one time, browser) or the CRE_API_KEY env var.
//
// Windows note: CRE CLI v1.38 + Bun's node_modules/.bin shims break when the project path
// contains spaces ("Too many positional arguments"). If the path has spaces, this script
// runs the simulator through a space-free directory junction in the temp folder, and puts a
// real bun.exe (~/.bun/bin) first on PATH when one exists.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = new Set(process.argv.slice(2))
const SAVE = args.has('--save')
const VERBOSE = args.has('--verbose')
const TIMEOUT_MS = Number(process.env.CRE_SIM_TIMEOUT_MS || 240000)

const here = path.dirname(fileURLToPath(import.meta.url))
const isWin = process.platform === 'win32'

const fail = (msg, code = 1) => {
	process.stderr.write(`simulate.mjs: ${msg}\n`)
	process.exit(code)
}

// Locate the cre binary
const findCre = () => {
	if (process.env.CRE_BIN && existsSync(process.env.CRE_BIN)) return process.env.CRE_BIN
	const candidates = isWin
		? [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cre', 'cre.exe')]
		: [path.join(os.homedir(), '.cre', 'bin', 'cre'), '/usr/local/bin/cre']
	for (const c of candidates) if (existsSync(c)) return c
	return isWin ? 'cre.exe' : 'cre' // fall back to PATH
}

// Pick a project root without spaces (Windows workaround)
const projectRoot = () => {
	if (!isWin || !here.includes(' ')) return here
	const link = path.join(os.tmpdir(), 'debate-desk-cre-link')
	if (link.includes(' ')) fail(`temp dir has spaces too (${link}); move the project to a path without spaces`)
	let ok = false
	try {
		ok = path.resolve(readlinkSync(link)).toLowerCase() === path.resolve(here).toLowerCase()
	} catch {}
	if (!ok) {
		try {
			rmSync(link, { recursive: false, force: true })
		} catch {}
		mkdirSync(path.dirname(link), { recursive: true })
		symlinkSync(here, link, 'junction')
	}
	return link
}

const env = { ...process.env }
const bunHome = path.join(os.homedir(), '.bun', 'bin')
if (existsSync(path.join(bunHome, isWin ? 'bun.exe' : 'bun'))) {
	env.PATH = bunHome + path.delimiter + (env.PATH || env.Path || '')
	if (isWin) delete env.Path
}

const root = projectRoot()
const cre = findCre()
const creArgs = [
	'workflow',
	'simulate',
	'./evidence-oracle',
	'--target',
	'staging-settings',
	'--trigger-index',
	'0',
	'--non-interactive',
]

const started = Date.now()
const child = spawn(cre, creArgs, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

let output = ''
const onData = (chunk) => {
	const s = chunk.toString()
	output += s
	if (VERBOSE) process.stderr.write(s)
}
child.stdout.on('data', onData)
child.stderr.on('data', onData)

const timer = setTimeout(() => {
	child.kill()
	fail(`simulation timed out after ${TIMEOUT_MS} ms`)
}, TIMEOUT_MS)

child.on('error', (e) => fail(`could not start cre (${cre}): ${e.message}`))

child.on('close', (code) => {
	clearTimeout(timer)
	const seconds = ((Date.now() - started) / 1000).toFixed(1)
	if (SAVE) writeFileSync(path.join(here, 'SIMULATION_OUTPUT.txt'), output)

	// Find the EVIDENCE_REPORT log line and extract the JSON after the prefix
	const marker = 'EVIDENCE_REPORT '
	let report = null
	for (const line of output.split(/\r?\n/)) {
		const i = line.indexOf(marker)
		if (i === -1) continue
		const candidate = line.slice(i + marker.length).trim()
		const start = candidate.indexOf('{')
		const end = candidate.lastIndexOf('}')
		if (start === -1 || end === -1) continue
		try {
			const parsed = JSON.parse(candidate.slice(start, end + 1))
			if (parsed && parsed.type === 'cre_evidence_report') report = parsed
		} catch {}
	}

	if (code !== 0 || !report) {
		const tail = output.split(/\r?\n/).filter(Boolean).slice(-25).join('\n')
		fail(`simulation failed (exit ${code}, ${seconds}s). Last output:\n${tail}`, code || 2)
	}
	process.stderr.write(`simulate.mjs: ok in ${seconds}s\n`)
	process.stdout.write(JSON.stringify(report) + '\n')
	process.exit(0)
})
