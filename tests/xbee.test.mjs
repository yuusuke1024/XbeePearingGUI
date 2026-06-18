import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeResponseLines,
  appendResponseChunk,
  buildPairingPlan,
  extractCompleteLines,
  normalizePanId,
  sanitizeHex32,
  XBeeSerialSession
} from "../docs/xbee.js";

function createFakeSerialPort(chunks) {
  const encoder = new TextEncoder();
  const queue = chunks.map((entry) => ({
    bytes: encoder.encode(entry.text),
    delayMs: entry.delayMs ?? 0
  }));

  const reader = {
    released: false,
    cancelled: false,
    async read() {
      if (queue.length === 0) {
        return new Promise(() => {});
      }
      const next = queue.shift();
      if (next.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, next.delayMs));
      }
      return { value: next.bytes, done: false };
    },
    async cancel() {
      this.cancelled = true;
    },
    releaseLock() {
      this.released = true;
    }
  };

  const writer = {
    writes: [],
    async write(bytes) {
      this.writes.push(new TextDecoder().decode(bytes));
    },
    releaseLock() {}
  };

  return {
    isOpen: false,
    readable: {
      getReader() {
        return reader;
      }
    },
    writable: {
      getWriter() {
        return writer;
      }
    },
    async open() {
      this.isOpen = true;
    },
    async close() {
      this.isOpen = false;
    },
    reader,
    writer
  };
}

async function openTestSession(chunks) {
  const port = createFakeSerialPort(chunks);
  const session = new XBeeSerialSession(port, {
    baudRate: 9600,
    name: "Test",
    commandTimeoutMs: 40,
    enterCommandTimeoutMs: 40,
    closeTimeoutMs: 5,
    valueSettleTimeoutMs: 10
  });
  await session.open();
  return { session, port };
}

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

test("readSerialLow は 値のみ応答で成功する", async () => {
  const { session, port } = await openTestSession([{ text: "1234ABCD\r" }]);
  await assert.doesNotReject(async () => {
    assert.equal(await session.readSerialLow(), "1234ABCD");
  });
  assert.deepEqual(port.writer.writes, ["ATSL\r"]);
  await session.close();
});

test("readSerialLow は 値とOKが同一チャンクで成功し値を返す", async () => {
  const { session, port } = await openTestSession([{ text: "1234ABCD\rOK\r" }]);
  assert.equal(await session.readSerialLow(), "1234ABCD");
  assert.deepEqual(port.writer.writes, ["ATSL\r"]);
  await session.close();
});

test("readSerialLow は 値とOKが別チャンクでも後続OKを誤消費しない", async () => {
  const { session, port } = await openTestSession([
    { text: "1234ABCD\r" },
    { text: "OK\r", delayMs: 1 },
    { text: "OK\r", delayMs: 12 }
  ]);

  assert.equal(await session.readSerialLow(), "1234ABCD");
  await session.sendOkCommand("ATID1\r", "ATID1");
  assert.deepEqual(port.writer.writes, ["ATSL\r", "ATID1\r"]);
  await session.close();
});

test("OK必須コマンドは値のみ応答なら失敗する", async () => {
  const { session } = await openTestSession([{ text: "1234ABCD\r" }]);
  await assert.rejects(session.sendOkCommand("ATID1\r", "ATID1"), /OK/);
  await session.close();
});
