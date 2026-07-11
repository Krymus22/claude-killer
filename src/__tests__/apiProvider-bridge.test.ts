/**
 * apiProvider-bridge.test.ts — tests for the bridge provider.
 *
 * Covers:
 *   - detectProvider() with API_PROVIDER=bridge
 *   - getProviderConfig() returns correct bridge config
 *   - Provider functions (heartbeat, hedging, multi-key, etc.) return bridge values
 *   - BRIDGE_URL must be HTTPS (§17.11 rule 81)
 *   - BRIDGE_TOKEN must be non-empty (§17.11 rule 82)
 *   - Bridge is NEVER auto-detected (must be explicit)
 *   - BRIDGE_MAX_RPM NaN guard (§17.11 rule 83, mirrors §17.9 rule 48)
 *   - Bridge exits(1) with helpful message when BRIDGE_URL or BRIDGE_TOKEN missing
 *
 * Bridge behavior summary (for cross-reference):
 *   - sendThinkingMode: false (like ZenMux)
 *   - reasoningField: "reasoning" (like ZenMux)
 *   - needsHeartbeat: false (no GPU cold start)
 *   - needsHedging: false (no GPU queue)
 *   - needsMultiKeyPool: false (single token = single identity)
 *   - maxConcurrentSubAgents: 1 (sequential — operator processes one at a time)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock logger (same pattern as apiProvider.test.ts)
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

const origEnv = { ...process.env };

beforeEach(() => {
  // Clean env
  delete process.env.API_PROVIDER;
  delete process.env.BRIDGE_URL;
  delete process.env.BRIDGE_TOKEN;
  delete process.env.BRIDGE_MAX_RPM;
  delete process.env.BRIDGE_PORT;
  delete process.env.BRIDGE_QUEUE_DIR;
  delete process.env.BRIDGE_RESPONSE_TIMEOUT_MS;
  delete process.env.ZENMUX_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEYS;
  delete process.env.NVIDIA_API_KEYS_FILE;
  delete process.env.MODEL;
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...origEnv };
  vi.resetModules();
});

describe("apiProvider — bridge provider", () => {
  describe("detectProvider", () => {
    it("returns 'bridge' when API_PROVIDER=bridge", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://example.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "secret-token";
      const { detectProvider } = await import("../apiProvider.js");
      expect(detectProvider()).toBe("bridge");
    });

    it("returns 'bridge' when API_PROVIDER=BRIDGE (case-insensitive)", async () => {
      process.env.API_PROVIDER = "BRIDGE";
      process.env.BRIDGE_URL = "https://example.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "secret-token";
      const { detectProvider } = await import("../apiProvider.js");
      expect(detectProvider()).toBe("bridge");
    });

    it("returns 'bridge' when API_PROVIDER has surrounding whitespace", async () => {
      process.env.API_PROVIDER = "  bridge  ";
      process.env.BRIDGE_URL = "https://example.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "secret-token";
      const { detectProvider } = await import("../apiProvider.js");
      expect(detectProvider()).toBe("bridge");
    });

    it("does NOT auto-detect bridge even if BRIDGE_URL and BRIDGE_TOKEN are set without API_PROVIDER", async () => {
      // Bridge must be explicit — never auto-detected
      process.env.BRIDGE_URL = "https://example.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "secret-token";
      // No NVIDIA or ZenMux keys set either → would default to nvidia
      const { detectProvider } = await import("../apiProvider.js");
      expect(detectProvider()).toBe("nvidia");
    });

    it("explicit API_PROVIDER=bridge takes priority over NVIDIA keys", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://example.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "secret-token";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      process.env.ZENMUX_API_KEY = "sk-test";
      const { detectProvider } = await import("../apiProvider.js");
      expect(detectProvider()).toBe("bridge");
    });
  });

  describe("getProviderConfig — bridge", () => {
    it("returns bridge config with BRIDGE_URL as baseUrl", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://my-tunnel.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc123";
      const { getProviderConfig } = await import("../apiProvider.js");
      const cfg = getProviderConfig();
      expect(cfg.name).toBe("bridge");
      expect(cfg.baseUrl).toBe("https://my-tunnel.trycloudflare.com");
      expect(cfg.apiKey).toBe("abc123");
    });

    it("trims BRIDGE_URL whitespace", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "  https://my-tunnel.trycloudflare.com  ";
      process.env.BRIDGE_TOKEN = "abc123";
      const { getProviderConfig } = await import("../apiProvider.js");
      const cfg = getProviderConfig();
      expect(cfg.baseUrl).toBe("https://my-tunnel.trycloudflare.com");
    });

    it("trims BRIDGE_TOKEN whitespace", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://my-tunnel.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "  abc123  ";
      const { getProviderConfig } = await import("../apiProvider.js");
      const cfg = getProviderConfig();
      expect(cfg.apiKey).toBe("abc123");
    });

    it("bridge does NOT send thinking mode", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().sendThinkingMode).toBe(false);
    });

    it("bridge reasoning field is 'reasoning'", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().reasoningField).toBe("reasoning");
    });

    it("bridge does NOT need heartbeat", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().needsHeartbeat).toBe(false);
    });

    it("bridge does NOT need hedging", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().needsHedging).toBe(false);
    });

    it("bridge does NOT use multi-key pool", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().needsMultiKeyPool).toBe(false);
    });

    it("bridge max sub-agents is 1 (sequential)", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().maxConcurrentSubAgents).toBe(1);
    });
  });

  describe("getProviderConfig — bridge validation (§17.11)", () => {
    it("exits with code 1 when BRIDGE_URL is missing", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_TOKEN = "abc";
      const { getProviderConfig } = await import("../apiProvider.js");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
        throw new Error(`exit:${code}`);
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => getProviderConfig()).toThrow("exit:1");
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("BRIDGE_URL"));
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it("exits with code 1 when BRIDGE_URL is empty string", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "   ";
      process.env.BRIDGE_TOKEN = "abc";
      const { getProviderConfig } = await import("../apiProvider.js");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
        throw new Error(`exit:${code}`);
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => getProviderConfig()).toThrow("exit:1");
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it("exits with code 1 when BRIDGE_URL is HTTP (not HTTPS) — §17.11 rule 81", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "http://my-tunnel.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
      const { getProviderConfig } = await import("../apiProvider.js");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
        throw new Error(`exit:${code}`);
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => getProviderConfig()).toThrow("exit:1");
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("HTTPS"));
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it("accepts HTTPS BRIDGE_URL — §17.11 rule 81", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://my-tunnel.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
      const { getProviderConfig } = await import("../apiProvider.js");
      const cfg = getProviderConfig();
      expect(cfg.baseUrl).toBe("https://my-tunnel.trycloudflare.com");
    });

    it("exits with code 1 when BRIDGE_TOKEN is missing — §17.11 rule 82", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      const { getProviderConfig } = await import("../apiProvider.js");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
        throw new Error(`exit:${code}`);
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => getProviderConfig()).toThrow("exit:1");
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("BRIDGE_TOKEN"));
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it("exits with code 1 when BRIDGE_TOKEN is whitespace-only — §17.11 rule 82", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "   ";
      const { getProviderConfig } = await import("../apiProvider.js");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
        throw new Error(`exit:${code}`);
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => getProviderConfig()).toThrow("exit:1");
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });
  });

  describe("provider helper functions — bridge", () => {
    beforeEach(() => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
    });

    it("providerNeedsHeartbeat() returns false for bridge", async () => {
      const { providerNeedsHeartbeat } = await import("../apiProvider.js");
      expect(providerNeedsHeartbeat()).toBe(false);
    });

    it("providerNeedsHedging() returns false for bridge", async () => {
      const { providerNeedsHedging } = await import("../apiProvider.js");
      expect(providerNeedsHedging()).toBe(false);
    });

    it("getProviderMaxSubAgents() returns 1 for bridge", async () => {
      const { getProviderMaxSubAgents } = await import("../apiProvider.js");
      expect(getProviderMaxSubAgents()).toBe(1);
    });

    it("getProviderReasoningField() returns 'reasoning' for bridge", async () => {
      const { getProviderReasoningField } = await import("../apiProvider.js");
      expect(getProviderReasoningField()).toBe("reasoning");
    });

    it("providerSendsThinkingMode() returns false for bridge", async () => {
      const { providerSendsThinkingMode } = await import("../apiProvider.js");
      expect(providerSendsThinkingMode()).toBe(false);
    });

    it("providerUsesMultiKeyPool() returns false for bridge", async () => {
      const { providerUsesMultiKeyPool } = await import("../apiProvider.js");
      expect(providerUsesMultiKeyPool()).toBe(false);
    });
  });

  describe("config.ts — bridge fields", () => {
    it("exposes bridgeUrl, bridgeToken, bridgeMaxRpm when provider=bridge", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "secret";
      vi.resetModules();
      const { config } = await import("../config.js");
      expect(config.apiProvider).toBe("bridge");
      expect(config.bridgeUrl).toBe("https://x.trycloudflare.com");
      expect(config.bridgeToken).toBe("secret");
      expect(config.bridgeMaxRpm).toBe(12); // default
    });

    it("bridgeUrl and bridgeToken are empty when provider != bridge", async () => {
      process.env.API_PROVIDER = "nvidia";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      vi.resetModules();
      const { config } = await import("../config.js");
      expect(config.apiProvider).toBe("nvidia");
      expect(config.bridgeUrl).toBe("");
      expect(config.bridgeToken).toBe("");
    });

    it("bridgeMaxRpm uses BRIDGE_MAX_RPM env var when set", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "secret";
      process.env.BRIDGE_MAX_RPM = "30";
      vi.resetModules();
      const { config } = await import("../config.js");
      expect(config.bridgeMaxRpm).toBe(30);
    });

    it("bridgeMaxRpm falls back to 12 when BRIDGE_MAX_RPM is non-numeric — §17.11 rule 83 (NaN guard)", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "secret";
      process.env.BRIDGE_MAX_RPM = "not-a-number";
      vi.resetModules();
      const { config } = await import("../config.js");
      expect(config.bridgeMaxRpm).toBe(12);
    });

    it("bridgeMaxRpm is at least 1 (NaN guard, §17.11 rule 83)", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "secret";
      process.env.BRIDGE_MAX_RPM = "0";
      vi.resetModules();
      const { config } = await import("../config.js");
      expect(config.bridgeMaxRpm).toBe(1); // Math.max(1, ...)
    });

    it("bridgeMaxRpm is at least 1 when negative — §17.11 rule 83", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "secret";
      process.env.BRIDGE_MAX_RPM = "-5";
      vi.resetModules();
      const { config } = await import("../config.js");
      expect(config.bridgeMaxRpm).toBe(1);
    });
  });
});
