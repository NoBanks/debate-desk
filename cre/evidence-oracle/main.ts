// evidence-oracle: CRE workflow used as the orchestration layer for Debate Desk evidence.
//
// On every cron tick it:
//   1. Reads the Chainlink SOL/USD Data Feed (latestRoundData) on Ethereum mainnet via the EVM capability.
//   2. Fetches SOL market data from the CoinGecko public API via the HTTP capability (median consensus per field).
//   3. Fetches the top crypto news headlines from the CoinDesk RSS feed via the HTTP capability.
//   4. Computes the Chainlink vs CoinGecko divergence in basis points.
//   5. Logs one line "EVIDENCE_REPORT {json}" and returns the same JSON as the workflow result.
//
// The report contains only integers and strings (no floats). Prices are decimal strings.

import {
	bytesToHex,
	ConsensusAggregationByFields,
	consensusIdenticalAggregation,
	CronCapability,
	EVMClient,
	encodeCallMsg,
	getNetwork,
	HTTPClient,
	type HTTPSendRequester,
	handler,
	LAST_FINALIZED_BLOCK_NUMBER,
	median,
	ok,
	Runner,
	type Runtime,
	text,
} from '@chainlink/cre-sdk'
import { type Address, decodeFunctionResult, encodeFunctionData, parseAbi, zeroAddress } from 'viem'
import { z } from 'zod'

const configSchema = z.object({
	schedule: z.string(),
	chainSelectorName: z.string(),
	feedAddress: z.string(),
	feedPair: z.string(),
	coingeckoUrl: z.string(),
	newsRssUrl: z.string(),
	maxHeadlines: z.number().int().min(0).max(10),
})

type Config = z.infer<typeof configSchema>

const aggregatorV3Abi = parseAbi([
	'function decimals() view returns (uint8)',
	'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
])

// CoinGecko values scaled to integers so the DON can take a median per field.
type CoinGeckoData = {
	usdE8: number // USD price * 1e8
	change24hBps: number // 24h change in basis points
	vol24hUsd: number // 24h volume in whole USD
}

type Headline = { title: string; link: string }

// ---------- helpers ----------

// Format a scaled integer as a decimal string, e.g. (10678500182n, 8) -> "106.78500182"
const formatScaled = (value: bigint, decimals: number): string => {
	const negative = value < 0n
	const abs = negative ? -value : value
	const base = 10n ** BigInt(decimals)
	const whole = abs / base
	const frac = abs % base
	const fracStr = decimals > 0 ? '.' + frac.toString().padStart(decimals, '0') : ''
	return (negative ? '-' : '') + whole.toString() + fracStr
}

// Trim trailing zeros of a decimal string ("106.93000000" -> "106.93")
const trimDecimal = (s: string): string => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s)

