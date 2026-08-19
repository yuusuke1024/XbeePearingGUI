import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeResponseLines,
  appendResponseChunk,
  buildBaudRateCandidates,
  enableApiMode,
  extractCompleteLines,
  openCommandModeSession,
  XBeeSerialSession
} from "../docs/xbee.js";

function createFakeSerialPort(script, { openError = null, writable = true, readable = true } = {}) {
  const encoder = new TextEncoder();
  const queue = [];
  const pending = [];
  const writes = [];
  const openOptions = [];
  let closed = false;
  let closeCount = 0;
  let readerReleaseCount = 0;
  let writerReleaseCount = 0;
  const enqueue = (chunk, delayMs = 0) => setTimeout(() => {
    const item = chunk.done ? { value: undefined, done: true } : { value: encoder.encode(chunk.text), done: false };
    (pending.shift() ?? ((value) => queue.push(value)))(item);
  }, delayMs);
  const reader = {
    async read() {
      if (queue.length) return queue.shift();
      if (closed) return { value: undefined, done: true };
      return new Promise((resolve) => pending.push(resolve));
    },
    async cancel() {
      closed = true;
      while (pending.length) pending.shift()({ value: undefined, done: true });
    },
    releaseLock() { readerReleaseCount += 1; }
  };
  const writer = {
    async write(bytes) {
      const command = new TextDecoder().decode(bytes);
      writes.push(command);
      const next = script.shift();
      assert.ok(next, `想定外の送信: ${JSON.stringify(command)}`);
      assert.equal(command, next.command);
      for (const chunk of next.chunks ?? []) enqueue(chunk, chunk.delayMs ?? 0);
    },
    releaseLock() { writerReleaseCount += 1; }
  };
  return {
    isOpen: false,
    readable: readable ? { getReader: () => reader } : null,
    writable: writable ? { getWriter: () => writer } : null,
    async open(options) {
      openOptions.push(options);
      if (openError) throw openError;
      this.isOpen = true;
      closed = false;
    },
    async close() {
      closeCount += 1;
      this.isOpen = false;
      closed = true;
      while (pending.length) pending.shift()({ value: undefined, done: true });
    },
    writer: { writes },
    openOptions,
    get closeCount() { return closeCount; },
    get readerReleaseCount() { return readerReleaseCount; },
    get writerReleaseCount() { return writerReleaseCount; }
  };
}

const fast = { guardTimeMs: 0, commandTimeoutMs: 20, enterCommandTimeoutMs: 20, closeTimeoutMs: 5 };
function ok(command) { return { command, chunks: [{ text: "OK\r" }] }; }

test("ボーレート候補は優先値を先頭にして重複を除く", () => {
  assert.deepEqual(buildBaudRateCandidates([38400, 9600]), [38400, 9600, 115200, 57600, 19200, 4800, 2400, 1200]);
});

test("応答行の解析は CR/LF と OK を扱う", () => {
  assert.deepEqual(extractCompleteLines("OK\r\npartial"), { lines: ["OK"], remainder: "partial" });
  assert.deepEqual(appendResponseChunk({ lines: [], remainder: "" }, "OK\r"), { lines: ["OK"], remainder: "" });
  assert.deepEqual(analyzeResponseLines(["ERROR"]), { hasOk: false, valueLine: "ERROR" });
});

test("enableApiMode の送信列は +++ と AP/WR/CN だけで、成功時に全解放する", async () => {
  const logs = [];
  const port = createFakeSerialPort([ok("+++"), ok("ATAP1\r"), ok("ATWR\r"), ok("ATCN\r")]);
  const result = await enableApiMode({ port, name: "XBee A", candidates: [9600], logger: (message) => logs.push(message), ...fast });
  assert.equal(result.apiMode, "1");
  assert.deepEqual(port.writer.writes, ["+++", "ATAP1\r", "ATWR\r", "ATCN\r"]);
  assert.equal(port.writer.writes.some((command) => /AT(?:ID|CE|DH|DL|BD|RE|FR|AO|SM)/.test(command)), false);
  assert.equal(port.closeCount, 1);
  assert.equal(port.readerReleaseCount, 1);
  assert.equal(port.writerReleaseCount, 1);
  assert.ok(logs.some((message) => message.startsWith("[SCAN]")));
  assert.ok(logs.some((message) => message.startsWith("[WRITE]") && message.includes("ATAP1")));
  assert.ok(logs.some((message) => message.startsWith("[DONE]")));
});

test("enableApiMode 自体が第1候補失敗から第2候補へ自動検出する", async () => {
  const port = createFakeSerialPort([
    { command: "+++", chunks: [] },
    ok("+++"), ok("ATAP1\r"), ok("ATWR\r"), ok("ATCN\r")
  ]);
  const result = await enableApiMode({ port, candidates: [9600, 38400], ...fast });
  assert.equal(result.baudRate, 38400);
  assert.deepEqual(port.openOptions.map((item) => item.baudRate), [9600, 38400]);
  assert.deepEqual(port.writer.writes, ["+++", "+++", "ATAP1\r", "ATWR\r", "ATCN\r"]);
  assert.equal(port.closeCount, 2);
  assert.ok(port.readerReleaseCount >= 2);
  assert.ok(port.writerReleaseCount >= 2);
});

