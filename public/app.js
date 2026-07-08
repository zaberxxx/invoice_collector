const DB_NAME = "invoice-capture-db";
const DB_VERSION = 1;
const STORE_RECORDS = "records";
const STORE_SETTINGS = "settings";
const DEFAULT_FILENAME = "invoice-summary.csv";
const APP_VERSION = "2026.07.08-live-compact";
const LIVE_QR_HISTORY_LIMIT = 12;

const els = {
  appVersion: document.querySelector("#appVersion"),
  tabs: document.querySelectorAll(".tab"),
  panels: {
    scan: document.querySelector("#scanPanel"),
    records: document.querySelector("#recordsPanel"),
    settings: document.querySelector("#settingsPanel")
  },
  liveScanButton: document.querySelector("#liveScanButton"),
  stopScanButton: document.querySelector("#stopScanButton"),
  cameraPanel: document.querySelector("#cameraPanel"),
  cameraPreview: document.querySelector("#cameraPreview"),
  cameraStatus: document.querySelector("#cameraStatus"),
  manualButton: document.querySelector("#manualButton"),
  reviewForm: document.querySelector("#reviewForm"),
  reviewStatus: document.querySelector("#reviewStatus"),
  invoiceNumber: document.querySelector("#invoiceNumber"),
  invoiceDate: document.querySelector("#invoiceDate"),
  totalAmount: document.querySelector("#totalAmount"),
  buyerTaxId: document.querySelector("#buyerTaxId"),
  taxIdResult: document.querySelector("#taxIdResult"),
  includeInTotal: document.querySelector("#includeInTotal"),
  duplicateWarning: document.querySelector("#duplicateWarning"),
  clearReviewButton: document.querySelector("#clearReviewButton"),
  includedCount: document.querySelector("#includedCount"),
  includedTotal: document.querySelector("#includedTotal"),
  duplicateCount: document.querySelector("#duplicateCount"),
  recordList: document.querySelector("#recordList"),
  settingsForm: document.querySelector("#settingsForm"),
  targetTaxId: document.querySelector("#targetTaxId"),
  exportFilename: document.querySelector("#exportFilename"),
  exportButton: document.querySelector("#exportButton"),
  clearRecordsButton: document.querySelector("#clearRecordsButton"),
  importInput: document.querySelector("#importInput"),
  scanDebug: document.querySelector("#scanDebug"),
  toast: document.querySelector("#toast"),
  installButton: document.querySelector("#installButton")
};

let db;
let settings = {
  targetTaxId: "",
  exportFilename: DEFAULT_FILENAME
};
let editingRecordId = "";
let deferredInstallPrompt = null;
let cameraStream = null;
let liveScanTimer = 0;
let liveScanBusy = false;
let liveScanDetector = null;
let liveQrHistory = [];

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_RECORDS)) {
        const store = database.createObjectStore(STORE_RECORDS, { keyPath: "id" });
        store.createIndex("invoiceNumber", "invoiceNumber", { unique: false });
      }
      if (!database.objectStoreNames.contains(STORE_SETTINGS)) {
        database.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(storeName, mode = "readonly") {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllRecords() {
  return requestToPromise(tx(STORE_RECORDS).getAll());
}

async function saveRecord(record) {
  return requestToPromise(tx(STORE_RECORDS, "readwrite").put(record));
}

async function deleteRecord(id) {
  return requestToPromise(tx(STORE_RECORDS, "readwrite").delete(id));
}

async function clearAllRecords() {
  return requestToPromise(tx(STORE_RECORDS, "readwrite").clear());
}

async function saveSettings() {
  await requestToPromise(tx(STORE_SETTINGS, "readwrite").put({ key: "settings", value: settings }));
}

async function loadSettings() {
  const row = await requestToPromise(tx(STORE_SETTINGS).get("settings"));
  settings = { ...settings, ...(row?.value || {}) };
  els.targetTaxId.value = settings.targetTaxId;
  els.exportFilename.value = settings.exportFilename || DEFAULT_FILENAME;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2800);
}

function setScanDebug(message = "") {
  if (!els.scanDebug) return;
  els.scanDebug.hidden = !message;
  els.scanDebug.textContent = message;
}

function scanDebugMessage(source, raw, parsed = {}) {
  const fields = [
    parsed.invoiceNumber ? "號碼" : "",
    parsed.invoiceDate ? "日期" : "",
    parsed.totalAmount ? "金額" : "",
    parsed.buyerTaxId ? "統編" : ""
  ].filter(Boolean);
  const missing = [
    parsed.invoiceNumber ? "" : "號碼",
    parsed.invoiceDate ? "" : "日期",
    parsed.totalAmount ? "" : "金額",
    parsed.buyerTaxId ? "" : "統編"
  ].filter(Boolean);
  const rawLength = String(raw || "").replace(/\s/g, "").length;
  return `版本 ${APP_VERSION}｜${source}｜QR ${rawLength || 0} 字｜已抓 ${fields.join("/") || "無"}｜缺 ${missing.join("/") || "無"}`;
}

function rememberLiveQrRaw(raw) {
  const values = String(raw || "")
    .split(/\n+/)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of values) {
    liveQrHistory = liveQrHistory.filter((item) => item !== value);
    liveQrHistory.unshift(value);
  }
  liveQrHistory = liveQrHistory.slice(0, LIVE_QR_HISTORY_LIMIT);
  return liveQrHistory.join("\n");
}

