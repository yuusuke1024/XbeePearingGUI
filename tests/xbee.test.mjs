import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeResponseLines,
  appendResponseChunk,
  buildApiFrame,
  buildBaudRateCandidates,
  enableApiMode,
  enableTransparentMode,
  extractCompleteLines,
  openCommandModeSession,
  openApiSession,
  parseApiFrameData,
  XBeeApiFrameParser,
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

function createFakeApiSerialPort(script, { openError = null, writable = true, readable = true } = {}) {
  const queue = [];
  const pending = [];
  const writes = [];
  const openOptions = [];
  let closed = false;
  let closeCount = 0;
  let readerReleaseCount = 0;
  let writerReleaseCount = 0;
  const enqueue = (bytes, delayMs = 0) => setTimeout(() => {
    const item = bytes?.done ? { value: undefined, done: true } : { value: bytes, done: false };
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
      const actual = Uint8Array.from(bytes);
      writes.push(actual);
      const next = script.shift();
      assert.ok(next, "想定外のAPIフレーム送信");
      assert.deepEqual(Array.from(actual), Array.from(next.request));
      for (const chunk of next.responses ?? []) {
        if (chunk instanceof Uint8Array) enqueue(chunk);
        else if (chunk?.done) enqueue(chunk);
        else enqueue(chunk.bytes, chunk.delayMs ?? 0);
      }
    },
    releaseLock() { writerReleaseCount += 1; }
  };
  return {
    isOpen: false,
    readable: readable ? { getReader: () => reader } : null,
    writable: writable ? { getWriter: () => writer } : null,
    async open(options) { openOptions.push(options); if (openError) throw openError; this.isOpen = true; closed = false; },
    async close() { closeCount += 1; this.isOpen = false; closed = true; while (pending.length) pending.shift()({ value: undefined, done: true }); },
    writes,
    openOptions,
    get closeCount() { return closeCount; },
    get readerReleaseCount() { return readerReleaseCount; },
    get writerReleaseCount() { return writerReleaseCount; }
  };
}

