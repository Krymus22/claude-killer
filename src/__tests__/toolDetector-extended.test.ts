/**
 * toolDetector-extended.test.ts — Testes estendidos para toolDetector.ts.
 *
 * Foca nas funções que o toolDetector.test.ts original NAO cobre:
 *   - smartSearch()
 *   - findToolchainConfig()  (via smartSearch — funcao interna)
 *   - extremeFilesystemSearch()
 *   - extremeSearchAllTools()
 *   - aiOnlySearchAllTools()
 *   - getVersion() / isExecutable()  (via smartSearch — funcoes internas)
 *   - queryPackageManagers()         (via smartSearch — funcao interna)
 *   - getRegistryPathDirs()          (via smartSearch — funcao interna)
 *
 * Mocks (mesmo padrao do toolDetector.test.ts):
 *   - ../logger.js          — silencia o logger
 *   - node:fs               — controla existsSync / statSync / readdirSync
 *   - node:child_process    — controla execSync / spawn
 *   - ../aiSearch.js        — controla a camada de IA sem chamar a API real
 *
 * Usa vi.hoisted() para que os mocks sejam criados ANTES do import do
 * toolDetector.js (vitest faz hoisting do vi.mock, mas o objeto mock em
 * si precisa existir antes da factory rodar).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// --- Mock do logger (mesmo do toolDetector.test.ts) --------------------------

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// --- Mocks controlaveis via vi.hoisted ---------------------------------------

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdtempSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const mockChild = vi.hoisted(() => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

const mockOs = vi.hoisted(() => ({
  homedir: vi.fn(() => "/home/user"),
  userInfo: vi.fn(() => ({ username: "testuser" })),
  tmpdir: vi.fn(() => "/tmp"),
  platform: vi.fn(() => "linux"),
  hostname: vi.fn(() => "testhost"),
  networkInterfaces: vi.fn(() => ({})),
}));

const mockAi = vi.hoisted(() => ({
  aiSuggestToolLocation: vi.fn(),
  aiResultToDetectionResult: vi.fn(),
}));

vi.mock("node:fs", () => mockFs);
vi.mock("node:child_process", () => mockChild);
vi.mock("node:os", () => mockOs);
vi.mock("../aiSearch.js", () => mockAi);

// --- Imports apos mocks ------------------------------------------------------

import {
  smartSearch,
  extremeFilesystemSearch,
  extremeSearchAllTools,
  aiOnlySearchAllTools,
  type ToolDetectionResult,
} from "../toolDetector.js";

// --- Helpers -----------------------------------------------------------------

const ORIG_PLATFORM = process.platform;
const ORIG_CWD = process.cwd();

/**
 * Cria um "fake child process" para mockar spawn().
 * Emite eventos `data` (stdout/stderr) e `close`/`error` de forma assincrona
 * (via setImmediate) para que todos os listeners sejam anexados antes do emit.
 */
function makeFakeChild(opts: {
  stdout?: string;
  stderr?: string;
  error?: Error | null;
} = {}): any {
  const stdoutHandlers: Array<(chunk: Buffer) => void> = [];
  const stderrHandlers: Array<(chunk: Buffer) => void> = [];
  const closeHandlers: Array<() => void> = [];
  const errorHandlers: Array<(err: Error) => void> = [];

  const child: any = {
    stdout: {
      on: (event: string, cb: any) => {
        if (event === "data") stdoutHandlers.push(cb);
      },
    },
    stderr: {
      on: (event: string, cb: any) => {
        if (event === "data") stderrHandlers.push(cb);
      },
    },
    kill: vi.fn(),
    on: (event: string, cb: any) => {
      if (event === "close") closeHandlers.push(cb);
      else if (event === "error") errorHandlers.push(cb);
    },
  };

  // Emite os eventos apos os listeners serem anexados (sincrono no Promise).
  setImmediate(() => {
    if (opts.stdout && stdoutHandlers.length > 0) {
      stdoutHandlers.forEach((cb) => cb(Buffer.from(opts.stdout!)));
    }
    if (opts.stderr && stderrHandlers.length > 0) {
      stderrHandlers.forEach((cb) => cb(Buffer.from(opts.stderr!)));
    }
    if (opts.error) {
      errorHandlers.forEach((cb) => cb(opts.error!));
    } else {
      closeHandlers.forEach((cb) => cb());
    }
  });

  return child;
}