function currency(value) {
  return Number(value || 0).toLocaleString("zh-TW", {
    style: "currency",
    currency: "TWD",
    maximumFractionDigits: 0
  });
}

function normalizeTaxId(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 8);
}

function normalizeInvoiceNumber(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
}

function toNumberString(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  return digits ? String(Number(digits)) : "";
}

function isTaxIdMatched() {
  const target = normalizeTaxId(settings.targetTaxId);
  const buyer = normalizeTaxId(els.buyerTaxId.value);
  return Boolean(target && buyer && target === buyer);
}

function updateTaxResult() {
  const target = normalizeTaxId(settings.targetTaxId);
  const buyer = normalizeTaxId(els.buyerTaxId.value);
  if (!target) {
    els.taxIdResult.textContent = "尚未設定";
    els.taxIdResult.className = "";
    els.includeInTotal.checked = false;
    return;
  }
  if (!buyer) {
    els.taxIdResult.textContent = "未辨識";
    els.taxIdResult.className = "";
    els.includeInTotal.checked = false;
    return;
  }
  const matched = target === buyer;
  els.taxIdResult.textContent = matched ? "正確" : "不符合";
  els.taxIdResult.className = matched ? "ok" : "warn";
  if (!matched) els.includeInTotal.checked = false;
}

function setReviewValues(data = {}) {
  els.invoiceNumber.value = normalizeInvoiceNumber(data.invoiceNumber);
  els.invoiceDate.value = data.invoiceDate || "";
  els.totalAmount.value = toNumberString(data.totalAmount);
  els.buyerTaxId.value = normalizeTaxId(data.buyerTaxId);
  els.includeInTotal.checked = Boolean(data.includeInTotal);
  els.reviewStatus.textContent = data.status || "請確認辨識結果";
  els.reviewForm.hidden = false;
  updateTaxResult();
  checkDuplicateWarning();
}

function clearReview() {
  editingRecordId = "";
  stopLiveScan();
  setReviewValues({ status: "請輸入或辨識發票資料" });
  els.reviewForm.hidden = true;
  els.duplicateWarning.hidden = true;
}

async function detectQrCodesFromSource(source) {
  let codes = [];
  if ("BarcodeDetector" in window) {
    try {
      liveScanDetector ||= new BarcodeDetector({ formats: ["qr_code"] });
      codes = await liveScanDetector.detect(source);
    } catch {
      codes = [];
    }
  }
  if (!codes.length && typeof window.detectQrCodesWithJsQR === "function") {
    codes = await window.detectQrCodesWithJsQR(source);
  }
  return codes;
}

function applyDetectedInvoice(data, status) {
  const merged = removeEmpty(data);
  merged.includeInTotal = normalizeTaxId(merged.buyerTaxId) === normalizeTaxId(settings.targetTaxId);
  merged.status = status;
  setReviewValues(merged);
}