test("ATAP1 失敗時は後続を送らず全リソースを解放する", async () => {
  const port = createFakeSerialPort([ok("+++"), { command: "ATAP1\r", chunks: [{ text: "ERROR\r" }] }]);
  await assert.rejects(enableApiMode({ port, candidates: [9600], ...fast }), /ATAP1/);
  assert.deepEqual(port.writer.writes, ["+++", "ATAP1\r"]);
  assert.equal(port.closeCount, 1);
  assert.equal(port.readerReleaseCount, 1);
  assert.equal(port.writerReleaseCount, 1);
});

test("ATWR 失敗時は ATCN を送らず全リソースを解放する", async () => {
  const port = createFakeSerialPort([ok("+++"), ok("ATAP1\r"), { command: "ATWR\r", chunks: [{ text: "ERROR\r" }] }]);
  await assert.rejects(enableApiMode({ port, candidates: [9600], ...fast }), /ATWR/);
  assert.deepEqual(port.writer.writes, ["+++", "ATAP1\r", "ATWR\r"]);
  assert.equal(port.closeCount, 1);
  assert.equal(port.readerReleaseCount, 1);
  assert.equal(port.writerReleaseCount, 1);
});

test("シリアルポートを開けない場合は候補を反復せず原因を返す", async () => {
  const port = createFakeSerialPort([], { openError: new Error("アクセス拒否") });
  await assert.rejects(enableApiMode({ port, candidates: [9600, 38400], ...fast }), /シリアルポートを開けませんでした.*アクセス拒否/);
  assert.deepEqual(port.openOptions.map((item) => item.baudRate), [9600]);
  assert.equal(port.closeCount, 0);
});

test("全候補で +++ に応答しない場合は明確な検出エラーを返す", async () => {
  const port = createFakeSerialPort(Array.from({ length: 8 }, () => ({ command: "+++", chunks: [] })));
  await assert.rejects(enableApiMode({ port, candidates: [9600, 38400], ...fast }), /UART.*検出できない.*AT.*モード/);
  assert.equal(port.closeCount, 8);
  assert.equal(port.readerReleaseCount, 8);
  assert.equal(port.writerReleaseCount, 8);
});

test("reader.read の done=true は切断エラーとして早期通知し、cleanupする", async () => {
  const port = createFakeSerialPort([ok("+++"), { command: "ATAP1\r", chunks: [{ done: true }] }]);
  await assert.rejects(enableApiMode({ port, candidates: [9600], ...fast }), /シリアルポートが切断されました/);
  assert.equal(port.closeCount, 1);
  assert.equal(port.readerReleaseCount, 1);
  assert.equal(port.writerReleaseCount, 1);
});

test("ストリーム取得失敗時も部分取得したreaderとポートを解放する", async () => {
  const port = createFakeSerialPort([], { writable: false });
  const session = new XBeeSerialSession(port, { baudRate: 9600, ...fast });
  await assert.rejects(session.open(), /シリアルポート／ストリームを取得できませんでした/);
  assert.equal(port.closeCount, 1);
  assert.equal(port.readerReleaseCount, 1);
  assert.equal(port.writerReleaseCount, 0);
  assert.equal(port.isOpen, false);
});

test("enableApiMode のストリーム取得失敗は候補を再試行せず明示する", async () => {
  const port = createFakeSerialPort([], { writable: false });
  await assert.rejects(enableApiMode({ port, candidates: [9600, 38400], ...fast }), /シリアルポート／ストリームを取得できません/);
  assert.deepEqual(port.openOptions.map((item) => item.baudRate), [9600]);
  assert.equal(port.closeCount, 1);
  assert.equal(port.readerReleaseCount, 1);
  assert.equal(port.writerReleaseCount, 0);
});

test("事前キャンセル済みsignalではポートを開かない", async () => {
  const port = createFakeSerialPort([]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(enableApiMode({ port, signal: controller.signal, candidates: [9600], ...fast }), /キャンセル/);
  assert.deepEqual(port.openOptions, []);
  assert.deepEqual(port.writer.writes, []);
  assert.equal(port.closeCount, 0);
});

test("XBeeSerialSession は AT コマンドの OK を待つ", async () => {
  const port = createFakeSerialPort([ok("+++"), ok("ATAP1\r")]);
  const session = new XBeeSerialSession(port, { baudRate: 9600, ...fast });
  await session.open();
  await session.enterCommandMode();
  await session.sendOkCommand("ATAP1\r", "ATAP1");
  assert.deepEqual(port.writer.writes, ["+++", "ATAP1\r"]);
  await session.close();
});

test("未選択ポートを拒否する", async () => {
  await assert.rejects(enableApiMode({}), /選択されていません/);
});
