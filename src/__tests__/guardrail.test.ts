/**
 * guardrail.test.ts — Tests for guardrail.ts pure logic.
 * Covers: syntax validation, pattern detection, message construction, advisories.
 */

import { describe, it, expect } from "vitest";

// ─── Extract pure functions from guardrail.ts ──────────────────────────────

interface Advisory {
  severity: "error" | "warning" | "info";
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
}

function detectDangerousPatterns(content: string): Advisory[] {
  const advisories: Advisory[] = [];
  const lines = content.split("\n");

  const patterns: Array<{ regex: RegExp; severity: Advisory["severity"]; message: string; suggestion: string }> = [
    { regex: /eval\s*\(/g, severity: "warning", message: "eval() usage detected — potential code injection risk", suggestion: "Consider using safer alternatives like Function constructor or JSON.parse" },
    { regex: /exec\s*\(/g, severity: "warning", message: "exec() usage detected — potential command injection", suggestion: "Validate and sanitize inputs before execution" },
    { regex: /__import__\s*\(/g, severity: "info", message: "Dynamic import detected", suggestion: "Ensure the imported module is trusted" },
    { regex: /process\.exit\s*\(\s*[01]\s*\)/g, severity: "warning", message: "process.exit() called — may interrupt cleanup", suggestion: "Use throw or return instead" },
    { regex: /noqa|nosec|noqa!/gi, severity: "info", message: "Lint suppression comment found", suggestion: "Ensure suppression is justified and documented" },
  ];

  for (let i = 0; i < lines.length; i++) {
    for (const pattern of patterns) {
      if (pattern.regex.test(lines[i])) {
        advisories.push({
          severity: pattern.severity,
          file: "current-file",
          line: i + 1,
          message: pattern.message,
          suggestion: pattern.suggestion,
        });
      }
      pattern.regex.lastIndex = 0;
    }
  }

  return advisories;
}

function formatAdvisorySummary(advisories: Advisory[]): string {
  if (advisories.length === 0) return "Guardrail: no issues found";

  const errors = advisories.filter((a) => a.severity === "error");
  const warnings = advisories.filter((a) => a.severity === "warning");
  const infos = advisories.filter((a) => a.severity === "info");

  const parts: string[] = [];
  if (errors.length > 0) parts.push(`${errors.length} error(s)`);
  if (warnings.length > 0) parts.push(`${warnings.length} warning(s)`);
  if (infos.length > 0) parts.push(`${infos.length} info`);

  return `Guardrail: ${advisories.length} issue(s) — ${parts.join(", ")}`;
}

function getAdvisoriesBySeverity(advisories: Advisory[], severity: Advisory["severity"]): Advisory[] {
  return advisories.filter((a) => a.severity === severity);
}

function shouldBlockWrite(advisories: Advisory[]): boolean {
  return advisories.some((a) => a.severity === "error");
}

function summarizeAdvisoryDetails(advisories: Advisory[]): string[] {
  return advisories.map((a) => {
    const loc = a.file && a.line ? ` [${a.file}:${a.line}]` : a.file ? ` [${a.file}]` : "";
    const sug = a.suggestion ? `\n  Suggestion: ${a.suggestion}` : "";
    return `[${a.severity.toUpperCase()}]${loc} ${a.message}${sug}`;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("guardrail.ts pure logic", () => {
  describe("detectDangerousPatterns", () => {
    it("should detect eval() usage", () => {
      const advisories = detectDangerousPatterns("const result = eval(code);");
      expect(advisories).toHaveLength(1);
      expect(advisories[0].severity).toBe("warning");
      expect(advisories[0].message).toContain("eval()");
      expect(advisories[0].line).toBe(1);
    });

    it("should detect exec() usage", () => {
      const advisories = detectDangerousPatterns("os.exec(cmd)");
      expect(advisories).toHaveLength(1);
      expect(advisories[0].severity).toBe("warning");
      expect(advisories[0].message).toContain("exec()");
    });

    it("should detect __import__() usage", () => {
      const advisories = detectDangerousPatterns('__import__("os")');
      expect(advisories).toHaveLength(1);
      expect(advisories[0].severity).toBe("info");
    });

    it("should detect process.exit()", () => {
      const advisories = detectDangerousPatterns("process.exit(0)");
      expect(advisories).toHaveLength(1);
      expect(advisories[0].severity).toBe("warning");
    });

    it("should detect noqa comment", () => {
      const advisories = detectDangerousPatterns("# noqa: F401");
      expect(advisories).toHaveLength(1);
      expect(advisories[0].severity).toBe("info");
    });

    it("should detect nosec comment", () => {
      const advisories = detectDangerousPatterns("# nosec B101");
      expect(advisories).toHaveLength(1);
      expect(advisories[0].severity).toBe("info");
    });

    it("should return empty for clean code", () => {
      const advisories = detectDangerousPatterns("const x = 1;\nconsole.log(x);");
      expect(advisories).toHaveLength(0);
    });

    it("should handle multiple patterns on different lines", () => {
      const code = `eval("bad")\nconst x = 1;\nos.exec(cmd)`;
      const advisories = detectDangerousPatterns(code);
      expect(advisories).toHaveLength(2);
      expect(advisories[0].line).toBe(1);
      expect(advisories[1].line).toBe(3);
    });

    it("should handle empty input", () => {
      expect(detectDangerousPatterns("")).toHaveLength(0);
    });

    it("should track file name in advisory", () => {
      const advisories = detectDangerousPatterns("eval(x)");
      expect(advisories[0].file).toBe("current-file");
    });
  });

  describe("formatAdvisorySummary", () => {
    it("should return no-issues message for empty", () => {
      expect(formatAdvisorySummary([])).toBe("Guardrail: no issues found");
    });

    it("should count warnings only", () => {
      const advisories: Advisory[] = [
        { severity: "warning", message: "w1" },
        { severity: "warning", message: "w2" },
      ];
      expect(formatAdvisorySummary(advisories)).toContain("2 warning(s)");
    });

    it("should count errors only", () => {
      const advisories: Advisory[] = [
        { severity: "error", message: "e1" },
      ];
      expect(formatAdvisorySummary(advisories)).toContain("1 error(s)");
    });

    it("should count all severities", () => {
      const advisories: Advisory[] = [
        { severity: "error", message: "e1" },
        { severity: "warning", message: "w1" },
        { severity: "info", message: "i1" },
      ];
      const summary = formatAdvisorySummary(advisories);
      expect(summary).toContain("1 error(s)");
      expect(summary).toContain("1 warning(s)");
      expect(summary).toContain("1 info");
      expect(summary).toContain("3 issue(s)");
    });
  });

  describe("getAdvisoriesBySeverity", () => {
    const mixed: Advisory[] = [
      { severity: "error", message: "e1" },
      { severity: "warning", message: "w1" },
      { severity: "info", message: "i1" },
      { severity: "error", message: "e2" },
    ];

    it("should filter errors", () => {
      expect(getAdvisoriesBySeverity(mixed, "error")).toHaveLength(2);
    });

    it("should filter warnings", () => {
      expect(getAdvisoriesBySeverity(mixed, "warning")).toHaveLength(1);
    });

    it("should filter info", () => {
      expect(getAdvisoriesBySeverity(mixed, "info")).toHaveLength(1);
    });

    it("should return empty for non-existent severity", () => {
      expect(getAdvisoriesBySeverity([], "error")).toHaveLength(0);
    });
  });

  describe("shouldBlockWrite", () => {
    it("should return true when errors exist", () => {
      expect(shouldBlockWrite([{ severity: "error", message: "bad" }])).toBe(true);
    });

    it("should return false for warnings only", () => {
      expect(shouldBlockWrite([{ severity: "warning", message: "careful" }])).toBe(false);
    });

    it("should return false for info only", () => {
      expect(shouldBlockWrite([{ severity: "info", message: "fyi" }])).toBe(false);
    });

    it("should return false for empty", () => {
      expect(shouldBlockWrite([])).toBe(false);
    });
  });

  describe("summarizeAdvisoryDetails", () => {
    it("should format advisory with file and line", () => {
      const a: Advisory[] = [{ severity: "warning", file: "app.ts", line: 42, message: "issue found", suggestion: "fix it" }];
      const details = summarizeAdvisoryDetails(a);
      expect(details[0]).toContain("[WARNING]");
      expect(details[0]).toContain("[app.ts:42]");
      expect(details[0]).toContain("issue found");
      expect(details[0]).toContain("Suggestion: fix it");
    });

    it("should format advisory with file but no line", () => {
      const a: Advisory[] = [{ severity: "info", file: "util.ts", message: "note" }];
      const details = summarizeAdvisoryDetails(a);
      expect(details[0]).toContain("[util.ts]");
      expect(details[0]).not.toContain(":");
    });

    it("should format advisory without file", () => {
      const a: Advisory[] = [{ severity: "error", message: "fatal" }];
      const details = summarizeAdvisoryDetails(a);
      expect(details[0]).toContain("[ERROR]");
      expect(details[0]).toContain("fatal");
      expect(details[0]).not.toMatch(/\[[^]]+:\d+\]/);
    });

    it("should handle empty advisories", () => {
      expect(summarizeAdvisoryDetails([])).toHaveLength(0);
    });
  });
});
