const GUARD_TIME_MS = 1100;
const ENTER_COMMAND_TIMEOUT_MS = 2500;
const COMMAND_TIMEOUT_MS = 2500;
const CLOSE_TIMEOUT_MS = 1000;

/** XBee の現在の UART 設定で試す候補。XBee の設定値は変更しない。 */
export const DEFAULT_BAUD_RATE_CANDIDATES = [9600, 38400, 115200, 57600, 19200, 4800, 2400, 1200];

/** @param {number | number[]} preferred */
export function buildBaudRateCandidates(preferred = []) {
  const values = Array.isArray(preferred) ? preferred : [preferred];
  const candidates = [];
  for (const value of [...values, ...DEFAULT_BAUD_RATE_CANDIDATES]) {
    const baudRate = Number(value);
    if (Number.isInteger(baudRate) && baudRate > 0 && !candidates.includes(baudRate)) candidates.push(baudRate);
  }
  return candidates;
}

/** @param {string} buffer */
export function extractCompleteLines(buffer) {
  const normalized = String(buffer).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const complete = normalized.endsWith("\n");
  const parts = normalized.split("\n");
  const remainder = complete ? "" : (parts.pop() ?? "");
  return { lines: parts.map((line) => line.trim()).filter(Boolean), remainder };
}

/** @param {{lines: string[], remainder: string}} state @param {string} chunkText */
export function appendResponseChunk(state, chunkText) {
  const next = extractCompleteLines(`${state.remainder}${chunkText}`);
  return { lines: [...state.lines, ...next.lines], remainder: next.remainder };
}

/** @param {string[]} lines */
export function analyzeResponseLines(lines) {
  return { hasOk: lines.some((line) => /^OK$/i.test(line)), valueLine: lines.find((line) => !/^OK$/i.test(line)) ?? null };
}

/** @param {{lines: string[], remainder: string}} state */
function analyzeResponseState(state) {
  const analysis = analyzeResponseLines(state.lines);
  const remainder = state.remainder.trim();
  if (/^OK$/i.test(remainder)) return { ...analysis, hasOk: true };
  if (!analysis.valueLine && remainder) return { ...analysis, valueLine: remainder };
  return analysis;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function formatError(error) { return error instanceof Error ? error.message : String(error); }
function ensureNotAborted(signal) {
  if (signal?.aborted) throw new Error("処理がキャンセルされました。");
}

const API_FRAME_START = 0x7e;
const API_MAX_FRAME_LENGTH = 4096;
const API_RESPONSE_STATUS = {
  0x00: "成功",
  0x01: "エラー",
  0x02: "無効なコマンド",
  0x03: "無効なパラメータ",
  0x04: "送信失敗"
};

/**
 * APIフレームを作成する。AP=1の非エスケープ形式のみを扱う。
 * @param {number} frameType
 * @param {number} frameId
 * @param {string} command
 * @param {Uint8Array|number[]|null} parameter
 * @returns {Uint8Array}
 */
export function buildApiFrame(frameType, frameId, command, parameter = null) {
  if (!Number.isInteger(frameType) || frameType < 0 || frameType > 0xff) throw new Error("APIフレーム種別が不正です。");
  if (!Number.isInteger(frameId) || frameId <= 0 || frameId > 0xff) throw new Error("APIフレームIDは1〜255で指定してください。");
  const text = String(command ?? "");
  if (!/^[A-Za-z]{2}$/.test(text)) throw new Error("ATコマンドは2文字で指定してください。");
  const values = parameter == null ? [] : Array.from(parameter, Number);
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 0xff)) throw new Error("APIパラメータが不正です。");
  const data = new Uint8Array([frameType, frameId, text.charCodeAt(0), text.charCodeAt(1), ...values]);
  const frame = new Uint8Array(data.length + 4);
  frame[0] = API_FRAME_START;
  frame[1] = (data.length >> 8) & 0xff;
  frame[2] = data.length & 0xff;
  frame.set(data, 3);
  let sum = 0;
  for (const value of data) sum = (sum + value) & 0xff;
  frame[frame.length - 1] = (0xff - sum) & 0xff;
  return frame;
}

export const buildLocalAtCommandFrame = buildApiFrame;

/** API受信フレームをストリームから取り出すparser。 */
export class XBeeApiFrameParser {
  constructor() { this.buffer = new Uint8Array(0); }

