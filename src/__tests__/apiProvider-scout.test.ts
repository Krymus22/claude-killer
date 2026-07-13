/**
 * apiProvider-scout.test.ts — tests for the scout provider (multi-provider support).
 *
 * Tests cover:
 *   - detectScoutProvider() returns the right provider based on SCOUT_PROVIDER env var
 *   - When SCOUT_PROVIDER is unset, scout uses the same provider as the main agent
 *   - When SCOUT_PROVIDER is set to a different provider, scout uses that provider
 *   - getScoutProviderConfig() returns the correct config for each provider
 *   - Invalid SCOUT_PROVIDER values cause exit(1)
 *   - Scout provider helpers (heartbeat, thinking, multi-key, reasoning field)
 *     return values for the SCOUT provider, not the main provider
 *   - §17.11 rules 102-106 compliance
 *
 * Key scenarios:
 *   - Main=bridge + Scout=nvidia → scout uses NVIDIA (fast local API)
 *   - Main=nvidia + Scout=bridge → scout uses bridge (remote LLM)
 *   - Main=bridge + Scout=unset → scout uses bridge (same as main)
 *   - Main=nvidia + Scout=nvidia → scout uses nvidia (same as main, no separate client)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

const origEnv = { ...process.env };

beforeEach(() => {
  delete process.env.API_PROVIDER;
  delete process.env.SCOUT_PROVIDER;
  delete process.env.BRIDGE_URL;
  delete process.env.BRIDGE_TOKEN;
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

describe("apiProvider — scout provider (multi-provider support)", () => {
  describe("detectScoutProvider", () => {
    it("returns the main provider when SCOUT_PROVIDER is unset (default)", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { detectScoutProvider } = await import("../apiProvider.js");
      expect(detectScoutProvider()).toBe("nvidia");
    });

    it("returns 'nvidia' when SCOUT_PROVIDER=nvidia", async () => {
      process.env.SCOUT_PROVIDER = "nvidia";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { detectScoutProvider } = await import("../apiProvider.js");
      expect(detectScoutProvider()).toBe("nvidia");
    });

    it("returns 'bridge' when SCOUT_PROVIDER=bridge", async () => {
      process.env.SCOUT_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
      const { detectScoutProvider } = await import("../apiProvider.js");
      expect(detectScoutProvider()).toBe("bridge");
    });

    it("returns 'zenmux' when SCOUT_PROVIDER=zenmux", async () => {
      process.env.SCOUT_PROVIDER = "zenmux";
      process.env.ZENMUX_API_KEY = "sk-test";
      const { detectScoutProvider } = await import("../apiProvider.js");
      expect(detectScoutProvider()).toBe("zenmux");
    });

    it("handles whitespace and case (SCOUT_PROVIDER='  NVIDIA  ')", async () => {
      process.env.SCOUT_PROVIDER = "  NVIDIA  ";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { detectScoutProvider } = await import("../apiProvider.js");
      expect(detectScoutProvider()).toBe("nvidia");
    });

    it("exits with code 1 on invalid SCOUT_PROVIDER — §17.11 rule 103", async () => {
      process.env.SCOUT_PROVIDER = "aws";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { detectScoutProvider } = await import("../apiProvider.js");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
        throw new Error(`exit:${code}`);
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => detectScoutProvider()).toThrow("exit:1");
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("not a valid provider"));
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it("exits with code 1 on typo SCOUT_PROVIDER='bridg' — §17.11 rule 103", async () => {
      process.env.SCOUT_PROVIDER = "bridg";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { detectScoutProvider } = await import("../apiProvider.js");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
        throw new Error(`exit:${code}`);
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => detectScoutProvider()).toThrow("exit:1");
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });
  });

  describe("getScoutProviderConfig", () => {
    it("returns the same config as main when SCOUT_PROVIDER is unset", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "shared-token";
      const { getProviderConfig, getScoutProviderConfig } = await import("../apiProvider.js");
      const mainCfg = getProviderConfig();
      const scoutCfg = getScoutProviderConfig();
      expect(scoutCfg.name).toBe(mainCfg.name);
      expect(scoutCfg.baseUrl).toBe(mainCfg.baseUrl);
      expect(scoutCfg.apiKey).toBe(mainCfg.apiKey);
    });

    it("returns NVIDIA config when main=bridge + SCOUT_PROVIDER=nvidia", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "bridge-token";
      process.env.SCOUT_PROVIDER = "nvidia";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { getScoutProviderConfig } = await import("../apiProvider.js");
      const cfg = getScoutProviderConfig();
      expect(cfg.name).toBe("nvidia");
      expect(cfg.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
      expect(cfg.apiKey).toBe("nvapi-test");
      expect(cfg.sendThinkingMode).toBe(true);
      expect(cfg.needsHeartbeat).toBe(true);
    });

    it("returns Bridge config when main=nvidia + SCOUT_PROVIDER=bridge", async () => {
      process.env.API_PROVIDER = "nvidia";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      process.env.SCOUT_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "bridge-token";
      const { getScoutProviderConfig } = await import("../apiProvider.js");
      const cfg = getScoutProviderConfig();
      expect(cfg.name).toBe("bridge");
      expect(cfg.baseUrl).toBe("https://x.trycloudflare.com");
      expect(cfg.apiKey).toBe("bridge-token");
      expect(cfg.sendThinkingMode).toBe(false);
      expect(cfg.needsHeartbeat).toBe(false);
    });

    it("returns ZenMux config when main=nvidia + SCOUT_PROVIDER=zenmux", async () => {
      process.env.API_PROVIDER = "nvidia";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      process.env.SCOUT_PROVIDER = "zenmux";
      process.env.ZENMUX_API_KEY = "sk-zenmux-test";
      const { getScoutProviderConfig } = await import("../apiProvider.js");
      const cfg = getScoutProviderConfig();
      expect(cfg.name).toBe("zenmux");
      expect(cfg.baseUrl).toBe("https://zenmux.ai/api/v1");
      expect(cfg.apiKey).toBe("sk-zenmux-test");
    });

    it("uses NVIDIA_API_KEYS (multi-key) when SCOUT_PROVIDER=nvidia", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "bridge-token";
      process.env.SCOUT_PROVIDER = "nvidia";
      process.env.NVIDIA_API_KEYS = "nvapi-k1,nvapi-k2";
      const { getScoutProviderConfig } = await import("../apiProvider.js");
      const cfg = getScoutProviderConfig();
      expect(cfg.apiKey).toBe("nvapi-k1"); // picks first key
    });

    it("exits with code 1 when SCOUT_PROVIDER=nvidia but no NVIDIA key — §17.11 rule 104", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "bridge-token";
      process.env.SCOUT_PROVIDER = "nvidia";
      // No NVIDIA_API_KEY set
      const { getScoutProviderConfig } = await import("../apiProvider.js");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
        throw new Error(`exit:${code}`);
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => getScoutProviderConfig()).toThrow("exit:1");
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("SCOUT_PROVIDER=nvidia"));
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it("exits with code 1 when SCOUT_PROVIDER=bridge but BRIDGE_URL missing", async () => {
      process.env.API_PROVIDER = "nvidia";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      process.env.SCOUT_PROVIDER = "bridge";
      process.env.BRIDGE_TOKEN = "abc";
      // No BRIDGE_URL
      const { getScoutProviderConfig } = await import("../apiProvider.js");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
        throw new Error(`exit:${code}`);
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => getScoutProviderConfig()).toThrow("exit:1");
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });

    it("exits with code 1 when SCOUT_PROVIDER=bridge but BRIDGE_URL is HTTP (not HTTPS)", async () => {
      process.env.API_PROVIDER = "nvidia";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      process.env.SCOUT_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "http://x.trycloudflare.com"; // HTTP, not HTTPS
      process.env.BRIDGE_TOKEN = "abc";
      const { getScoutProviderConfig } = await import("../apiProvider.js");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
        throw new Error(`exit:${code}`);
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => getScoutProviderConfig()).toThrow("exit:1");
      exitSpy.mockRestore();
      errSpy.mockRestore();
    });
  });

  describe("scout provider helpers — §17.11 rule 105", () => {
    it("scoutProviderNeedsHeartbeat() returns true for nvidia, false for bridge", async () => {
      // Test with main=bridge, scout=nvidia
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
      process.env.SCOUT_PROVIDER = "nvidia";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { scoutProviderNeedsHeartbeat, providerNeedsHeartbeat } = await import("../apiProvider.js");
      // Main (bridge) doesn't need heartbeat
      expect(providerNeedsHeartbeat()).toBe(false);
      // Scout (nvidia) DOES need heartbeat — independent of main
      expect(scoutProviderNeedsHeartbeat()).toBe(true);
    });

    it("scoutProviderSendsThinkingMode() returns true for nvidia, false for bridge", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
      process.env.SCOUT_PROVIDER = "nvidia";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { scoutProviderSendsThinkingMode, providerSendsThinkingMode } = await import("../apiProvider.js");
      expect(providerSendsThinkingMode()).toBe(false); // main=bridge
      expect(scoutProviderSendsThinkingMode()).toBe(true); // scout=nvidia
    });

    it("scoutProviderUsesMultiKeyPool() returns true for nvidia, false for bridge", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
      process.env.SCOUT_PROVIDER = "nvidia";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { scoutProviderUsesMultiKeyPool, providerUsesMultiKeyPool } = await import("../apiProvider.js");
      expect(providerUsesMultiKeyPool()).toBe(false); // main=bridge
      expect(scoutProviderUsesMultiKeyPool()).toBe(true); // scout=nvidia
    });

    it("getScoutProviderReasoningField() returns 'reasoning_content' for nvidia", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
      process.env.SCOUT_PROVIDER = "nvidia";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { getScoutProviderReasoningField, getProviderReasoningField } = await import("../apiProvider.js");
      expect(getProviderReasoningField()).toBe("reasoning"); // main=bridge
      expect(getScoutProviderReasoningField()).toBe("reasoning_content"); // scout=nvidia
    });

    it("helpers return same value as main when SCOUT_PROVIDER is unset", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      // SCOUT_PROVIDER unset — defaults to main (nvidia)
      const { scoutProviderNeedsHeartbeat, providerNeedsHeartbeat } = await import("../apiProvider.js");
      expect(scoutProviderNeedsHeartbeat()).toBe(providerNeedsHeartbeat());
    });
  });
});

describe("apiClient — scout client (multi-provider)", () => {
  describe("scoutUsesDifferentProvider", () => {
    it("returns false when SCOUT_PROVIDER is unset (same as main)", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      vi.resetModules();
      const { scoutUsesDifferentProvider } = await import("../apiClient.js");
      expect(scoutUsesDifferentProvider()).toBe(false);
    });

    it("returns false when SCOUT_PROVIDER matches main provider", async () => {
      process.env.API_PROVIDER = "nvidia";
      process.env.SCOUT_PROVIDER = "nvidia";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      vi.resetModules();
      const { scoutUsesDifferentProvider } = await import("../apiClient.js");
      expect(scoutUsesDifferentProvider()).toBe(false);
    });

    it("returns true when main=bridge + SCOUT_PROVIDER=nvidia", async () => {
      process.env.API_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
      process.env.SCOUT_PROVIDER = "nvidia";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      vi.resetModules();
      const { scoutUsesDifferentProvider } = await import("../apiClient.js");
      expect(scoutUsesDifferentProvider()).toBe(true);
    });

    it("returns true when main=nvidia + SCOUT_PROVIDER=bridge", async () => {
      process.env.API_PROVIDER = "nvidia";
      process.env.NVIDIA_API_KEY = "nvapi-test";
      process.env.SCOUT_PROVIDER = "bridge";
      process.env.BRIDGE_URL = "https://x.trycloudflare.com";
      process.env.BRIDGE_TOKEN = "abc";
      vi.resetModules();
      const { scoutUsesDifferentProvider } = await import("../apiClient.js");
      expect(scoutUsesDifferentProvider()).toBe(true);
    });
  });
});
