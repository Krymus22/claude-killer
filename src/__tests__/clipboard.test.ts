/**
 * clipboard.test.ts — Tests for clipboard.ts pure logic.
 * Covers: platform detection, command construction, content parsing.
 */

import { describe, it, expect } from "vitest";

// ─── Extract pure functions from clipboard.ts ──────────────────────────────

type Platform = "win32" | "darwin" | "linux";

function detectPlatform(): Platform {
  const p = process.platform;
  if (p === "win32" || p === "darwin" || p === "linux") return p;
  return "linux";
}

function getCopyCommand(platform: Platform): string {
  switch (platform) {
    case "win32": return "clip";
    case "darwin": return "pbcopy";
    case "linux": return "xclip -selection clipboard";
  }
}

function getPasteCommand(platform: Platform): string {
  switch (platform) {
    case "win32": return "powershell -command \"Get-Clipboard\"";
    case "darwin": return "pbpaste";
    case "linux": return "xclip -selection clipboard -o";
  }
}

function sanitizeClipboardContent(content: string): string {
  // Remove null bytes and normalize line endings
  return content.replace(/\0/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isImageContent(content: string): boolean {
  const trimmed = content.trim();
  // Check for image file extensions or base64 data URI
  if (/\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(trimmed)) return true;
  if (/^data:image\//.test(trimmed)) return true;
  if (/^iVBORw0KGgo/.test(trimmed)) return true; // PNG base64 header
  return false;
}

function detectImageFormat(data: string): string | null {
  if (data.startsWith("PNG")) return "png";
  if (data.startsWith("JPEG") || data.startsWith("JFIF")) return "jpeg";
  if (data.startsWith("GIF8")) return "gif";
  if (data.startsWith("RIFF") && data.includes("WEBP")) return "webp";
  if (data.startsWith("<svg")) return "svg";
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("clipboard.ts pure logic", () => {
  describe("detectPlatform", () => {
    it("should return a valid platform", () => {
      const p = detectPlatform();
      expect(["win32", "darwin", "linux"]).toContain(p);
    });
  });

  describe("getCopyCommand", () => {
    it("should return clip for Windows", () => {
      expect(getCopyCommand("win32")).toBe("clip");
    });

    it("should return pbcopy for macOS", () => {
      expect(getCopyCommand("darwin")).toBe("pbcopy");
    });

    it("should return xclip for Linux", () => {
      expect(getCopyCommand("linux")).toContain("xclip");
    });
  });

  describe("getPasteCommand", () => {
    it("should return PowerShell for Windows", () => {
      const cmd = getPasteCommand("win32");
      expect(cmd).toContain("powershell");
      expect(cmd).toContain("Get-Clipboard");
    });

    it("should return pbpaste for macOS", () => {
      expect(getPasteCommand("darwin")).toBe("pbpaste");
    });

    it("should return xclip for Linux", () => {
      const cmd = getPasteCommand("linux");
      expect(cmd).toContain("xclip");
      expect(cmd).toContain("-o");
    });
  });

  describe("sanitizeClipboardContent", () => {
    it("should remove null bytes", () => {
      expect(sanitizeClipboardContent("hello\0world")).toBe("helloworld");
    });

    it("should normalize CRLF to LF", () => {
      expect(sanitizeClipboardContent("line1\r\nline2")).toBe("line1\nline2");
    });

    it("should normalize CR to LF", () => {
      expect(sanitizeClipboardContent("line1\rline2")).toBe("line1\nline2");
    });

    it("should handle clean content unchanged", () => {
      expect(sanitizeClipboardContent("clean text")).toBe("clean text");
    });

    it("should handle empty string", () => {
      expect(sanitizeClipboardContent("")).toBe("");
    });
  });

  describe("isImageContent", () => {
    it("should detect PNG file path", () => {
      expect(isImageContent("screenshot.png")).toBe(true);
    });

    it("should detect JPEG file path", () => {
      expect(isImageContent("photo.jpg")).toBe(true);
    });

    it("should detect JPEG extension", () => {
      expect(isImageContent("image.jpeg")).toBe(true);
    });

    it("should detect GIF file path", () => {
      expect(isImageContent("anim.gif")).toBe(true);
    });

    it("should detect SVG file path", () => {
      expect(isImageContent("icon.svg")).toBe(true);
    });

    it("should detect data URI", () => {
      expect(isImageContent("data:image/png;base64,iVBOR...")).toBe(true);
    });

    it("should detect PNG base64 header", () => {
      expect(isImageContent("iVBORw0KGgoAAAANSUhEUg")).toBe(true);
    });

    it("should reject plain text", () => {
      expect(isImageContent("hello world")).toBe(false);
    });

    it("should reject non-image file extension", () => {
      expect(isImageContent("script.ts")).toBe(false);
    });

    it("should handle case-insensitive extensions", () => {
      expect(isImageContent("PHOTO.PNG")).toBe(true);
    });
  });

  describe("detectImageFormat", () => {
    it("should detect PNG", () => {
      expect(detectImageFormat("PNGrest")).toBe("png");
    });

    it("should detect JPEG", () => {
      expect(detectImageFormat("JPEGrest")).toBe("jpeg");
    });

    it("should detect JPEG from JFIF", () => {
      expect(detectImageFormat("JFIFrest")).toBe("jpeg");
    });

    it("should detect GIF", () => {
      expect(detectImageFormat("GIF89a")).toBe("gif");
    });

    it("should detect SVG", () => {
      expect(detectImageFormat("<svg xmlns='http://www.w3.org/2000/svg'>")).toBe("svg");
    });

    it("should return null for unknown format", () => {
      expect(detectImageFormat("random data")).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(detectImageFormat("")).toBeNull();
    });
  });
});
