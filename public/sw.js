const CACHE_NAME = "invoice-capture-v6";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./tesseract/tesseract.min.js",
  "./tesseract/worker.min.js",
  "./tesseract/tesseract-core.wasm.js",
  "./tesseract/tesseract-core.wasm",
  "./tesseract/tesseract-core-simd.wasm.js",
  "./tesseract/tesseract-core-simd.wasm",
  "./tesseract/tesseract-core-lstm.wasm.js",
  "./tesseract/tesseract-core-lstm.wasm",
  "./tesseract/tesseract-core-simd-lstm.wasm.js",
  "./tesseract/tesseract-core-simd-lstm.wasm",
  "./tessdata/eng.traineddata.gz",
  "./zxing.js",
  "./jsQR.js",
  "./qr-fallback.js",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
