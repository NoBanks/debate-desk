import { test } from "node:test";
import assert from "node:assert/strict";
import { ZERO32, base58, decodeReceiptAttested, name32, nextPolicyHead, nextReceiptHead } from "../src/program.js";
import { explorerAddress, explorerTx } from "../src/config.js";

// Expected heads computed independently with Python from the IDL domain constants:
//   sha256(DOMAIN || head || hash || u32le(version))            (policy)
//   sha256(DOMAIN || head || hash || u64le(seq) || action byte) (receipt)
const H = "11".repeat(32);

test("policy head matches the independent reference", () => {
  assert.equal(nextPolicyHead(ZERO32, H, 2), "c34d2cb407e10d9b64bc6e34853691ea513caf0e1e4b09ad9e531a3f67decca2");
});

test("receipt head matches the independent reference and binds the action", () => {
  assert.equal(nextReceiptHead(ZERO32, H, 7n, "BUY"), "b50940aff2377e7290a0db13b5fba0b3bb6f4309e965d3ee6ccbcb6e387bfe33");
  assert.notEqual(nextReceiptHead(ZERO32, H, 7n, "SELL"), nextReceiptHead(ZERO32, H, 7n, "BUY"));
  assert.notEqual(nextReceiptHead(ZERO32, H, 8n, "BUY"), nextReceiptHead(ZERO32, H, 7n, "BUY"));
});

test("name32 pads to 32 bytes", () => {
  const b = name32("DEBATE_DESK");
  assert.equal(b.length, 32);
  assert.equal(b.subarray(0, 11).toString("ascii"), "DEBATE_DESK");
  assert.ok(b.subarray(11).every((x) => x === 0));
});

test("base58 of 32 zero bytes is the system program address", () => {
  assert.equal(base58(new Uint8Array(32)), "11111111111111111111111111111111");
});

test("decodeReceiptAttested parses an event and ignores other events", () => {
  const eventDisc = Buffer.from([167, 6, 141, 58, 14, 212, 77, 160]); // ReceiptAttested, from idl/
  const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
  const data = Buffer.concat([
    Buffer.alloc(8), eventDisc, Buffer.alloc(32), u64(42n), Buffer.from([1]),
    Buffer.alloc(32, 0xaa), Buffer.alloc(32, 0xbb), Buffer.alloc(32, 0xcc), u32(3), u64(999n), i64(1_793_000_000n),
  ]);
  const ev = decodeReceiptAttested(data)!;
  assert.equal(ev.seq, 42n);
  assert.equal(ev.action, 1);
  assert.equal(ev.receiptHash, "aa".repeat(32));
  assert.equal(ev.prevReceiptHash, "bb".repeat(32));
  assert.equal(ev.head, "cc".repeat(32));
  assert.equal(ev.policyVersion, 3);
  assert.equal(ev.slot, 999n);
  assert.equal(ev.unixTs, 1_793_000_000);
  const other = Buffer.concat([Buffer.alloc(8), Buffer.alloc(8, 9), data.subarray(16)]);
  assert.equal(decodeReceiptAttested(other), null);
});

test("explorer links use the configured cluster", () => {
  assert.match(explorerTx("SIG"), /^https:\/\/explorer\.solana\.com\/tx\/SIG\?cluster=/);
  assert.match(explorerAddress("ADDR"), /^https:\/\/explorer\.solana\.com\/address\/ADDR\?cluster=/);
});
