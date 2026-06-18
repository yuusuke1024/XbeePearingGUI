const GUARD_TIME_MS = 1100;
const ENTER_COMMAND_TIMEOUT_MS = 2500;
const COMMAND_TIMEOUT_MS = 2500;
const CLOSE_TIMEOUT_MS = 1000;
const VALUE_SETTLE_TIMEOUT_MS = 80;

const CONFIG_BAUD_RATE = 9600;

const BAUD_RATE_ATBD_TABLE = {
  1200: "0",
  2400: "1",
  4800: "2",
  9600: "3",
  19200: "4",
  38400: "5",
  57600: "6",
  115200: "7"
};

export function baudRateToAtbd(baudRate) {
  const code = BAUD_RATE_ATBD_TABLE[baudRate];
  if (!code) {
    throw new Error(`未対応のボーレートです: ${baudRate}`);
  }
  return code;
}

/**
 * @param {string} value
 * @returns {string}
 */
/**
 * @param {string[]} lines
 * @param {string} remainder
 * @returns {string}
 */
function formatReceivedForError(lines, remainder) {
  const parts = lines.map((line) => JSON.stringify(line));
  if (remainder) {
    parts.push(`remainder=${JSON.stringify(remainder)}`);
  }
  return parts.length > 0 ? parts.join(", ") : "(なし)";
}

export function sanitizeHex32(value) {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/^0X/, "");
  if (!/^[0-9A-F]{1,8}$/.test(normalized)) {
    throw new Error("SL/DL に使用する値は 1〜8 桁の16進数で指定してください。");
  }
  return normalized.padStart(8, "0");
}

/**
 * @param {string} input
 * @returns {string}
 */
export function normalizePanId(input) {
  const normalized = String(input ?? "").trim().toUpperCase().replace(/^0X/, "");
  if (!/^[0-9A-F]{1,16}$/.test(normalized)) {
    throw new Error("PAN ID は 1〜16 桁の16進数で入力してください。0x 接頭辞は省略可能です。");
  }
  return normalized;
}

/**
 * @param {{ panId: string, coordinator: "A"|"B", baudRate: number }} options
 * @returns {{
 *   normalizedPanId: string,
 *   roles: { A: "1"|"0", B: "1"|"0" },
 *   baudRate: number,
 *   commandsForA: string[],
 *   commandsForB: string[]
 * }}
 */
export function buildPairingPlan({ panId, coordinator, baudRate }) {
  const normalizedPanId = normalizePanId(panId);
  if (coordinator !== "A" && coordinator !== "B") {
    throw new Error("Coordinator は A または B を指定してください。");
  }

  const bdCode = baudRateToAtbd(baudRate);
  const roles = coordinator === "A" ? { A: "1", B: "0" } : { A: "0", B: "1" };

  return {
    normalizedPanId,
    roles,
    baudRate,
    commandsForA: [`ATID${normalizedPanId}\r`, `ATCE${roles.A}\r`, `ATBD${bdCode}\r`],
    commandsForB: [`ATID${normalizedPanId}\r`, `ATCE${roles.B}\r`, `ATBD${bdCode}\r`]
  };
}

/**
 * @param {string} buffer
 * @returns {{ lines: string[], remainder: string }}
 */
export function extractCompleteLines(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const parts = normalized.split("\n");
  const remainder = trailingNewline ? "" : parts.pop() ?? "";
  const lines = parts.map((line) => line.trim()).filter(Boolean);
  return { lines, remainder };
}

/**
 * @param {{ lines: string[], remainder: string }} state
 * @param {string} chunkText
 * @returns {{ lines: string[], remainder: string }}
 */
export function appendResponseChunk(state, chunkText) {
  const next = extractCompleteLines(`${state.remainder}${chunkText}`);
  return {
    lines: [...state.lines, ...next.lines],
    remainder: next.remainder
  };
}

/**
 * @param {string[]} lines
 * @returns {{ hasOk: boolean, valueLine: string | null }}
 */
