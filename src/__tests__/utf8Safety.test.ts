/**
 * utf8Safety.test.ts — Testes para utf8Safety.ts.
 *
 * utf8Safety.ts lida com detecção de locale UTF-8.
 * pickBestUtf8Locale retorna { locale, tried }, diagnoseUtf8 retorna string.
 */
import { describe, it, expect } from "vitest";
import {
  listSystemLocales,
  pickBestUtf8Locale,
  forceUtf8Environment,
  diagnoseUtf8,
} from "../utf8Safety.js";

describe("utf8Safety", () => {
  describe("listSystemLocales", () => {
    it("retorna array", () => {
      const locales = listSystemLocales();
      expect(Array.isArray(locales)).toBe(true);
    });

    it("cada item é string", () => {
      const locales = listSystemLocales();
      for (const l of locales) {
        expect(typeof l).toBe("string");
      }
    });
  });

  describe("pickBestUtf8Locale", () => {
    it("retorna objeto com locale e tried", () => {
      const result = pickBestUtf8Locale();
      expect(result).toHaveProperty("locale");
      expect(result).toHaveProperty("tried");
    });

    it("locale é string ou null", () => {
      const result = pickBestUtf8Locale();
      expect(result.locale === null || typeof result.locale === "string").toBe(true);
    });

    it("tried é array", () => {
      const result = pickBestUtf8Locale();
      expect(Array.isArray(result.tried)).toBe(true);
    });
  });

  describe("forceUtf8Environment", () => {
    it("não lança erro", () => {
      expect(() => forceUtf8Environment()).not.toThrow();
    });

    it("retorna objeto com propriedades", () => {
      const result = forceUtf8Environment();
      expect(typeof result).toBe("object");
    });

    it("é idempotente", () => {
      forceUtf8Environment();
      expect(() => forceUtf8Environment()).not.toThrow();
    });
  });

  describe("diagnoseUtf8", () => {
    it("retorna string", () => {
      const result = diagnoseUtf8();
      expect(typeof result).toBe("string");
    });

    it("contém 'UTF-8' no output", () => {
      const result = diagnoseUtf8();
      expect(result).toContain("UTF-8");
    });

    it("contém 'platform' no output", () => {
      const result = diagnoseUtf8();
      expect(result).toContain("platform");
    });
  });
});
