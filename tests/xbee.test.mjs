import test from "node:test";
import assert from "node:assert/strict";

import { buildPairingPlan, normalizePanId, sanitizeHex32 } from "../docs/xbee.js";

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
