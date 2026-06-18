const GUARD_TIME_MS = 1100;
const ENTER_COMMAND_TIMEOUT_MS = 2500;
const COMMAND_TIMEOUT_MS = 2500;
const CLOSE_TIMEOUT_MS = 1000;
const VALUE_SETTLE_TIMEOUT_MS = 80;

/**
 * @param {string} value
 * @returns {string}
 */
export function sanitizeHex32(value) {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/^0X/, "");
  if (!/^[0-9A-F]{1,8}$/.test(normalized)) {
    throw new Error("SL/DL に使用する値は 1〜8 桁の16進数で指定してください。");
  }
  return normalized;
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
 * @param {{ panId: string, coordinator: "A"|"B" }} options
 * @returns {{
 *   normalizedPanId: string,
 *   roles: { A: "1"|"0", B: "1"|"0" },
 *   commandsForA: string[],
 *   commandsForB: string[]
 * }}
 */
export function buildPairingPlan({ panId, coordinator }) {
  const normalizedPanId = normalizePanId(panId);
  if (coordinator !== "A" && coordinator !== "B") {
    throw new Error("Coordinator は A または B を指定してください。");
  }

  const roles = coordinator === "A" ? { A: "1", B: "0" } : { A: "0", B: "1" };

  return {
    normalizedPanId,
    roles,
    commandsForA: [`ATID${normalizedPanId}\r`, `ATCE${roles.A}\r`],
    commandsForB: [`ATID${normalizedPanId}\r`, `ATCE${roles.B}\r`]
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
    this.isOpen = false;
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
    this.log(`ポートを開きました (baud=${this.baudRate})`);
  }

  async close() {
    const tasks = [];

    if (this.reader) {
      tasks.push(
        Promise.race([
          this.reader.cancel().catch(() => {}),
          delay(this.closeTimeoutMs)
        ]).then(() => {
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
  }

  async enterCommandMode() {
    this.ensureReady();
    this.log("コマンドモードへ移行します");
    await delay(GUARD_TIME_MS);
    await this.writeRaw("+++");
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
    this.log(`${options.label} を送信します`);
    this.buffer = "";
    await this.writeRaw(command);
    const lines = await this.readResponse(options.label, this.commandTimeoutMs, {
      acceptValue: options.expectValue
    });
    const analysis = analyzeResponseLines(lines);

    if (options.expectValue) {
      if (!analysis.valueLine) {
        throw new Error(`${this.name}: ${options.label} の応答値を受信できませんでした。`);
      }
      this.log(`${options.label} 応答値: ${analysis.valueLine}`);
      return analysis.valueLine;
    }

    if (!analysis.hasOk) {
      throw new Error(`${this.name}: ${options.label} の応答が OK ではありませんでした。`);
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
      throw new Error(`${this.name}: ${context} の応答が OK ではありませんでした。`);
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
    let state = { lines: [], remainder: this.buffer };
    this.buffer = "";

    while (Date.now() < deadline) {
      const waitMs = computeWaitMs(deadline, settleDeadline);
      const result = await Promise.race([
        this.reader.read().then((readResult) => ({ kind: "read", ...readResult })),
        delay(waitMs).then(() => ({ kind: "timeout" }))
      ]);

      if (result.kind === "timeout") {
        const analysis = analyzeResponseLines(state.lines);
        if (options.acceptValue && analysis.valueLine) {
          this.buffer = state.remainder;
          return state.lines;
        }
        continue;
      }

      if (result.done) {
        break;
      }

      if (!result.value) {
        continue;
      }

      state = appendResponseChunk(state, this.decoder.decode(result.value, { stream: true }));
      const analysis = analyzeResponseLines(state.lines);

      if (analysis.hasOk) {
        this.buffer = state.remainder;
        return state.lines;
      }

      if (options.acceptValue && analysis.valueLine && settleDeadline === null) {
        settleDeadline = Date.now() + this.valueSettleTimeoutMs;
      }
    }

    const finalAnalysis = analyzeResponseLines(state.lines);
    if (options.acceptValue && finalAnalysis.valueLine) {
      this.buffer = state.remainder;
      return state.lines;
    }

    this.buffer = state.remainder;
    if (!options.acceptValue && finalAnalysis.valueLine) {
      throw new Error(`${this.name}: ${context} の応答が OK ではありませんでした。`);
    }
    throw new Error(`${this.name}: ${context} の応答待ちがタイムアウトしました。`);
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
    coordinator: options.coordinator
  });

  const sessionA = new XBeeSerialSession(options.portA, {
    baudRate: options.baudRate,
    name: "XBee A",
    logger
  });
  const sessionB = new XBeeSerialSession(options.portB, {
    baudRate: options.baudRate,
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

    logger(`[PLAN] PAN ID=${plan.normalizedPanId} / Coordinator=${options.coordinator}`);
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
    return {
      normalizedPanId: plan.normalizedPanId,
      slA,
      slB,
      roles: plan.roles
    };
  } finally {
    await Promise.allSettled([sessionA.close(), sessionB.close()]);
  }
}