  /** @param {Uint8Array} chunk @returns {Uint8Array[]} */
  feed(chunk) {
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
    const frames = [];
    while (true) {
      const start = this.buffer.indexOf(API_FRAME_START);
      if (start < 0) { this.buffer = new Uint8Array(0); break; }
      if (start > 0) this.buffer = this.buffer.slice(start);
      if (this.buffer.length < 3) break;
      const length = (this.buffer[1] << 8) | this.buffer[2];
      if (length < 1 || length > API_MAX_FRAME_LENGTH) { this.buffer = this.buffer.slice(1); continue; }
      const total = length + 4;
      if (this.buffer.length < total) break;
      const data = this.buffer.slice(3, 3 + length);
      const checksum = this.buffer[3 + length];
      let sum = checksum;
      for (const value of data) sum = (sum + value) & 0xff;
      if (sum !== 0xff) {
        this.buffer = this.buffer.slice(1);
        continue;
      }
      this.buffer = this.buffer.slice(total);
      frames.push(data);
    }
    return frames;
  }
}

/** @param {Uint8Array} data */
export function parseApiFrameData(data) {
  if (!(data instanceof Uint8Array) || data.length < 1) throw new Error("空のAPIフレームです。");
  const frame = { frameType: data[0], frameId: data[1] ?? null, command: data.length >= 4 ? String.fromCharCode(data[2], data[3]) : null, status: null, parameter: data.length > 5 ? data.slice(5) : new Uint8Array(0), data };
  if (frame.frameType === 0x88) {
    if (data.length < 5) throw new Error("0x88応答フレームが短すぎます。");
    frame.status = data[4];
  }
  return frame;
}

/** Web Serial の1ポートを XBee AT コマンドモードで扱うセッション。 */
export class XBeeSerialSession {
  /** @param {SerialPort} port @param {any} options */
  constructor(port, options) {
    this.port = port;
    this.baudRate = options.baudRate;
    this.name = options.name ?? "XBee";
    this.logger = options.logger ?? (() => {});
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.enterCommandTimeoutMs = options.enterCommandTimeoutMs ?? ENTER_COMMAND_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    this.guardTimeMs = options.guardTimeMs ?? GUARD_TIME_MS;
    this.reader = null;
    this.writer = null;
    this.isOpen = false;
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
    this.responseLines = [];
    this.responseRemainder = "";
    this.inputSequence = 0;
    this.lastSeenSequence = 0;
    this.waiters = [];
    this.readLoopPromise = null;
    this.readLoopError = null;
    this.closing = false;
  }

  async open() {
    if (this.isOpen) return;
    try {
      await this.port.open({ baudRate: this.baudRate, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
    } catch (error) {
      const wrapped = new Error(`${this.name}: シリアルポートを開けませんでした: ${formatError(error)}`);
      wrapped.code = "PORT_OPEN_FAILED";
      throw wrapped;
    }
    this.isOpen = true;
    try {
      this.reader = this.port.readable?.getReader() ?? null;
      this.writer = this.port.writable?.getWriter() ?? null;
      if (!this.reader || !this.writer) throw new Error("シリアルストリームを取得できませんでした。");
      this.readLoopError = null;
      this.readLoopPromise = this.readLoop();
    } catch (error) {
      await this.close();
      const wrapped = new Error(`${this.name}: シリアルポート／ストリームを取得できませんでした: ${formatError(error)}`);
      wrapped.code = "PORT_STREAM_FAILED";
      throw wrapped;
    }
  }

  async close() {
    this.closing = true;
    const reader = this.reader;
    this.reader = null;
    this.writer?.releaseLock?.();
    this.writer = null;
    if (reader) {
      await Promise.race([Promise.resolve(reader.cancel()).catch(() => {}), delay(this.closeTimeoutMs)]);
      reader.releaseLock?.();
    }
    if (this.isOpen) await this.port.close().catch(() => {});
    this.isOpen = false;
    this.responseLines = [];
    this.responseRemainder = "";
    this.waiters.splice(0).forEach((resolve) => resolve(false));
    this.readLoopPromise = null;
    this.readLoopError = null;
    this.closing = false;
  }

  async enterCommandMode() {
    this.ensureReady();
    await delay(this.guardTimeMs);
    this.clearResponseBuffer();
    await this.writeRaw("+++");
    await delay(this.guardTimeMs);
    await this.expectOk(this.enterCommandTimeoutMs, "コマンドモード移行");
  }

  /** @param {string} command @param {string} label */
  async sendOkCommand(command, label = command.trim()) {
    this.ensureReady();
    this.clearResponseBuffer();
    await this.writeRaw(command);
    await this.expectOk(this.commandTimeoutMs, label);
  }

  async writeRaw(command) {
    this.ensureReady();
    await this.writer.write(this.encoder.encode(command));
  }

  async expectOk(timeoutMs, context) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = analyzeResponseState({ lines: this.responseLines, remainder: this.responseRemainder });
      if (state.hasOk) {
        this.clearResponseBuffer();
        return;
      }
      if (this.readLoopError) throw this.readLoopError;
      await this.waitForInput(Math.max(0, deadline - Date.now()));
    }
    const received = [...this.responseLines, this.responseRemainder].filter(Boolean).join(", ");
    throw new Error(`${this.name}: ${context} の応答が OK ではありませんでした。${received ? `受信内容=[${received}]` : "タイムアウト"}`);
  }

