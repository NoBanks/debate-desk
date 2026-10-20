/**
 * evidence.ts - the evidence pack every agent in a debate reads from.
 *
 * Each item is normalised to integers and ASCII strings so it can be hashed
 * canonically, then saved under data/evidence/<sha256>.json. The receipt only
 * carries ids and hashes; the verifier re-hashes the saved files. Bull, bear
 * and judge all see the exact same bytes, so "they argued from the same
 * evidence" is a checkable claim, not a promise.
 *
 *   PYTH   SOL/USD read straight from Pyth's account on Solana devnet
 *   CB     Coinbase Exchange SOL-USD 24h stats (last, open, high, low, volume)
 *   KR     Kraken SOLUSD ticker (last, 24h VWAP, open, high, low, volume)
 *   CG     CoinGecko market snapshot (1h / 24h / 7d moves, volume), when its free tier answers
 *   NEWS-n crypto headlines from public RSS feeds
 *   CL     Chainlink SOL/USD Data Feed, delivered by the CRE workflow in cre/ (when it runs)
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { Rpc, GetAccountInfoApi } from "@solana/kit";
import { DATA_DIR, PYTH_SOL_USD, REPO_ROOT } from "./config.js";
import { canonicalBytes, receiptHash, sha256Hex, type Json } from "./canonical.js";
import { confBps, deviationBps, readPyth, type PythPrice } from "./pyth.js";

export type EvidenceItem = {
  id: string;
  source: string;
  url: string;
  fetched_at: string;
  raw_sha256: string;
  data: { [k: string]: Json };
};

export type EvidencePack = {
  items: EvidenceItem[];
  pyth: PythPrice;
  /** id -> sha256 of the item's canonical bytes */
  hashes: { [id: string]: string };
  pack_hash: string;
};

/** Receipts and transcripts are ASCII-only (see canonical.ts). Fold the usual typography down. */
export function ascii(s: string): string {
  return s
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[    ]/g, " ")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Decimal string from a float without scientific notation, at most `dp` places. */
function dec(x: number, dp = 6): string {
  return x.toFixed(dp).replace(/\.?0+$/, "");
}
function bps(pct: number | null | undefined): number | null {
  return typeof pct === "number" && Number.isFinite(pct) ? Math.round(pct * 100) : null;
}
function iso(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Public devnet RPC times out or 429s now and then. Back off and retry rather than lose a cycle. */
export async function withRetry<T>(call: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await call();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** i));
    }
  }
}

async function getText(url: string, timeoutMs = 15000): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": "debate-desk/0.1 (+github.com/NoBanks)" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

function pythItem(p: PythPrice, nowS: number): EvidenceItem {
  return {
    id: "PYTH",
    source: "Pyth SOL/USD PriceUpdateV2 account on Solana devnet",
    url: `solana:${p.account}`,
    fetched_at: iso(),
    raw_sha256: p.accountSha256,
    data: {
      price: p.price.toString(),
      ema_price: p.emaPrice.toString(),
      conf: p.conf.toString(),
      exponent: p.exponent,
      publish_time: p.publishTime,
      age_s: nowS - p.publishTime,
      read_at_slot: p.contextSlot.toString(),
      deviation_from_ema_bps: deviationBps(p),
      conf_bps: confBps(p),
      price_usd: dec(Number(p.price) * 10 ** p.exponent, 4),
      ema_price_usd: dec(Number(p.emaPrice) * 10 ** p.exponent, 4),
    },
  };
}

async function coingeckoItem(): Promise<EvidenceItem> {
  const url = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=solana&price_change_percentage=1h,24h,7d";
  const raw = await getText(url);
  const [m] = JSON.parse(raw) as Array<Record<string, number | string | null>>;
  if (!m) throw new Error("CoinGecko returned no solana row");
  return {
    id: "CG",
    source: "CoinGecko /coins/markets",
    url,
    fetched_at: iso(),
    raw_sha256: sha256Hex(Buffer.from(raw, "utf8")),
    data: {
      price_usd: dec(Number(m.current_price), 4),
      change_1h_bps: bps(m.price_change_percentage_1h_in_currency as number),
      change_24h_bps: bps(m.price_change_percentage_24h_in_currency as number),
      change_7d_bps: bps(m.price_change_percentage_7d_in_currency as number),
      high_24h_usd: dec(Number(m.high_24h), 4),
      low_24h_usd: dec(Number(m.low_24h), 4),
      volume_24h_usd: String(Math.round(Number(m.total_volume))),
      market_cap_usd: String(Math.round(Number(m.market_cap))),
      last_updated: ascii(String(m.last_updated ?? "")),
    },
  };
}

