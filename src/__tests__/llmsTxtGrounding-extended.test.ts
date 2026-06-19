/**
 * llmsTxtGrounding-extended.test.ts
 *
 * Expande a cobertura do módulo llmsTxtGrounding.ts com casos de borda,
 * error handling e integrações de cache. Foco em:
 *   - fetchLlmsTxt: fallback de URL, salvamento em cache após fetch, TTL
 *   - getLlmsCacheStats: diretório inexistente, erro de stat
 *   - clearLlmsCache: diretório inexistente, contagem correta
 *   - formatLlmsTxt: flags de cache
 *   - error handling: curl falha, conteúdo curto
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

// Mock do child_process para controlar o curl sem fazer rede real
const mockSpawn = vi.hoisted(() => ({
  stdout: "",
  code: 0 as number,
  shouldEmitError: false,
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn((cmd: string, args: string[]) => {
    const { EventEmitter } = require("node:events");
    const child = new EventEmitter();
    (child as any).stdout = new EventEmitter();
    (child as any).stderr = new EventEmitter();
    (child as any).kill = vi.fn();
    // Emite stdout de forma assíncrona
    setImmediate(() => {
      (child as any).stdout.emit("data", Buffer.from(mockSpawn.stdout));
      if (mockSpawn.shouldEmitError) {
        child.emit("error", new Error("spawn failed"));
      } else {
        child.emit("close", mockSpawn.code);
      }
    });
    return child;
  }),
}));

describe("llmsTxtGrounding (extended)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "llms-ext-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    // Reset defaults
    mockSpawn.stdout = "";
    mockSpawn.code = 0;
    mockSpawn.shouldEmitError = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("fetchLlmsTxt deve usar URL conhecida para biblioteca popular (react)", async () => {
    const { fetchLlmsTxt } = await import("./../llmsTxtGrounding.js");
    // Sem cache, fetch falha (curl retorna vazio) — deve retornar not found
    mockSpawn.stdout = "";
    mockSpawn.code = 1;
    const result = await fetchLlmsTxt("react");
    expect(result.url).toBe("https://react.dev/llms.txt");
    expect(result.library).toBe("react");
  });

  it("fetchLlmsTxt deve construir URL fallback para biblioteca desconhecida", async () => {
    const { fetchLlmsTxt } = await import("./../llmsTxtGrounding.js");
    mockSpawn.stdout = "";
    mockSpawn.code = 1;
    const result = await fetchLlmsTxt("myCustomLib");
    // Biblioteca desconhecida cai no fallback https://<lib>.dev/llms.txt
    expect(result.url).toBe("https://mycustomlib.dev/llms.txt");
    expect(result.found).toBe(false);
  });

  it("fetchLlmsTxt deve salvar conteúdo recém-buscado no cache", async () => {
    const { fetchLlmsTxt, getLlmsCacheStats } = await import("./../llmsTxtGrounding.js");
    // Simula retorno bem-sucedido do curl com conteúdo > 100 bytes
    const fakeContent = "x".repeat(200);
    mockSpawn.stdout = fakeContent;
    mockSpawn.code = 0;
    const result = await fetchLlmsTxt("react");
    expect(result.found).toBe(true);
    expect(result.fromCache).toBe(false);
    expect(result.content).toContain("x");
    // Agora deve existir cache
    const stats = getLlmsCacheStats();
    expect(stats.entries).toBe(1);
    expect(stats.sizeBytes).toBeGreaterThanOrEqual(200);
  });

  it("fetchLlmsTxt deve rejeitar conteúdo curto (<100 bytes) como não encontrado", async () => {
    const { fetchLlmsTxt } = await import("./../llmsTxtGrounding.js");
    // Conteúdo muito curto — deve ser considerado inválido
    mockSpawn.stdout = "short";
    mockSpawn.code = 0;
    const result = await fetchLlmsTxt("react");
    expect(result.found).toBe(false);
    expect(result.content).toBe("");
  });

  it("fetchLlmsTxt deve lidar com erro de spawn gracefully", async () => {
    const { fetchLlmsTxt } = await import("./../llmsTxtGrounding.js");
    mockSpawn.shouldEmitError = true;
    const result = await fetchLlmsTxt("react");
    expect(result.found).toBe(false);
    expect(result.content).toBe("");
    expect(result.fromCache).toBe(false);
  });

  it("getLlmsCacheStats deve retornar zero quando diretório não existe", async () => {
    const { getLlmsCacheStats } = await import("./../llmsTxtGrounding.js");
    // Sem criar o diretório de cache
    const stats = getLlmsCacheStats();
    expect(stats.entries).toBe(0);
    expect(stats.sizeBytes).toBe(0);
  });

  it("getLlmsCacheStats deve ignorar arquivos não-.txt ao contar", async () => {
    const { getLlmsCacheStats } = await import("./../llmsTxtGrounding.js");
    const cacheDir = path.join(tmpHome, ".claude-killer", "llms-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "react.txt"), "content", "utf8");
    fs.writeFileSync(path.join(cacheDir, "README.md"), "ignored", "utf8");
    fs.writeFileSync(path.join(cacheDir, "tmp.json"), "{}", "utf8");
    const stats = getLlmsCacheStats();
    expect(stats.entries).toBe(1);
  });

  it("clearLlmsCache deve retornar 0 quando cache não existe", async () => {
    const { clearLlmsCache } = await import("./../llmsTxtGrounding.js");
    // Sem criar o diretório
    const cleared = clearLlmsCache();
    expect(cleared).toBe(0);
  });

  it("clearLlmsCache deve remover apenas .txt preservando outros arquivos", async () => {
    const { clearLlmsCache, getLlmsCacheStats } = await import("./../llmsTxtGrounding.js");
    const cacheDir = path.join(tmpHome, ".claude-killer", "llms-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "react.txt"), "x", "utf8");
    fs.writeFileSync(path.join(cacheDir, "vue.txt"), "y", "utf8");
    fs.writeFileSync(path.join(cacheDir, "meta.json"), "{}", "utf8");
    const cleared = clearLlmsCache();
    expect(cleared).toBe(2);
    // meta.json ainda está lá
    expect(fs.existsSync(path.join(cacheDir, "meta.json"))).toBe(true);
    expect(getLlmsCacheStats().entries).toBe(0);
  });

  it("formatLlmsTxt deve marcar flag fromCache corretamente", async () => {
    const { formatLlmsTxt } = await import("./../llmsTxtGrounding.js");
    const cached = formatLlmsTxt({
      library: "react", url: "https://react.dev/llms.txt",
      content: "X", fromCache: true, found: true,
    });
    expect(cached).toContain("Cached: yes");
    const fresh = formatLlmsTxt({
      library: "react", url: "https://react.dev/llms.txt",
      content: "X", fromCache: false, found: true,
    });
    expect(fresh).toContain("Cached: fresh");
  });

  it("fetchLlmsTxt deve ler do cache quando fresco (sem chamar curl)", async () => {
    const { fetchLlmsTxt } = await import("./../llmsTxtGrounding.js");
    const cacheDir = path.join(tmpHome, ".claude-killer", "llms-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "react.txt"), "cached content here", "utf8");
    // Configura curl para falhar — se fosse chamado, o resultado seria not found
    mockSpawn.code = 1;
    mockSpawn.stdout = "";
    const result = await fetchLlmsTxt("react");
    // Mesmo com curl falhando, deve retornar o cache
    expect(result.found).toBe(true);
    expect(result.fromCache).toBe(true);
    expect(result.content).toContain("cached content");
  });

  it("fetchLlmsTxt deve truncar conteúdo maior que MAX_CONTENT_LENGTH", async () => {
    const { fetchLlmsTxt } = await import("./../llmsTxtGrounding.js");
    // Gera conteúdo longo (maior que 8000 chars)
    const longContent = "x".repeat(10000);
    mockSpawn.stdout = longContent;
    mockSpawn.code = 0;
    const result = await fetchLlmsTxt("react");
    expect(result.found).toBe(true);
    // Deve ter sido truncado para no máximo 8000 caracteres
    expect(result.content.length).toBeLessThanOrEqual(8000);
  });
});