async function startLiveScan() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("此瀏覽器不支援即時相機掃描");
    return;
  }

  stopLiveScan();
  liveQrHistory = [];
  setScanDebug(scanDebugMessage("即時掃描", "", {}));
  els.cameraPanel.hidden = false;
  els.liveScanButton.disabled = true;
  els.stopScanButton.hidden = false;
  els.cameraStatus.textContent = "正在開啟相機";

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    els.cameraPreview.srcObject = cameraStream;
    await els.cameraPreview.play();
    els.cameraStatus.textContent = "請將左側 QR 放在框內";
    scheduleLiveScan();
  } catch (error) {
    stopLiveScan();
    showToast(error.name === "NotAllowedError" ? "相機權限被拒絕" : "無法開啟相機");
  } finally {
    els.liveScanButton.disabled = false;
  }
}

function stopLiveScan() {
  if (liveScanTimer) {
    cancelAnimationFrame(liveScanTimer);
    liveScanTimer = 0;
  }
  liveScanBusy = false;
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  if (els.cameraPreview) {
    els.cameraPreview.pause();
    els.cameraPreview.removeAttribute("srcObject");
    els.cameraPreview.srcObject = null;
  }
  if (els.cameraPanel) els.cameraPanel.hidden = true;
  if (els.stopScanButton) els.stopScanButton.hidden = true;
  if (els.liveScanButton) els.liveScanButton.disabled = false;
}

function pauseLiveScanForReview() {
  if (liveScanTimer) {
    cancelAnimationFrame(liveScanTimer);
    liveScanTimer = 0;
  }
  liveScanBusy = false;
  if (els.cameraStatus) els.cameraStatus.textContent = "已掃到 QR，請確認下方資料";
  if (els.stopScanButton) els.stopScanButton.hidden = false;
  if (els.liveScanButton) els.liveScanButton.disabled = false;
}

function scheduleLiveScan() {
  liveScanTimer = requestAnimationFrame(scanLiveFrame);
}

async function scanLiveFrame() {
  if (!cameraStream || liveScanBusy) {
    if (cameraStream) scheduleLiveScan();
    return;
  }
  if (els.cameraPreview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    scheduleLiveScan();
    return;
  }

  liveScanBusy = true;
  try {
    const codes = await detectQrCodesFromSource(els.cameraPreview);
    const raw = codes.map((code) => code.rawValue).filter(Boolean).join("\n");
    const combinedRaw = rememberLiveQrRaw(raw);
    const parsed = parseTaiwanInvoiceQr(combinedRaw);
    setScanDebug(scanDebugMessage("即時掃描", combinedRaw, parsed));
    if (hasCoreInvoiceData(parsed)) {
      pauseLiveScanForReview();
      applyDetectedInvoice(parsed, "已即時讀取 QR，請確認");
      showToast("已掃到發票 QR");
      return;
    }
    if (Object.keys(removeEmpty(parsed)).length) {
      els.cameraStatus.textContent = "已讀到部分 QR，請靠近左側 QR";
    } else {
      els.cameraStatus.textContent = "掃描中，請靠近左側 QR";
    }
  } catch {
    els.cameraStatus.textContent = "掃描中，請保持發票平整";
  } finally {
    liveScanBusy = false;
  }

  if (cameraStream) {
    window.setTimeout(scheduleLiveScan, 160);
  }
}

function hasCoreInvoiceData(data = {}) {
  return Boolean(data.invoiceDate && data.totalAmount && data.buyerTaxId);
}

function parseTaiwanInvoiceQr(raw) {
  const text = String(raw || "").toUpperCase();
  const compact = text.replace(/\s/g, "");
  const fixedCandidates = [...compact.matchAll(/[A-Z]{2}\d{8}/g)]
    .map((match) => parseTaiwanQrPayload(compact.slice(match.index)))
    .filter((candidate) => Object.keys(removeEmpty(candidate)).length);
  const completeCandidate = fixedCandidates.find(hasCoreInvoiceData);
  if (completeCandidate) return completeCandidate;

  const bestCandidate = fixedCandidates[0] || {};
  const invoiceMatch = compact.match(/[A-Z]{2}\d{8}/);
  const amountCandidates = [...text.matchAll(/[:*]([0-9A-F]{8})[:*]/g)].map((match) => match[1]);
  const taxIds = [...compact.matchAll(/\d{8}/g)].map((match) => match[0]);
  const targetTaxId = normalizeTaxId(settings.targetTaxId);
  const rocDateMatch = compact.match(/(?:[A-Z]{2}\d{8})(\d{7})/);
  return {
    invoiceNumber: bestCandidate.invoiceNumber || invoiceMatch?.[0] || "",
    invoiceDate: bestCandidate.invoiceDate || (rocDateMatch ? rocToDate(rocDateMatch[1]) : ""),
    totalAmount: bestCandidate.totalAmount || (amountCandidates.length >= 2 ? String(parseInt(amountCandidates[1], 16)) : ""),
    buyerTaxId: bestCandidate.buyerTaxId || taxIds.find((id) => targetTaxId && id === targetTaxId) || ""
  };
}

