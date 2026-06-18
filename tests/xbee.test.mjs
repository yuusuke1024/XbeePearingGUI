import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeResponseLines,
  appendResponseChunk,
  buildPairingPlan,
  extractCompleteLines,
  normalizePanId,
  sanitizeHex32
} from "../docs/xbee.js";

test("normalizePanId は 0x 接頭辞を除去して大文字化する", () => {
  assert.equal(normalizePanId("0x1a2b"), "1A2B");
});

test("normalizePanId は 1〜16 桁の16進数のみを受け付ける", () => {
  assert.throws(() => normalizePanId(""), /PAN ID/);
  assert.throws(() => normalizePanId("0x1234567890ABCDEF0"), /PAN ID/);
  assert.throws(() => normalizePanId("ZZZZ"), /PAN ID/);
});

test("sanitizeHex32 は 1〜8 桁の16進数のみを受け付ける", () => {
  assert.equal(sanitizeHex32("00ab12"), "00AB12");
  assert.throws(() => sanitizeHex32("0x123456789"), /SL\/DL/);
  assert.throws(() => sanitizeHex32("xyz"), /SL\/DL/);
});

test("buildPairingPlan は Coordinator=A の計画を返す", () => {
  const plan = buildPairingPlan({ panId: "0x7b", coordinator: "A" });
  assert.equal(plan.normalizedPanId, "7B");
  assert.deepEqual(plan.roles, { A: "1", B: "0" });
  assert.deepEqual(plan.commandsForA, ["ATID7B\r", "ATCE1\r"]);
  assert.deepEqual(plan.commandsForB, ["ATID7B\r", "ATCE0\r"]);
});

test("buildPairingPlan は Coordinator=B の計画を返す", () => {
  const plan = buildPairingPlan({ panId: "ABCD", coordinator: "B" });
  assert.deepEqual(plan.roles, { A: "0", B: "1" });
});

test("buildPairingPlan は不正な Coordinator を拒否する", () => {
  assert.throws(() => buildPairingPlan({ panId: "1234", coordinator: /** @type {any} */ ("C") }), /Coordinator/);
});

test("extractCompleteLines は CR/LF 混在の完全な行だけを返す", () => {
  assert.deepEqual(extractCompleteLines("1234ABCD\r\nOK\rpartial"), {
    lines: ["1234ABCD", "OK"],
    remainder: "partial"
  });
});

test("appendResponseChunk は 値のみ応答を蓄積できる", () => {
  const state = appendResponseChunk({ lines: [], remainder: "" }, "1234ABCD\r");
  assert.deepEqual(state, {
    lines: ["1234ABCD"],
    remainder: ""
  });
  assert.deepEqual(analyzeResponseLines(state.lines), {
    hasOk: false,
    valueLine: "1234ABCD"
  });
});

test("appendResponseChunk は 値とOKが同一チャンクでも両方保持する", () => {
  const state = appendResponseChunk({ lines: [], remainder: "" }, "1234ABCD\rOK\r");
  assert.deepEqual(state, {
    lines: ["1234ABCD", "OK"],
    remainder: ""
  });
  assert.deepEqual(analyzeResponseLines(state.lines), {
    hasOk: true,
    valueLine: "1234ABCD"
  });
});

test("appendResponseChunk は 値とOKが別チャンクでも値を失わない", () => {
  const first = appendResponseChunk({ lines: [], remainder: "" }, "1234ABCD\r");
  const second = appendResponseChunk(first, "OK\r");
  assert.deepEqual(second, {
    lines: ["1234ABCD", "OK"],
    remainder: ""
  });
  assert.deepEqual(analyzeResponseLines(second.lines), {
    hasOk: true,
    valueLine: "1234ABCD"
  });
});

test("appendResponseChunk は OKのみ応答も判定できる", () => {
  const state = appendResponseChunk({ lines: [], remainder: "" }, "OK\r");
  assert.deepEqual(state, {
    lines: ["OK"],
    remainder: ""
  });
  assert.deepEqual(analyzeResponseLines(state.lines), {
    hasOk: true,
    valueLine: null
  });
});
