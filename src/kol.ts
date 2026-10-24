/**
 * kol.ts - what public market voices are saying, read without a model.
 *
 * The desk watches up to 20 public Telegram channels (KOL_CHANNELS, default list
 * below) through their keyless web preview at https://t.me/s/<channel>. Every
 * post that names a token becomes a signal: token(s), stance, conviction and
 * urgency, decided by the fixed word lists in this file, and stored next to the
 * literal quote it was read from. No model is involved, so the classification is
 * a pure function of the quote: verify.ts re-runs classify() on every recorded
 * quote and recomputes convergence, and any edit to a signal fails the check.
 *
 * Convergence: when 2+ distinct voices hold the same net stance on the same
 * token inside the window, that narrative is flagged. The result is one
 * hashed evidence item (id KOL) that bull, bear and judge all read and cite,
 * and that risk.ts may use only to SHRINK a trade (see LIMITS.kol_*).
 */
import { ascii } from "./evidence.js";
import { receiptHash, type Json } from "./canonical.js";

export const KOL_RULES_VERSION = "kol-v1";
export const KOL_WINDOW_HOURS = 12;
export const KOL_MIN_VOICES = 2;
export const KOL_MAX_CHANNELS = 20;
const QUOTE_MAX = 280;
const SIGNALS_PER_VOICE = 4;

/** Public market news and on-chain alert channels whose previews answer without login (checked 2026-10-24). */
export const DEFAULT_KOL_CHANNELS = [
  "WatcherGuru",
  "wublockchainenglish",
  "lookonchainchannel",
  "whale_alert_io",
  "cointelegraph",
  "unfolded",
  "CoinBureau",
  "the_block_crypto",
  "DegenerateNews",
];

export function kolChannels(): string[] {
  const env = process.env.KOL_CHANNELS?.split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_]{4,64}$/.test(s));
  return (env?.length ? env : DEFAULT_KOL_CHANNELS).slice(0, KOL_MAX_CHANNELS);
}

export type Stance = "BULL" | "BEAR" | "NEUTRAL";

export type Classification = {
  tokens: string[];
  stance: Stance;
  conviction: number;
  urgency: "HIGH" | "NORMAL";
  matched: string[];
};

export type Signal = Classification & { voice: string; post: string; posted_at: string; quote: string };

export type Convergence = { token: string; stance: "BULL" | "BEAR"; voices: string[]; n: number };