  async readLoop() {
    try {
      while (this.reader) {
        const { value, done } = await this.reader.read();
        if (done) {
          if (!this.closing) {
            this.readLoopError = new Error(`${this.name}: シリアルポートが切断されました。`);
            this.log(this.readLoopError.message);
            this.waiters.splice(0).forEach((resolve) => resolve(false));
          }
          break;
        }
        if (value) {
          const next = appendResponseChunk({ lines: this.responseLines, remainder: this.responseRemainder }, this.decoder.decode(value, { stream: true }));
          this.responseLines = next.lines;
          this.responseRemainder = next.remainder;
          this.inputSequence += 1;
          this.waiters.splice(0).forEach((resolve) => resolve(true));
        }
      }
    } catch (error) {
      this.readLoopError = error;
      this.waiters.splice(0).forEach((resolve) => resolve(false));
    }
  }

  waitForInput(timeoutMs) {
    if (this.inputSequence !== this.lastSeenSequence) {
      this.lastSeenSequence = this.inputSequence;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const finish = (value) => { clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== finish);
        resolve(false);
      }, timeoutMs);
      this.waiters.push(finish);
    }).then((value) => { this.lastSeenSequence = this.inputSequence; return value; });
  }

  clearResponseBuffer() { this.responseLines = []; this.responseRemainder = ""; this.lastSeenSequence = this.inputSequence; }
  ensureReady() { if (!this.isOpen || !this.reader || !this.writer) throw new Error(`${this.name}: ポートが開かれていません。`); }
  log(message) { this.logger(`[${this.name}] ${message}`); }
}

/** AP=1非エスケープAPIフレーム用のローカルATセッション。 */
export class XBeeApiSerialSession {
  /** @param {SerialPort} port @param {any} options */
  constructor(port, options) {
    this.port = port;
    this.baudRate = options.baudRate;
    this.name = options.name ?? "XBee";
    this.logger = options.logger ?? (() => {});
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    this.reader = null;
    this.writer = null;
    this.isOpen = false;
    this.parser = new XBeeApiFrameParser();
    this.frames = [];
    this.waiters = [];
    this.readLoopPromise = null;
    this.readLoopError = null;
    this.closing = false;
  }

