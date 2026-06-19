import { configureApiNetwork, findWorkingBaudRate, normalizePanId, pairXBees, verifyTransparentWirelessLink } from "./xbee.js";

const MAX_API_DEVICE_COUNT = 12;
const DEVICE_IDS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const form = /** @type {HTMLFormElement} */ (document.getElementById("pairingForm"));
const runButton = /** @type {HTMLButtonElement} */ (document.getElementById("runButton"));
const testConnectionButton = /** @type {HTMLButtonElement} */ (document.getElementById("testConnectionButton"));
const runWirelessTestButton = /** @type {HTMLButtonElement} */ (document.getElementById("runWirelessTestButton"));
const clearLogButton = /** @type {HTMLButtonElement} */ (document.getElementById("clearLogButton"));
const clearWirelessLogButton = /** @type {HTMLButtonElement} */ (document.getElementById("clearWirelessLogButton"));
const selectPortAButton = /** @type {HTMLButtonElement} */ (document.getElementById("selectPortAButton"));
const selectPortBButton = /** @type {HTMLButtonElement} */ (document.getElementById("selectPortBButton"));
const disconnectPortAButton = /** @type {HTMLButtonElement} */ (document.getElementById("disconnectPortAButton"));
const disconnectPortBButton = /** @type {HTMLButtonElement} */ (document.getElementById("disconnectPortBButton"));
const apiModeCheckbox = /** @type {HTMLInputElement} */ (document.getElementById("apiMode"));
const apiDeviceControls = /** @type {HTMLDivElement} */ (document.getElementById("apiDeviceControls"));
const addApiDeviceButton = /** @type {HTMLButtonElement} */ (document.getElementById("addApiDeviceButton"));
const deviceGrid = /** @type {HTMLDivElement} */ (document.getElementById("deviceGrid"));
const baudRateSelect = /** @type {HTMLSelectElement} */ (document.getElementById("baudRate"));
const panIdInput = /** @type {HTMLInputElement} */ (document.getElementById("panId"));
const coordinatorSelect = /** @type {HTMLSelectElement} */ (document.getElementById("coordinator"));
const wirelessMessageInput = /** @type {HTMLInputElement} */ (document.getElementById("wirelessMessage"));
const supportBadge = /** @type {HTMLSpanElement} */ (document.getElementById("supportBadge"));
const supportMessage = /** @type {HTMLParagraphElement} */ (document.getElementById("supportMessage"));
const wirelessStatus = /** @type {HTMLParagraphElement} */ (document.getElementById("wirelessStatus"));
const logOutput = /** @type {HTMLPreElement} */ (document.getElementById("logOutput"));
const wirelessLogOutput = /** @type {HTMLPreElement} */ (document.getElementById("wirelessLogOutput"));

/** @type {Record<string, SerialPort | null>} */
const selectedPorts = {
  A: null,
  B: null
};

function supportsWebSerial() {
  return "serial" in navigator && window.isSecureContext;
}

function isApiModeEnabled() {
  return apiModeCheckbox.checked;
}

/**
 * @returns {string[]}
 */
function getActiveDeviceIds() {
  return isApiModeEnabled() ? Object.keys(selectedPorts) : ["A", "B"];
}

/**
 * @returns {string[]}
 */
