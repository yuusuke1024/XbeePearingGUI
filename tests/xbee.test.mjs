import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeResponseLines,
  analyzeResponseState,
  appendResponseChunk,
  baudRateToAtbd,
  buildApiNetworkPlan,
  buildBaudRateCandidates,
  buildPairingPlan,
  buildWirelessTestFrame,
  extractCompleteLines,
  openCommandModeSession,
  normalizePanId,
  normalizeWirelessTestPayload,
  sanitizeHex32,
  verifyTransparentWirelessLink,
  XBeeSerialSession
} from "../docs/xbee.js";

function createFakeSerialPort(script) {
  const encoder = new TextEncoder();
  const queue = [];
  const pendingReaders = [];

  function enqueue(entry) {
    const item = {
      bytes: encoder.encode(entry.text),
      delayMs: entry.delayMs ?? 0
    };

    if (pendingReaders.length > 0) {
      const resolve = pendingReaders.shift();
      resolve(item);
      return;
    }

    queue.push(item);
  }

  function readNextItem() {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift());
    }
    return new Promise((resolve) => {
      pendingReaders.push(resolve);
    });
  }

  const reader = {
    released: false,
    cancelled: false,
    async read() {
      const next = await readNextItem();
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

  const openOptions = [];

  const writer = {
    writes: [],
    async write(bytes) {
      const command = new TextDecoder().decode(bytes);
      this.writes.push(command);
      const next = script.shift();
      assert.ok(next, `unexpected write: ${command}`);
      assert.equal(command, next.command);
      for (const chunk of next.chunks ?? []) {
        setTimeout(() => enqueue(chunk), chunk.delayMs ?? 0);
      }
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
    async open(options) {
      openOptions.push(options);
      this.isOpen = true;
    },
    async close() {
      this.isOpen = false;
    },
    reader,
    writer,
    openOptions
  };
}

function createLinkedTransparentPorts() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function createEndpoint() {
    const queue = [];
    const pendingReaders = [];
    const openOptions = [];
    let peer = null;
    let cancelled = false;

    function enqueue(bytes) {
      if (cancelled) {
        return;
      }
      const item = { value: bytes, done: false };
      if (pendingReaders.length > 0) {
        pendingReaders.shift()(item);
        return;
      }
      queue.push(item);
    }

    const reader = {
      async read() {
        if (queue.length > 0) {
          return queue.shift();
        }
        if (cancelled) {
          return { value: undefined, done: true };
        }
        return new Promise((resolve) => {
          pendingReaders.push(resolve);
        });
      },
      async cancel() {
        cancelled = true;
        while (pendingReaders.length > 0) {
          pendingReaders.shift()({ value: undefined, done: true });
        }
      },
      releaseLock() {}
    };

    const writer = {
      writes: [],
      async write(bytes) {
        this.writes.push(decoder.decode(bytes));
        setTimeout(() => peer.enqueue(bytes), 0);
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
      async open(options) {
        cancelled = false;
        openOptions.push(options);
        this.isOpen = true;
      },
      async close() {
        this.isOpen = false;
      },
      setPeer(nextPeer) {
        peer = nextPeer;
      },
      enqueue,
      writer,
      openOptions
    };
  }

  const portA = createEndpoint();
  const portB = createEndpoint();
  portA.setPeer(portB);
  portB.setPeer(portA);
  return { portA, portB };
}

async function openTestSession(script) {
  const port = createFakeSerialPort(script);
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

test("sanitizeHex32 は 1〜8 桁の16進数のみを受け付け、8桁にゼロパディングする", () => {
  assert.equal(sanitizeHex32("00ab12"), "0000AB12");
  assert.equal(sanitizeHex32("418CDC"), "00418CDC");
  assert.equal(sanitizeHex32("4"), "00000004");
  assert.equal(sanitizeHex32("0xDEADBEEF"), "DEADBEEF");
  assert.throws(() => sanitizeHex32("0x123456789"), /SL\/DL/);
  assert.throws(() => sanitizeHex32("xyz"), /SL\/DL/);
});

test("baudRateToAtbd はボーレートを ATBD コードに変換する", () => {
  assert.equal(baudRateToAtbd(9600), "3");
  assert.equal(baudRateToAtbd(38400), "5");
  assert.equal(baudRateToAtbd(115200), "7");
});

test("baudRateToAtbd は未対応のボーレートを拒否する", () => {
  assert.throws(() => baudRateToAtbd(12345), /未対応/);
});

test("buildBaudRateCandidates は指定ボーレートを優先して重複と未対応値を除外する", () => {
  assert.deepEqual(buildBaudRateCandidates(38400), [38400, 9600, 115200, 57600, 19200, 4800, 2400, 1200]);
  assert.deepEqual(buildBaudRateCandidates([115200, 9600, 12345]), [115200, 9600, 38400, 57600, 19200, 4800, 2400, 1200]);
});

test("buildPairingPlan は Coordinator=A の計画を返す", () => {
  const plan = buildPairingPlan({ panId: "0x7b", coordinator: "A", baudRate: 9600 });
  assert.equal(plan.normalizedPanId, "7B");
  assert.deepEqual(plan.roles, { A: "1", B: "0" });
  assert.deepEqual(plan.commandsForA, ["ATID7B\r", "ATCE1\r", "ATBD3\r"]);
  assert.deepEqual(plan.commandsForB, ["ATID7B\r", "ATCE0\r", "ATBD3\r"]);
});

test("buildPairingPlan は Coordinator=B の計画を返す", () => {
  const plan = buildPairingPlan({ panId: "ABCD", coordinator: "B", baudRate: 38400 });
  assert.deepEqual(plan.roles, { A: "0", B: "1" });
  assert.equal(plan.baudRate, 38400);
});

test("buildPairingPlan は不正な Coordinator を拒否する", () => {
  assert.throws(() => buildPairingPlan({ panId: "1234", coordinator: /** @type {any} */ ("C"), baudRate: 9600 }), /Coordinator/);
});

test("buildApiNetworkPlan は 3 台以上の API モード設定計画を返す", () => {
  const plan = buildApiNetworkPlan({ panId: "0x77", coordinatorIndex: 1, baudRate: 9600, deviceCount: 3 });
  assert.equal(plan.normalizedPanId, "77");
  assert.equal(plan.apiMode, "1");
  assert.deepEqual(plan.roles, ["0", "1", "0"]);
  assert.deepEqual(plan.commandsForDevices, [
    ["ATID77\r", "ATCE0\r", "ATBD3\r", "ATAP1\r"],
    ["ATID77\r", "ATCE1\r", "ATBD3\r", "ATAP1\r"],
    ["ATID77\r", "ATCE0\r", "ATBD3\r", "ATAP1\r"]
  ]);
});

test("buildApiNetworkPlan は 2 台以下を拒否する", () => {
  assert.throws(() => buildApiNetworkPlan({ panId: "1234", coordinatorIndex: 0, baudRate: 9600, deviceCount: 2 }), /3 台以上/);
});

test("buildApiNetworkPlan は範囲外の Coordinator を拒否する", () => {
  assert.throws(() => buildApiNetworkPlan({ panId: "1234", coordinatorIndex: 3, baudRate: 9600, deviceCount: 3 }), /Coordinator/);
});

test("normalizeWirelessTestPayload は空欄なら既定値を返し、改行を除去する", () => {
  assert.equal(normalizeWirelessTestPayload(""), "XBee wireless test");
  assert.equal(normalizeWirelessTestPayload("  hello\r\nworld  "), "hello world");
});

test("buildWirelessTestFrame は方向とペイロードを含む1行の送信データを作る", () => {
  const frame = buildWirelessTestFrame("a2b", "hello");
  assert.match(frame, /^\[A2B:[A-Z0-9]+:[A-F0-9]{6}\] hello\n$/);
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
  const { session, port } = await openTestSession([
    { command: "ATSL\r", chunks: [{ text: "1234ABCD\r" }] }
  ]);
  await assert.doesNotReject(async () => {
    assert.equal(await session.readSerialLow(), "1234ABCD");
  });
  assert.deepEqual(port.writer.writes, ["ATSL\r"]);
  await session.close();
});

test("readSerialLow の値のみ応答後でも次のOK応答を失わない", async () => {
  const { session, port } = await openTestSession([
    { command: "ATSL\r", chunks: [{ text: "1234ABCD\r" }] },
    { command: "ATID1\r", chunks: [{ text: "OK\r" }] }
  ]);

  assert.equal(await session.readSerialLow(), "1234ABCD");
  await session.sendOkCommand("ATID1\r", "ATID1");
  assert.deepEqual(port.writer.writes, ["ATSL\r", "ATID1\r"]);
  await session.close();
});

test("readSerialLow は 値とOKが同一チャンクで成功し値を返す", async () => {
  const { session, port } = await openTestSession([
    { command: "ATSL\r", chunks: [{ text: "1234ABCD\rOK\r" }] }
  ]);
  assert.equal(await session.readSerialLow(), "1234ABCD");
  assert.deepEqual(port.writer.writes, ["ATSL\r"]);
  await session.close();
});

test("readSerialLow は 値とOKが別チャンクでも後続OKを誤消費しない", async () => {
  const { session, port } = await openTestSession([
    { command: "ATSL\r", chunks: [{ text: "1234ABCD\r" }, { text: "OK\r", delayMs: 1 }] },
    { command: "ATID1\r", chunks: [{ text: "OK\r" }] }
  ]);

  assert.equal(await session.readSerialLow(), "1234ABCD");
  await session.sendOkCommand("ATID1\r", "ATID1");
  assert.deepEqual(port.writer.writes, ["ATSL\r", "ATID1\r"]);
  await session.close();
});

test("enterCommandMode は +++ を送信して OK を受信する", async () => {
  const { session, port } = await openTestSession([
    { command: "+++", chunks: [{ text: "OK\r" }] }
  ]);
  await assert.doesNotReject(async () => {
    await session.enterCommandMode();
  });
  assert.deepEqual(port.writer.writes, ["+++"]);
  await session.close();
});

test("openCommandModeSession は応答したボーレートのセッションを開いたまま返す", async () => {
  const port = createFakeSerialPort([
    { command: "+++", chunks: [{ text: "OK\r" }] }
  ]);

  const session = await openCommandModeSession(port, {
    name: "Test",
    candidates: [38400],
    logger: () => {},
    commandTimeoutMs: 40,
    enterCommandTimeoutMs: 40,
    closeTimeoutMs: 5,
    valueSettleTimeoutMs: 10
  });

  assert.equal(session.baudRate, 38400);
  assert.equal(port.isOpen, true);
  assert.deepEqual(port.openOptions.map((options) => options.baudRate), [38400]);
  assert.deepEqual(port.writer.writes, ["+++"]);
  await session.close();
});

test("OK必須コマンドは値のみ応答なら失敗する", async () => {
  const { session } = await openTestSession([
    { command: "ATID1\r", chunks: [{ text: "1234ABCD\r" }] }
  ]);
  await assert.rejects(session.sendOkCommand("ATID1\r", "ATID1"), /OK/);
  await session.close();
});

test("readSerialLow の遅延OKだけでは次のOK必須コマンドを成功扱いしない", async () => {
  const { session } = await openTestSession([
    { command: "ATSL\r", chunks: [{ text: "1234ABCD\r" }, { text: "OK\r", delayMs: 12 }] },
    { command: "ATID1\r", chunks: [] }
  ]);

  assert.equal(await session.readSerialLow(), "1234ABCD");
  await assert.rejects(session.sendOkCommand("ATID1\r", "ATID1"), /タイムアウト/);
  await session.close();
});

test("analyzeResponseState は remainder の未終端値を値として扱う", () => {
  const result = analyzeResponseState([], "418CDC");
  assert.equal(result.valueLine, "418CDC");
  assert.equal(result.valueFromRemainder, true);
  assert.equal(result.hasOk, false);
});

test("analyzeResponseState は remainder が OK の場合は値としない", () => {
  const result = analyzeResponseState([], "OK");
  assert.equal(result.valueLine, null);
  assert.equal(result.hasOk, true);
});

test("analyzeResponseState は完全行の値を優先する", () => {
  const result = analyzeResponseState(["1234ABCD"], "418CDC");
  assert.equal(result.valueLine, "1234ABCD");
  assert.equal(result.valueFromRemainder, false);
});

test("readSerialLow は \\r 終端なしの値応答でも成功する", async () => {
  const { session, port } = await openTestSession([
    { command: "ATSL\r", chunks: [{ text: "418CDC" }] }
  ]);
  assert.equal(await session.readSerialLow(), "00418CDC");
  assert.deepEqual(port.writer.writes, ["ATSL\r"]);
  await session.close();
});

test("readSerialLow は値が分割到着しても完全な値を返す", async () => {
  const { session } = await openTestSession([
    { command: "ATSL\r", chunks: [{ text: "4" }, { text: "18CDC\r", delayMs: 1 }] }
  ]);
  assert.equal(await session.readSerialLow(), "00418CDC");
  await session.close();
});

test("sendOkCommand は \\r 終端なしの OK 応答でも成功する", async () => {
  const { session, port } = await openTestSession([
    { command: "ATID1\r", chunks: [{ text: "OK" }] }
  ]);
  await assert.doesNotReject(async () => {
    await session.sendOkCommand("ATID1\r", "ATID1");
  });
  assert.deepEqual(port.writer.writes, ["ATID1\r"]);
  await session.close();
});

test("verifyTransparentWirelessLink は透過モードで A→B と B→A の受信を確認する", async () => {
  const { portA, portB } = createLinkedTransparentPorts();
  const logs = [];

  const result = await verifyTransparentWirelessLink({
    portA,
    portB,
    baudRate: 9600,
    payload: "ping",
    timeoutMs: 100,
    logger: (message) => logs.push(message)
  });

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.map((item) => item.direction), ["A→B", "B→A"]);
  assert.equal(portA.openOptions[0].baudRate, 9600);
  assert.equal(portB.openOptions[0].baudRate, 9600);
  assert.equal(portA.writer.writes.length, 1);
  assert.equal(portB.writer.writes.length, 1);
  assert.ok(logs.some((message) => message.includes("[DONE]")));
});
