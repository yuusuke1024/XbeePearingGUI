import { normalizePanId, pairXBees } from "./xbee.js";

const form = /** @type {HTMLFormElement} */ (document.getElementById("pairingForm"));
const runButton = /** @type {HTMLButtonElement} */ (document.getElementById("runButton"));
const clearLogButton = /** @type {HTMLButtonElement} */ (document.getElementById("clearLogButton"));
const selectPortAButton = /** @type {HTMLButtonElement} */ (document.getElementById("selectPortAButton"));
const selectPortBButton = /** @type {HTMLButtonElement} */ (document.getElementById("selectPortBButton"));
const baudRateSelect = /** @type {HTMLSelectElement} */ (document.getElementById("baudRate"));
const panIdInput = /** @type {HTMLInputElement} */ (document.getElementById("panId"));
const coordinatorSelect = /** @type {HTMLSelectElement} */ (document.getElementById("coordinator"));
const supportBadge = /** @type {HTMLSpanElement} */ (document.getElementById("supportBadge"));
const supportMessage = /** @type {HTMLParagraphElement} */ (document.getElementById("supportMessage"));
const logOutput = /** @type {HTMLPreElement} */ (document.getElementById("logOutput"));
const portALabel = /** @type {HTMLParagraphElement} */ (document.getElementById("portALabel"));
const portBLabel = /** @type {HTMLParagraphElement} */ (document.getElementById("portBLabel"));
const portAState = /** @type {HTMLSpanElement} */ (document.getElementById("portAState"));
const portBState = /** @type {HTMLSpanElement} */ (document.getElementById("portBState"));

/** @type {{ A: SerialPort | null, B: SerialPort | null }} */
const selectedPorts = {
  A: null,
  B: null
};

function supportsWebSerial() {
  return "serial" in navigator && window.isSecureContext;
}

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  logOutput.textContent += `[${timestamp}] ${message}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}

function setSupportState() {
  if (supportsWebSerial()) {
    supportBadge.textContent = "対応環境";
    supportBadge.className = "badge is-supported";
    supportMessage.textContent = "このブラウザでは Web Serial API を利用できます。Chrome / Edge の HTTPS または localhost で開いてください。";
    return;
  }

  supportBadge.textContent = "未対応";
  supportBadge.className = "badge is-unsupported";
  supportMessage.textContent = "Web Serial API が利用できません。Chrome / Edge で、HTTPS または localhost から開いてください。";
}

/**
 * @param {"A"|"B"} side
 * @param {SerialPort} port
 */
function setPort(side, port) {
  selectedPorts[side] = port;
  const info = describePort(port);
  const label = side === "A" ? portALabel : portBLabel;
  const state = side === "A" ? portAState : portBState;
  label.textContent = info;
  state.textContent = "選択済み";
  state.className = "port-state is-selected";
  appendLog(`${side === "A" ? "XBee A" : "XBee B"} のポートを選択しました: ${info}`);
}

/**
 * @param {SerialPort} port
 * @returns {string}
 */
function describePort(port) {
  const info = port.getInfo?.() ?? {};
  const usbVendorId = typeof info.usbVendorId === "number" ? `VID=${info.usbVendorId.toString(16).toUpperCase().padStart(4, "0")}` : "VID=不明";
  const usbProductId = typeof info.usbProductId === "number" ? `PID=${info.usbProductId.toString(16).toUpperCase().padStart(4, "0")}` : "PID=不明";
  return `${usbVendorId} / ${usbProductId}`;
}

function setBusy(isBusy) {
  runButton.disabled = isBusy || !supportsWebSerial();
  clearLogButton.disabled = isBusy;
  selectPortAButton.disabled = isBusy || !supportsWebSerial();
  selectPortBButton.disabled = isBusy || !supportsWebSerial();
  baudRateSelect.disabled = isBusy;
  panIdInput.disabled = isBusy;
  coordinatorSelect.disabled = isBusy;
}

async function requestPort(side) {
  if (!supportsWebSerial()) {
    appendLog("Web Serial API が使えないため、ポート選択を開始できません。");
    return;
  }

  try {
    const port = await navigator.serial.requestPort();
    setPort(side, port);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      appendLog(`${side === "A" ? "XBee A" : "XBee B"} のポート選択がキャンセルされました。`);
      return;
    }
    appendLog(`ポート選択に失敗しました: ${formatError(error)}`);
  }
}

function validateInputs() {
  if (!selectedPorts.A || !selectedPorts.B) {
    throw new Error("XBee A と XBee B の両方のポートを選択してください。");
  }

  if (selectedPorts.A === selectedPorts.B) {
    throw new Error("XBee A と XBee B に同じポートは使用できません。別々のポートを選択してください。");
  }

  const panId = normalizePanId(panIdInput.value);
  const coordinator = coordinatorSelect.value;
  if (coordinator !== "A" && coordinator !== "B") {
    throw new Error("Coordinator の選択が不正です。");
  }

  return {
    panId,
    coordinator,
    baudRate: Number(baudRateSelect.value)
  };
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

selectPortAButton.addEventListener("click", async () => {
  await requestPort("A");
});

selectPortBButton.addEventListener("click", async () => {
  await requestPort("B");
});

clearLogButton.addEventListener("click", () => {
  logOutput.textContent = "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const { panId, coordinator, baudRate } = validateInputs();
    setBusy(true);
    appendLog("ペアリング処理を開始します。");

    const result = await pairXBees({
      portA: selectedPorts.A,
      portB: selectedPorts.B,
      baudRate,
      panId,
      coordinator,
      logger: appendLog
    });

    appendLog(`完了: PAN ID=${result.normalizedPanId}, A.SL=${result.slA}, B.SL=${result.slB}`);
  } catch (error) {
    appendLog(`失敗: ${formatError(error)}`);
  } finally {
    setBusy(false);
  }
});

setSupportState();
setBusy(false);
appendLog("準備完了。XBee 2 台のポートを選択してから実行してください。");