function apiResponse(frameId, command, status, parameter = []) {
  return buildApiFrame(0x88, frameId, command, [status, ...parameter]);
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

test("APIフレームのAP query/AP0/WR bytesとchecksumが正確", () => {
  assert.deepEqual(Array.from(buildApiFrame(0x09, 1, "AP")), [0x7e, 0x00, 0x04, 0x09, 0x01, 0x41, 0x50, 0x64]);
  assert.deepEqual(Array.from(buildApiFrame(0x09, 2, "AP", [0x00])), [0x7e, 0x00, 0x05, 0x09, 0x02, 0x41, 0x50, 0x00, 0x63]);
  assert.deepEqual(Array.from(buildApiFrame(0x08, 3, "WR")), [0x7e, 0x00, 0x04, 0x08, 0x03, 0x57, 0x52, 0x4b]);
  assert.throws(() => buildApiFrame(0x09, 0, "AP"), /フレームID/);
});

test("API parserはfragmented、複数frame、noise、不正checksumを安全に扱う", () => {
  const parser = new XBeeApiFrameParser();
  const first = buildApiFrame(0x88, 1, "AP", [0x00, 0x01]);
  const second = buildApiFrame(0x88, 2, "WR", [0x00]);
  const bad = Uint8Array.from(first);
  bad[bad.length - 1] ^= 0xff;
  assert.equal(parser.feed(first.slice(0, 2)).length, 0);
  assert.equal(parser.feed(first.slice(2)).length, 1);
  const frames = parser.feed(Uint8Array.from([0x01, 0x02, ...bad, ...second]));
  assert.equal(frames.length, 1);
  assert.deepEqual(parseApiFrameData(frames[0]), {
    frameType: 0x88,
    frameId: 2,
    command: "WR",
    status: 0,
    parameter: new Uint8Array(0),
    data: frames[0]
  });
});

test("API AP queryは第1候補失敗後に第2候補のAP=1を検出する", async () => {
  const query = buildApiFrame(0x09, 1, "AP");
  const port = createFakeApiSerialPort([
    { request: query, responses: [] },
    { request: query, responses: [apiResponse(1, "AP", 0, [1])] }
  ]);
  const session = await openApiSession(port, { candidates: [9600, 38400], ...fast });
  assert.equal(session.baudRate, 38400);
  assert.deepEqual(port.openOptions.map((item) => item.baudRate), [9600, 38400]);
  await session.close();
  assert.equal(port.closeCount, 2);
  assert.equal(port.readerReleaseCount, 2);
  assert.equal(port.writerReleaseCount, 2);
});

test("API応答待ちはunrelated/wrong IDを破棄し、同一chunkと遅延targetを処理する", async () => {
  const query = buildApiFrame(0x09, 1, "AP");
  const unrelated = buildApiFrame(0x90, 9, "ZZ", [0x01]);
  const wrongId = apiResponse(9, "AP", 0, [1]);
  const target = apiResponse(1, "AP", 0, [1]);
  const port = createFakeApiSerialPort([
    { request: query, responses: [unrelated, wrongId, { bytes: target, delayMs: 5 }] }
  ]);
  const session = await openApiSession(port, { candidates: [9600], ...fast });
  assert.equal(session.baudRate, 9600);
  await session.close();
  assert.equal(port.closeCount, 1);
});

test("matching API応答のstatus失敗はbaud fallbackせず即時エラーにする", async () => {
  const query = buildApiFrame(0x09, 1, "AP");
  const port = createFakeApiSerialPort([
    { request: query, responses: [apiResponse(1, "AP", 3)] }
  ]);
  await assert.rejects(openApiSession(port, { candidates: [9600, 38400], ...fast }), /無効なパラメータ/);
  assert.deepEqual(port.openOptions.map((item) => item.baudRate), [9600]);
  assert.equal(port.closeCount, 1);
});

test("API→透過はAP query、0x09 AP=0、0x08 WRだけを送信する", async () => {
  const query = buildApiFrame(0x09, 1, "AP");
  const ap0 = buildApiFrame(0x09, 2, "AP", [0]);
  const wr = buildApiFrame(0x08, 3, "WR");
  const port = createFakeApiSerialPort([
    { request: query, responses: [apiResponse(1, "AP", 0, [1])] },
    { request: ap0, responses: [apiResponse(2, "AP", 0)] },
    { request: wr, responses: [apiResponse(3, "WR", 0)] }
  ]);
  const result = await enableTransparentMode({ port, candidates: [9600], ...fast });
  assert.equal(result.apiMode, "0");
  assert.deepEqual(port.writes.map((frame) => Array.from(frame)), [Array.from(query), Array.from(ap0), Array.from(wr)]);
  assert.equal(port.closeCount, 1);
  assert.equal(port.readerReleaseCount, 1);
  assert.equal(port.writerReleaseCount, 1);
});

test("API AP=0の失敗時はWRを送らずcleanupする", async () => {
  const query = buildApiFrame(0x09, 1, "AP");
  const ap0 = buildApiFrame(0x09, 2, "AP", [0]);
  const port = createFakeApiSerialPort([
    { request: query, responses: [apiResponse(1, "AP", 0, [1])] },
    { request: ap0, responses: [apiResponse(2, "AP", 3)] }
  ]);
  await assert.rejects(enableTransparentMode({ port, candidates: [9600], ...fast }), /無効なパラメータ/);
  assert.deepEqual(port.writes.map((frame) => Array.from(frame)), [Array.from(query), Array.from(ap0)]);
  assert.equal(port.closeCount, 1);
  assert.equal(port.readerReleaseCount, 1);
  assert.equal(port.writerReleaseCount, 1);
});

test("API WR応答なしは成功扱いせずcleanupする", async () => {
  const query = buildApiFrame(0x09, 1, "AP");
  const ap0 = buildApiFrame(0x09, 2, "AP", [0]);
  const wr = buildApiFrame(0x08, 3, "WR");
  const port = createFakeApiSerialPort([
    { request: query, responses: [apiResponse(1, "AP", 0, [1])] },
    { request: ap0, responses: [apiResponse(2, "AP", 0)] },
    { request: wr, responses: [] }
  ]);
  await assert.rejects(enableTransparentMode({ port, candidates: [9600], ...fast }), /WR.*タイムアウト/);
  assert.deepEqual(port.writes.map((frame) => Array.from(frame)), [Array.from(query), Array.from(ap0), Array.from(wr)]);
  assert.equal(port.closeCount, 1);
});

test("APIフローのシリアル切断は早期失敗してcleanupする", async () => {
  const query = buildApiFrame(0x09, 1, "AP");
  const ap0 = buildApiFrame(0x09, 2, "AP", [0]);
  const port = createFakeApiSerialPort([
    { request: query, responses: [apiResponse(1, "AP", 0, [1])] },
    { request: ap0, responses: [{ done: true }] }
  ]);
  await assert.rejects(enableTransparentMode({ port, candidates: [9600], ...fast }), /シリアルポートが切断されました/);
  assert.equal(port.closeCount, 1);
  assert.equal(port.readerReleaseCount, 1);
  assert.equal(port.writerReleaseCount, 1);
});

test("API=2は明確に非対応としてcleanupする", async () => {
  const query = buildApiFrame(0x09, 1, "AP");
  const port = createFakeApiSerialPort([{ request: query, responses: [apiResponse(1, "AP", 0, [2])] }]);
  await assert.rejects(enableTransparentMode({ port, candidates: [9600], ...fast }), /AP=2.*サポート対象外/);
  assert.equal(port.closeCount, 1);
  assert.equal(port.readerReleaseCount, 1);
  assert.equal(port.writerReleaseCount, 1);
});

test("APIポートopen失敗は候補再試行せず明示する", async () => {
  const port = createFakeApiSerialPort([], { openError: new Error("アクセス拒否") });
  await assert.rejects(enableTransparentMode({ port, candidates: [9600, 38400], ...fast }), /シリアルポートを開けませんでした.*アクセス拒否/);
  assert.deepEqual(port.openOptions.map((item) => item.baudRate), [9600]);
  assert.equal(port.closeCount, 0);
});

test("APIストリーム取得失敗は部分resourceをcleanupする", async () => {
  const port = createFakeApiSerialPort([], { writable: false });
  await assert.rejects(enableTransparentMode({ port, candidates: [9600, 38400], ...fast }), /シリアルポート／ストリームを取得できません/);
  assert.deepEqual(port.openOptions.map((item) => item.baudRate), [9600]);
  assert.equal(port.closeCount, 1);
  assert.equal(port.readerReleaseCount, 1);
  assert.equal(port.writerReleaseCount, 0);
});

test("API→透過も事前キャンセル済みsignalではポートを開かない", async () => {
  const port = createFakeApiSerialPort([]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(enableTransparentMode({ port, signal: controller.signal, candidates: [9600], ...fast }), /キャンセル/);
  assert.deepEqual(port.openOptions, []);
  assert.equal(port.writes.length, 0);
  assert.equal(port.closeCount, 0);
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
