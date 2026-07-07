(function () {
  if (typeof window.jsQR !== "function") return;

  function sourceSize(source) {
    return {
      width: source.width || source.videoWidth || source.naturalWidth,
      height: source.height || source.videoHeight || source.naturalHeight
    };
  }

  function drawCrop(source, crop) {
    const canvas = document.createElement("canvas");
    const maxSide = 1200;
    const scale = Math.min(1, maxSide / Math.max(crop.width, crop.height));
    canvas.width = Math.max(1, Math.round(crop.width * scale));
    canvas.height = Math.max(1, Math.round(crop.height * scale));

    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.imageSmoothingEnabled = false;
    context.drawImage(
      source,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      canvas.width,
      canvas.height
    );

    return { canvas, context };
  }

  function decodeCrop(source, crop) {
    const { canvas, context } = drawCrop(source, crop);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    return window.jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "attemptBoth"
    });
  }

  function decodeCropWithZXing(source, crop) {
    if (!window.ZXing) return null;

    const { canvas } = drawCrop(source, crop);
    const zxing = window.ZXing;
    const hints = new Map();
    hints.set(zxing.DecodeHintType.POSSIBLE_FORMATS, [zxing.BarcodeFormat.QR_CODE]);
    hints.set(zxing.DecodeHintType.TRY_HARDER, true);

    try {
      const luminance = new zxing.HTMLCanvasElementLuminanceSource(canvas);
      const bitmap = new zxing.BinaryBitmap(new zxing.HybridBinarizer(luminance));
      return new zxing.QRCodeReader().decode(bitmap, hints).getText();
    } catch {
      return null;
    }
  }

  function candidateCrops(width, height) {
    const crop = (x, y, w, h) => ({
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      width: Math.min(width - Math.max(0, Math.round(x)), Math.round(w)),
      height: Math.min(height - Math.max(0, Math.round(y)), Math.round(h))
    });

    return [
      crop(0, 0, width, height),
      crop(0, height * 0.35, width, height * 0.5),
      crop(width * 0.12, height * 0.42, width * 0.76, height * 0.34),
      crop(width * 0.12, height * 0.43, width * 0.4, height * 0.33),
      crop(width * 0.42, height * 0.43, width * 0.42, height * 0.33),
      crop(width * 0.05, height * 0.35, width * 0.5, height * 0.45),
      crop(width * 0.35, height * 0.35, width * 0.6, height * 0.45)
    ].filter((item) => item.width > 80 && item.height > 80);
  }

  async function detectQrCodesWithJsQR(source) {
    const { width, height } = sourceSize(source);
    if (!width || !height) return [];

    const results = [];
    const seen = new Set();
    for (const crop of candidateCrops(width, height)) {
      const zxingResult = decodeCropWithZXing(source, crop);
      if (zxingResult && !seen.has(zxingResult)) {
        seen.add(zxingResult);
        results.push({ rawValue: zxingResult, format: "qr_code" });
      }

      const result = decodeCrop(source, crop);
      if (result?.data && !seen.has(result.data)) {
        seen.add(result.data);
        results.push({ rawValue: result.data, format: "qr_code" });
      }
    }

    return results;
  }

  window.detectQrCodesWithJsQR = detectQrCodesWithJsQR;

  if ("BarcodeDetector" in window) return;

  window.BarcodeDetector = class BarcodeDetector {
    constructor(options = {}) {
      this.formats = options.formats || ["qr_code"];
    }

    async detect(source) {
      if (!this.formats.includes("qr_code")) return [];

      return detectQrCodesWithJsQR(source);
    }
  };
})();
