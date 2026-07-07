# 統編發票記錄 PWA

手機網頁 App，用拍照或上傳照片記錄台灣統一發票。每筆保留發票號碼、日期、單張總金額、統編是否正確、是否納入加總，並提示重複項目。

## 執行

### 手機脫離電腦使用

這個 App 可以做成不需要家裡電腦常開的手機 PWA。做法是把 `public/` 資料夾部署到任一個 HTTPS 靜態網站服務，例如 Cloudflare Pages、GitHub Pages、Netlify 或 Vercel Static Hosting。

部署後：

1. 用手機打開該 HTTPS 網址。
2. iPhone 在 Safari 選「分享」->「加入主畫面」；Android 在 Chrome 選「安裝應用程式」。
3. 之後從主畫面開啟即可使用；資料存在手機本機 IndexedDB。
4. 在外面不需要連回家裡電腦，也不需要 Tailscale。

注意：第一次安裝需要能連到部署網址。安裝後，已載入的 App 可離線開啟；但若換手機或清除瀏覽器資料，本機記錄會消失，所以請定期匯出 CSV 到 iCloud Drive。

### 本機測試

```bash
node server.js
```

開啟 `http://localhost:4173`。部署到 HTTPS 網址後，手機瀏覽器可使用相機與安裝為 PWA。

若要讓同一個 Wi-Fi 內的手機連到這台電腦測試，可用：

```bash
HOST=0.0.0.0 node server.js
```

## 辨識模式

- 不一定需要 LLM API key。
- App 會先用瀏覽器的 `BarcodeDetector` 嘗試離線讀電子發票 QR Code。
- 若手機瀏覽器不支援 `BarcodeDetector`，會改用 jsQR fallback 讀取照片中的 QR Code。
- 純靜態部署時沒有後端 API，仍可離線讀 QR；讀不到時手動輸入。
- 若自行部署 `server.js` 並設定 `OPENAI_API_KEY`，後端才會呼叫雲端視覺辨識輔助讀取照片。
- 若沒有 `OPENAI_API_KEY`，仍可手動新增、校正、檢查統編、提示重複、加總與匯出。

完全離線 OCR 也可行，但需要額外整合 OCR 模型或函式庫，例如 Tesseract.js、Google ML Kit 或 PaddleOCR。第一版先以電子發票 QR 離線讀取為主，因為比純 OCR 判讀照片文字穩定。

## 匯出

固定匯出檔名預設為 `invoice-summary.csv`。App 內資料會更新同一份本機主記錄；匯出時產生同名 CSV。若存到 iCloud Drive，請選擇取代原檔。