function getSelectedActiveDeviceIds() {
  return getActiveDeviceIds().filter((id) => selectedPorts[id]);
}

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  logOutput.textContent += `[${timestamp}] ${message}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}

function appendWirelessLog(message) {
  const timestamp = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  wirelessLogOutput.textContent += `[${timestamp}] ${message}\n`;
  wirelessLogOutput.scrollTop = wirelessLogOutput.scrollHeight;
}

/**
 * @param {string} message
 * @param {"neutral"|"ok"|"ng"} state
 */
function setWirelessStatus(message, state = "neutral") {
  wirelessStatus.textContent = message;
  wirelessStatus.className = `wireless-status${state === "ok" ? " is-ok" : state === "ng" ? " is-ng" : ""}`;
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
 * @param {string} side
 */
function getDeviceElements(side) {
  return {
    label: /** @type {HTMLParagraphElement} */ (document.getElementById(`port${side}Label`)),
    state: /** @type {HTMLSpanElement} */ (document.getElementById(`port${side}State`)),
    selectButton: /** @type {HTMLButtonElement} */ (document.getElementById(`selectPort${side}Button`)),
    disconnectButton: /** @type {HTMLButtonElement} */ (document.getElementById(`disconnectPort${side}Button`))
  };
}

/**
 * @param {string} side
 * @param {SerialPort} port
 */
function setPort(side, port) {
  selectedPorts[side] = port;
  const info = describePort(port);
  const elements = getDeviceElements(side);
  elements.label.textContent = info;
  elements.state.textContent = "選択済み";
  elements.state.className = "port-state is-selected";
  elements.disconnectButton.disabled = false;
  appendLog(`${deviceLabel(side)} のポートを選択しました: ${info}`);
  updateCoordinatorOptions();
  setBusy(false);
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

/**
 * @param {string} side
 * @returns {string}
 */
function deviceLabel(side) {
  return `XBee ${side}`;
}

function setBusy(isBusy) {
  runButton.disabled = isBusy || !supportsWebSerial();
  testConnectionButton.disabled = isBusy || !supportsWebSerial();
  runWirelessTestButton.disabled = isBusy || !supportsWebSerial() || isApiModeEnabled();
  clearLogButton.disabled = isBusy;
  clearWirelessLogButton.disabled = isBusy;
  apiModeCheckbox.disabled = isBusy;
  addApiDeviceButton.disabled = isBusy || !supportsWebSerial() || !isApiModeEnabled() || Object.keys(selectedPorts).length >= MAX_API_DEVICE_COUNT;
  baudRateSelect.disabled = isBusy;
  panIdInput.disabled = isBusy;
  coordinatorSelect.disabled = isBusy;
  wirelessMessageInput.disabled = isBusy;

  for (const side of Object.keys(selectedPorts)) {
    const elements = getDeviceElements(side);
    elements.selectButton.disabled = isBusy || !supportsWebSerial();
    elements.disconnectButton.disabled = isBusy || !selectedPorts[side];
    const removeButton = /** @type {HTMLButtonElement | null} */ (document.getElementById(`removePort${side}Button`));
    if (removeButton) {
      removeButton.disabled = isBusy;
    }
  }
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
      appendLog(`${deviceLabel(side)} のポート選択がキャンセルされました。`);
      return;
    }
    appendLog(`ポート選択に失敗しました: ${formatError(error)}`);
  }
}

async function testConnection() {
  const activeIds = getSelectedActiveDeviceIds();
  if (activeIds.length === 0) {
    appendLog("接続テストする XBee のポートを選択してください。");
    return;
  }

  if (!isApiModeEnabled() && activeIds.length < 2) {
    appendLog("通常の1対1ペアリングでは XBee A と XBee B の両方のポートを選択してください。");
    return;
  }

  setBusy(true);
  appendLog("接続テストを開始します。XBee の現在の UART ボーレートを自動検出します。");

  try {
    const results = [];
    for (const side of activeIds) {
      const found = await findWorkingBaudRate(/** @type {SerialPort} */ (selectedPorts[side]), {
        name: deviceLabel(side),
        logger: appendLog
      });
      results.push({ side, found });
    }

    for (const result of results) {
      if (result.found) {
        appendLog(`[OK] ${deviceLabel(result.side)} は ${result.found} bps で応答しました`);
      } else {
        appendLog(`[NG] ${deviceLabel(result.side)} から応答がありませんでした。電源・ケーブル、AT/API モード、UART ボーレート設定を確認してください。`);
      }
    }

    if (results.every((result) => result.found)) {
      appendLog("選択済みの XBee は設定を実行できます。");
    } else {
      appendLog("すでに API モードの XBee は、この AT コマンド用テストに応答しない場合があります。");
    }
  } catch (error) {
    appendLog(`接続テストでエラー: ${formatError(error)}`);
  } finally {
    setBusy(false);
  }
}

async function runWirelessTest() {
  if (!supportsWebSerial()) {
    appendWirelessLog("Web Serial API が使えないため、無線通信テストを開始できません。");
    setWirelessStatus("Web Serial API が利用できません。Chrome / Edge の HTTPS または localhost で開いてください。", "ng");
    return;
  }

  if (isApiModeEnabled()) {
    appendWirelessLog("API モード(AP=1)では透過モードの無線送受信テストは実行できません。通常の1対1ペアリングで確認してください。");
    setWirelessStatus("API モード中は透過モードの送受信テストを実行できません。", "ng");
    return;
  }

  if (!selectedPorts.A || !selectedPorts.B) {
    appendWirelessLog("XBee A と XBee B の両方のポートを選択してください。");
    setWirelessStatus("XBee A と XBee B の両方のポートが必要です。", "ng");
    return;
  }

  if (selectedPorts.A === selectedPorts.B) {
    appendWirelessLog("XBee A と XBee B に同じポートは使用できません。");
    setWirelessStatus("別々のポートを選択してください。", "ng");
    return;
  }

  const baudRate = Number(baudRateSelect.value);
  setBusy(true);
  setWirelessStatus("無線通信テストを実行中です...", "neutral");
  appendWirelessLog(`無線通信テストを開始します。通信ボーレート=${baudRate} bps`);

  try {
    const result = await verifyTransparentWirelessLink({
      portA: selectedPorts.A,
      portB: selectedPorts.B,
      baudRate,
      payload: wirelessMessageInput.value,
      logger: appendWirelessLog
    });

    if (result.ok) {
      setWirelessStatus("A→B / B→A の両方向で送受信を確認しました。", "ok");
    }
  } catch (error) {
    appendWirelessLog(`無線通信テストでエラー: ${formatError(error)}`);
    setWirelessStatus("送受信を確認できませんでした。電源再投入、DL設定、ボーレート、アンテナ/距離を確認してください。", "ng");
  } finally {
    setBusy(false);
  }
}

async function disconnectPort(side) {
  if (!supportsWebSerial()) {
    appendLog("Web Serial API が使えないため、切断できません。");
    return;
  }

  const port = selectedPorts[side];
  if (!port) {
    return;
  }

  try {
    if (port.readable && port.writable) {
      await port.close();
      appendLog(`${deviceLabel(side)} のポートを閉じました`);
    }
  } catch (error) {
    appendLog(`${deviceLabel(side)} のポート切断中にエラー: ${formatError(error)}`);
  }

  selectedPorts[side] = null;
  const elements = getDeviceElements(side);
  elements.label.textContent = "ポート未選択";
  elements.state.textContent = "未選択";
  elements.state.className = "port-state";
  appendLog(`${deviceLabel(side)} の選択を解除しました`);
  updateCoordinatorOptions();
  setBusy(false);
}

function addApiDevice() {
  const nextId = DEVICE_IDS.find((id) => !(id in selectedPorts));
  if (!nextId) {
    appendLog("追加できる XBee の上限に達しました。");
    return;
  }

  selectedPorts[nextId] = null;
  const section = document.createElement("section");
  section.className = "device-card api-device-card";
  section.id = `device${nextId}Card`;
  section.setAttribute("aria-labelledby", `device-${nextId.toLowerCase()}-title`);
  section.innerHTML = `
    <div class="device-card-header">
      <h2 id="device-${nextId.toLowerCase()}-title">${deviceLabel(nextId)}</h2>
      <span id="port${nextId}State" class="port-state">未選択</span>
    </div>
    <button id="selectPort${nextId}Button" class="action-button" type="button">${deviceLabel(nextId)} のポートを選択</button>
    <div class="device-actions">
      <button id="disconnectPort${nextId}Button" class="ghost-button disconnect-button" type="button" disabled>接続を切る</button>
      <button id="removePort${nextId}Button" class="ghost-button remove-button" type="button">削除</button>
    </div>
    <p id="port${nextId}Label" class="port-label">ポート未選択</p>
  `;
  deviceGrid.appendChild(section);

  getDeviceElements(nextId).selectButton.addEventListener("click", async () => {
    await requestPort(nextId);
  });
  getDeviceElements(nextId).disconnectButton.addEventListener("click", async () => {
    await disconnectPort(nextId);
  });
  document.getElementById(`removePort${nextId}Button`)?.addEventListener("click", async () => {
    await removeApiDevice(nextId);
  });

  updateApiModeUi();
  updateCoordinatorOptions();
  setBusy(false);
  appendLog(`${deviceLabel(nextId)} を API モード用に追加しました。`);
}

/**
 * @param {string} side
 */
async function removeApiDevice(side) {
  if (side === "A" || side === "B") {
    return;
  }
  await disconnectPort(side);
  delete selectedPorts[side];
  document.getElementById(`device${side}Card`)?.remove();
  updateCoordinatorOptions();
  setBusy(false);
  appendLog(`${deviceLabel(side)} を削除しました。`);
}

function updateApiModeUi() {
  const enabled = isApiModeEnabled();
  apiDeviceControls.hidden = !enabled;
  for (const card of document.querySelectorAll(".api-device-card")) {
    card.toggleAttribute("hidden", !enabled);
  }
  runButton.textContent = enabled ? "API モード設定を書き込む" : "ペアリング設定を書き込む";
  updateCoordinatorOptions();
  setBusy(false);
}

function updateCoordinatorOptions() {
  const previousValue = coordinatorSelect.value;
  const ids = getActiveDeviceIds();
  coordinatorSelect.textContent = "";

  for (const id of ids) {
    const option = document.createElement("option");
    option.value = id;
    if (isApiModeEnabled()) {
      option.textContent = `${id} を Coordinator / 他を Router`;
    } else if (id === "A") {
      option.textContent = "A を Coordinator / B を Router";
    } else {
      option.textContent = "B を Coordinator / A を Router";
    }
    coordinatorSelect.appendChild(option);
  }

  if (ids.includes(previousValue)) {
    coordinatorSelect.value = previousValue;
  }
}

function validateInputs() {
  const panId = normalizePanId(panIdInput.value);
  const coordinator = coordinatorSelect.value;
  const baudRate = Number(baudRateSelect.value);

  if (!isApiModeEnabled()) {
    if (!selectedPorts.A || !selectedPorts.B) {
      throw new Error("通常の1対1ペアリングでは XBee A と XBee B の両方のポートを選択してください。");
    }
    if (selectedPorts.A === selectedPorts.B) {
      throw new Error("XBee A と XBee B に同じポートは使用できません。別々のポートを選択してください。");
    }
    if (coordinator !== "A" && coordinator !== "B") {
      throw new Error("Coordinator の選択が不正です。");
    }

    return {
      mode: "pair",
      panId,
      coordinator,
      baudRate
    };
  }

  const selectedIds = getSelectedActiveDeviceIds();
  if (selectedIds.length < 3) {
    throw new Error("API モードでは 3 台以上の XBee ポートを選択してください。");
  }
  if (!selectedIds.includes(coordinator)) {
    throw new Error("Coordinator には選択済みの XBee を指定してください。");
  }
  if (new Set(selectedIds.map((id) => selectedPorts[id])).size !== selectedIds.length) {
    throw new Error("同じポートを複数の XBee に使用できません。別々のポートを選択してください。");
  }

  return {
    mode: "api",
    panId,
    coordinator,
    coordinatorIndex: selectedIds.indexOf(coordinator),
    baudRate,
    ports: selectedIds.map((id) => /** @type {SerialPort} */ (selectedPorts[id])),
    deviceIds: selectedIds
  };
}

function formatError(error) {
  if (error instanceof Error) {
    const stack = typeof error.stack === "string" ? error.stack.split("\n").slice(1, 4).join("\n") : "";
    const details = [error.name, error.message, stack].filter(Boolean).join(" | ");
    return details || String(error);
  }
  return String(error);
}

selectPortAButton.addEventListener("click", async () => {
  await requestPort("A");
});

selectPortBButton.addEventListener("click", async () => {
  await requestPort("B");
});

disconnectPortAButton.addEventListener("click", async () => {
  await disconnectPort("A");
});

disconnectPortBButton.addEventListener("click", async () => {
  await disconnectPort("B");
});

apiModeCheckbox.addEventListener("change", () => {
  updateApiModeUi();
  appendLog(isApiModeEnabled() ? "API モード設定を ON にしました。3 台以上の XBee を選択できます。" : "通常の1対1ペアリングに戻しました。追加ノードは使用しません。");
  setWirelessStatus(
    isApiModeEnabled()
      ? "API モード中は透過モードの送受信テストを実行できません。"
      : "ペアリング設定後、A→B と B→A の両方向で実データを送受信します。",
    isApiModeEnabled() ? "ng" : "neutral"
  );
});

addApiDeviceButton.addEventListener("click", () => {
  addApiDevice();
});

testConnectionButton.addEventListener("click", async () => {
  await testConnection();
});

runWirelessTestButton.addEventListener("click", async () => {
  await runWirelessTest();
});

clearLogButton.addEventListener("click", () => {
  logOutput.textContent = "";
});

clearWirelessLogButton.addEventListener("click", () => {
  wirelessLogOutput.textContent = "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const inputs = validateInputs();
    setBusy(true);

    if (inputs.mode === "api") {
      appendLog("API モード設定を開始します。");
      const result = await configureApiNetwork({
        ports: inputs.ports,
        baudRate: inputs.baudRate,
        panId: inputs.panId,
        coordinatorIndex: inputs.coordinatorIndex,
        names: inputs.deviceIds.map((id) => deviceLabel(id)),
        logger: appendLog
      });

      appendLog(`完了: PAN ID=${result.normalizedPanId}, AP=${result.apiMode}, 台数=${result.serialLows.length}`);
      return;
    }

    appendLog("ペアリング処理を開始します。");
    const result = await pairXBees({
      portA: selectedPorts.A,
      portB: selectedPorts.B,
      baudRate: inputs.baudRate,
      panId: inputs.panId,
      coordinator: inputs.coordinator,
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
updateApiModeUi();
appendLog("準備完了。通常は XBee 2 台、API モードでは 3 台以上のポートを選択してから実行してください。");
appendWirelessLog("準備完了。ペアリング後に無線送受信を確認できます。");
