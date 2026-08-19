import { enableApiMode } from "./xbee.js";

const form = /** @type {HTMLFormElement} */ (document.getElementById("apiForm"));
const selectPortButton = /** @type {HTMLButtonElement} */ (document.getElementById("selectPortButton"));
const disconnectPortButton = /** @type {HTMLButtonElement} */ (document.getElementById("disconnectPortButton"));
const cancelButton = /** @type {HTMLButtonElement} */ (document.getElementById("cancelButton"));
const runButton = /** @type {HTMLButtonElement} */ (document.getElementById("runButton"));
const clearLogButton = /** @type {HTMLButtonElement} */ (document.getElementById("clearLogButton"));
const supportBadge = /** @type {HTMLSpanElement} */ (document.getElementById("supportBadge"));
const supportMessage = /** @type {HTMLParagraphElement} */ (document.getElementById("supportMessage"));
const portState = /** @type {HTMLSpanElement} */ (document.getElementById("portState"));
const portLabel = /** @type {HTMLParagraphElement} */ (document.getElementById("portLabel"));
const logOutput = /** @type {HTMLPreElement} */ (document.getElementById("logOutput"));

/** @type {SerialPort | null} */
let selectedPort = null;
/** @type {AbortController | null} */
let activeController = null;

function supportsWebSerial() {
  return typeof navigator !== "undefined" && "serial" in navigator && window.isSecureContext;
}

function formatError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  logOutput.textContent += `[${timestamp}] ${message}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}

function describePort(port) {
  const info = port.getInfo?.() ?? {};
  const vid = typeof info.usbVendorId === "number" ? info.usbVendorId.toString(16).toUpperCase().padStart(4, "0") : "不明";
  const pid = typeof info.usbProductId === "number" ? info.usbProductId.toString(16).toUpperCase().padStart(4, "0") : "不明";
  return `VID=${vid} / PID=${pid}`;
}

function setBusy(isBusy) {
  selectPortButton.disabled = isBusy || !supportsWebSerial();
  disconnectPortButton.disabled = isBusy || !selectedPort;
  runButton.disabled = isBusy || !selectedPort || !supportsWebSerial();
  cancelButton.disabled = !isBusy;
  clearLogButton.disabled = isBusy;
}

function setSupportState() {
  const supported = supportsWebSerial();
  supportBadge.textContent = supported ? "対応環境" : "未対応";
  supportBadge.className = `badge ${supported ? "is-supported" : "is-unsupported"}`;
  supportMessage.textContent = supported
    ? "Web Serial API を利用できます。HTTPS または localhost で XBee を選択してください。"
    : "Web Serial API が利用できません。Chrome / Edge の HTTPS または localhost で開いてください。";
}

function setPort(port) {
  selectedPort = port;
  portState.textContent = "選択済み";
  portState.className = "port-state is-selected";
  portLabel.textContent = describePort(port);
  appendLog(`XBee のポートを選択しました: ${describePort(port)}`);
  setBusy(false);
}

async function requestPort() {
  if (!supportsWebSerial()) {
    appendLog("Web Serial API が使えないため、ポートを選択できません。");
    return;
  }
  try {
    setPort(await navigator.serial.requestPort());
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") appendLog("ポート選択をキャンセルしました。");
    else appendLog(`ポート選択に失敗しました: ${formatError(error)}`);
  }
}

async function disconnectPort() {
  const port = selectedPort;
  selectedPort = null;
  if (port) await port.close?.().catch((error) => appendLog(`切断中にエラー: ${formatError(error)}`));
  portState.textContent = "未選択";
  portState.className = "port-state";
  portLabel.textContent = "ポート未選択";
  appendLog("XBee の選択を解除しました。");
  setBusy(false);
}

async function run() {
  if (!supportsWebSerial()) {
    appendLog("Web Serial API が利用できません。対応ブラウザと安全な配信環境を確認してください。");
    return;
  }
  if (!selectedPort) {
    appendLog("設定対象の XBee ポートを選択してください。");
    return;
  }
  activeController = new AbortController();
  setBusy(true);
  appendLog("API モード設定を開始します。現在のボーレートを自動検出します。");
  try {
    const result = await enableApiMode({ port: selectedPort, name: "XBee", signal: activeController.signal, logger: appendLog });
    appendLog(`成功: AP=1 を ATWR で保存し、ATCN で終了しました (baud=${result.baudRate})。`);
    appendLog("注意: AP=1 の反映後は API フレーム通信になります。必要に応じて XBee を再起動してください。");
  } catch (error) {
    appendLog(`失敗: ${formatError(error)}`);
    if (activeController.signal.aborted) appendLog("処理をキャンセルしました。ポートは解放済みです。");
  } finally {
    activeController = null;
    setBusy(false);
  }
}

selectPortButton.addEventListener("click", requestPort);
disconnectPortButton.addEventListener("click", disconnectPort);
cancelButton.addEventListener("click", () => {
  activeController?.abort();
  appendLog("キャンセルを要求しました。現在のコマンド終了後にポートを解放します。");
});
clearLogButton.addEventListener("click", () => { logOutput.textContent = ""; });
form.addEventListener("submit", (event) => { event.preventDefault(); void run(); });

if (supportsWebSerial()) {
  navigator.serial.addEventListener("disconnect", (event) => {
    if (event.target !== selectedPort) return;
    selectedPort = null;
    portState.textContent = "切断";
    portState.className = "port-state";
    portLabel.textContent = "ポートが切断されました";
    appendLog("シリアルポートが切断されました。処理を終了し、選択を解除しました。");
    activeController?.abort();
    setBusy(activeController !== null);
  });
}

setSupportState();
setBusy(false);
appendLog("準備完了。既存設定済み XBee を1台選択してください。");