/** Stat de arquivo executavel Unix (isFile true + mode com bit 0o111). */
const EXEC_STAT = { isFile: () => true, mode: 0o755 };
/** Stat de arquivo Windows (isFile true, sem mode relevante). */
const WIN_FILE_STAT = { isFile: () => true, mode: 0o100644 };

// --- Setup / Teardown global -------------------------------------------------

describe("toolDetector-extended", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();

    // Defaults: nada existe, nenhum comando funciona.
    mockFs.existsSync.mockReturnValue(false);
    mockFs.statSync.mockImplementation(() => {
      const e = new Error("ENOENT");
      (e as any).code = "ENOENT";
      throw e;
    });
    mockFs.readdirSync.mockReturnValue([]);
    mockFs.mkdtempSync.mockReturnValue("/tmp/claude-killer-verify-mock");
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.rmSync.mockReturnValue(undefined);
    mockFs.readFileSync.mockReturnValue("");

    mockChild.execSync.mockImplementation(() => {
      throw new Error("command not found");
    });
    mockChild.spawn.mockImplementation(() => makeFakeChild());

    // Defaults do os — podem ser sobrescritos por teste
    mockOs.homedir.mockReturnValue("/home/user");
    mockOs.userInfo.mockReturnValue({ username: "testuser" });
    mockOs.tmpdir.mockReturnValue("/tmp");

    // AI desligada por default — cada teste de IA sobrescreve.
    mockAi.aiSuggestToolLocation.mockResolvedValue({
      suggestions: [],
      verifiedPath: null,
      version: null,
      rawResponse: "",
      error: "AI search disabled",
    });
    mockAi.aiResultToDetectionResult.mockReturnValue(null);

    // Limpa env vars relevantes
    delete process.env.AUTO_DETECT_TOOLS;
    delete process.env.AI_SEARCH_ENABLED;
    delete process.env.AI_SEARCH_API_KEY;

    // Restaura platform e cwd
    Object.defineProperty(process, "platform", {
      value: ORIG_PLATFORM,
      configurable: true,
    });
    Object.defineProperty(process, "cwd", {
      value: () => ORIG_CWD,
      configurable: true,
    });
    mockFs.existsSync.mockReturnValue(false);
    mockFs.statSync.mockImplementation(() => {
      const e = new Error("ENOENT");
      (e as any).code = "ENOENT";
      throw e;
    });
    mockFs.readdirSync.mockReturnValue([]);
    mockFs.mkdtempSync.mockReturnValue("/tmp/claude-killer-verify-mock");
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.rmSync.mockReturnValue(undefined);
    mockFs.readFileSync.mockReturnValue("");
    mockChild.execSync.mockImplementation(() => {
      throw new Error("command not found");
    });
    mockChild.spawn.mockImplementation(() => makeFakeChild());
    mockOs.homedir.mockReturnValue("/home/user");
    mockOs.userInfo.mockReturnValue({ username: "testuser" });
    mockOs.tmpdir.mockReturnValue("/tmp");
    mockAi.aiSuggestToolLocation.mockResolvedValue({
      suggestions: [],
      verifiedPath: null,
      version: null,
      rawResponse: "",
      error: "AI search disabled",
    });
    mockAi.aiResultToDetectionResult.mockReturnValue(null);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: ORIG_PLATFORM,
      configurable: true,
    });
    Object.defineProperty(process, "cwd", {
      value: () => ORIG_CWD,
      configurable: true,
    });
    process.env = { ...origEnv };
  });

  // ===========================================================================
  // 1. smartSearch() — 5 testes
  // ===========================================================================
  describe("smartSearch", () => {
    it("retorna null quando nenhuma fonte encontra o tool", () => {
      // Sem rokit.toml, sem cargo, sem registry (non-Windows). Tudo falha.
      const result = smartSearch("nonexistent-tool-xyz");
      expect(result).toBeNull();
    });

    it("retorna ToolDetectionResult quando rokit.toml existe e binary esta em .rokit/bin", () => {
      Object.defineProperty(process, "cwd", {
        value: () => "/home/user/project",
        configurable: true,
      });

      // rokit.toml existe no cwd
      mockFs.existsSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith("rokit.toml")) return true;
        return false;
      });
      // Binary existe e e executavel
      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith(".rokit/bin/rojo")) return EXEC_STAT;
        const e = new Error("ENOENT");
        throw e;
      });
      // getVersion responde
      mockChild.execSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("--version")) return "rojo 7.6.1\n";
        throw new Error("no");
      });

      const result = smartSearch("rojo");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("found");
      expect(result!.binaryPath).toContain(".rokit");
      expect(result!.binaryPath).toContain("rojo");
      expect(result!.version).toBe("7.6.1");
      expect(result!.error).toBeNull();
    });

    it("retorna ToolDetectionResult quando aftman.toml existe", () => {
      Object.defineProperty(process, "cwd", {
        value: () => "/home/user/project",
        configurable: true,
      });

      mockFs.existsSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith("aftman.toml")) return true;
        return false;
      });
      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith(".aftman/bin/wally")) return EXEC_STAT;
        throw new Error("ENOENT");
      });
      mockChild.execSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("--version")) return "wally 0.3.2\n";
        throw new Error("no");
      });

      const result = smartSearch("wally");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("found");
      expect(result!.binaryPath).toContain(".aftman");
      expect(result!.binaryPath).toContain("wally");
      expect(result!.version).toBe("0.3.2");
    });

    it("retorna ToolDetectionResult quando registry PATH (Windows) contem o binary", () => {
      // Simula Windows
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      mockOs.homedir.mockReturnValue("C:\\Users\\test");

      // Sem rokit.toml / aftman.toml
      mockFs.existsSync.mockImplementation((p: string) => {
        // scoop/cargo/winget nao encontram (so precisamos do registry)
        return false;
      });

      // reg query para HKLM e HKCU — ambos retornam PATH
      mockChild.execSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("reg query")) {
          if (cmd.includes("HKCU")) {
            return "    PATH    REG_EXPAND_SZ    C:\\Users\\test\\bin;C:\\Tools\n";
          }
          // HKLM tambem retorna algo (vai ser ignorado se nao tiver o binary)
          return "    PATH    REG_EXPAND_SZ    C:\\Windows\\System32\n";
        }
        if (typeof cmd === "string" && cmd.includes("scoop which")) {
          throw new Error("not found");
        }
        if (typeof cmd === "string" && cmd.includes("cargo install --list")) {
          throw new Error("cargo not installed");
        }
        if (typeof cmd === "string" && cmd.includes("winget list")) {
          throw new Error("winget not installed");
        }
        if (typeof cmd === "string" && cmd.includes("--version")) {
          return "rojo 7.6.1\n";
        }
        throw new Error("no");
      });

      // Stat: o candidate em C:\\Users\\test\\bin\\rojo.exe existe
      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith("bin\\rojo.exe")) return WIN_FILE_STAT;
        if (typeof p === "string" && p.endsWith("bin/rojo.exe")) return WIN_FILE_STAT;
        throw new Error("ENOENT");
      });

      const result = smartSearch("rojo");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("found");
      expect(result!.binaryPath).toContain("rojo.exe");
      expect(result!.version).toBe("7.6.1");
      expect(result!.searchedPaths.some((p) => p.includes("registry PATH"))).toBe(true);
    });

    it("retorna ToolDetectionResult quando cargo install --list contem o tool", () => {
      Object.defineProperty(process, "cwd", {
        value: () => "/tmp/some-random-cwd",
        configurable: true,
      });

      // Sem configs de toolchain
      mockFs.existsSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith(".cargo/bin/selene")) return true;
        return false;
      });

      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith(".cargo/bin/selene")) return EXEC_STAT;
        throw new Error("ENOENT");
      });

      mockChild.execSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("cargo install --list")) {
          return "selene v0.27.1:\n    selene\nother v1.0.0:\n    other\n";
        }
        if (typeof cmd === "string" && cmd.includes("--version")) {
          return "selene 0.27.1\n";
        }
        throw new Error("no");
      });

      const result = smartSearch("selene");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("found");
      expect(result!.binaryPath).toContain(".cargo");
      expect(result!.binaryPath).toContain("selene");
      expect(result!.version).toBe("0.27.1");
      expect(result!.searchedPaths.some((p) => p.includes("package manager"))).toBe(true);
    });
  });

  // ===========================================================================
  // 2. findToolchainConfig() — 4 testes (indireto via smartSearch)
  // ===========================================================================
  describe("findToolchainConfig (via smartSearch)", () => {
    it("encontra rokit.toml no diretorio atual", () => {
      Object.defineProperty(process, "cwd", {
        value: () => "/home/user/project",
        configurable: true,
      });

      mockFs.existsSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p === "/home/user/project/rokit.toml") return true;
        return false;
      });
      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith("project/.rokit/bin/rojo")) return EXEC_STAT;
        throw new Error("ENOENT");
      });
      mockChild.execSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("--version")) return "rojo 7.6.1\n";
        throw new Error("no");
      });

      const result = smartSearch("rojo");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("found");
      // O searchedPaths deve mencionar rokit.toml
      expect(result!.searchedPaths.some((p) => p.includes("rokit.toml"))).toBe(true);
    });

    it("encontra aftman.toml em diretorio pai", () => {
      Object.defineProperty(process, "cwd", {
        value: () => "/home/user/project/sub",
        configurable: true,
      });

      // Aftman.toml so existe no pai (/home/user/project), nao no cwd
      mockFs.existsSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p === "/home/user/project/aftman.toml") return true;
        return false;
      });
      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith("project/.aftman/bin/wally")) return EXEC_STAT;
        throw new Error("ENOENT");
      });
      mockChild.execSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("--version")) return "wally 0.3.2\n";
        throw new Error("no");
      });

      const result = smartSearch("wally");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("found");
      // Binary deve estar no .aftman/bin do pai, nao do cwd
      expect(result!.binaryPath).toContain("project/.aftman/bin");
      expect(result!.binaryPath).not.toContain("project/sub/.aftman");
    });

    it("retorna null quando nenhum config encontrado (smartSearch cai em package managers)", () => {
      Object.defineProperty(process, "cwd", {
        value: () => "/home/user/project",
        configurable: true,
      });

      // Nenhum toml existe; cargo tambem nao tem o tool
      mockFs.existsSync.mockReturnValue(false);
      mockChild.execSync.mockImplementation(() => {
        throw new Error("not found");
      });

      const result = smartSearch("rojo");
      expect(result).toBeNull();
    });

    it("para de buscar ao chegar no home dir", () => {
      // cwd = /home/user (igual ao home). O loop deve parar imediatamente.
      Object.defineProperty(process, "cwd", {
        value: () => "/home/user",
        configurable: true,
      });

      // existsSync nunca deve ser chamado para paths acima de /home/user
      const checkedPaths: string[] = [];
      mockFs.existsSync.mockImplementation((p: string) => {
        checkedPaths.push(String(p));
        return false;
      });
      mockChild.execSync.mockImplementation(() => {
        throw new Error("no");
      });

      const result = smartSearch("rojo");
      expect(result).toBeNull();
      // Nao deve ter tentado /home, / (root), etc. — so /home/user/rokit.toml e aftman.toml
      expect(checkedPaths).toEqual(
        expect.arrayContaining([
          "/home/user/rokit.toml",
          "/home/user/aftman.toml",
        ])
      );
      // Nao deve ter saido do home (sem /rokit.toml ou /aftman.toml no root)
      expect(checkedPaths).not.toContain("/rokit.toml");
      expect(checkedPaths).not.toContain("/aftman.toml");
    });
  });

  // ===========================================================================
  // 3. extremeFilesystemSearch() — 5 testes
  // ===========================================================================
  describe("extremeFilesystemSearch", () => {
    it("retorna null quando tool nao existe em nenhuma unidade (Unix)", async () => {
      // Unix: enumerateDrives usa fs.existsSync("/mnt") e fs.existsSync("/media")
      mockFs.existsSync.mockReturnValue(false);
      // find nao encontra nada
      mockChild.spawn.mockImplementation(() => makeFakeChild({ stdout: "" }));
      // getVersion nao e chamado porque nada foi encontrado

      const progress: string[] = [];
      const result = await extremeFilesystemSearch("nonexistent", (msg) => progress.push(msg));

      expect(result).toBeNull();
      expect(progress.some((m) => m.includes("nao encontrado"))).toBe(true);
    });

    it("retorna resultado quando tool existe (mock spawn retorna path)", async () => {
      mockFs.existsSync.mockReturnValue(false);
      // find retorna um path
      mockChild.spawn.mockImplementation(() =>
        makeFakeChild({ stdout: "/usr/local/bin/rojo\n" })
      );
      // getVersion responde
      mockChild.execSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("--version")) return "rojo 7.6.1\n";
        throw new Error("no");
      });

      const result = await extremeFilesystemSearch("rojo");

      expect(result).not.toBeNull();
      expect(result!.status).toBe("found");
      expect(result!.binaryPath).toBe("/usr/local/bin/rojo");
      expect(result!.version).toBe("7.6.1");
    });

    it("respeita abortSignal.aborted (cancela e retorna null)", async () => {
      mockFs.existsSync.mockReturnValue(false);
      // spawn nunca deve ser chamado se abortSignal ja comeca aborted
      const abortSignal = { aborted: true };

      const progress: string[] = [];
      const result = await extremeFilesystemSearch(
        "rojo",
        (msg) => progress.push(msg),
        abortSignal
      );

      expect(result).toBeNull();
      // Deve ter emitido mensagem de cancelamento
      expect(progress.some((m) => m.includes("Cancelado"))).toBe(true);
      // spawn nao deve ter sido chamado
      expect(mockChild.spawn).not.toHaveBeenCalled();
    });

    it("chama onProgress com mensagens de progresso", async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockChild.spawn.mockImplementation(() => makeFakeChild({ stdout: "" }));

      const progress: string[] = [];
      await extremeFilesystemSearch("rojo", (msg) => progress.push(msg));

      // Deve ter chamado onProgress com a mensagem inicial de unidades detectadas
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.some((m) => m.includes("Unidades detectadas") || m.includes("Escaneando"))).toBe(true);
    });

    it("lida com drives que nao existem (fallback Windows fsutil falha)", async () => {
      // Windows: fsutil fsinfo drives falha -> fallback para ["C:\\", "D:\\", ...]
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });

      // fsutil falha
      mockChild.execSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("fsutil")) {
          throw new Error("admin required");
        }
        if (typeof cmd === "string" && cmd.includes("--version")) {
          return "rojo 7.6.1\n";
        }
        throw new Error("no");
      });
      // PowerShell scan nao encontra nada em nenhum drive
      mockChild.spawn.mockImplementation(() => makeFakeChild({ stdout: "" }));

      const progress: string[] = [];
      const result = await extremeFilesystemSearch("rojo", (msg) => progress.push(msg));

      // Mesmo com fallback, deve retornar null (nao encontrou em lugar nenhum)
      expect(result).toBeNull();
      // Deve ter tentado varios drives (fallback tem 4: C, D, E, F)
      expect(progress.some((m) => m.includes("Escaneando"))).toBe(true);
    });
  });

  // ===========================================================================
  // 4. extremeSearchAllTools() — 4 testes
  // ===========================================================================
  describe("extremeSearchAllTools", () => {
    it("itera sobre todos os tools e retorna array de SearchResult", async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockChild.spawn.mockImplementation(() => makeFakeChild({ stdout: "" }));

      const results = await extremeSearchAllTools(["rojo", "selene", "stylua"]);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(3);
      expect(results[0].toolName).toBe("rojo");
      expect(results[1].toolName).toBe("selene");
      expect(results[2].toolName).toBe("stylua");
      // Todos devem ter status definido
      results.forEach((r) => {
        expect(["missing", "found", "working"]).toContain(r.status);
        expect(Array.isArray(r.searchedPaths)).toBe(true);
      });
    });

    it("chama onProgress para cada tool", async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockChild.spawn.mockImplementation(() => makeFakeChild({ stdout: "" }));

      const progress: any[] = [];
      await extremeSearchAllTools(["rojo", "selene"], (p) => progress.push(p));

      // Deve ter pelo menos 2 chamadas (uma por tool)
      expect(progress.length).toBeGreaterThanOrEqual(2);
      // currentTool deve ter sido "rojo" e "selene" em algum momento
      const toolsReported = new Set(progress.map((p) => p.currentTool));
      expect(toolsReported.has("rojo")).toBe(true);
      expect(toolsReported.has("selene")).toBe(true);
    });

    it("respeita abortSignal entre tools (break do loop)", async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockChild.spawn.mockImplementation(() => makeFakeChild({ stdout: "" }));

      // abortSignal comeca NAO aborted e vira true apos o primeiro tool
      const abortSignal = { aborted: false };
      const progress: any[] = [];
      const results = await extremeSearchAllTools(
        ["rojo", "selene", "stylua"],
        (p) => {
          progress.push(p);
          // Aborta assim que o primeiro tool termina (toolsDone === 1)
          if (p.toolsDone >= 1 && !abortSignal.aborted) {
            abortSignal.aborted = true;
          }
        },
        abortSignal
      );

      // Deve ter parado antes de processar todos os 3
      expect(results.length).toBeLessThan(3);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("usa smartSearch como primeira camada antes do filesystem scan", async () => {
      // Configura smartSearch para ENCONTRAR o tool — filesystem scan nao deve rodar
      Object.defineProperty(process, "cwd", {
        value: () => "/home/user/project",
        configurable: true,
      });
      mockFs.existsSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith("rokit.toml")) return true;
        return false;
      });
      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith(".rokit/bin/rojo")) return EXEC_STAT;
        throw new Error("ENOENT");
      });
      mockChild.execSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("--version")) return "rojo 7.6.1\n";
        throw new Error("no");
      });

      const results = await extremeSearchAllTools(["rojo"]);

      expect(results.length).toBe(1);
      expect(results[0].status).toBe("found");
      expect(results[0].binaryPath).toContain(".rokit");
      // Como smartSearch encontrou, spawn (filesystem scan) NAO deve ter sido chamado
      expect(mockChild.spawn).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 5. aiOnlySearchAllTools() — 4 testes
  // ===========================================================================
  describe("aiOnlySearchAllTools", () => {
    it("chama aiSuggestToolLocation para cada tool", async () => {
      mockAi.aiSuggestToolLocation.mockResolvedValue({
        suggestions: [],
        verifiedPath: null,
        version: null,
        rawResponse: "",
        error: "AI disabled",
      });

      await aiOnlySearchAllTools(["rojo", "selene"]);

      expect(mockAi.aiSuggestToolLocation).toHaveBeenCalledTimes(2);
      expect(mockAi.aiSuggestToolLocation).toHaveBeenCalledWith("rojo", []);
      expect(mockAi.aiSuggestToolLocation).toHaveBeenCalledWith("selene", []);
    });

    it("retorna SearchResult com status 'found' quando IA encontra", async () => {
      // IA encontra um path verificado
      mockAi.aiSuggestToolLocation.mockResolvedValue({
        suggestions: [
          { path: "/opt/rojo", reason: "guessed", exists: true },
        ],
        verifiedPath: "/opt/rojo",
        version: "7.6.1",
        rawResponse: "...",
        error: null,
      });
      // aiResultToDetectionResult retorna um ToolDetectionResult valido
      mockAi.aiResultToDetectionResult.mockReturnValue({
        status: "found",
        binaryPath: "/opt/rojo",
        version: "7.6.1",
        error: null,
        searchedPaths: ["[AI] /opt/rojo"],
      });

      const results = await aiOnlySearchAllTools(["rojo"]);

      expect(results.length).toBe(1);
      expect(results[0].status).toBe("found");
      expect(results[0].binaryPath).toBe("/opt/rojo");
      expect(results[0].version).toBe("7.6.1");
    });

    it("retorna SearchResult com status 'missing' quando IA falha", async () => {
      mockAi.aiSuggestToolLocation.mockResolvedValue({
        suggestions: [],
        verifiedPath: null,
        version: null,
        rawResponse: "",
        error: "AI search disabled",
      });
      mockAi.aiResultToDetectionResult.mockReturnValue(null);

      const results = await aiOnlySearchAllTools(["rojo"]);

      expect(results.length).toBe(1);
      expect(results[0].status).toBe("missing");
      expect(results[0].binaryPath).toBeNull();
      expect(results[0].version).toBeNull();
      expect(results[0].searchedPaths.some((p) => p.includes("IA"))).toBe(true);
    });

    it("lida com erro de import dinamico gracefully", async () => {
      // Simula erro no import dinâmico — aiSuggestToolLocation rejeita
      mockAi.aiSuggestToolLocation.mockRejectedValue(new Error("Module load failed"));

      // Nao deve lancar — deve retornar status "missing"
      const results = await aiOnlySearchAllTools(["rojo"]);

      expect(results.length).toBe(1);
      expect(results[0].status).toBe("missing");
      expect(results[0].binaryPath).toBeNull();
    });
  });

  // ===========================================================================
  // 6. getVersion() / isExecutable() — 3 testes (indireto via smartSearch)
  // ===========================================================================
  describe("getVersion / isExecutable (via smartSearch)", () => {
    it("getVersion retorna string de versao quando binary responde", () => {
      Object.defineProperty(process, "cwd", {
        value: () => "/home/user/project",
        configurable: true,
      });
      mockFs.existsSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith("rokit.toml")) return true;
        return false;
      });
      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith(".rokit/bin/rojo")) return EXEC_STAT;
        throw new Error("ENOENT");
      });
      // getVersion responde com versao
      mockChild.execSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("--version")) {
          return "rojo 7.6.1 (build abc123)\n";
        }
        throw new Error("no");
      });

      const result = smartSearch("rojo");
      expect(result).not.toBeNull();
      // getVersion extrai o primeiro \d+\.\d+\.\d+ da saida
      expect(result!.version).toBe("7.6.1");
    });

    it("getVersion retorna null quando binary falha (isExecutable true, mas --version quebra)", () => {
      Object.defineProperty(process, "cwd", {
        value: () => "/home/user/project",
        configurable: true,
      });
      mockFs.existsSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith("rokit.toml")) return true;
        return false;
      });
      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith(".rokit/bin/rojo")) return EXEC_STAT;
        throw new Error("ENOENT");
      });
      // getVersion falha (execSync lanca)
      mockChild.execSync.mockImplementation(() => {
        throw new Error("binary crashed");
      });

      const result = smartSearch("rojo");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("found");
      expect(result!.binaryPath).toContain(".rokit");
      // getVersion retornou null
      expect(result!.version).toBeNull();
    });

    it("isExecutable retorna false para arquivo inexistente (statSync lanca ENOENT)", () => {
      Object.defineProperty(process, "cwd", {
        value: () => "/home/user/project",
        configurable: true,
      });
      // rokit.toml existe mas o binary NAO
      mockFs.existsSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith("rokit.toml")) return true;
        return false;
      });
      // statSync sempre lanca (arquivo inexistente)
      mockFs.statSync.mockImplementation(() => {
        const e = new Error("ENOENT");
        (e as any).code = "ENOENT";
        throw e;
      });
      mockChild.execSync.mockImplementation(() => {
        throw new Error("no");
      });

      // smartSearch deve retornar null porque isExecutable retornou false
      const result = smartSearch("rojo");
      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // 7. queryPackageManagers() — 3 testes (indireto via smartSearch)
  // ===========================================================================
  describe("queryPackageManagers (via smartSearch)", () => {
    it("retorna paths quando scoop which encontra (Windows)", () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      mockOs.homedir.mockReturnValue("C:\\Users\\test");

      // Sem configs de toolchain
      mockFs.existsSync.mockImplementation((p: string) => {
        // scoop which retorna um path; fs.existsSync confirma que existe
        if (typeof p === "string" && p.endsWith("scoop\\apps\\rojo\\current\\rojo.exe")) return true;
        return false;
      });

      mockChild.execSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("scoop which")) {
          return "C:\\Users\\test\\scoop\\apps\\rojo\\current\\rojo.exe\n";
        }
        if (typeof cmd === "string" && cmd.includes("cargo install --list")) {
          throw new Error("cargo not installed");
        }
        if (typeof cmd === "string" && cmd.includes("winget list")) {
          throw new Error("winget not installed");
        }
        if (typeof cmd === "string" && cmd.includes("reg query")) {
          throw new Error("reg failed");
        }
        if (typeof cmd === "string" && cmd.includes("--version")) {
          return "rojo 7.6.1\n";
        }
        throw new Error("no");
      });

      // stat: o path do scoop e executavel
      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith("scoop\\apps\\rojo\\current\\rojo.exe")) {
          return WIN_FILE_STAT;
        }
        throw new Error("ENOENT");
      });

      const result = smartSearch("rojo");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("found");
      expect(result!.binaryPath).toContain("scoop");
      expect(result!.binaryPath).toContain("rojo.exe");
      expect(result!.searchedPaths.some((p) => p.includes("package manager"))).toBe(true);
    });

    it("retorna paths quando cargo install --list tem o tool", () => {
      Object.defineProperty(process, "cwd", {
        value: () => "/tmp/cwd",
        configurable: true,
      });

      // Sem configs de toolchain, mas .cargo/bin/selene existe
      mockFs.existsSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p === "/home/user/.cargo/bin/selene") return true;
        return false;
      });

      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p === "/home/user/.cargo/bin/selene") return EXEC_STAT;
        throw new Error("ENOENT");
      });

      mockChild.execSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("cargo install --list")) {
          return "selene v0.27.1:\n    selene\nother v1.0.0:\n    other\n";
        }
        if (typeof cmd === "string" && cmd.includes("--version")) {
          return "selene 0.27.1\n";
        }
        throw new Error("no");
      });

      const result = smartSearch("selene");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("found");
      expect(result!.binaryPath).toBe("/home/user/.cargo/bin/selene");
      expect(result!.version).toBe("0.27.1");
    });

    it("retorna array vazio quando nenhum package manager tem o tool", () => {
      Object.defineProperty(process, "cwd", {
        value: () => "/tmp/cwd",
        configurable: true,
      });

      // Tudo falha
      mockFs.existsSync.mockReturnValue(false);
      mockChild.execSync.mockImplementation(() => {
        throw new Error("not installed");
      });

      // smartSearch deve retornar null — nenhum package manager encontrou
      const result = smartSearch("nonexistent");
      expect(result).toBeNull();
      // E nenhum path "[smart] package manager" deve aparecer
      // (porque pkgMgrPaths e vazio, o loop for-of nao itera)
    });
  });

  // ===========================================================================
  // 8. getRegistryPathDirs() — 2 testes (indireto via smartSearch)
  // ===========================================================================
  describe("getRegistryPathDirs (via smartSearch)", () => {
    it("retorna array vazio em non-Windows (registry nunca e consultado)", () => {
      // Plataforma atual (Linux) — smartSearch pula o bloco Windows registry
      Object.defineProperty(process, "cwd", {
        value: () => "/tmp/cwd",
        configurable: true,
      });

      mockFs.existsSync.mockReturnValue(false);
      mockChild.execSync.mockImplementation((cmd: string) => {
        // NUNCA deve ser chamado com "reg query" em non-Windows
        if (typeof cmd === "string" && cmd.includes("reg query")) {
          throw new Error("reg should not be called on non-Windows");
        }
        throw new Error("not found");
      });

      const result = smartSearch("rojo");
      expect(result).toBeNull();
      // Confirma que "reg query" nunca foi chamado
      const regCalls = mockChild.execSync.mock.calls.filter(
        ([cmd]) => typeof cmd === "string" && cmd.includes("reg query")
      );
      expect(regCalls.length).toBe(0);
    });

    it("retorna paths do registry em Windows (mock reg query)", () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      mockOs.homedir.mockReturnValue("C:\\Users\\test");

      mockFs.existsSync.mockReturnValue(false);

      mockChild.execSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("reg query")) {
          if (cmd.includes("HKCU")) {
            return "    PATH    REG_EXPAND_SZ    C:\\Users\\test\\bin;C:\\Custom\\Tools\n";
          }
          // HKLM
          return "    PATH    REG_EXPAND_SZ    C:\\Program Files\\App\n";
        }
        if (typeof cmd === "string" && cmd.includes("scoop which")) {
          throw new Error("not found");
        }
        if (typeof cmd === "string" && cmd.includes("cargo install --list")) {
          throw new Error("cargo not installed");
        }
        if (typeof cmd === "string" && cmd.includes("winget list")) {
          throw new Error("winget not installed");
        }
        if (typeof cmd === "string" && cmd.includes("--version")) {
          return "rojo 7.6.1\n";
        }
        throw new Error("no");
      });

      // O binary esta em um dos dirs do registry (C:\\Users\\test\\bin\\rojo.exe)
      // path.join em Linux usa "/" como separador — o candidate vira
      // "C:\\Users\\test\\bin/rojo.exe" (separadores mistos). Match flexivel.
      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.includes("rojo.exe") && p.includes("bin")) {
          return WIN_FILE_STAT;
        }
        throw new Error("ENOENT");
      });

      const result = smartSearch("rojo");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("found");
      expect(result!.binaryPath).toContain("rojo.exe");
      // Deve ter consultado o registry (HKLM e HKCU)
      const regCalls = mockChild.execSync.mock.calls.filter(
        ([cmd]) => typeof cmd === "string" && cmd.includes("reg query")
      );
      expect(regCalls.length).toBeGreaterThanOrEqual(2);
      // E registrado os paths tentados
      expect(result!.searchedPaths.some((p) => p.includes("registry PATH"))).toBe(true);
    });
  });
});
