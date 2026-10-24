/**
 * debate.ts - bull and bear argue from the same evidence, a judge decides.
 *
 * Bull and bear run independently (neither sees the other), both reading the
 * exact evidenceText() of one pack. The judge reads the pack plus both cases.
 * Every call runs at temperature 0 with a JSON schema, and every call is saved
 * as a transcript (role, model, model version, prompt, raw response) under
 * data/transcripts/<sha256>.json. The receipt commits to those hashes, so the
 * whole reasoning trail is pinned on chain and can be re-read word for word.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, GEMINI_MODEL } from "./config.js";
import { documentBytes, documentHash, type Json } from "./canonical.js";
import { ascii, evidenceText, type EvidencePack } from "./evidence.js";

export type Role = "BULL" | "BEAR" | "JUDGE";

export type Case = {
  thesis: string;
  points: { claim: string; evidence_ids: string[]; cause_effect: string }[];
  confidence: number;
  what_would_change_my_mind: string;
};

export type Ruling = {
  winner: "BULL" | "BEAR" | "NEITHER";
  verdict: "BUY" | "SELL" | "HOLD";
  conviction: number;
  rationale: string;
  decisive_evidence_ids: string[];
  rejected_points: { side: "BULL" | "BEAR"; claim: string; why: string }[];
  size_pct_of_max: number;
  stop_loss_bps: number;
  take_profit_bps: number;
  horizon_minutes: number;
};

export type Transcript = {
  role: Role;
  model: string;
  model_version: string;
  temperature: number;
  system: string;
  prompt: string;
  response_text: string;
  parsed: Json;
};

export type Debate = {
  bull: Case;
  bear: Case;
  judge: Ruling;
  transcripts: { role: Role; sha256: string }[];
};

const CASE_SCHEMA = {
  type: "OBJECT",
  properties: {
    thesis: { type: "STRING" },
    points: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          claim: { type: "STRING" },
          evidence_ids: { type: "ARRAY", items: { type: "STRING" } },
          cause_effect: { type: "STRING" },
        },
        required: ["claim", "evidence_ids", "cause_effect"],
      },
    },
    confidence: { type: "INTEGER" },
    what_would_change_my_mind: { type: "STRING" },
  },
  required: ["thesis", "points", "confidence", "what_would_change_my_mind"],
};

const RULING_SCHEMA = {
  type: "OBJECT",
  properties: {
    winner: { type: "STRING", enum: ["BULL", "BEAR", "NEITHER"] },
    verdict: { type: "STRING", enum: ["BUY", "SELL", "HOLD"] },
    conviction: { type: "INTEGER" },
    rationale: { type: "STRING" },
    decisive_evidence_ids: { type: "ARRAY", items: { type: "STRING" } },
    rejected_points: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { side: { type: "STRING", enum: ["BULL", "BEAR"] }, claim: { type: "STRING" }, why: { type: "STRING" } },
        required: ["side", "claim", "why"],
      },
    },
    size_pct_of_max: { type: "INTEGER" },
    stop_loss_bps: { type: "INTEGER" },
    take_profit_bps: { type: "INTEGER" },
    horizon_minutes: { type: "INTEGER" },
  },
  required: ["winner", "verdict", "conviction", "rationale", "decisive_evidence_ids", "rejected_points", "size_pct_of_max", "stop_loss_bps", "take_profit_bps", "horizon_minutes"],
};

const RULES_OF_EVIDENCE = [
  "Rules of evidence:",
  "- Use ONLY the evidence items below. No outside facts, no memory of past prices.",
  "- Every claim must cite the bracketed ids it relies on, e.g. PYTH or NEWS-2.",
  "- State cause and effect plainly: what in the evidence causes what expected move.",
  "- Numbers ending in _bps are basis points (100 bps = 1%). Prices are USD strings.",
  "- KOL is what public market voices said, not market data. Cite it as KOL. A convergence is a narrative to weigh against the prices, not proof.",
  "- Write plain ASCII. No markdown.",
].join("\n");

const SYSTEM: Record<Role, string> = {
  BULL:
    "You are BULL, an advocate on a practice trading desk for SOL/USD. Make the strongest honest case for BUYING SOL right now, from the evidence only. Do not invent support. If the evidence is weak for your side, say so and lower your confidence (0-100).",
  BEAR:
    "You are BEAR, an advocate on a practice trading desk for SOL/USD. Make the strongest honest case for SELLING SOL right now, from the evidence only. Do not invent support. If the evidence is weak for your side, say so and lower your confidence (0-100).",
  JUDGE:
    "You are the JUDGE on a practice trading desk for SOL/USD. Two advocates argued from the same evidence. Weigh their cases against the evidence itself, not their rhetoric. Reject any point whose cited evidence does not say what the advocate claims, and list it in rejected_points. Then decide BUY, SELL or HOLD as ONE decision with entry, size and exit: conviction 0-100, size_pct_of_max 0-100, stop_loss_bps and take_profit_bps (positive integers), horizon_minutes. HOLD is a valid and often correct verdict. winner must agree with verdict: BULL for BUY, BEAR for SELL, NEITHER for HOLD.",
};

/** Folded into the on-chain policy_hash: editing a prompt or schema is a recorded policy change. */
export function promptsSha256(): string {
  return documentHash({ system: SYSTEM, rules: RULES_OF_EVIDENCE, case_schema: CASE_SCHEMA, ruling_schema: RULING_SCHEMA } as unknown as Json);
}