function parseTaiwanQrPayload(payload) {
  const invoiceNumber = payload.slice(0, 10);
  const rocDate = payload.slice(10, 17);
  const totalHex = payload.slice(29, 37);
  const buyerTaxId = payload.slice(37, 45);
  if (!/^[A-Z]{2}\d{8}$/.test(invoiceNumber) || !/^\d{7}$/.test(rocDate)) return {};

  const parsed = {
    invoiceNumber,
    invoiceDate: rocToDate(rocDate),
    totalAmount: "",
    buyerTaxId: ""
  };
  if (/^[0-9A-F]{8}$/.test(totalHex)) {
    const totalAmount = parseInt(totalHex, 16);
    if (Number.isFinite(totalAmount) && totalAmount > 0) parsed.totalAmount = String(totalAmount);
  }
  if (/^\d{8}$/.test(buyerTaxId) && buyerTaxId !== "00000000") {
    parsed.buyerTaxId = buyerTaxId;
  }
  return parsed;
}

function rocToDate(value) {
  if (!/^\d{7}$/.test(value)) return "";
  const year = Number(value.slice(0, 3)) + 1911;
  const month = value.slice(3, 5);
  const day = value.slice(5, 7);
  return `${year}-${month}-${day}`;
}

function removeEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== ""));
}

function sortRecordsByDate(records) {
  return [...records].sort((a, b) =>
    String(a.invoiceDate).localeCompare(String(b.invoiceDate)) ||
    String(a.createdAt).localeCompare(String(b.createdAt))
  );
}

async function duplicateInfo(candidateNumber, candidateDate, candidateAmount) {
  const records = await getAllRecords();
  const invoiceNumber = normalizeInvoiceNumber(candidateNumber);
  if (invoiceNumber) {
    const exact = records.find((record) => record.id !== editingRecordId && record.invoiceNumber === invoiceNumber);
    if (exact) return { type: "exact", record: exact };
  }
  if (candidateDate && candidateAmount) {
    const possible = records.find((record) =>
      record.id !== editingRecordId &&
      record.invoiceDate === candidateDate &&
      String(record.totalAmount) === String(candidateAmount)
    );
    if (possible) return { type: "possible", record: possible };
  }
  return null;
}

async function checkDuplicateWarning() {
  const duplicate = await duplicateInfo(
    els.invoiceNumber.value,
    els.invoiceDate.value,
    toNumberString(els.totalAmount.value)
  );
  if (!duplicate) {
    els.duplicateWarning.hidden = true;
    els.duplicateWarning.textContent = "";
    return;
  }
  els.duplicateWarning.hidden = false;
  els.duplicateWarning.textContent =
    duplicate.type === "exact"
      ? `發票號碼已存在：${duplicate.record.invoiceNumber}，儲存時會再次確認。`
      : `可能重複：同日期與同金額已有一筆記錄。`;
}