  async open() {
    if (this.isOpen) return;
    try {
      await this.port.open({ baudRate: this.baudRate, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
    } catch (error) {
      const wrapped = new Error(`${this.name}: シリアルポートを開けませんでした: ${formatError(error)}`);
      wrapped.code = "PORT_OPEN_FAILED";
      throw wrapped;
    }
    this.isOpen = true;
    try {
      this.reader = this.port.readable?.getReader() ?? null;
      this.writer = this.port.writable?.getWriter() ?? null;
      if (!this.reader || !this.writer) throw new Error("シリアルストリームを取得できませんでした。");
      this.readLoopError = null;
      this.readLoopPromise = this.readLoop();
    } catch (error) {
      await this.close();
      const wrapped = new Error(`${this.name}: シリアルポート／ストリームを取得できませんでした: ${formatError(error)}`);
      wrapped.code = "PORT_STREAM_FAILED";
      throw wrapped;
    }
  }

  async close() {
    this.closing = true;
    const reader = this.reader;
    this.reader = null;
    this.writer?.releaseLock?.();
    this.writer = null;
    if (reader) {
      await Promise.race([Promise.resolve(reader.cancel()).catch(() => {}), delay(this.closeTimeoutMs)]);
      reader.releaseLock?.();
    }
    if (this.isOpen) await this.port.close().catch(() => {});
    this.isOpen = false;
    this.waiters.splice(0).forEach((resolve) => resolve(false));
    this.frames = [];
    this.readLoopPromise = null;
    this.readLoopError = null;
    this.closing = false;
  }

  async readLoop() {
    try {
      while (this.reader) {
        const { value, done } = await this.reader.read();
        if (done) {
          if (!this.closing) {
            this.readLoopError = new Error(`${this.name}: シリアルポートが切断されました。`);
            this.waiters.splice(0).forEach((resolve) => resolve(false));
          }
          break;
        }
        if (value) {
          this.frames.push(...this.parser.feed(value));
          this.waiters.splice(0).forEach((resolve) => resolve(true));
        }
      }
    } catch (error) {
      this.readLoopError = error;
      this.waiters.splice(0).forEach((resolve) => resolve(false));
    }
  }

  /** @param {number} frameType @param {string} command @param {Uint8Array|number[]|null} parameter @param {any} options */
  async sendLocalAtCommand(frameType, command, parameter, options = {}) {
    if (options.signal?.aborted) throw new Error("処理がキャンセルされました。");
    this.ensureReady();
    const frameId = options.frameId ?? 1;
    const request = buildApiFrame(frameType, frameId, command, parameter);
    await this.writer.write(request);
    const deadline = Date.now() + (options.timeoutMs ?? this.commandTimeoutMs);
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new Error("処理がキャンセルされました。");
      if (this.readLoopError) throw this.readLoopError;
      while (this.frames.length > 0) {
        const data = this.frames.shift();
        let frame;
        try { frame = parseApiFrameData(data); } catch { continue; }
        if (frame.frameType !== 0x88 || frame.frameId !== frameId || frame.command !== command) continue;
        if (frame.status !== 0) {
          const description = API_RESPONSE_STATUS[frame.status] ?? `status=0x${frame.status.toString(16).padStart(2, "0")}`;
          const failure = new Error(`${this.name}: API ${command} 応答が失敗しました（${description}）。`);
          failure.code = "API_COMMAND_FAILED";
          throw failure;
        }
        return frame;
      }
      await this.waitForInput(Math.max(0, Math.min(100, deadline - Date.now())));
    }
    throw new Error(`${this.name}: API ${command} の0x88応答がタイムアウトしました。`);
  }

  waitForInput(timeoutMs) {
    if (this.frames.length || this.readLoopError) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (value) => { clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((item) => item !== finish); resolve(false); }, timeoutMs);
      this.waiters.push(finish);
    });
  }

  ensureReady() { if (!this.isOpen || !this.reader || !this.writer) throw new Error(`${this.name}: ポートが開かれていません。`); }
}

/** API=1のAP queryでボーレートを検出し、開いたAPIセッションを返す。 */
export async function openApiSession(port, options) {
  const candidates = buildBaudRateCandidates(options.candidates ?? []);
  const logger = options.logger ?? (() => {});
  for (const baudRate of candidates) {
    ensureNotAborted(options.signal);
    const session = new XBeeApiSerialSession(port, { ...options, baudRate, logger });
    try {
      logger(`[SCAN] ${options.name ?? "XBee"}: ${baudRate} bps でAPI AP queryを確認します`);
      await session.open();
      const response = await session.sendLocalAtCommand(0x09, "AP", null, { signal: options.signal, frameId: 1 });
      const value = response.parameter[0];
      if (value === 2) {
        const unsupported = new Error(`${options.name ?? "XBee"}: AP=2（エスケープAPI）はサポート対象外です。AP=1にしてから実行してください。`);
        await session.close().catch(() => {});
        throw unsupported;
      }
      if (value !== 1) throw new Error(`${options.name ?? "XBee"}: API応答のAP値が1ではありません。`);
      logger(`[OK] ${options.name ?? "XBee"}: ${baudRate} bps / AP=1を検出しました`);
      return session;
    } catch (error) {
      if (error?.code === "PORT_OPEN_FAILED" || error?.code === "PORT_STREAM_FAILED" || error?.code === "API_COMMAND_FAILED" || /AP=2/.test(formatError(error))) {
        await session.close().catch(() => {});
        throw error;
      }
      logger(`[SCAN] ${options.name ?? "XBee"}: ${baudRate} bps はAPI応答なし: ${formatError(error)}`);
      await session.close().catch(() => {});
    }
  }
  throw new Error(`${options.name ?? "XBee"}: APIフレームでUARTボーレートを検出できませんでした。AP=1のXBeeか確認してください。`);
}

