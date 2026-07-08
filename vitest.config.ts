import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: [
      "src/__tests__/markdown-renderer.test.ts",  // OOM in CI — React element accumulation
      "src/__tests__/memory-full.test.ts",        // Pre-existing exclusion
    ],
    testTimeout: 60000,
    setupFiles: ["./vitest-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/__tests__/**", "src/tui/**"],
    },
  },
});