function bpsMove(from: number, to: number): number {
  return Math.round(((to - from) / from) * 10_000);
}

async function coinbaseItem(): Promise<EvidenceItem> {
  const url = "https://api.exchange.coinbase.com/products/SOL-USD/stats";
  const raw = await getText(url, 10000);
  const m = JSON.parse(raw) as Record<string, string>;
  const last = Number(m.last), open = Number(m.open);
  if (!(last > 0 && open > 0)) throw new Error("Coinbase stats missing last/open");
  return {
    id: "CB",
    source: "Coinbase Exchange SOL-USD 24h stats",
    url,
    fetched_at: iso(),
    raw_sha256: sha256Hex(Buffer.from(raw, "utf8")),
    data: {
      price_usd: dec(last, 4),
      open_24h_usd: dec(open, 4),
      change_24h_bps: bpsMove(open, last),
      high_24h_usd: dec(Number(m.high), 4),
      low_24h_usd: dec(Number(m.low), 4),
      volume_24h_sol: String(Math.round(Number(m.volume))),
    },
  };
}

async function krakenItem(): Promise<EvidenceItem> {
  const url = "https://api.kraken.com/0/public/Ticker?pair=SOLUSD";
  const raw = await getText(url, 10000);
  const j = JSON.parse(raw) as { error: string[]; result: Record<string, { c: string[]; p: string[]; o: string; h: string[]; l: string[]; v: string[]; t: number[] }> };
  const t = Object.values(j.result ?? {})[0];
  if (!t) throw new Error(`Kraken: ${j.error?.join(",")}`);
  const last = Number(t.c[0]), open = Number(t.o), vwap = Number(t.p[1]);
  return {
    id: "KR",
    source: "Kraken SOLUSD ticker",
    url,
    fetched_at: iso(),
    raw_sha256: sha256Hex(Buffer.from(raw, "utf8")),
    data: {
      price_usd: dec(last, 4),
      open_today_usd: dec(open, 4),
      change_today_bps: bpsMove(open, last),
      vwap_24h_usd: dec(vwap, 4),
      price_vs_vwap_bps: bpsMove(vwap, last),
      high_24h_usd: dec(Number(t.h[1]), 4),
      low_24h_usd: dec(Number(t.l[1]), 4),
      volume_24h_sol: String(Math.round(Number(t.v[1]))),
      trades_24h: t.t[1],
    },
  };
}

const FEEDS = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
];

function unCdata(s: string): string {
  return s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Newest headlines across feeds, Solana stories first. Max 6 items so the prompt stays small. */
async function newsItems(): Promise<EvidenceItem[]> {
  type H = { feed: string; feedUrl: string; rawSha: string; title: string; link: string; ts: number };
  const all: H[] = [];
  await Promise.all(
    FEEDS.map(async (f) => {
      try {
        const xml = await getText(f.url);
        const rawSha = sha256Hex(Buffer.from(xml, "utf8"));
        for (const block of xml.split(/<item[\s>]/).slice(1, 25)) {
          const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1];
          const link = /<link>([\s\S]*?)<\/link>/.exec(block)?.[1];
          const date = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1];
          if (!title || !link) continue;
          const ts = date ? Date.parse(unCdata(date.trim())) : NaN;
          all.push({ feed: f.name, feedUrl: f.url, rawSha, title: ascii(unCdata(title.trim())), link: ascii(unCdata(link.trim())), ts: Number.isFinite(ts) ? ts : 0 });
        }
      } catch {
        // one dead feed does not stop the debate; the pack simply has fewer headlines
      }
    }),
  );
  const isSol = (h: H) => /\bsol(ana)?\b/i.test(h.title);
  const dayAgo = Date.now() - 36 * 3600 * 1000;
  const fresh = all.filter((h) => h.ts >= dayAgo);
  fresh.sort((a, b) => Number(isSol(b)) - Number(isSol(a)) || b.ts - a.ts);
  const seen = new Set<string>();
  const picked = fresh.filter((h) => (seen.has(h.title) ? false : (seen.add(h.title), true))).slice(0, 6);
  return picked.map((h, i) => ({
    id: `NEWS-${i + 1}`,
    source: `${h.feed} RSS`,
    url: h.link,
    fetched_at: iso(),
    raw_sha256: h.rawSha,
    data: { headline: h.title, published_at: iso(h.ts), feed: h.feedUrl, mentions_solana: isSol(h) },
  }));
}

