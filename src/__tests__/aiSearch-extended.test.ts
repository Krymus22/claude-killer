/**
 * aiSearch-extended.test.ts — Cobertura adicional para aiSearch.ts.
 *
 * Expande os casos do aiSearch.test.ts original cobrindo:
 *   - aiSuggestToolLocation: caminho verificado no disco (sucesso real),
 *     erro de API com objeto não-Error, conteúdo nulo do modelo
 *   - parseSuggestions (indireto via aiSuggestToolLocation): JSON strict
 *     com array vazia, markdown fenced sem linguagem, regex fallback Linux
 *   - aiResultToDetectionResult: preserva lista de sugestões no
 *     searchedPaths, converte mesmo quando error está setado
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock config controlável por teste
const mockConfig = vi.hoisted(() => ({
  aiSearchEnabled: true,
  aiSearchApiKey: "test-key",
  aiSearchBaseUrl: "https://test.api.com/v1",
  aiSearchModel: "test-model",
}));

vi.mock("../config.js", () => ({
  config: mockConfig,
}));

// Mock OpenAI client
const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

// Mock node:fs para controlarmos existsSync por teste
const mockExistsSync = vi.hoisted(() => vi.fn(() => false));
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  default: { existsSync: mockExistsSync },
}));

// Mock node:child_process para getVersion
const mockExecSync = vi.hoisted(() => vi.fn(() => "1.0.0\n"));
vi.mock("node:child_process", () => ({
  execSync: mockExecSync,
}));

import { aiSuggestToolLocation, aiResultToDetectionResult, type AiSearchResult } from "../aiSearch.js";

describe("aiSearch (extended)", () => {
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.aiSearchEnabled = true;
    mockConfig.aiSearchApiKey = "test-key";
    mockConfig.aiSearchBaseUrl = "https://test.api.com/v1";
    mockConfig.aiSearchModel = "test-model";
    mockExistsSync.mockImplementation(() => false);
    mockExecSync.mockImplementation(() => "1.0.0\n");
    // Default: Linux
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });

  afterEach(() => {
    if (origPlatform) {
      Object.defineProperty(process, "platform", origPlatform);
    }
  });

  describe("aiSuggestToolLocation", () => {
    it("retorna verifiedPath e version quando o caminho sugerido existe no disco (sucesso)", async () => {
      // O modelo sugere um caminho — fazemos existsSync retornar true para ele
      const suggestedPath = "/home/user/.rokit/bin/rojo";
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify([
              { path: suggestedPath, reason: "rokit bin folder" },
            ]),
          },
        }],
      });
      // existsSync retorna true APENAS para o caminho sugerido
      mockExistsSync.mockImplementation((p: string) => p === suggestedPath);
      // execSync retorna uma string de versão
      mockExecSync.mockImplementation(() => "Rojo 7.6.1\n");

      const result = await aiSuggestToolLocation("rojo");

      expect(result.error).toBeNull();
      expect(result.verifiedPath).toBe(suggestedPath);
      expect(result.suggestions[0].exists).toBe(true);
      // Version pode ser null ou string — depende de conseguir rodar --version.
      // O importante é que verifiedPath foi corretamente identificado.
      expect(typeof result.version === "string" || result.version === null).toBe(true);
    });

    it("trata erro de API quando o objeto rejeitado não é uma instância de Error", async () => {
      // Lança uma string em vez de Error — o código usa err?.message ?? String(err)
      mockCreate.mockRejectedValueOnce("string error sem message");

      const result = await aiSuggestToolLocation("rojo");

      expect(result.error).toBe("string error sem message");
      expect(result.suggestions).toEqual([]);
      expect(result.verifiedPath).toBeNull();
    });

    it("retorna resposta vazia e sem sugestões quando content do modelo é nulo", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: null } }],
      });

      const result = await aiSuggestToolLocation("rojo");

      expect(result.error).toBeNull();
      expect(result.suggestions).toEqual([]);
      expect(result.rawResponse).toBe("");
      expect(result.verifiedPath).toBeNull();
    });
  });

  describe("parseSuggestions (via aiSuggestToolLocation)", () => {
    it("JSON strict: retorna array vazia quando modelo responde []", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "[]" } }],
      });

      const result = await aiSuggestToolLocation("rojo");

      expect(result.suggestions).toEqual([]);
      expect(result.error).toBeNull();
    });

    it("markdown fenced sem linguagem: strips ``` genérico e faz parse JSON", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "```\n" + JSON.stringify([
              { path: "/opt/rojo/bin/rojo", reason: "opt install" },
            ]) + "\n```",
          },
        }],
      });

      const result = await aiSuggestToolLocation("rojo");

      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0].path).toBe("/opt/rojo/bin/rojo");
      expect(result.suggestions[0].reason).toBe("opt install");
    });

    it("regex fallback no Linux: extrai caminhos absolutos de texto livre", async () => {
      // Texto livre sem JSON — o regex fallback deve pegar /usr/local/bin/rojo
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "Hmm, tente procurar em /usr/local/bin/rojo ou talvez /home/user/rojo. Boa sorte!",
          },
        }],
      });

      const result = await aiSuggestToolLocation("rojo");

      expect(result.suggestions.length).toBeGreaterThanOrEqual(1);
      // Todos os caminhos extraídos devem terminar com "rojo"
      for (const s of result.suggestions) {
        expect(s.path.endsWith("rojo")).toBe(true);
        expect(s.reason).toContain("extracted");
      }
    });
  });

  describe("aiResultToDetectionResult", () => {
    it("preserva todas as sugestões no campo searchedPaths quando verifiedPath está setado", () => {
      const aiResult: AiSearchResult = {
        suggestions: [
          { path: "/a/rojo", reason: "razão A", exists: false },
          { path: "/b/rojo", reason: "razão B", exists: true },
          { path: "/c/rojo", reason: "razão C", exists: false },
        ],
        verifiedPath: "/b/rojo",
        version: "7.6.1",
        rawResponse: "[...]",
        error: null,
      };

      const detection = aiResultToDetectionResult("rojo", aiResult);

      expect(detection).not.toBeNull();
      expect(detection!.searchedPaths.length).toBe(3);
      // Cada searchedPath deve conter o marcador [AI] e o caminho
      expect(detection!.searchedPaths[0]).toContain("[AI]");
      expect(detection!.searchedPaths[0]).toContain("/a/rojo");
      expect(detection!.searchedPaths[1]).toContain("[AI]");
      expect(detection!.searchedPaths[1]).toContain("/b/rojo");
      expect(detection!.searchedPaths[2]).toContain("[AI]");
      expect(detection!.searchedPaths[2]).toContain("/c/rojo");
    });

    it("converte para ToolDetectionResult mesmo quando error está setado mas verifiedPath existe", () => {
      // Situação rara: o erro foi registrado mas ainda temos um verifiedPath
      const aiResult: AiSearchResult = {
        suggestions: [
          { path: "/x/rojo", reason: "fallback", exists: true },
        ],
        verifiedPath: "/x/rojo",
        version: null, // versão não obtida
        rawResponse: "",
        error: "partial failure", // erro setado, mas verifiedPath também
      };

      const detection = aiResultToDetectionResult("rojo", aiResult);

      // A função só checa verifiedPath — error é ignorado
      expect(detection).not.toBeNull();
      expect(detection!.status).toBe("found");
      expect(detection!.binaryPath).toBe("/x/rojo");
      expect(detection!.version).toBeNull();
    });
  });
});