// Named tokens: the ticker is matched case-sensitively (so "sol" in a Spanish headline is not SOL),
// the full name case-insensitively.
const NAMED: [string, RegExp | null][] = [
  ["SOL", /\bsolana\b/i],
  ["BTC", /\bbitcoin\b/i],
  ["ETH", /\bethereum\b|\bether\b/i],
  ["XRP", null],
  ["BNB", null],
  ["DOGE", /\bdogecoin\b/i],
  ["USDT", /\btether\b/i],
  ["USDC", null],
];
const tickerRe = (t: string) => new RegExp(`(?:^|[^A-Za-z0-9])[$#]?${t}(?![A-Za-z0-9])`);
const CASHTAG = /[$#]([A-Z][A-Z0-9]{1,9})(?![A-Za-z0-9])/g;
const NOT_TOKENS = new Set(["USD", "US", "ETF", "SEC", "CEO", "AI", "NFT", "DEFI", "BREAKING", "JUST", "IN", "NEW", "UK", "EU", "GDP", "CPI", "FED", "OKEX", "OKX", "HTX"]);

const BULL_TERMS: [string, RegExp][] = [
  ["bullish", /\bbullish\b/i],
  ["surge", /\bsurg(e|es|ed|ing)\b/i],
  ["soar", /\bsoar(s|ed|ing)?\b/i],
  ["rally", /\brall(y|ies|ied|ying)\b/i],
  ["jump", /\bjump(s|ed|ing)?\b/i],
  ["climb", /\bclimb(s|ed|ing)?\b/i],
  ["gain", /\bgain(s|ed|ing)?\b/i],
  ["rebound", /\brebound(s|ed|ing)?\b/i],
  ["breakout", /\bbreak(s|ing)? ?out\b/i],
  ["all-time high", /\ball[- ]time high\b|\bATH\b|\brecord high\b/i],
  ["inflow", /\binflows?\b/i],
  ["buy", /\b(buy|buys|buying|bought)\b/i],
  ["accumulate", /\baccumulat\w*\b/i],
  ["approve", /\bapprov(e|es|ed|al)\b/i],
  ["adopt", /\badopt\w*\b/i],
  ["pump", /\bpump(s|ed|ing)?\b/i],
  ["up %", /\bup \d+(\.\d+)?%/i],
  ["withdrawn from exchange", /\bfrom #?(binance|coinbase|kraken|okx|okex|bybit|bitfinex|htx|gemini|kucoin|bitget|upbit)\b[^.]*\bto unknown\b/i],
  ["stablecoin minted", /\b(USDT|USDC)\b[^.]*\bminted\b/i],
];
const BEAR_TERMS: [string, RegExp][] = [
  ["bearish", /\bbearish\b/i],
  ["plunge", /\bplung(e|es|ed|ing)\b/i],
  ["crash", /\bcrash(es|ed|ing)?\b/i],
  ["dump", /\bdump(s|ed|ing)?\b/i],
  // "drop" and "fall" only as price moves: "drops criminal case" is not bearish
  ["drop", /\b(drop|drops|dropped|dropping)( by)? \d+(\.\d+)?%|\b(drop|drops|dropped|dropping) (below|under|to) \$?\d|\bprice drop\b/i],
  ["fall", /\b(fall|falls|fell|falling|fallen)( by)? \d+(\.\d+)?%|\b(fall|falls|fell|falling|fallen) (below|under|to) \$?\d/i],
  ["slide", /\bslid(e|es|ing)\b/i],
  ["slump", /\bslump(s|ed|ing)?\b/i],
  ["tumble", /\btumbl(e|es|ed|ing)\b/i],
  ["sell-off", /\bsell-?offs?\b/i],
  ["outflow", /\boutflows?\b/i],
  ["sell", /\b(sell|sells|selling|sold)\b/i],
  ["hack", /\bhack(s|ed|er|ers)?\b|\bexploit(s|ed)?\b|\bdrained\b/i],
  ["liquidation", /\bliquidat\w*\b/i],
  ["lawsuit", /\blawsuit\b|\bsue[sd]?\b|\bfraud\b/i],
  ["ban", /\bban(s|ned)?\b|\bdelist\w*\b/i],
  ["down %", /\bdown \d+(\.\d+)?%/i],
  ["sent to exchange", /\bfrom unknown( new)? wallet to #?(binance|coinbase|kraken|okx|okex|bybit|bitfinex|htx|gemini|kucoin|bitget|upbit)\b/i],
];
const URGENT = /\b(BREAKING|JUST IN|URGENT|ALERT)\b/;
const PERCENT = /(\d+(?:\.\d+)?)%/g;

/** Pure function of the quote. verify.ts calls this on every recorded quote. */
export function classify(quote: string): Classification {
  const found = new Set<string>();
  for (const [t, name] of NAMED) if (tickerRe(t).test(quote) || name?.test(quote)) found.add(t);
  for (const m of quote.matchAll(CASHTAG)) if (!NOT_TOKENS.has(m[1])) found.add(m[1]);
  const tokens = [...found].sort().slice(0, 6);
  const bull = BULL_TERMS.filter(([, re]) => re.test(quote)).map(([n]) => n);
  const bear = BEAR_TERMS.filter(([, re]) => re.test(quote)).map(([n]) => n);
  const diff = bull.length - bear.length;
  const stance: Stance = diff > 0 ? "BULL" : diff < 0 ? "BEAR" : "NEUTRAL";
  const urgency = URGENT.test(quote) ? "HIGH" : "NORMAL";
  // any figure of 5% or more in a post that already has a stance counts as a big move
  const big = [...quote.matchAll(PERCENT)].some((m) => Number(m[1]) >= 5);
  const conviction = stance === "NEUTRAL" ? 0 : Math.min(100, 40 + 15 * (Math.abs(diff) - 1) + (big ? 15 : 0) + (urgency === "HIGH" ? 15 : 0));
  return { tokens, stance, conviction, urgency, matched: [...bull.map((b) => `+${b}`), ...bear.map((b) => `-${b}`)] };
}

function decodeHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export type Post = { voice: string; post: string; posted_at: string; quote: string };

/** Posts from one https://t.me/s/<channel> page, oldest first, as on the page. */
export function parseChannelPage(channel: string, html: string): Post[] {
  const out: Post[] = [];
  for (const block of html.split('data-post="').slice(1)) {
    const id = block.slice(0, block.indexOf('"'));
    if (!/^[A-Za-z0-9_]+\/\d+$/.test(id)) continue;
    // a reply preview also carries message text; the post's own text is the last one in the block
    const texts = [...block.matchAll(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
    const when = /<time datetime="([^"]+)"/.exec(block)?.[1];
    if (!texts.length || !when) continue;
    const t = Date.parse(when);
    if (!Number.isFinite(t)) continue;
    let quote = ascii(decodeHtml(texts[texts.length - 1][1]));
    if (quote.length > QUOTE_MAX) quote = quote.slice(0, QUOTE_MAX - 3).trimEnd() + "...";
    if (!quote) continue;
    out.push({ voice: channel, post: `https://t.me/${id}`, posted_at: new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z"), quote });
  }
  return out;
}

/** Each voice's net stance per token, then voices counted per token and stance. */
export function convergence(signals: Signal[], minVoices = KOL_MIN_VOICES): Convergence[] {
  const net = new Map<string, Map<string, number>>(); // token -> voice -> sum
  for (const s of signals) {
    if (s.stance === "NEUTRAL") continue;
    for (const t of s.tokens) {
      const byVoice = net.get(t) ?? new Map<string, number>();
      byVoice.set(s.voice, (byVoice.get(s.voice) ?? 0) + (s.stance === "BULL" ? 1 : -1));
      net.set(t, byVoice);
    }
  }
  const out: Convergence[] = [];
  for (const [token, byVoice] of net) {
    for (const stance of ["BULL", "BEAR"] as const) {
      const voices = [...byVoice].filter(([, v]) => (stance === "BULL" ? v > 0 : v < 0)).map(([voice]) => voice).sort();
      if (voices.length >= minVoices) out.push({ token, stance, voices, n: voices.length });
    }
  }
  return out.sort((a, b) => b.n - a.n || a.token.localeCompare(b.token) || a.stance.localeCompare(b.stance));
}

export function solSummary(signals: Signal[]): { bull_voices: number; bear_voices: number; converged: string } {
  const c = convergence(signals, 1).filter((x) => x.token === "SOL");
  const bull = c.find((x) => x.stance === "BULL")?.n ?? 0;
  const bear = c.find((x) => x.stance === "BEAR")?.n ?? 0;
  const converged = bull >= KOL_MIN_VOICES && bull > bear ? "BULL" : bear >= KOL_MIN_VOICES && bear > bull ? "BEAR" : "NONE";
  return { bull_voices: bull, bear_voices: bear, converged };
}

/** Token-naming posts inside the window, newest few per voice, in channel order. */
export function buildSignals(posts: Post[], channels: string[], nowMs: number): Signal[] {
  const from = nowMs - KOL_WINDOW_HOURS * 3600 * 1000;
  const out: Signal[] = [];
  for (const ch of channels) {
    const seen = new Set<string>(); // a channel that reposts the same text is still one statement
    const mine = posts
      .filter((p) => p.voice === ch && Date.parse(p.posted_at) >= from && Date.parse(p.posted_at) <= nowMs)
      .sort((a, b) => b.posted_at.localeCompare(a.posted_at) || a.post.localeCompare(b.post))
      .filter((p) => (seen.has(p.quote) ? false : (seen.add(p.quote), true)))
      .map((p) => ({ ...p, ...classify(p.quote) }))
      .filter((s) => s.tokens.length > 0)
      .sort((a, b) => b.posted_at.localeCompare(a.posted_at) || a.post.localeCompare(b.post))
      .slice(0, SIGNALS_PER_VOICE);
    out.push(...mine);
  }
  return out;
}

/** The evidence item's data block. Everything in it can be recomputed from `signals`. */
export function kolData(
  voices: { channel: string; url: string; page_sha256: string; posts_read: number }[],
  signals: Signal[],
): { [k: string]: Json } {
  return {
    rules_version: KOL_RULES_VERSION,
    rules_file: "src/kol.ts",
    method: "keyword rules on the literal quote; no model",
    window_hours: KOL_WINDOW_HOURS,
    min_voices: KOL_MIN_VOICES,
    voices: voices as unknown as Json,
    signals: signals.map((s) => ({ voice: s.voice, post: s.post, posted_at: s.posted_at, quote: s.quote, tokens: s.tokens, stance: s.stance, conviction: s.conviction, urgency: s.urgency, matched: s.matched })) as unknown as Json,
    convergence: convergence(signals) as unknown as Json,
    sol: solSummary(signals),
  };
}

/** verify.ts: re-derive every signal from its quote and every convergence from the signals. */
export function recheckKol(data: { [k: string]: Json }, fetchedAt: string): string[] {
  const problems: string[] = [];
  const signals = (data.signals ?? []) as unknown as Signal[];
  const now = Date.parse(fetchedAt);
  const from = now - Number(data.window_hours) * 3600 * 1000;
  for (const s of signals) {
    const c = classify(s.quote);
    const same = JSON.stringify([c.tokens, c.stance, c.conviction, c.urgency, c.matched]) === JSON.stringify([s.tokens, s.stance, s.conviction, s.urgency, s.matched]);
    if (!same) problems.push(`signal ${s.post} does not re-derive from its quote`);
    const t = Date.parse(s.posted_at);
    if (!(t >= from && t <= now)) problems.push(`signal ${s.post} is outside the ${data.window_hours}h window`);
    // Telegram usernames are case-insensitive (t.me/coinbureau posts as CoinBureau/...)
    if (!s.post.toLowerCase().startsWith(`https://t.me/${s.voice.toLowerCase()}/`)) problems.push(`signal ${s.post} is not a post by ${s.voice}`);
  }
  // canonical hashes, because the saved evidence file has its keys sorted
  if (receiptHash(convergence(signals, Number(data.min_voices)) as unknown as Json) !== receiptHash(data.convergence ?? null)) problems.push("convergence does not recompute from the signals");
  if (receiptHash(solSummary(signals) as unknown as Json) !== receiptHash(data.sol ?? null)) problems.push("SOL summary does not recompute from the signals");
  return problems;
}