export function analyzeResponseLines(lines) {
  const hasOk = lines.some((line) => /^OK$/i.test(line));
  const valueLine = lines.find((line) => !/^OK$/i.test(line)) ?? null;
  return { hasOk, valueLine };
}

/**
 * @param {string[]} lines
 * @param {string} remainder
 * @returns {{ hasOk: boolean, valueLine: string | null, valueFromRemainder: boolean }}
 */
export function analyzeResponseState(lines, remainder) {
  const analysis = analyzeResponseLines(lines);
  const trimmedRemainder = remainder.trim();
  const remainderIsOk = trimmedRemainder !== "" && /^OK$/i.test(trimmedRemainder);

  if (analysis.valueLine) {
    return { hasOk: analysis.hasOk || remainderIsOk, valueLine: analysis.valueLine, valueFromRemainder: false };
  }
  if (remainderIsOk) {
    return { hasOk: true, valueLine: null, valueFromRemainder: false };
  }
  if (trimmedRemainder) {
    return { hasOk: analysis.hasOk, valueLine: trimmedRemainder, valueFromRemainder: true };
  }
  return { hasOk: analysis.hasOk, valueLine: null, valueFromRemainder: false };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {number} deadline
 * @param {number | null} settleDeadline
 * @returns {number}
 */
function computeWaitMs(deadline, settleDeadline) {
  const now = Date.now();
  const candidates = [deadline - now];
  if (settleDeadline !== null) {
    candidates.push(settleDeadline - now);
  }
  return Math.max(0, Math.min(...candidates));
}

export class XBeeSerialSession {
  /**
   * @param {SerialPort} port
   * @param {{
   *   baudRate: number,
   *   name: string,
   *   logger?: (message: string) => void,
   *   commandTimeoutMs?: number,
   *   enterCommandTimeoutMs?: number,
   *   closeTimeoutMs?: number,
   *   valueSettleTimeoutMs?: number
   * }} options
   */
  constructor(port, options) {
    this.port = port;
    this.baudRate = options.baudRate;
    this.name = options.name;
    this.logger = options.logger ?? (() => {});
    this.reader = null;
    this.writer = null;
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
    this.buffer = "";
    this.responseLines = [];
    this.responseRemainder = "";
    this.waiters = [];
    this.isOpen = false;
    this.readLoopPromise = null;
    this.readLoopError = null;
    this.needsInputFlush = false;
    this.inputSequence = 0;
    this.lastSeenSequence = 0;
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.enterCommandTimeoutMs = options.enterCommandTimeoutMs ?? ENTER_COMMAND_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    this.valueSettleTimeoutMs = options.valueSettleTimeoutMs ?? VALUE_SETTLE_TIMEOUT_MS;
  }

  async open() {
    if (this.isOpen) {
      return;
    }

    await this.port.open({
      baudRate: this.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none"
    });

    this.reader = this.port.readable?.getReader() ?? null;
    this.writer = this.port.writable?.getWriter() ?? null;

    if (!this.reader || !this.writer) {
      throw new Error(`${this.name}: シリアルストリームを取得できませんでした。`);
    }

    this.isOpen = true;
    this.readLoopError = null;
    this.readLoopPromise = this.readLoop();
    this.log(`ポートを開きました (baud=${this.baudRate})`);
  }

  async close() {
    const tasks = [];

    if (this.reader) {
      tasks.push(
        Promise.race([
          this.reader.cancel().catch(() => {}),
          delay(this.closeTimeoutMs)
        ]).then(async () => {
          if (this.readLoopPromise) {
            await Promise.race([
              this.readLoopPromise.catch(() => {}),
              delay(this.closeTimeoutMs)
            ]);
          }
          this.reader?.releaseLock();
          this.reader = null;
        })
      );
    }

    if (this.writer) {
      tasks.push(
        Promise.resolve().then(() => {
          this.writer?.releaseLock();
          this.writer = null;
        })
      );
    }

    await Promise.all(tasks);

    if (this.isOpen) {
      await this.port.close().catch(() => {});
      this.log("ポートを閉じました");
    }

    this.isOpen = false;
    this.buffer = "";
    this.responseLines = [];
    this.responseRemainder = "";
    this.waiters = [];
    this.readLoopPromise = null;
    this.readLoopError = null;
    this.needsInputFlush = false;
    this.inputSequence = 0;
    this.lastSeenSequence = 0;
  }

  async enterCommandMode() {
    this.ensureReady();
    this.log("コマンドモードへ移行します");
    await delay(GUARD_TIME_MS);
    this.clearResponseBuffer();
    this.log(`送信: ${JSON.stringify("+++")}`);
    await this.writeRaw("+++");
    await delay(GUARD_TIME_MS);
    await this.expectOk(this.enterCommandTimeoutMs, "コマンドモード移行");
  }

  /**
   * @returns {Promise<string>}
   */
  async readSerialLow() {
    this.ensureReady();
    this.log("ATSL を送信します");
    const response = await this.sendCommand("ATSL\r", { expectValue: true, label: "ATSL" });
    return sanitizeHex32(response);
  }

  /**
   * @param {string} command
   * @param {string} label
   */
  async sendOkCommand(command, label) {
    this.ensureReady();
    await this.sendCommand(command, { expectValue: false, label });
  }

  /**
   * @param {string} command
   * @param {{ expectValue: boolean, label: string }} options
   * @returns {Promise<string>}
   */
  async sendCommand(command, options) {
    this.ensureReady();
    this.log(`${options.label} を送信します: ${JSON.stringify(command)}`);
    await this.flushStaleInputIfNeeded();
    this.clearResponseBuffer();
    await this.writeRaw(command);
    const lines = await this.readResponse(options.label, this.commandTimeoutMs, {
      acceptValue: options.expectValue
    });
    const analysis = analyzeResponseLines(lines);

    if (options.expectValue) {
      if (!analysis.valueLine) {
        const received = formatReceivedForError(lines, this.responseRemainder);
        throw new Error(`${this.name}: ${options.label} の応答値を受信できませんでした。受信内容=[${received}]`);
      }
      this.log(`${options.label} 応答値: ${analysis.valueLine}`);
      return analysis.valueLine;
    }

    if (!analysis.hasOk) {
      const received = formatReceivedForError(lines, this.responseRemainder);
      throw new Error(`${this.name}: ${options.label} の応答が OK ではありませんでした。受信内容=[${received}]`);
    }

    this.log(`${options.label} OK`);
    return "OK";
  }

  /**
   * @param {string} command
   */
  async writeRaw(command) {
    if (!this.writer) {
      throw new Error(`${this.name}: writer が利用できません。`);
    }
    await this.writer.write(this.encoder.encode(command));
  }

  /**
   * @param {number} timeoutMs
   * @param {string} context
   */
  async expectOk(timeoutMs, context) {
    const lines = await this.readResponse(context, timeoutMs, { acceptValue: false });
    const analysis = analyzeResponseLines(lines);
    if (!analysis.hasOk) {
      const received = formatReceivedForError(lines, this.responseRemainder);
      throw new Error(`${this.name}: ${context} の応答が OK ではありませんでした。受信内容=[${received}]`);
    }
    this.log(`${context}: OK`);
  }

  /**
   * @param {string} context
   * @param {number} timeoutMs
   * @param {{ acceptValue: boolean }} options
   * @returns {Promise<string[]>}
   */
  async readResponse(context, timeoutMs, options) {
    if (!this.reader) {
      throw new Error(`${this.name}: reader が利用できません。`);
    }

    const deadline = Date.now() + timeoutMs;
    let settleDeadline = null;

    while (Date.now() < deadline) {
      const waitMs = computeWaitMs(deadline, settleDeadline);
      const state = analyzeResponseState(this.responseLines, this.responseRemainder);

      if (state.hasOk) {
        if (this.responseRemainder.trim()) {
          this.promoteRemainderToLine();
        }
        const lines = this.consumeResponseLines();
        this.needsInputFlush = false;
        return lines;
      }

      if (options.acceptValue && state.valueLine && !state.valueFromRemainder && settleDeadline === null) {
        settleDeadline = Date.now() + this.valueSettleTimeoutMs;
      }

      if (options.acceptValue && state.valueLine && settleDeadline !== null && Date.now() >= settleDeadline) {
        const lines = this.consumeResponseLines();
        this.needsInputFlush = true;
        return lines;
      }

      const didReceive = await this.waitForInput(waitMs);
      if (!didReceive) {
        const latest = analyzeResponseState(this.responseLines, this.responseRemainder);
        if (options.acceptValue && latest.valueLine) {
          if (latest.valueFromRemainder) {
            this.promoteRemainderToLine();
          }
          const lines = this.consumeResponseLines();
          this.needsInputFlush = !latest.hasOk;
          return lines;
        }
      }
    }

    const finalState = analyzeResponseState(this.responseLines, this.responseRemainder);
    if (options.acceptValue && finalState.valueLine) {
      if (finalState.valueFromRemainder) {
        this.promoteRemainderToLine();
      }
      const lines = this.consumeResponseLines();
      this.needsInputFlush = !finalState.hasOk;
      return lines;
    }

    if (!options.acceptValue && finalState.valueLine) {
      const received = formatReceivedForError(this.responseLines, this.responseRemainder);
      this.clearResponseBuffer();
      throw new Error(`${this.name}: ${context} の応答が OK ではありませんでした。受信内容=[${received}]`);
    }
    const received = formatReceivedForError(this.responseLines, this.responseRemainder);
    throw new Error(`${this.name}: ${context} の応答待ちがタイムアウトしました。受信内容=[${received}]`);
  }

  async readLoop() {
    if (!this.reader) {
      return;
    }

    try {
      while (this.reader) {
        const { value, done } = await this.reader.read();
        if (done) {
          break;
        }
        if (value) {
          const next = appendResponseChunk(
            { lines: this.responseLines, remainder: this.responseRemainder },
            this.decoder.decode(value, { stream: true })
          );
          this.responseLines = next.lines;
          this.responseRemainder = next.remainder;
          this.inputSequence += 1;
          this.notifyInputWaiters();
        }
      }
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.log(`シリアル読み取りでエラーが発生しました: ${message}`);
      this.readLoopError = error;
      this.notifyInputWaiters();
    }
  }

  /**
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  waitForInput(timeoutMs) {
    if (this.readLoopError) {
      throw this.readLoopError;
    }

    if (this.inputSequence !== this.lastSeenSequence) {
      this.lastSeenSequence = this.inputSequence;
      return Promise.resolve(true);
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== resolveInput);
        resolve(false);
      }, timeoutMs);

      const resolveInput = () => {
        clearTimeout(timeoutId);
        if (this.readLoopError) {
          reject(this.readLoopError);
          return;
        }
        resolve(true);
      };

      this.waiters.push(resolveInput);
    });
  }

  notifyInputWaiters() {
    const waiters = this.waiters.splice(0, this.waiters.length);
    for (const waiter of waiters) {
      waiter();
    }
  }

  async flushStaleInputIfNeeded() {
    if (!this.needsInputFlush) {
      return;
    }

    this.clearResponseBuffer();
    const staleFlushTimeoutMs = Math.max(this.valueSettleTimeoutMs, this.commandTimeoutMs);
    while (true) {
      const didReceive = await this.waitForInput(staleFlushTimeoutMs);
      if (!didReceive) {
        this.needsInputFlush = false;
        return;
      }
      this.clearResponseBuffer();
    }
  }

  clearResponseBuffer() {
    this.responseLines = [];
    this.responseRemainder = "";
    this.lastSeenSequence = this.inputSequence;
  }

  consumeResponseLines() {
    const lines = this.responseLines;
    this.clearResponseBuffer();
    return lines;
  }

  promoteRemainderToLine() {
    const trimmed = this.responseRemainder.trim();
    if (trimmed) {
      this.responseLines.push(trimmed);
      this.responseRemainder = "";
    }
  }

  ensureReady() {
    if (!this.isOpen || !this.reader || !this.writer) {
      throw new Error(`${this.name}: ポートが開かれていません。`);
    }
  }

  /**
   * @param {string} message
   */
  log(message) {
    this.logger(`[${this.name}] ${message}`);
  }
}

/**
 * @param {{
 *   portA: SerialPort,
 *   portB: SerialPort,
 *   baudRate: number,
 *   panId: string,
 *   coordinator: "A"|"B",
 *   logger?: (message: string) => void
 * }} options
 */
export async function pairXBees(options) {
  const logger = options.logger ?? (() => {});
  const plan = buildPairingPlan({
    panId: options.panId,
    coordinator: options.coordinator,
    baudRate: options.baudRate
  });

  const sessionA = new XBeeSerialSession(options.portA, {
    baudRate: CONFIG_BAUD_RATE,
    name: "XBee A",
    logger
  });
  const sessionB = new XBeeSerialSession(options.portB, {
    baudRate: CONFIG_BAUD_RATE,
    name: "XBee B",
    logger
  });

  try {
    await sessionA.open();
    await sessionB.open();

    await sessionA.enterCommandMode();
    await sessionB.enterCommandMode();

    const slA = await sessionA.readSerialLow();
    const slB = await sessionB.readSerialLow();

    logger(`[PLAN] PAN ID=${plan.normalizedPanId} / Coordinator=${options.coordinator} / 通信ボーレート=${options.baudRate} bps`);
    logger(`[PLAN] XBee A の SL=${slA} を XBee B の DL に設定します`);
    logger(`[PLAN] XBee B の SL=${slB} を XBee A の DL に設定します`);

    for (const command of plan.commandsForA) {
      await sessionA.sendOkCommand(command, command.trim());
    }
    for (const command of plan.commandsForB) {
      await sessionB.sendOkCommand(command, command.trim());
    }

    await sessionA.sendOkCommand(`ATDL${slB}\r`, `ATDL${slB}`);
    await sessionB.sendOkCommand(`ATDL${slA}\r`, `ATDL${slA}`);

    await sessionA.sendOkCommand("ATWR\r", "ATWR");
    await sessionB.sendOkCommand("ATWR\r", "ATWR");

    await sessionA.sendOkCommand("ATCN\r", "ATCN");
    await sessionB.sendOkCommand("ATCN\r", "ATCN");

    logger("[DONE] ペアリング設定の書き込みが完了しました");
    logger(`[NOTE] XBee 同士の通信ボーレートを ${options.baudRate} bps に設定しました。変更を有効にするため、両方の XBee を再起動（電源 OFF/ON）してください`);
    return {
      normalizedPanId: plan.normalizedPanId,
      slA,
      slB,
      roles: plan.roles,
      baudRate: options.baudRate
    };
  } finally {
    await Promise.allSettled([sessionA.close(), sessionB.close()]);
  }
}

/**
 * @param {SerialPort} port
 * @param {{
 *   name: string,
 *   candidates?: number[],
 *   logger?: (message: string) => void
 * }} options
 * @returns {Promise<number | null>}
 */
export async function findWorkingBaudRate(port, options) {
  const candidates = options.candidates ?? [9600];
  const logger = options.logger ?? (() => {});

  for (const baudRate of candidates) {
    const session = new XBeeSerialSession(port, {
      baudRate,
      name: options.name,
      logger,
      commandTimeoutMs: 1000,
      enterCommandTimeoutMs: 1000,
      closeTimeoutMs: 500,
      valueSettleTimeoutMs: 50
    });

    try {
      await session.open();
      await session.enterCommandMode();
      await session.sendOkCommand("ATCN\r", "ATCN");
      return baudRate;
    } catch {
      // このボーレートではコマンドモードに入れなかった
    } finally {
      await session.close().catch(() => {});
    }
  }

  return null;
}
