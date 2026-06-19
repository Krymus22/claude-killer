/**
 * telemetry-extended.test.ts — Casos edge / error handling / integração para
 * telemetry.ts que NÃO estão cobertos pelo teste básico.
 *
 * Foco:
 *   - trackEvent (recordToolCall/recordApiCall/recordMessage) — 3 casos
 *   - flush (endSession + persistência) — 2 casos
 *   - anonymize (getAggregatedStats lendo JSONs sem vazar dados) — 2 casos
 *   - edge cases — 1 caso
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

// Mocks controláveis por teste (espelha o padrão do telemetry.test.ts)
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    writeFileSync: (...args: any[]) => (telemetryWriteSpy ?? actual.writeFileSync)(...args),
    mkdirSync: (...args: any[]) => (telemetryMkdirSpy ?? actual.mkdirSync)(...args),
    existsSync: (...args: any[]) => (telemetryExistsSpy ?? actual.existsSync)(...args),
    readdirSync: (...args: any[]) => (telemetryReaddirSpy ?? actual.readdirSync)(...args),
    readFileSync: (...args: any[]) => (telemetryReadSpy ?? actual.readFileSync)(...args),
  };
});

let telemetryWriteSpy: ((...args: any[]) => any) | null = null;
let telemetryMkdirSpy: ((...args: any[]) => any) | null = null;
let telemetryExistsSpy: ((...args: any[]) => any) | null = null;
let telemetryReaddirSpy: ((...args: any[]) => any) | null = null;
let telemetryReadSpy: ((...args: any[]) => any) | null = null;

import {
  startSession,
  endSession,
  recordApiCall,
  recordToolCall,
  recordError,
  recordMessage,
  getCurrentSession,
  getToolMetrics,
  getAggregatedStats,
} from "../telemetry.js";

import * as log from "../logger.js";

beforeEach(() => {
  telemetryWriteSpy = null;
  telemetryMkdirSpy = null;
  telemetryExistsSpy = null;
  telemetryReaddirSpy = null;
  telemetryReadSpy = null;
  vi.clearAllMocks();
});

afterEach(() => {
  // Garante sessão finalizada
  endSession();
});

// ─── trackEvent: recordApiCall acumulação ─────────────────────────────────
describe("trackEvent — recordApiCall (acumulação de tokens)", () => {
  it("soma promptTokens, completionTokens e totalTokens corretamente em múltiplas chamadas", () => {
    startSession("ext_acc_tokens");
    recordApiCall(10, 5);
    recordApiCall(20, 15);
    recordApiCall(0, 0);

    const session = getCurrentSession();
    expect(session!.apiCalls).toBe(3);
    expect(session!.promptTokens).toBe(30);
    expect(session!.completionTokens).toBe(20);
    expect(session!.totalTokens).toBe(50);
  });

  it("mantém contadores zerados quando recordApiCall é chamado sem sessão ativa", () => {
    // Sem startSession — chamadas devem ser silenciosamente ignoradas
    expect(() => recordApiCall(100, 50)).not.toThrow();
    expect(getCurrentSession()).toBeNull();
  });
});

// ─── trackEvent: recordToolCall erro/sucesso ──────────────────────────────
describe("trackEvent — recordToolCall (métricas de tool)", () => {
  it("incrementa successCount e errorCount conforme o parâmetro success", () => {
    startSession("ext_tool_metrics");
    recordToolCall("ler_arquivo", 5, true);
    recordToolCall("ler_arquivo", 8, true);
    recordToolCall("ler_arquivo", 12, false);
    recordToolCall("aplicar_diff", 20, true);

    const metrics = getToolMetrics();
    const ler = metrics.find((m) => m.name === "ler_arquivo");
    const diff = metrics.find((m) => m.name === "aplicar_diff");
    expect(ler).toBeDefined();
    expect(ler!.callCount).toBe(3);
    expect(ler!.successCount).toBe(2);
    expect(ler!.errorCount).toBe(1);
    expect(ler!.totalDurationMs).toBe(25);
    expect(diff!.callCount).toBe(1);
  });

  it("ignora recordToolCall quando nenhuma sessão está ativa (sem criar nova entrada)", () => {
    // Captura métricas atuais (podem existir de testes anteriores por state de módulo)
    const before = getToolMetrics();
    const beforeCount = before.find((m) => m.name === "qualquer_tool")?.callCount ?? 0;
    expect(() => recordToolCall("qualquer_tool", 100, true)).not.toThrow();
    const after = getToolMetrics();
    const afterCount = after.find((m) => m.name === "qualquer_tool")?.callCount ?? 0;
    // Chamada sem sessão ativa NÃO deve incrementar o contador
    expect(afterCount).toBe(beforeCount);
    expect(getCurrentSession()).toBeNull();
  });
});

// ─── trackEvent: recordMessage + recordError ──────────────────────────────
describe("trackEvent — recordMessage e recordError", () => {
  it("acumula chars e contador de mensagens, e conta erros", () => {
    startSession("ext_msg_err");
    recordMessage(150);
    recordMessage(250);
    recordMessage(0);
    recordError();
    recordError();
    recordError();

    const s = getCurrentSession();
    expect(s!.messagesCount).toBe(3);
    expect(s!.totalChars).toBe(400);
    expect(s!.errors).toBe(3);
  });

  it("recordMessage/recordError sem sessão ativa não propagam estado", () => {
    expect(() => recordMessage(999)).not.toThrow();
    expect(() => recordError()).not.toThrow();
    expect(getCurrentSession()).toBeNull();
  });
});

// ─── flush: endSession + saveSessionMetric ────────────────────────────────
describe("flush — endSession e persistência", () => {
  it("endSession sem sessão ativa retorna null (no-op seguro)", () => {
    // Garante que não há sessão ativa
    endSession();
    const result = endSession();
    expect(result).toBeNull();
  });

  it("endSession zera a sessão atual e grava JSON no disco via writeFileSync", () => {
    telemetryWriteSpy = vi.fn();
    telemetryMkdirSpy = vi.fn();
    startSession("ext_flush_session");
    recordApiCall(10, 5);
    recordToolCall("ler_arquivo", 30, true);
    const ended = endSession();

    expect(ended).not.toBeNull();
    expect(ended!.endTime).toBeDefined();
    expect(ended!.durationMs).toBeGreaterThanOrEqual(0);
    expect(telemetryWriteSpy).toHaveBeenCalledTimes(1);
    const written = telemetryWriteSpy.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.sessionId).toBe("ext_flush_session");
    expect(parsed.apiCalls).toBe(1);
    expect(parsed.toolCalls["ler_arquivo"]).toBe(1);
  });
});

// ─── anonymize: getAggregatedStats lendo JSONs sem vazar dados ────────────
describe("anonymize — getAggregatedStats (leitura de JSONs)", () => {
  it("soma corretamente apiCalls, tokens, toolCalls e duração de múltiplos arquivos", () => {
    const fakeFiles = ["sess1.json", "sess2.json"];
    const fakeData: Record<string, string> = {
      "sess1.json": JSON.stringify({
        apiCalls: 5,
        totalTokens: 1000,
        toolCalls: { ler_arquivo: 3, aplicar_diff: 2 },
        durationMs: 5000,
      }),
      "sess2.json": JSON.stringify({
        apiCalls: 7,
        totalTokens: 2000,
        toolCalls: { ler_arquivo: 1, executar_comando: 4 },
        durationMs: 15000,
      }),
    };

    telemetryExistsSpy = () => true;
    telemetryReaddirSpy = () => fakeFiles as any;
    telemetryReadSpy = ((_p: string) => {
      const p = String(_p);
      return fakeData[p.split("/").pop() ?? ""] ?? "{}";
    }) as any;

    const stats = getAggregatedStats();
    expect(stats.totalSessions).toBe(2);
    expect(stats.totalApiCalls).toBe(12);
    expect(stats.totalTokens).toBe(3000);
    expect(stats.totalToolCalls).toBe(10); // 3+2+1+4
    expect(stats.avgSessionDuration).toBe(10000); // (5000+15000)/2
  });

  it("ignora arquivos JSON inválidos e não quebra a agregação", () => {
    const fakeFiles = ["good.json", "bad.json"];
    const fakeData: Record<string, string> = {
      "good.json": JSON.stringify({
        apiCalls: 3,
        totalTokens: 500,
        toolCalls: { tool_x: 2 },
        durationMs: 4000,
      }),
      "bad.json": "{not valid json {{{",
    };

    telemetryExistsSpy = () => true;
    telemetryReaddirSpy = () => fakeFiles as any;
    telemetryReadSpy = ((_p: string) => {
      const p = String(_p);
      return fakeData[p.split("/").pop() ?? ""] ?? "{}";
    }) as any;

    const stats = getAggregatedStats();
    expect(stats.totalSessions).toBe(2); // arquivos contados
    expect(stats.totalApiCalls).toBe(3); // só good.json contribui
    expect(stats.totalTokens).toBe(500);
    expect(stats.totalToolCalls).toBe(2);
    expect(stats.avgSessionDuration).toBe(2000); // 4000 / 2
  });
});

// ─── edge cases ───────────────────────────────────────────────────────────
describe("edge cases", () => {
  it("getToolMetrics retorna array ordenado por callCount desc (maior primeiro)", () => {
    startSession("ext_sort_test");
    // menos chamadas para tool_rara
    recordToolCall("tool_rara", 1, true);
    // muitas chamadas para tool_frequente
    recordToolCall("tool_frequente", 1, true);
    recordToolCall("tool_frequente", 1, true);
    recordToolCall("tool_frequente", 1, true);
    recordToolCall("tool_media", 1, true);
    recordToolCall("tool_media", 1, true);
    endSession();

    const metrics = getToolMetrics();
    expect(metrics.length).toBeGreaterThanOrEqual(3);
    // Os três tools devem aparecer em ordem decrescente de callCount
    const freq = metrics.findIndex((m) => m.name === "tool_frequente");
    const media = metrics.findIndex((m) => m.name === "tool_media");
    const rara = metrics.findIndex((m) => m.name === "tool_rara");
    expect(freq).toBeLessThan(media);
    expect(media).toBeLessThan(rara);
  });

  it("saveSessionMetric captura erro via log.error quando writeFileSync lança exceção", () => {
    telemetryMkdirSpy = vi.fn(() => undefined);
    telemetryWriteSpy = vi.fn(() => {
      throw new Error("simulated disk failure");
    });

    startSession("ext_error_path");
    endSession();

    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to save telemetry"),
    );
  });
});