async function submitReview(event) {
  event.preventDefault();
  const invoiceNumber = normalizeInvoiceNumber(els.invoiceNumber.value);
  const invoiceDate = els.invoiceDate.value;
  const totalAmount = toNumberString(els.totalAmount.value);
  const buyerTaxId = normalizeTaxId(els.buyerTaxId.value);
  const taxIdMatched = buyerTaxId && settings.targetTaxId ? buyerTaxId === settings.targetTaxId : false;
  const includeInTotal = Boolean(els.includeInTotal.checked && taxIdMatched);

  if (!invoiceDate || !totalAmount) {
    showToast("日期與總金額必填");
    return;
  }

  const duplicate = await duplicateInfo(invoiceNumber, invoiceDate, totalAmount);
  let duplicateFlag = duplicate?.type || "";
  if (duplicate?.type === "exact") {
    const overwrite = confirm("發票號碼已存在。按「確定」覆蓋原記錄，按「取消」仍新增並標記重複。");
    if (overwrite) editingRecordId = duplicate.record.id;
    else duplicateFlag = "exact";
  } else if (duplicate?.type === "possible") {
    const continueAdd = confirm("同日期與同金額已有記錄，可能重複。仍要新增嗎？");
    if (!continueAdd) return;
  }

  const now = new Date().toISOString();
  await saveRecord({
    id: editingRecordId || crypto.randomUUID(),
    invoiceNumber,
    invoiceDate,
    totalAmount: Number(totalAmount),
    buyerTaxId,
    taxIdMatched,
    includeInTotal,
    duplicateFlag,
    createdAt: now,
    updatedAt: now
  });
  showToast("已儲存記錄");
  clearReview();
  await render();
}

async function render() {
  const records = sortRecordsByDate(await getAllRecords());
  const included = records.filter((record) => record.taxIdMatched && record.includeInTotal);
  const total = included.reduce((sum, record) => sum + Number(record.totalAmount || 0), 0);
  const duplicates = records.filter((record) => record.duplicateFlag).length;

  els.includedCount.textContent = String(included.length);
  els.includedTotal.textContent = currency(total);
  els.duplicateCount.textContent = String(duplicates);

  if (!records.length) {
    els.recordList.innerHTML = `<div class="status-line">尚無記錄</div>`;
    return;
  }

  els.recordList.innerHTML = records.map((record) => recordHtml(record)).join("");
}

function recordHtml(record) {
  const matchedClass = record.taxIdMatched ? "ok" : "warn";
  const matchedText = record.taxIdMatched ? "統編正確" : "統編不符";
  const includedText = record.includeInTotal ? "納入加總" : "未納入";
  const duplicateText = record.duplicateFlag ? `<span class="badge warn">重複提示</span>` : "";
  return `
    <article class="record-card" data-id="${record.id}">
      <div class="record-top">
        <strong>${currency(record.totalAmount)}</strong>
        <span>${record.invoiceDate || ""}</span>
      </div>
      <div>
        <span class="badge">${record.invoiceNumber || "無發票號碼"}</span>
        <span class="badge ${matchedClass}">${matchedText}</span>
        <span class="badge">${includedText}</span>
        ${duplicateText}
      </div>
      <div class="record-meta">
        <span>發票統編：${record.buyerTaxId || "未填"}</span>
        <span>更新：${new Date(record.updatedAt || record.createdAt).toLocaleDateString("zh-TW")}</span>
      </div>
      <div class="record-actions">
        <button class="secondary" type="button" data-action="toggle">${record.includeInTotal ? "排除" : "納入"}</button>
        <button class="secondary" type="button" data-action="edit">編輯</button>
        <button class="secondary" type="button" data-action="delete">刪除</button>
      </div>
    </article>
  `;
}

