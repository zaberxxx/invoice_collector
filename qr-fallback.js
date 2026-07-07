(function () {
  if ("BarcodeDetector" in window || typeof window.jsQR !== "function") return;

  window.BarcodeDetector = class BarcodeDetector {
    constructor(options = {}) {
      this.formats = options.formats || ["qr_code"];
    }

    async detect(source) {
      if (!this.formats.includes("qr_code")) return [];

      const canvas = document.createElement("canvas");
      canvas.width = source.width || source.videoWidth || source.naturalWidth;
      canvas.height = source.height || source.videoHeight || source.naturalHeight;
      if (!canvas.width || !canvas.height) return [];

      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = window.jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: "attemptBoth"
      });

      return result ? [{ rawValue: result.data, format: "qr_code" }] : [];
    }
  };
})();