/**
 * Chainlink SOL/USD via the CRE workflow. cre/simulate.mjs runs `cre workflow simulate`
 * and prints one EVIDENCE_REPORT line. If CRE is not installed here, the pack says so
 * and the risk rules fall back to Pyth vs CoinGecko for the cross-source check.
 */
async function creItem(): Promise<EvidenceItem | null> {
  const script = join(REPO_ROOT, "cre", "simulate.mjs");
  if (process.env.DESK_SKIP_CRE === "1" || !existsSync(script)) return null;
  const out = await new Promise<string>((resolve) => {
    execFile(process.execPath, [script], { cwd: join(REPO_ROOT, "cre"), timeout: 180_000, maxBuffer: 8 << 20 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
  const line = out.split(/\r?\n/).find((l) => l.startsWith("EVIDENCE_REPORT ")) ?? (out.trim().startsWith("{") ? "EVIDENCE_REPORT " + out.trim() : "");
  if (!line) return null;
  const raw = line.slice("EVIDENCE_REPORT ".length).trim();
  let r: { chainlink?: Record<string, Json>; generated_at?: Json };
  try {
    r = JSON.parse(raw);
  } catch {
    return null;
  }
  const cl = r.chainlink ?? {};
  const answer = String(cl.answer ?? "");
  const decimals = Number(cl.decimals ?? 8);
  if (!/^\d+$/.test(answer)) return null;
  return {
    id: "CL",
    source: "Chainlink SOL/USD Data Feed, read by the CRE workflow (cre/)",
    url: ascii(`evm:${cl.chain ?? "?"}:${cl.feed ?? "?"}`),
    fetched_at: iso(),
    raw_sha256: sha256Hex(Buffer.from(raw, "utf8")),
    data: {
      answer,
      decimals,
      price_usd: dec(Number(answer) / 10 ** decimals, 4),
      updated_at: Number(cl.updated_at ?? 0),
      round_id: ascii(String(cl.round_id ?? "")),
      chain: ascii(String(cl.chain ?? "")),
      feed: ascii(String(cl.feed ?? "")),
    },
  };
}

export async function gatherEvidence(rpc: Rpc<GetAccountInfoApi>): Promise<EvidencePack> {
  const nowS = Math.floor(Date.now() / 1000);
  const [pyth, cb, kr, cg, news, cl] = await Promise.all([
    withRetry(() => readPyth(rpc, PYTH_SOL_USD)),
    withRetry(coinbaseItem, 3).catch(() => null),
    withRetry(krakenItem, 3).catch(() => null),
    withRetry(coingeckoItem, 2).catch(() => null),
    newsItems(),
    creItem().catch(() => null),
  ]);
  const items: EvidenceItem[] = [pythItem(pyth, nowS)];
  if (cl) items.push(cl);
  if (cb) items.push(cb);
  if (kr) items.push(kr);
  if (cg) items.push(cg);
  items.push(...news);

  const dir = join(DATA_DIR, "evidence");
  mkdirSync(dir, { recursive: true });
  const hashes: { [id: string]: string } = {};
  for (const it of items) {
    const h = receiptHash(it as unknown as Json);
    hashes[it.id] = h;
    const p = join(dir, `${h}.json`);
    if (!existsSync(p)) writeFileSync(p, canonicalBytes(it as unknown as Json));
  }
  const pack_hash = receiptHash(items.map((i) => hashes[i.id]) as Json);
  return { items, pyth, hashes, pack_hash };
}

/** The text every role reads. Same function, same pack, same bytes for bull, bear and judge. */
export function evidenceText(pack: EvidencePack): string {
  // canonical (sorted-key) JSON, so the text rebuilt from the saved evidence files is byte-identical
  return pack.items.map((i) => `[${i.id}] ${i.source}\n${canonicalBytes(i.data).toString("utf8")}`).join("\n\n");
}
