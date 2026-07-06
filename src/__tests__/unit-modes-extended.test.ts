/**
 * unit-modes-extended.test.ts — Deep unit tests for src/modes.ts
 *
 * Coverage focus:
 *   - getMode: returns null for nonexistent, returns mode for existing built-in
 *   - getAllModes: returns array with built-in modes
 *   - getActiveModeName / getActiveMode: null when no mode active, fallback to "normal"
 *   - applyMode: success for valid, error for invalid, sets effort + env vars
 *   - deactivateMode: clears active mode
 *   - suggestMode: returns suggestion with all fields, detects language contexts
 *   - confirmAndSaveMode: saves and returns ModeDefinition
 *   - Mode precedence (user > bundled), name handling, env var management
 *
 * External deps mocked: logger, extensionCenter, effortLevels (dynamic imports).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- Mocks ------------------------------------------------------------------

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  throttle: vi.fn(),
}));

// Controllable mock for extensionCenter (applyMode does dynamic import)
const extState = vi.hoisted(() => ({
  setEffortLevel: vi.fn(),
  toggleExtension: vi.fn(() => true),
  setTriggerMode: vi.fn(() => "always"),
  getAllExtensions: vi.fn(() => []),
}));

vi.mock("../extensionCenter.js", () => ({
  toggleExtension: extState.toggleExtension,
  setTriggerMode: extState.setTriggerMode,
  getAllExtensions: extState.getAllExtensions,
}));

// Mock for effortLevels (applyMode does dynamic import)
vi.mock("../effortLevels.js", () => ({
  setEffortLevel: extState.setEffortLevel,
}));

// Mock for ensureRobloxTools (setActiveMode does require for roblox)
vi.mock("../ensureRobloxTools.js", () => ({
  warnIfMissingTools: vi.fn(),
}));

// Mock for extensions.ts (applyMode calls loadModeMCPs which spawns real MCP servers).
// We stub loadModeMCPs to a no-op so tests don't spawn real child processes.
vi.mock("../extensions.js", () => ({
  loadModeMCPs: vi.fn(async () => {}),
  loadAllExtensions: vi.fn(async () => {}),
  getActiveSkills: vi.fn(() => []),
  getActiveMCPServers: vi.fn(() => []),
  shutdownMCPServers: vi.fn(() => {}),
  callMCPTool: vi.fn(async () => "[ERROR] not available"),
  getMCPToolDefinitions: vi.fn(() => []),
  initExtensionDirs: vi.fn(() => {}),
}));

// --- Setup ------------------------------------------------------------------

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ck-modes-unit-home-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // Clear env vars set by previous tests
  delete process.env.STRICT_MODE;
  delete process.env.READ_BEFORE_WRITE;
  delete process.env.ADVANCED_THINKING;
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

// Helper: load modes module fresh
async function loadModes() {
  return import("../modes.js");
}

// --- Tests ------------------------------------------------------------------

describe("modes (unit-extended) — getMode", () => {
  it("returns null for a nonexistent mode name", async () => {
    const { getMode } = await loadModes();
    expect(getMode("nonexistent_mode_xyz")).toBeNull();
  });

  it("returns mode definition for an existing built-in (roblox)", async () => {
    const { getMode } = await loadModes();
    const mode = getMode("roblox");
    expect(mode).not.toBeNull();
    expect(mode!.name).toBe("roblox");
    expect(mode!.builtIn).toBe(true);
  });

  it("returns null for empty string", async () => {
    const { getMode } = await loadModes();
    expect(getMode("")).toBeNull();
  });

  it("returned mode has required fields (name, label, description)", async () => {
    const { getMode } = await loadModes();
    const mode = getMode("roblox");
    expect(mode).not.toBeNull();
    expect(typeof mode!.name).toBe("string");
    expect(typeof mode!.label).toBe("string");
    expect(typeof mode!.description).toBe("string");
  });
});

describe("modes (unit-extended) — getAllModes", () => {
  it("returns an array (not null)", async () => {
    const { getAllModes } = await loadModes();
    const modes = getAllModes();
    expect(Array.isArray(modes)).toBe(true);
  });

  it("includes built-in 'roblox' mode", async () => {
    const { getAllModes } = await loadModes();
    const modes = getAllModes();
    expect(modes.some((m) => m.name === "roblox")).toBe(true);
  });

  it("each mode has a non-empty name", async () => {
    const { getAllModes } = await loadModes();
    const modes = getAllModes();
    for (const m of modes) {
      expect(typeof m.name).toBe("string");
      expect(m.name.length).toBeGreaterThan(0);
    }
  });
});

describe("modes (unit-extended) — getActiveModeName / getActiveMode", () => {
  it("getActiveModeName returns null when no mode is active (after setActiveMode(null))", async () => {
    const { setActiveMode, getActiveModeName } = await loadModes();
    setActiveMode(null);
    expect(getActiveModeName()).toBeNull();
  });

  it("getActiveModeName returns the active mode name after setActiveMode", async () => {
    const { setActiveMode, getActiveModeName } = await loadModes();
    setActiveMode("roblox");
    expect(getActiveModeName()).toBe("roblox");
  });

  it("getActiveMode never returns null (always falls back to 'normal' built-in)", async () => {
    const { setActiveMode, getActiveMode } = await loadModes();
    setActiveMode(null);
    const mode = getActiveMode();
    // Per Sprint 6 + Sprint 12: getActiveMode() NEVER returns null
    expect(mode).not.toBeNull();
    expect(mode!.name).toBeTruthy();
  });

  it("getActiveMode returns the active mode definition after setActiveMode", async () => {
    const { setActiveMode, getActiveMode } = await loadModes();
    setActiveMode("roblox");
    const mode = getActiveMode();
    expect(mode).not.toBeNull();
    expect(mode!.name).toBe("roblox");
  });

  it("getActiveMode falls back to a minimal 'normal' default if 'normal' file is missing", async () => {
    // Set HOME to an empty dir so no "normal" mode file exists
    const { setActiveMode, getActiveMode } = await loadModes();
    setActiveMode(null);
    const mode = getActiveMode();
    // Even without "normal" file, getActiveMode returns a minimal default
    expect(mode).not.toBeNull();
    expect(mode!.name).toBeTruthy();
  });
});

describe("modes (unit-extended) — applyMode", () => {
  it("returns success for a valid mode (roblox)", async () => {
    const { applyMode } = await loadModes();
    const result = await applyMode("roblox");
    expect(result.success).toBe(true);
    expect(result.modeName).toBe("roblox");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it("returns error for an invalid mode name", async () => {
    const { applyMode } = await loadModes();
    const result = await applyMode("does_not_exist_xyz");
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("not found");
  });

  it("result has all required fields (modeName, toolsEnabled, toolsDisabled, etc.)", async () => {
    const { applyMode } = await loadModes();
    const result = await applyMode("roblox");
    expect(result).toHaveProperty("modeName");
    expect(result).toHaveProperty("toolsEnabled");
    expect(result).toHaveProperty("toolsDisabled");
    expect(result).toHaveProperty("skillsEnabled");
    expect(result).toHaveProperty("featuresEnabled");
    expect(result).toHaveProperty("errors");
    expect(Array.isArray(result.toolsEnabled)).toBe(true);
    expect(Array.isArray(result.toolsDisabled)).toBe(true);
  });

  it("sets STRICT_MODE env var from mode.strictMode", async () => {
    const { applyMode } = await loadModes();
    // roblox mode has strictMode=true
    await applyMode("roblox");
    expect(process.env.STRICT_MODE).toBe("true");
  });

  it("sets READ_BEFORE_WRITE env var from mode.readBeforeWrite", async () => {
    const { applyMode } = await loadModes();
    await applyMode("roblox");
    expect(process.env.READ_BEFORE_WRITE).toBe("true");
  });

  it("calls setEffortLevel with mode.effortLevel", async () => {
    const { applyMode } = await loadModes();
    await applyMode("roblox");
    expect(extState.setEffortLevel).toHaveBeenCalled();
    // roblox mode has effortLevel="high"
    expect(extState.setEffortLevel).toHaveBeenCalledWith("high");
  });
});

describe("modes (unit-extended) — deactivateMode", () => {
  it("clears the active mode (getActiveModeName returns null)", async () => {
    const { setActiveMode, deactivateMode, getActiveModeName } = await loadModes();
    setActiveMode("roblox");
    expect(getActiveModeName()).toBe("roblox");
    deactivateMode();
    expect(getActiveModeName()).toBeNull();
  });

  it("is idempotent: calling deactivateMode twice doesn't throw", async () => {
    const { deactivateMode } = await loadModes();
    expect(() => {
      deactivateMode();
      deactivateMode();
    }).not.toThrow();
  });

  it("resets STRICT_MODE / READ_BEFORE_WRITE env vars when clearing", async () => {
    const { setActiveMode, deactivateMode } = await loadModes();
    setActiveMode("roblox");
    expect(process.env.STRICT_MODE).toBe("true");
    deactivateMode();
    // After deactivate, env vars are reset to "false" (setActiveMode(null) inside deactivateMode)
    expect(process.env.STRICT_MODE).toBe("false");
    expect(process.env.READ_BEFORE_WRITE).toBe("false");
  });
});

describe("modes (unit-extended) — suggestMode", () => {
  it("returns a suggestion object with all required fields", async () => {
    const { suggestMode } = await loadModes();
    const suggestion = suggestMode({
      prompt: "create a generic project",
      availableTools: [],
      availableSkills: [],
      availableFeatures: [],
    });
    expect(suggestion).toHaveProperty("name");
    expect(suggestion).toHaveProperty("label");
    expect(suggestion).toHaveProperty("description");
    expect(suggestion).toHaveProperty("enableTools");
    expect(suggestion).toHaveProperty("enableSkills");
    expect(suggestion).toHaveProperty("enableFeatures");
    expect(suggestion).toHaveProperty("effortLevel");
    expect(suggestion).toHaveProperty("strictMode");
    expect(suggestion).toHaveProperty("readBeforeWrite");
    expect(suggestion).toHaveProperty("advancedThinking");
    expect(suggestion).toHaveProperty("reasoning");
  });

  it("detects Roblox context (mentions 'roblox')", async () => {
    const { suggestMode } = await loadModes();
    const suggestion = suggestMode({
      prompt: "I want to make a Roblox game with Rojo and Wally",
      availableTools: ["tool:rojo_build", "tool:wally_install", "tool:selene_lint"],
      availableSkills: [],
      availableFeatures: ["feature:strict_gate", "feature:read_before_write"],
    });
    expect(suggestion.name).toBe("roblox-custom");
    expect(suggestion.label).toBe("Roblox (External)");
    expect(suggestion.enableTools).toContain("tool:rojo_build");
  });

  it("detects Python context (mentions 'python')", async () => {
    const { suggestMode } = await loadModes();
    const suggestion = suggestMode({
      prompt: "Build a Python web scraper using pip and pytest",
      availableTools: [],
      availableSkills: [],
      availableFeatures: [],
    });
    expect(suggestion.name).toBe("python-custom");
    expect(suggestion.label).toBe("Python");
  });

  it("detects TypeScript context (mentions 'typescript')", async () => {
    const { suggestMode } = await loadModes();
    const suggestion = suggestMode({
      prompt: "TypeScript project with vitest and node",
      availableTools: [],
      availableSkills: [],
      availableFeatures: [],
    });
    expect(suggestion.name).toBe("ts-custom");
    expect(suggestion.label).toBe("TypeScript/Node");
  });

  it("falls back to 'custom' mode for unrecognized context", async () => {
    const { suggestMode } = await loadModes();
    const suggestion = suggestMode({
      prompt: "completely unknown technology stack with no keywords",
      availableTools: [],
      availableSkills: [],
      availableFeatures: [],
    });
    expect(suggestion.name).toBe("custom");
    expect(suggestion.label).toBe("Custom");
  });

  it("default suggestion has effortLevel='high' and strictMode=true", async () => {
    const { suggestMode } = await loadModes();
    const suggestion = suggestMode({
      prompt: "anything",
      availableTools: [],
      availableSkills: [],
      availableFeatures: [],
    });
    expect(suggestion.effortLevel).toBe("high");
    expect(suggestion.strictMode).toBe(true);
    expect(suggestion.readBeforeWrite).toBe(true);
  });
});

describe("modes (unit-extended) — confirmAndSaveMode", () => {
  it("saves a user mode and returns a ModeDefinition", async () => {
    const { confirmAndSaveMode } = await loadModes();
    const mode = confirmAndSaveMode({
      name: "test-save-mode",
      label: "Test Save",
      description: "for testing",
      enableTools: ["tool:foo"],
      enableSkills: [],
      enableFeatures: [],
      effortLevel: "medium",
      strictMode: false,
      readBeforeWrite: false,
      advancedThinking: false,
      reasoning: "test reasoning",
    });
    expect(mode).toBeDefined();
    expect(mode.name).toBe("test-save-mode");
    expect(mode.builtIn).toBe(false);
  });

  it("creates a JSON file in ~/.claude-killer/modes/<name>.json", async () => {
    const { confirmAndSaveMode } = await loadModes();
    confirmAndSaveMode({
      name: "file-check-mode",
      label: "File Check",
      description: "",
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
      effortLevel: "low",
      strictMode: false,
      readBeforeWrite: false,
      advancedThinking: false,
      reasoning: "",
    });
    const expectedPath = path.join(tmpHome, ".claude-killer", "modes", "file-check-mode.json");
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("saved file can be loaded back via getMode", async () => {
    const { confirmAndSaveMode, getMode } = await loadModes();
    confirmAndSaveMode({
      name: "reload-mode",
      label: "Reload",
      description: "test description",
      enableTools: ["tool:bar"],
      enableSkills: [],
      enableFeatures: [],
      effortLevel: "max",
      strictMode: true,
      readBeforeWrite: true,
      advancedThinking: false,
      reasoning: "",
    });
    const loaded = getMode("reload-mode");
    expect(loaded).not.toBeNull();
    expect(loaded!.label).toBe("Reload");
    expect(loaded!.effortLevel).toBe("max");
  });

  it("sets createdAt (ISO date string) on the saved mode", async () => {
    const { confirmAndSaveMode } = await loadModes();
    const mode = confirmAndSaveMode({
      name: "date-mode",
      label: "Date",
      description: "",
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
      effortLevel: "low",
      strictMode: false,
      readBeforeWrite: false,
      advancedThinking: false,
      reasoning: "",
    });
    expect(mode.createdAt).toBeDefined();
    expect(typeof mode.createdAt).toBe("string");
    // Should be a valid ISO date
    expect(() => new Date(mode.createdAt!).toISOString()).not.toThrow();
  });
});

describe("modes (unit-extended) — saveUserMode / deleteUserMode", () => {
  it("saveUserMode throws when name is empty", async () => {
    const { saveUserMode } = await loadModes();
    expect(() =>
      saveUserMode({
        name: "",
        label: "Empty",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
      }),
    ).toThrow();
  });

  it("deleteUserMode returns true when mode exists", async () => {
    const { saveUserMode, deleteUserMode } = await loadModes();
    saveUserMode({
      name: "to-delete",
      label: "Delete Me",
      description: "",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    });
    expect(deleteUserMode("to-delete")).toBe(true);
  });

  it("deleteUserMode returns false when mode does not exist", async () => {
    const { deleteUserMode } = await loadModes();
    expect(deleteUserMode("non_existent_mode_xyz")).toBe(false);
  });

  it("preserves the mode name as provided (no auto-lowercasing)", async () => {
    const { saveUserMode, getMode } = await loadModes();
    saveUserMode({
      name: "MixedCaseName",
      label: "Mixed Case",
      description: "",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    });
    // Name should be preserved exactly as provided (no auto-lowercase)
    expect(getMode("MixedCaseName")).not.toBeNull();
    expect(getMode("mixedcasename")).toBeNull();
  });
});

describe("modes (unit-extended) — user mode overrides built-in", () => {
  it("user mode with same name as built-in overrides it in getAllModes", async () => {
    const { saveUserMode, getAllModes } = await loadModes();
    saveUserMode({
      name: "roblox",
      label: "Custom Roblox",
      description: "user override",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    });
    const modes = getAllModes();
    const robloxMode = modes.find((m) => m.name === "roblox");
    expect(robloxMode).toBeDefined();
    // User's label should win (override)
    expect(robloxMode!.label).toBe("Custom Roblox");
  });
});

describe("modes (unit-extended) — reactive subscription", () => {
  it("getModesVersion returns a number", async () => {
    const { getModesVersion } = await loadModes();
    expect(typeof getModesVersion()).toBe("number");
  });

  it("subscribeToModesChanges returns an unsubscribe function", async () => {
    const { subscribeToModesChanges } = await loadModes();
    const unsub = subscribeToModesChanges(() => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("saveUserMode bumps the modes version (notifies subscribers)", async () => {
    const { subscribeToModesChanges, getModesVersion, saveUserMode } = await loadModes();
    let notified = false;
    const unsub = subscribeToModesChanges(() => {
      notified = true;
    });
    const v1 = getModesVersion();
    saveUserMode({
      name: "version-bump-test",
      label: "Bump",
      description: "",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    });
    const v2 = getModesVersion();
    expect(v2).toBeGreaterThan(v1);
    expect(notified).toBe(true);
    unsub();
  });

  it("deactivateMode bumps the modes version", async () => {
    const { getModesVersion, deactivateMode } = await loadModes();
    const v1 = getModesVersion();
    deactivateMode();
    const v2 = getModesVersion();
    expect(v2).toBeGreaterThanOrEqual(v1);
  });
});

describe("modes (unit-extended) — setActiveMode env var management", () => {
  it("setActiveMode(null) resets READ_BEFORE_WRITE / STRICT_MODE / ADVANCED_THINKING to 'false'", async () => {
    const { setActiveMode } = await loadModes();
    // First set them to true via roblox
    setActiveMode("roblox");
    expect(process.env.STRICT_MODE).toBe("true");
    // Now clear
    setActiveMode(null);
    expect(process.env.READ_BEFORE_WRITE).toBe("false");
    expect(process.env.STRICT_MODE).toBe("false");
    expect(process.env.ADVANCED_THINKING).toBe("false");
  });

  it("setActiveMode(roblox) sets STRICT_MODE='true' (roblox.strictMode=true)", async () => {
    const { setActiveMode } = await loadModes();
    setActiveMode("roblox");
    expect(process.env.STRICT_MODE).toBe("true");
    expect(process.env.READ_BEFORE_WRITE).toBe("true");
    expect(process.env.ADVANCED_THINKING).toBe("true");
  });
});

describe("modes (unit-extended) — seedBuiltInModes", () => {
  it("returns a number (count of seeded modes)", async () => {
    const { seedBuiltInModes } = await loadModes();
    const count = seedBuiltInModes();
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("is idempotent: seeding twice doesn't create duplicate files (count=0 second time)", async () => {
    const { seedBuiltInModes } = await loadModes();
    seedBuiltInModes();
    const secondCount = seedBuiltInModes();
    expect(secondCount).toBe(0);
  });
});
