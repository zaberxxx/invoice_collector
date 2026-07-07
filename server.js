import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const openAiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"]
]);

function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(data));
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function parseOpenAiJson(text) {
  if (!text) return {};
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

async function extractInvoiceWithOpenAi(imageDataUrl, targetTaxId) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: true,
      mode: "manual",
      extracted: {
        invoiceNumber: "",
        invoiceDate: "",
        totalAmount: "",
        buyerTaxId: "",
        taxIdMatched: false,
        includeInTotal: false,
        confidence: 0,
        warnings: ["未設定 OPENAI_API_KEY，請手動輸入發票資料。"]
      }
    };
  }

  const prompt = [
    "你是台灣統一發票資料擷取器。請只回傳 JSON，不要 Markdown。",
    "從照片判讀以下欄位：invoiceNumber、invoiceDate、totalAmount、buyerTaxId。",
    "invoiceDate 請用西元 YYYY-MM-DD；totalAmount 請回傳整數數字字串；buyerTaxId 是買方統一編號。",
    `targetTaxId 是 ${targetTaxId || "未設定"}，taxIdMatched 必須表示 buyerTaxId 是否完全相同。`,
    "includeInTotal 預設等於 taxIdMatched；若任一欄位不確定，請留空並在 warnings 說明。",
    "回傳格式：{\"invoiceNumber\":\"\",\"invoiceDate\":\"\",\"totalAmount\":\"\",\"buyerTaxId\":\"\",\"taxIdMatched\":false,\"includeInTotal\":false,\"confidence\":0,\"warnings\":[]}"
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: openAiModel,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: imageDataUrl }
          ]
        }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    return {
      ok: false,
      error: data?.error?.message || "雲端辨識失敗"
    };
  }

  const text =
    data.output_text ||
    data.output?.flatMap((item) => item.content || [])
      .map((item) => item.text)
      .filter(Boolean)
      .join("\n");

  const extracted = parseOpenAiJson(text);
  return { ok: true, mode: "cloud", extracted };
}

async function handleExtract(req, res) {
  try {
    const body = await readRequestJson(req);
    if (!body.imageDataUrl) {
      sendJson(res, 400, { ok: false, error: "缺少 imageDataUrl" });
      return;
    }

    const result = await extractInvoiceWithOpenAi(body.imageDataUrl, body.targetTaxId);
    sendJson(res, result.ok ? 200 : 502, result);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || "伺服器錯誤" });
  }
}

function safePublicPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const requestPath = decoded === "/" ? "/index.html" : decoded;
  const filePath = normalize(join(publicDir, requestPath));
  if (!filePath.startsWith(publicDir)) return null;
  return filePath;
}

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/invoices/extract") {
    await handleExtract(req, res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  const filePath = safePublicPath(req.url || "/");
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes.get(extname(filePath)) || "application/octet-stream",
      "cache-control": filePath.endsWith("sw.js") ? "no-store" : "public, max-age=300"
    });
    if (req.method === "HEAD") res.end();
    else res.end(file);
  } catch {
    const fallback = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(fallback);
  }
});

server.listen(port, host, () => {
  console.log(`Invoice Capture PWA running at http://${host}:${port}`);
});