const decodeEntities = (s: string): string =>
	s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&#8217;/g, "'")
		.replace(/&#8216;/g, "'")
		.replace(/&#8220;/g, '"')
		.replace(/&#8221;/g, '"')
		.replace(/&amp;/g, '&')

const stripCdata = (s: string): string => s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim()

// ---------- 1. Chainlink Data Feed read (EVM capability) ----------

const readChainlinkFeed = (runtime: Runtime<Config>) => {
	const network = getNetwork({
		chainFamily: 'evm',
		chainSelectorName: runtime.config.chainSelectorName,
		isTestnet: false,
	})
	if (!network) {
		throw new Error(`Network not found: ${runtime.config.chainSelectorName}`)
	}

	const evmClient = new EVMClient(network.chainSelector.selector)
	const feed = runtime.config.feedAddress as Address

	const call = (functionName: 'decimals' | 'latestRoundData') =>
		evmClient
			.callContract(runtime, {
				call: encodeCallMsg({
					from: zeroAddress,
					to: feed,
					data: encodeFunctionData({ abi: aggregatorV3Abi, functionName }),
				}),
				blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
			})
			.result()

	const decimalsRaw = call('decimals')
	const decimals = Number(
		decodeFunctionResult({ abi: aggregatorV3Abi, functionName: 'decimals', data: bytesToHex(decimalsRaw.data) }),
	)

	const roundRaw = call('latestRoundData')
	const [roundId, answer, , updatedAt] = decodeFunctionResult({
		abi: aggregatorV3Abi,
		functionName: 'latestRoundData',
		data: bytesToHex(roundRaw.data),
	}) as readonly [bigint, bigint, bigint, bigint, bigint]

	if (answer <= 0n) {
		throw new Error(`Chainlink feed returned non-positive answer: ${answer.toString()}`)
	}

	return { roundId, answer, updatedAt, decimals }
}

// ---------- 2. CoinGecko (HTTP capability, median consensus per field) ----------

const fetchCoinGecko = (sendRequester: HTTPSendRequester, config: Config): CoinGeckoData => {
	const resp = sendRequester
		.sendRequest({
			url: config.coingeckoUrl,
			method: 'GET' as const,
			headers: { Accept: 'application/json', 'User-Agent': 'debate-desk-evidence-oracle/1.0' },
		})
		.result()

	if (!ok(resp)) {
		throw new Error(`CoinGecko returned HTTP ${resp.statusCode}`)
	}

	const body = JSON.parse(text(resp)) as {
		solana?: { usd?: number; usd_24h_change?: number; usd_24h_vol?: number }
	}
	const sol = body.solana
	if (!sol || typeof sol.usd !== 'number') {
		throw new Error('CoinGecko response missing solana.usd')
	}

	return {
		usdE8: Math.round(sol.usd * 1e8),
		change24hBps: Math.round((sol.usd_24h_change ?? 0) * 100),
		vol24hUsd: Math.round(sol.usd_24h_vol ?? 0),
	}
}

// ---------- 3. News headlines (HTTP capability, identical consensus) ----------

const fetchHeadlines = (sendRequester: HTTPSendRequester, config: Config): string => {
	const resp = sendRequester
		.sendRequest({
			url: config.newsRssUrl,
			method: 'GET' as const,
			headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'debate-desk-evidence-oracle/1.0' },
		})
		.result()

	if (!ok(resp)) {
		throw new Error(`RSS feed returned HTTP ${resp.statusCode}`)
	}

	const xml = text(resp)
	const items: Headline[] = []
	const itemRe = /<item[\s>][\s\S]*?<\/item>/g
	let m: RegExpExecArray | null
	while ((m = itemRe.exec(xml)) !== null && items.length < config.maxHeadlines) {
		const block = m[0]
		const t = /<title[^>]*>([\s\S]*?)<\/title>/.exec(block)
		const l = /<link[^>]*>([\s\S]*?)<\/link>/.exec(block)
		if (!t) continue
		items.push({
			title: decodeEntities(stripCdata(t[1])),
			link: l ? decodeEntities(stripCdata(l[1])) : '',
		})
	}
	return JSON.stringify(items)
}

// ---------- workflow handler ----------

const onCronTrigger = (runtime: Runtime<Config>): string => {
	const cfg = runtime.config
	runtime.log(`evidence-oracle triggered | feed=${cfg.feedPair} ${cfg.feedAddress} on ${cfg.chainSelectorName}`)

	// 1. Onchain read
	const cl = readChainlinkFeed(runtime)
	runtime.log(
		`Chainlink ${cfg.feedPair}: answer=${cl.answer.toString()} decimals=${cl.decimals} roundId=${cl.roundId.toString()} updatedAt=${cl.updatedAt.toString()}`,
	)

	const httpClient = new HTTPClient()

	// 2. CoinGecko
	const cg = httpClient
		.sendRequest(
			runtime,
			fetchCoinGecko,
			ConsensusAggregationByFields<CoinGeckoData>({
				usdE8: median,
				change24hBps: median,
				vol24hUsd: median,
			}),
		)(cfg)
		.result()
	runtime.log(`CoinGecko SOL: usdE8=${cg.usdE8} change24hBps=${cg.change24hBps} vol24hUsd=${cg.vol24hUsd}`)

	// 3. Headlines (optional; failure does not fail the report)
	let headlines: Headline[] = []
	if (cfg.maxHeadlines > 0) {
		try {
			const raw = httpClient
				.sendRequest(runtime, fetchHeadlines, consensusIdenticalAggregation<string>())(cfg)
				.result()
			headlines = JSON.parse(raw) as Headline[]
		} catch (e) {
			runtime.log(`Headline fetch failed, continuing without headlines: ${String(e)}`)
		}
	}

	// 4. Divergence in basis points, computed on 1e8-scaled integers
	const clE8 =
		cl.decimals >= 8 ? cl.answer / 10n ** BigInt(cl.decimals - 8) : cl.answer * 10n ** BigInt(8 - cl.decimals)
	const cgE8 = BigInt(cg.usdE8)
	const diff = cgE8 > clE8 ? cgE8 - clE8 : clE8 - cgE8
	// rounded: (diff * 10000 + clE8/2) / clE8
	const divergenceBps = Number((diff * 10000n + clE8 / 2n) / clE8)

	const report = {
		type: 'cre_evidence_report',
		version: 1,
		chainlink: {
			chain: cfg.chainSelectorName,
			feed: cfg.feedAddress,
			pair: cfg.feedPair,
			answer: cl.answer.toString(),
			answer_decimal: trimDecimal(formatScaled(cl.answer, cl.decimals)),
			decimals: cl.decimals,
			updated_at: Number(cl.updatedAt),
			round_id: cl.roundId.toString(),
		},
		coingecko: {
			usd: trimDecimal(formatScaled(cgE8, 8)),
			change_24h_bps: cg.change24hBps,
			vol_24h_usd: String(cg.vol24hUsd),
		},
		divergence_bps: divergenceBps,
		headlines,
		headlines_source: cfg.maxHeadlines > 0 ? cfg.newsRssUrl : '',
		generated_at: Math.floor(runtime.now().getTime() / 1000),
	}

	const json = JSON.stringify(report)
	runtime.log(`EVIDENCE_REPORT ${json}`)
	return json
}

const initWorkflow = (config: Config) => {
	const cron = new CronCapability()
	return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)]
}

export async function main() {
	const runner = await Runner.newRunner<Config>({ configSchema })
	await runner.run(initWorkflow)
}

main()
