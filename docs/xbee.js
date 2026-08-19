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
