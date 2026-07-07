const DB_NAME = "invoice-capture-db";
const DB_VERSION = 1;
const STORE_RECORDS = "records";
const STORE_SETTINGS = "settings";
const DEFAULT_FILENAME = "invoice-summary.csv";

const els = {
  tabs: document.querySelectorAll(".tab"),
  panels: {
    scan: document.querySelector("#scanPanel"),
    records: document.querySelector("#recordsPanel"),
    settings: document.querySelector("#settingsPanel")
  },
  imageInput: document.querySelector("#imageInput"),
  previewImage: document.querySelector("#previewImage"),
  extractButton: document.querySelector("#extractButton"),
  manualButton: document.querySelector("#manualButton"),
  scanForm: document.querySelector("#scanForm"),
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
  importInput: document.querySelector("#importInput"),
  toast: document.querySelector("#toast"),
  installButton: document.querySelector("#installButton")
};

let db;
let settings = {
  targetTaxId: "",
  exportFilename: DEFAULT_FILENAME
};
let selectedImageDataUrl = "";
let editingRecordId = "";
let deferredInstallPrompt = null;

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
  selectedImageDataUrl = "";
  els.imageInput.value = "";
  els.previewImage.hidden = true;
  els.previewImage.removeAttribute("src");
  setReviewValues({ status: "請輸入或辨識發票資料" });
  els.reviewForm.hidden = true;
  els.duplicateWarning.hidden = true;
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function detectBarcodeFromImage(file) {
  if (!("BarcodeDetector" in window) && typeof window.detectQrCodesWithJsQR !== "function") return {};
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    let codes = [];
    if ("BarcodeDetector" in window) {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      codes = await detector.detect(bitmap);
    }
    if (!codes.length && typeof window.detectQrCodesWithJsQR === "function") {
      codes = await window.detectQrCodesWithJsQR(bitmap);
    }
    const raw = codes.map((code) => code.rawValue).filter(Boolean).join("\n");
    return parseTaiwanInvoiceQr(raw);
  } catch {
    return {};
  } finally {
    bitmap?.close?.();
  }
}

function parseTaiwanInvoiceQr(raw) {
  const text = String(raw || "");
  const invoiceMatch = text.match(/[A-Z]{2}\d{8}/);
  const amountCandidates = [...text.matchAll(/[:*]([0-9A-Fa-f]{8})[:*]/g)].map((match) => match[1]);
  const taxIds = [...text.matchAll(/\b\d{8}\b/g)].map((match) => match[0]);
  const rocDateMatch = text.match(/(?:[A-Z]{2}\d{8})(\d{7})/);
  return {
    invoiceNumber: invoiceMatch?.[0] || "",
    invoiceDate: rocDateMatch ? rocToDate(rocDateMatch[1]) : "",
    totalAmount: amountCandidates.length >= 2 ? String(parseInt(amountCandidates[1], 16)) : "",
    buyerTaxId: taxIds.find((id) => id === settings.targetTaxId) || ""
  };
}

function rocToDate(value) {
  if (!/^\d{7}$/.test(value)) return "";
  const year = Number(value.slice(0, 3)) + 1911;
  const month = value.slice(3, 5);
  const day = value.slice(5, 7);
  return `${year}-${month}-${day}`;
}

async function extractInvoice() {
  const file = els.imageInput.files?.[0];
  if (!file) return;
  els.extractButton.disabled = true;
  els.extractButton.textContent = "辨識中";

  const barcodeData = await detectBarcodeFromImage(file);
  let result = { ok: false, mode: "offline", extracted: {}, error: "" };

  try {
    const response = await fetch("./api/invoices/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        imageDataUrl: selectedImageDataUrl,
        targetTaxId: settings.targetTaxId
      })
    });
    if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
      result = await response.json();
    }
  } catch (error) {
    result.error = error.message || "";
  } finally {
    const cloudData = result.ok ? result.extracted : {};
    const merged = { ...cloudData, ...removeEmpty(barcodeData) };
    merged.includeInTotal = normalizeTaxId(merged.buyerTaxId) === normalizeTaxId(settings.targetTaxId);
    const hasOfflineData = Object.keys(removeEmpty(barcodeData)).length > 0;
    merged.status = hasOfflineData ? "已讀取 QR 資料，請確認" : "未讀取到 QR，請近拍左側 QR 或手動輸入";
    if (result.ok && result.mode !== "manual") merged.status = "請確認辨識結果";
    if (result.ok && result.mode === "manual" && !hasOfflineData) merged.status = "未連接雲端辨識，請手動確認";
    setReviewValues(merged);
    els.extractButton.disabled = false;
    els.extractButton.textContent = "辨識發票";
  }
}

function removeEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== ""));
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
  const records = (await getAllRecords()).sort((a, b) =>
    String(b.invoiceDate).localeCompare(String(a.invoiceDate)) ||
    String(b.createdAt).localeCompare(String(a.createdAt))
  );
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
  const rows = records.map((record) => [
    record.invoiceNumber,
    record.invoiceDate,
    record.totalAmount,
    record.taxIdMatched ? "是" : "否",
    record.includeInTotal ? "是" : "否"
  ]);
  const total = records
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
  const records = await getAllRecords();
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
  els.tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === name));
  Object.entries(els.panels).forEach(([key, panel]) => panel.classList.toggle("is-active", key === name));
}

function bindEvents() {
  els.tabs.forEach((tab) => tab.addEventListener("click", () => setTab(tab.dataset.tab)));
  els.imageInput.addEventListener("change", async () => {
    const file = els.imageInput.files?.[0];
    if (!file) return;
    selectedImageDataUrl = await fileToDataUrl(file);
    els.previewImage.src = selectedImageDataUrl;
    els.previewImage.hidden = false;
    els.extractButton.disabled = false;
  });
  els.scanForm.addEventListener("submit", (event) => {
    event.preventDefault();
    extractInvoice();
  });
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
}

async function init() {
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
