/**
 * imagePaste.test.ts — Tests for imagePaste.ts pure logic.
 * Covers: image detection, format detection, data URI parsing, size estimation.
 */

import { describe, it, expect } from "vitest";

// ─── Extract pure functions from imagePaste.ts ─────────────────────────────

function isDataUriImage(dataUri: string): boolean {
  return /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,/.test(dataUri);
}

function parseDataUri(dataUri: string): { mimeType: string; base64Data: string } | null {
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUri);
  if (!match) return null;
  return { mimeType: match[1], base64Data: match[2] };
}

function estimateBase64Size(base64Data: string): number {
  // Each base64 char represents 6 bits, 4 chars = 3 bytes
  const padding = (base64Data.match(/={1,2}$/) ?? [""])[0].length;
  return Math.floor((base64Data.length * 3) / 4) - padding;
}

function isPngSignature(data: Uint8Array): boolean {
  return data.length >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47 &&
    data[4] === 0x0D && data[5] === 0x0A && data[6] === 0x1A && data[7] === 0x0A;
}

function isJpegSignature(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0xFF && data[1] === 0xD8;
}

function isGifSignature(data: Uint8Array): boolean {
  const header = String.fromCharCode(...data.slice(0, 6));
  return header === "GIF87a" || header === "GIF89a";
}

function detectFormatFromBytes(data: Uint8Array): string | null {
  if (isPngSignature(data)) return "png";
  if (isJpegSignature(data)) return "jpeg";
  if (isGifSignature(data)) return "gif";
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("imagePaste.ts pure logic", () => {
  describe("isDataUriImage", () => {
    it("should accept valid PNG data URI", () => {
      expect(isDataUriImage("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    });

    it("should accept valid JPEG data URI", () => {
      expect(isDataUriImage("data:image/jpeg;base64,/9j/4AAQ=")).toBe(true);
    });

    it("should accept valid JPG data URI", () => {
      expect(isDataUriImage("data:image/jpg;base64,abc123=")).toBe(true);
    });

    it("should accept valid GIF data URI", () => {
      expect(isDataUriImage("data:image/gif;base64,R0lGODlh=")).toBe(true);
    });

    it("should accept valid WebP data URI", () => {
      expect(isDataUriImage("data:image/webp;base64,UklGRg==")).toBe(true);
    });

    it("should accept valid SVG data URI", () => {
      expect(isDataUriImage("data:image/svg+xml;base64,PHN2Zw==")).toBe(true);
    });

    it("should reject non-image data URI", () => {
      expect(isDataUriImage("data:text/plain;base64,SGVsbG8=")).toBe(false);
    });

    it("should reject plain text", () => {
      expect(isDataUriImage("not a data uri")).toBe(false);
    });

    it("should reject empty string", () => {
      expect(isDataUriImage("")).toBe(false);
    });
  });

  describe("parseDataUri", () => {
    it("should parse PNG data URI", () => {
      const result = parseDataUri("data:image/png;base64,iVBORw0KGgo=");
      expect(result).not.toBeNull();
      expect(result!.mimeType).toBe("image/png");
      expect(result!.base64Data).toBe("iVBORw0KGgo=");
    });

    it("should parse JPEG data URI", () => {
      const result = parseDataUri("data:image/jpeg;base64,/9j/4AAQ=");
      expect(result).not.toBeNull();
      expect(result!.mimeType).toBe("image/jpeg");
    });

    it("should return null for non-data URI", () => {
      expect(parseDataUri("https://example.com/img.png")).toBeNull();
    });

    it("should return null for invalid base64", () => {
      expect(parseDataUri("data:image/png;base64,")).toBeNull();
    });

    it("should handle case-insensitive mime type", () => {
      const result = parseDataUri("data:IMAGE/PNG;base64,abc123==");
      expect(result).not.toBeNull();
    });
  });

  describe("estimateBase64Size", () => {
    it("should estimate size correctly", () => {
      // "SGVsbG8=" = "Hello" = 5 bytes
      expect(estimateBase64Size("SGVsbG8=")).toBe(5);
    });

    it("should handle no-padding base64", () => {
      // 4 chars = 3 bytes without padding
      expect(estimateBase64Size("AAAA")).toBe(3);
    });

    it("should handle single padding", () => {
      // "YQ==" = "a" = 1 byte
      expect(estimateBase64Size("YQ==")).toBe(1);
    });

    it("should return 0 for empty string", () => {
      expect(estimateBase64Size("")).toBe(0);
    });

    it("should handle larger data", () => {
      // 12 chars = 9 bytes
      expect(estimateBase64Size("AAAAAAAAAAAA")).toBe(9);
    });
  });

  describe("binary format detection", () => {
    it("should detect PNG from bytes", () => {
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]);
      expect(detectFormatFromBytes(pngBytes)).toBe("png");
    });

    it("should detect JPEG from bytes", () => {
      const jpegBytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]);
      expect(detectFormatFromBytes(jpegBytes)).toBe("jpeg");
    });

    it("should detect GIF87a", () => {
      const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
      expect(detectFormatFromBytes(gifBytes)).toBe("gif");
    });

    it("should detect GIF89a", () => {
      const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      expect(detectFormatFromBytes(gifBytes)).toBe("gif");
    });

    it("should return null for unknown format", () => {
      const data = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
      expect(detectFormatFromBytes(data)).toBeNull();
    });

    it("should return null for empty array", () => {
      expect(detectFormatFromBytes(new Uint8Array([]))).toBeNull();
    });

    it("should return null for too-short data", () => {
      expect(detectFormatFromBytes(new Uint8Array([0x89]))).toBeNull();
    });

    it("isPngSignature should be correct", () => {
      const correct = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      expect(isPngSignature(correct)).toBe(true);
      const wrong = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0B]);
      expect(isPngSignature(wrong)).toBe(false);
    });

    it("isJpegSignature should be correct", () => {
      expect(isJpegSignature(new Uint8Array([0xFF, 0xD8, 0xFF]))).toBe(true);
      expect(isJpegSignature(new Uint8Array([0xFF, 0xD8]))).toBe(true);
      expect(isJpegSignature(new Uint8Array([0x00, 0x00]))).toBe(false);
    });

    it("isGifSignature should be correct", () => {
      expect(isGifSignature(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe(true);
      expect(isGifSignature(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe(true);
      expect(isGifSignature(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x30, 0x61]))).toBe(false);
    });
  });
});