function toCsv(records) {
  const header = ["發票號碼", "發票日期", "單張總金額", "統編是否正確", "是否納入加總"];
  const sortedRecords = sortRecordsByDate(records);
  const rows = sortedRecords.map((record) => [
    record.invoiceNumber,
    record.invoiceDate,
    record.totalAmount,
    record.taxIdMatched ? "是" : "否",
    record.includeInTotal ? "是" : "否"
  ]);
  const total = sortedRecords
    .filter((record) => record.taxIdMatched && record.includeInTotal)
    .reduce((sum, record) => sum + Number(record.totalAmount || 0), 0);
  rows.push(["", "加總", total, "", ""]);
  return [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

async function exportCsv() {
  const records = sortRecordsByDate(await getAllRecords());
  const csv = "\ufeff" + toCsv(records);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const filename = settings.exportFilename || DEFAULT_FILENAME;

  if ("showSaveFilePicker" in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "CSV", accept: { "text/csv": [".csv"] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      showToast("已更新匯出檔");
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  showToast("已產生固定檔名匯出檔");
}

async function importCsv(file) {
  const text = await file.text();
  const rows = parseCsv(text.replace(/^\ufeff/, ""));
  const [, ...dataRows] = rows;
  let count = 0;
  for (const row of dataRows) {
    if (row[1] === "加總" || !row[1] || !row[2]) continue;
    await saveRecord({
      id: crypto.randomUUID(),
      invoiceNumber: normalizeInvoiceNumber(row[0]),
      invoiceDate: row[1],
      totalAmount: Number(toNumberString(row[2])),
      buyerTaxId: "",
      taxIdMatched: row[3] === "是",
      includeInTotal: row[4] === "是",
      duplicateFlag: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    count += 1;
  }
  showToast(`已匯入 ${count} 筆`);
  await render();
}

async function clearRecords() {
  const records = await getAllRecords();
  if (!records.length) {
    showToast("目前沒有紀錄");
    return;
  }
  if (!confirm(`確定清除全部 ${records.length} 筆紀錄？此動作無法復原。`)) return;
  await clearAllRecords();
  showToast("已清除全部紀錄");
  await render();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted && char === '"' && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function handleRecordAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest(".record-card");
  const id = card?.dataset.id;
  const records = await getAllRecords();
  const record = records.find((item) => item.id === id);
  if (!record) return;

  if (button.dataset.action === "delete") {
    if (!confirm("確定刪除此筆記錄？")) return;
    await deleteRecord(id);
    showToast("已刪除");
    await render();
  }

  if (button.dataset.action === "toggle") {
    record.includeInTotal = !record.includeInTotal && record.taxIdMatched;
    record.updatedAt = new Date().toISOString();
    await saveRecord(record);
    await render();
  }

  if (button.dataset.action === "edit") {
    editingRecordId = record.id;
    setTab("scan");
    setReviewValues({ ...record, status: "編輯既有記錄" });
  }
}

function setTab(name) {
  if (name !== "scan") stopLiveScan();
  els.tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === name));
  Object.entries(els.panels).forEach(([key, panel]) => panel.classList.toggle("is-active", key === name));
}

function bindEvents() {
  els.tabs.forEach((tab) => tab.addEventListener("click", () => setTab(tab.dataset.tab)));
  els.liveScanButton.addEventListener("click", startLiveScan);
  els.stopScanButton.addEventListener("click", stopLiveScan);
  els.manualButton.addEventListener("click", () => setReviewValues({ status: "手動新增發票資料" }));
  els.reviewForm.addEventListener("submit", submitReview);
  els.clearReviewButton.addEventListener("click", clearReview);
  [els.buyerTaxId, els.invoiceNumber, els.invoiceDate, els.totalAmount].forEach((input) => {
    input.addEventListener("input", () => {
      if (input === els.buyerTaxId) {
        els.buyerTaxId.value = normalizeTaxId(els.buyerTaxId.value);
        updateTaxResult();
      }
      if (input === els.totalAmount) els.totalAmount.value = toNumberString(els.totalAmount.value);
      if (input === els.invoiceNumber) els.invoiceNumber.value = normalizeInvoiceNumber(els.invoiceNumber.value);
      checkDuplicateWarning();
    });
  });
  els.includeInTotal.addEventListener("change", () => {
    if (els.includeInTotal.checked && !isTaxIdMatched()) {
      els.includeInTotal.checked = false;
      showToast("統編正確才可納入加總");
    }
  });
  els.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    settings.targetTaxId = normalizeTaxId(els.targetTaxId.value);
    settings.exportFilename = els.exportFilename.value.trim() || DEFAULT_FILENAME;
    els.targetTaxId.value = settings.targetTaxId;
    await saveSettings();
    updateTaxResult();
    showToast("設定已儲存");
  });
  els.exportButton.addEventListener("click", exportCsv);
  els.clearRecordsButton?.addEventListener("click", clearRecords);
  els.importInput.addEventListener("change", async () => {
    const file = els.importInput.files?.[0];
    if (file) await importCsv(file);
    els.importInput.value = "";
  });
  els.recordList.addEventListener("click", handleRecordAction);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    els.installButton.hidden = false;
  });
  els.installButton.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    els.installButton.hidden = true;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopLiveScan();
  });
}

async function init() {
  if (els.appVersion) els.appVersion.textContent = `版本 ${APP_VERSION}`;
  db = await openDb();
  await loadSettings();
  bindEvents();
  await render();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

init().catch((error) => {
  showToast(error.message || "App 啟動失敗");
});