/** 候補ボーレートを順に試し、+++ に応答した開いたセッションを返す。 */
export async function openCommandModeSession(port, options) {
  const candidates = buildBaudRateCandidates(options.candidates ?? []);
  const logger = options.logger ?? (() => {});
  for (const baudRate of candidates) {
    ensureNotAborted(options.signal);
    const session = new XBeeSerialSession(port, { ...options, baudRate, logger });
    try {
      logger(`[SCAN] ${options.name ?? "XBee"}: ${baudRate} bps で +++ を確認します`);
      await session.open();
      await session.enterCommandMode();
      logger(`[OK] ${options.name ?? "XBee"}: ${baudRate} bps でコマンドモードを検出しました`);
      return session;
    } catch (error) {
      if (error?.code === "PORT_OPEN_FAILED" || error?.code === "PORT_STREAM_FAILED") throw error;
      logger(`[SCAN] ${options.name ?? "XBee"}: ${baudRate} bps は失敗: ${formatError(error)}`);
      await session.close().catch(() => {});
    }
  }
  throw new Error(`${options.name ?? "XBee"}: UART ボーレートを検出できないか、AT コマンドモードに入れませんでした。電源・USB接続・現在のATモードを確認してください。`);
}

/** 1台を独立して AP=1 にする。 */
export async function enableApiMode(options) {
  if (!options?.port) throw new Error("設定対象の XBee ポートが選択されていません。");
  const logger = options.logger ?? (() => {});
  let session = null;
  try {
    ensureNotAborted(options.signal);
    session = await openCommandModeSession(options.port, options);
    logger(`[${options.name ?? "XBee"}] API モード設定を開始します`);
    ensureNotAborted(options.signal);
    logger(`[WRITE] ${options.name ?? "XBee"}: ATAP1`);
    await session.sendOkCommand("ATAP1\r", "ATAP1");
    logger(`[OK] ${options.name ?? "XBee"}: ATAP1`);
    ensureNotAborted(options.signal);
    logger(`[WRITE] ${options.name ?? "XBee"}: ATWR`);
    await session.sendOkCommand("ATWR\r", "ATWR");
    logger(`[OK] ${options.name ?? "XBee"}: ATWR`);
    ensureNotAborted(options.signal);
    logger(`[WRITE] ${options.name ?? "XBee"}: ATCN`);
    await session.sendOkCommand("ATCN\r", "ATCN");
    logger(`[OK] ${options.name ?? "XBee"}: ATCN`);
    logger(`[DONE] ${options.name ?? "XBee"}: AP=1 設定が完了しました`);
    return { name: options.name ?? "XBee", baudRate: session.baudRate, apiMode: "1" };
  } finally {
    await session?.close().catch(() => {});
  }
}

/** AP=1 APIモードから、AP=0透過（AT）モードへ変更する。 */
export async function enableTransparentMode(options) {
  if (!options?.port) throw new Error("設定対象の XBee ポートが選択されていません。");
  const logger = options.logger ?? (() => {});
  let session = null;
  try {
    ensureNotAborted(options.signal);
    session = await openApiSession(options.port, options);
    logger(`[WRITE] ${options.name ?? "XBee"}: API 0x09 Queue Local AT AP=0`);
    await session.sendLocalAtCommand(0x09, "AP", [0x00], { signal: options.signal, frameId: 2 });
    logger(`[OK] ${options.name ?? "XBee"}: API AP=0 queued`);
    ensureNotAborted(options.signal);
    logger(`[WRITE] ${options.name ?? "XBee"}: API 0x08 Local AT WR`);
    await session.sendLocalAtCommand(0x08, "WR", null, { signal: options.signal, frameId: 3 });
    logger(`[OK] ${options.name ?? "XBee"}: API WR`);
    logger(`[DONE] ${options.name ?? "XBee"}: 透過（AT）モード AP=0 を保存しました`);
    return { name: options.name ?? "XBee", baudRate: session.baudRate, apiMode: "0" };
  } finally {
    await session?.close().catch(() => {});
  }
}