async function gemini(system: string, prompt: string, schema: object): Promise<{ text: string; modelVersion: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: schema },
  };
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as Response);
    if (res.ok) {
      const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; modelVersion?: string };
      const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (text) return { text, modelVersion: j.modelVersion ?? GEMINI_MODEL };
      lastErr = "empty response";
    } else {
      // the key travels in a header, never in the URL, so this message is safe to log
      lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    }
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
  throw new Error(`Gemini failed after retries: ${lastErr}`);
}

/** Deep-fold every string to ASCII so the parsed answer can be hashed canonically. */
function asciiDeep(v: unknown): Json {
  if (typeof v === "string") return ascii(v);
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : Math.round(v);
  if (Array.isArray(v)) return v.map(asciiDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, asciiDeep(x)]));
  return (v ?? null) as Json;
}

/** Prompt and response are kept byte-exact; only `parsed` (which enters the receipt) is folded to ASCII. */
function saveTranscript(t: Transcript): string {
  const doc = t as unknown as Json;
  const h = documentHash(doc);
  const dir = join(DATA_DIR, "transcripts");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${h}.json`);
  if (!existsSync(p)) writeFileSync(p, documentBytes(doc));
  return h;
}

async function ask<T>(role: Role, prompt: string, schema: object): Promise<{ parsed: T; sha256: string }> {
  const system = SYSTEM[role];
  const { text, modelVersion } = await gemini(system, prompt, schema);
  const parsed = asciiDeep(JSON.parse(text)) as unknown as T;
  const sha256 = saveTranscript({ role, model: GEMINI_MODEL, model_version: modelVersion, temperature: 0, system, prompt, response_text: text, parsed: parsed as unknown as Json });
  return { parsed, sha256 };
}

function caseText(name: string, c: Case): string {
  const pts = c.points.map((p, i) => `  ${i + 1}. ${p.claim} [cites: ${p.evidence_ids.join(", ")}] cause/effect: ${p.cause_effect}`).join("\n");
  return `${name} (confidence ${c.confidence})\nThesis: ${c.thesis}\nPoints:\n${pts}\nWould change my mind: ${c.what_would_change_my_mind}`;
}

export async function runDebate(pack: EvidencePack, context: string): Promise<Debate> {
  const evidence = evidenceText(pack);
  const advocatePrompt = `${RULES_OF_EVIDENCE}\n\nDesk context:\n${context}\n\nEVIDENCE (pack ${pack.pack_hash.slice(0, 16)}):\n\n${evidence}\n\nArgue your side now.`;
  const [bull, bear] = await Promise.all([
    ask<Case>("BULL", advocatePrompt, CASE_SCHEMA),
    ask<Case>("BEAR", advocatePrompt, CASE_SCHEMA),
  ]);
  const judgePrompt = `${RULES_OF_EVIDENCE}\n\nDesk context:\n${context}\n\nEVIDENCE (pack ${pack.pack_hash.slice(0, 16)}):\n\n${evidence}\n\n---\n${caseText("BULL", bull.parsed)}\n\n---\n${caseText("BEAR", bear.parsed)}\n\nRule now.`;
  const judge = await ask<Ruling>("JUDGE", judgePrompt, RULING_SCHEMA);
  return {
    bull: bull.parsed,
    bear: bear.parsed,
    judge: judge.parsed,
    transcripts: [
      { role: "BULL", sha256: bull.sha256 },
      { role: "BEAR", sha256: bear.sha256 },
      { role: "JUDGE", sha256: judge.sha256 },
    ],
  };
}
