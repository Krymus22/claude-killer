/**
 * extensionCenter.test.ts — Tests for the Extension Hub core module.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock fs to avoid touching real filesystem
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false, size: 100 })),
  },
}));

// Mock logger
vi.mock("../logger.js", () => ({
  default: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import {
  getAllExtensions,
  getExtensionsByCategory,
  getEnabledExtensions,
  getExtensionsForTrigger,
  getExtension,
  syncExtensions,
  toggleExtension,
  setTriggerMode,
  cycleTriggerMode,
  enableAllInCategory,
  disableAll,
  executeTrigger,
  registerExecutor,
  getHubSummary,
  getTriggerLabel,
  getTriggerModes,
  getCategoryIcon,
  getCategoryColor,
  type ExtensionEntry,
  type TriggerMode,
} from "../extensionCenter.js";

function makeExt(overrides: Partial<ExtensionEntry> = {}): Omit<ExtensionEntry, "enabled" | "triggerMode"> {
  return {
    id: overrides.id ?? "test:ext1",
    name: overrides.name ?? "Test Extension",
    category: overrides.category ?? "skill",
    description: overrides.description ?? "A test extension",
    installed: overrides.installed ?? true,
    ...overrides,
  } as Omit<ExtensionEntry, "enabled" | "triggerMode">;
}

describe("extensionCenter", () => {
  beforeEach(() => {
    // Reset state by syncing empty list
    syncExtensions([]);
  });

  describe("syncExtensions", () => {
    it("should register new extensions as disabled by default if not installed", () => {
      syncExtensions([makeExt({ id: "test:1", installed: false })]);
      const ext = getExtension("test:1");
      expect(ext).toBeDefined();
      expect(ext!.enabled).toBe(false);
      expect(ext!.triggerMode).toBe("disabled");
    });

    it("should register new extensions as enabled if installed", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      const ext = getExtension("test:1");
      expect(ext).toBeDefined();
      expect(ext!.enabled).toBe(true);
      expect(ext!.triggerMode).toBe("disabled");
    });

    it("should preserve existing state on re-sync", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      toggleExtension("test:1"); // disable it
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      const ext = getExtension("test:1");
      expect(ext!.enabled).toBe(false); // preserved
    });
  });

  describe("toggleExtension", () => {
    it("should toggle enabled state", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      expect(toggleExtension("test:1")).toBe(false);
      expect(toggleExtension("test:1")).toBe(true);
    });

    it("should return null for non-existent extension", () => {
      expect(toggleExtension("nonexistent")).toBeNull();
    });

    it("should reset trigger mode when disabling", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      setTriggerMode("test:1", "on_file");
      toggleExtension("test:1"); // disable
      const ext = getExtension("test:1");
      expect(ext!.triggerMode).toBe("disabled");
    });
  });

  describe("setTriggerMode", () => {
    it("should set trigger mode and enable extension", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      setTriggerMode("test:1", "on_task");
      const ext = getExtension("test:1");
      expect(ext!.triggerMode).toBe("on_task");
      expect(ext!.enabled).toBe(true);
    });

    it("should disable extension when setting to disabled", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      setTriggerMode("test:1", "disabled");
      const ext = getExtension("test:1");
      expect(ext!.enabled).toBe(false);
    });

    it("should return null for non-existent extension", () => {
      expect(setTriggerMode("nonexistent", "always")).toBeNull();
    });
  });

  describe("cycleTriggerMode", () => {
    it("should cycle through all modes", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      const modes = getTriggerModes();
      let mode = cycleTriggerMode("test:1");
      expect(mode).toBe(modes[1]); // on_file

      mode = cycleTriggerMode("test:1");
      expect(mode).toBe(modes[2]); // on_task

      mode = cycleTriggerMode("test:1");
      expect(mode).toBe(modes[3]); // always

      mode = cycleTriggerMode("test:1");
      expect(mode).toBe(modes[0]); // disabled
    });

    it("should return null for non-existent extension", () => {
      expect(cycleTriggerMode("nonexistent")).toBeNull();
    });
  });

  describe("getExtensionsByCategory", () => {
    it("should filter by category", () => {
      syncExtensions([
        makeExt({ id: "skill:1", category: "skill" }),
        makeExt({ id: "tool:1", category: "tool" }),
        makeExt({ id: "skill:2", category: "skill" }),
      ]);
      const skills = getExtensionsByCategory("skill");
      expect(skills).toHaveLength(2);
    });
  });

  describe("getEnabledExtensions", () => {
    it("should return only enabled extensions with non-disabled trigger", () => {
      syncExtensions([
        makeExt({ id: "test:1", installed: true }),
        makeExt({ id: "test:2", installed: true }),
      ]);
      setTriggerMode("test:1", "disabled"); // disable
      setTriggerMode("test:2", "on_task"); // enable with trigger
      const enabled = getEnabledExtensions();
      expect(enabled).toHaveLength(1);
      expect(enabled[0]!.id).toBe("test:2");
    });
  });

  describe("getExtensionsForTrigger", () => {
    it("should return extensions matching trigger mode", () => {
      syncExtensions([
        makeExt({ id: "test:1", installed: true }),
        makeExt({ id: "test:2", installed: true }),
        makeExt({ id: "test:3", installed: true }),
      ]);
      setTriggerMode("test:1", "on_file");
      setTriggerMode("test:2", "on_task");
      setTriggerMode("test:3", "on_file");

      const onFile = getExtensionsForTrigger("on_file");
      expect(onFile).toHaveLength(2);
    });
  });

  describe("enableAllInCategory", () => {
    it("should enable all installed extensions in category", () => {
      syncExtensions([
        makeExt({ id: "skill:1", category: "skill", installed: true }),
        makeExt({ id: "skill:2", category: "skill", installed: true }),
        makeExt({ id: "tool:1", category: "tool", installed: true }),
      ]);
      const count = enableAllInCategory("skill", "always");
      expect(count).toBe(2);
      const skills = getExtensionsByCategory("skill");
      expect(skills.every((s) => s.triggerMode === "always")).toBe(true);
    });
  });

  describe("disableAll", () => {
    it("should disable all extensions", () => {
      syncExtensions([
        makeExt({ id: "test:1", installed: true }),
        makeExt({ id: "test:2", installed: true }),
      ]);
      setTriggerMode("test:1", "always");
      setTriggerMode("test:2", "on_task");
      disableAll();
      expect(getEnabledExtensions()).toHaveLength(0);
    });
  });

  describe("executeTrigger", () => {
    it("should call executor for matching extensions", async () => {
      syncExtensions([
        makeExt({ id: "test:1", installed: true }),
        makeExt({ id: "test:2", installed: true }),
      ]);
      setTriggerMode("test:1", "on_task");
      setTriggerMode("test:2", "on_file");

      const executor = vi.fn().mockResolvedValue("output");
      registerExecutor(executor);

      const results = await executeTrigger("on_task", { cwd: "/tmp" });
      expect(results).toHaveLength(1);
      expect(results[0]!.extensionId).toBe("test:1");
      expect(executor).toHaveBeenCalledTimes(1);
    });

    it("should handle executor errors gracefully", async () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      setTriggerMode("test:1", "always");

      registerExecutor(async () => {
        throw new Error("test error");
      });

      const results = await executeTrigger("always", { cwd: "/tmp" });
      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(false);
    });

    it("should return empty if no executor registered", async () => {
      registerExecutor(null as never);
      const results = await executeTrigger("always", { cwd: "/tmp" });
      expect(results).toHaveLength(0);
    });
  });

  describe("getHubSummary", () => {
    it("should return correct counts", () => {
      syncExtensions([
        makeExt({ id: "skill:1", category: "skill", installed: true }),
        makeExt({ id: "tool:1", category: "tool", installed: true }),
      ]);
      setTriggerMode("skill:1", "on_file");
      toggleExtension("tool:1"); // disable

      const summary = getHubSummary();
      expect(summary.total).toBe(2);
      expect(summary.enabled).toBe(1);
      expect(summary.byCategory.skill.enabled).toBe(1);
      expect(summary.byCategory.tool.enabled).toBe(0);
      expect(summary.byTrigger.on_file).toBe(1);
    });
  });

  describe("UI helpers", () => {
    it("getTriggerLabel returns correct labels", () => {
      expect(getTriggerLabel("disabled")).toBe("OFF");
      expect(getTriggerLabel("on_file")).toBe("FILE");
      expect(getTriggerLabel("on_task")).toBe("TASK");
      expect(getTriggerLabel("always")).toBe("EVERY");
    });

    it("getCategoryIcon returns emoji for each category", () => {
      expect(getCategoryIcon("skill")).toBeTruthy();
      expect(getCategoryIcon("tool")).toBeTruthy();
      expect(getCategoryIcon("mcp")).toBeTruthy();
      expect(getCategoryIcon("plugin")).toBeTruthy();
    });

    it("getCategoryColor returns hex color for each category", () => {
      expect(getCategoryColor("skill")).toMatch(/^#/);
      expect(getCategoryColor("tool")).toMatch(/^#/);
    });
  });
});
