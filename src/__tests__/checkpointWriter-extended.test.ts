/**
 * checkpointWriter-extended.test.ts — Expandindo cobertura do checkpointWriter.
 *
 * O módulo checkpointWriter extrai estado estruturado da conversa em 3
 * checkpoints (20%, 45%, 70% do contexto). Este arquivo expande a cobertura
 * das funções writeCheckpoint, shouldCheckpoint, formatCheckpoint,
 * getLastCheckpointState, getLastCheckpointNumber e resetCheckpoints,
 * incluindo:
 *   - Escrita de checkpoints com state completo e vazio
 *   - Tratamento de JSON inválido e exceções do LLM
 *   - Checkpoints incrementais (usa estado anterior)
 *   - Thresholds em 20%, 45%, 70%
 *   - Metadados (checkpointNumber, contextPercent, durationMs)
 *   - formatação de estado completo e vazio
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("./../apiClient.js", () => ({ chat: vi.fn() }));
vi.mock("./../history.js", () => ({ getHistory: vi.fn(() => []) }));

describe("checkpointWriter — cobertura estendida", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetCheckpoints } = await import("./../checkpointWriter.js");
    resetCheckpoints();
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockReset();
  });

  /** Gera um JSON de estado válido com overrides opcionais. */
  function makeStateJson(overrides: Record<string, unknown> = {}): string {
    const base = {
      intention: "Implementar feature X",
      nextAction: "Escrever testes",
      constraints: ["Não quebrar API", "Manter compatibilidade"],
      taskTree: ["Task 1", "Task 2", "Task 3"],
      currentWork: "Refatorando módulo Y",
      filesInvolved: [
        { path: "src/y.ts", change: "added foo()" },
        { path: "src/z.ts", change: "removed bar()" },
      ],
      crossTaskDiscoveries: ["Bug em auth afeta feature X"],
      errorsAndCorrections: [
        { error: "TypeError", fix: "cast to string" },
      ],
      runtimeState: "tests passing",
      designDecisions: [{ decision: "usar Option", rationale: "safer" }],
      miscNotes: "lembrar de atualizar docs",
      ...overrides,
    };
    return JSON.stringify(base);
  }

  // --- createCheckpoint (writeCheckpoint) ---

  it("createCheckpoint salva estado de arquivos modificados (state completo)", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson() } }],
    });
    const result = await writeCheckpoint(1);
    expect(result.checkpointNumber).toBe(1);
    expect(result.state.intention).toBe("Implementar feature X");
    expect(result.state.nextAction).toBe("Escrever testes");
    expect(result.state.filesInvolved).toHaveLength(2);
    expect(result.state.filesInvolved[0]!.path).toBe("src/y.ts");
    expect(result.state.filesInvolved[1]!.change).toBe("removed bar()");
    expect(result.state.runtimeState).toBe("tests passing");
    expect(result.state.constraints).toHaveLength(2);
  });

  it("createCheckpoint lida com lista de histórico vazia (contextPercent=0)", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson({ intention: "empty-history" }) } }],
    });
    const result = await writeCheckpoint(1);
    expect(result.state.intention).toBe("empty-history");
    expect(result.contextPercent).toBe(0);
  });

  it("createCheckpoint lida com path inexistente (LLM retorna JSON inválido)", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: "isto não é JSON válido" } }],
    });
    const result = await writeCheckpoint(2);
    // Fallback para estado vazio
    expect(result.state.intention).toBe("");
    expect(result.state.constraints).toEqual([]);
    expect(result.state.filesInvolved).toEqual([]);
    expect(result.state.taskTree).toEqual([]);
    expect(result.checkpointNumber).toBe(2);
  });

  it("createCheckpoint lida com exceção do chat() (fallback empty state)", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockRejectedValue(new Error("network failure"));
    const result = await writeCheckpoint(3);
    expect(result.state.intention).toBe("");
    expect(result.state.taskTree).toEqual([]);
    expect(result.state.designDecisions).toEqual([]);
    expect(result.checkpointNumber).toBe(3);
  });

  it("createCheckpoint lida com response.choices ausente (content vazio)", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({});
    const result = await writeCheckpoint(1);
    expect(result.state.intention).toBe("");
    expect(result.state.miscNotes).toBe("");
  });

  it("createCheckpoint usa estado anterior em checkpoint incremental", async () => {
    const { writeCheckpoint, getLastCheckpointState } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValueOnce({
      choices: [{ message: { content: makeStateJson({ intention: "primeiro" }) } }],
    });
    await writeCheckpoint(1);
    expect(getLastCheckpointState()!.intention).toBe("primeiro");

    (chat as any).mockResolvedValueOnce({
      choices: [{ message: { content: makeStateJson({ intention: "segundo" }) } }],
    });
    await writeCheckpoint(2);
    expect(getLastCheckpointState()!.intention).toBe("segundo");
  });

  it("createCheckpoint extrai JSON de resposta com texto ao redor", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    // LLM pode envolver JSON em markdown ou texto
    (chat as any).mockResolvedValue({
      choices: [{
        message: {
          content: `Aqui está o estado:\n\`\`\`json\n${makeStateJson({ intention: "extraido" })}\n\`\`\`\nFim.`,
        },
      }],
    });
    const result = await writeCheckpoint(1);
    expect(result.state.intention).toBe("extraido");
  });

  // --- shouldCheckpoint ---

  it("shouldCheckpoint retorna 3 em ~70% do contexto", async () => {
    const { shouldCheckpoint, resetCheckpoints, writeCheckpoint } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    resetCheckpoints();
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson() } }],
    });
    await writeCheckpoint(1);
    await writeCheckpoint(2);
    expect(shouldCheckpoint(90000)).toBe(3); // ~70% of 128000
  });

  it("shouldCheckpoint retorna 0 quando contexto é muito pequeno", async () => {
    const { shouldCheckpoint } = await import("./../checkpointWriter.js");
    expect(shouldCheckpoint(10)).toBe(0);
    expect(shouldCheckpoint(1000)).toBe(0);
    expect(shouldCheckpoint(5000)).toBe(0);
  });

  it("shouldCheckpoint não retrocede checkpoint já passado", async () => {
    const { shouldCheckpoint, resetCheckpoints, writeCheckpoint } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    resetCheckpoints();
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson() } }],
    });
    await writeCheckpoint(1);
    await writeCheckpoint(2);
    expect(shouldCheckpoint(26000)).toBe(0); // já passou checkpoint 1
    expect(shouldCheckpoint(58000)).toBe(0); // já passou checkpoint 2
  });

  // --- getLatestCheckpoint ---

  it("getLatestCheckpointNumber retorna número correto após writeCheckpoint", async () => {
    const { writeCheckpoint, getLastCheckpointNumber, resetCheckpoints } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    resetCheckpoints();
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson() } }],
    });
    expect(getLastCheckpointNumber()).toBe(0);
    await writeCheckpoint(1);
    expect(getLastCheckpointNumber()).toBe(1);
    await writeCheckpoint(2);
    expect(getLastCheckpointNumber()).toBe(2);
    await writeCheckpoint(3);
    expect(getLastCheckpointNumber()).toBe(3);
  });

  it("getLatestCheckpointState retorna null quando nenhum checkpoint foi escrito", async () => {
    const { resetCheckpoints, getLastCheckpointState } = await import(
      "./../checkpointWriter.js"
    );
    resetCheckpoints();
    expect(getLastCheckpointState()).toBeNull();
  });

  it("getLatestCheckpointState retorna estado mais recente após writeCheckpoint", async () => {
    const { writeCheckpoint, getLastCheckpointState } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson({ intention: "estado-atual" }) } }],
    });
    await writeCheckpoint(1);
    const state = getLastCheckpointState();
    expect(state).not.toBeNull();
    expect(state!.intention).toBe("estado-atual");
    expect(state!.filesInvolved).toHaveLength(2);
  });

  it("getLatestCheckpointState atualiza após cada checkpoint incremental", async () => {
    const { writeCheckpoint, getLastCheckpointState } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    (chat as any)
      .mockResolvedValueOnce({
        choices: [{ message: { content: makeStateJson({ intention: "v1" }) } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: makeStateJson({ intention: "v2" }) } }],
      });
    await writeCheckpoint(1);
    expect(getLastCheckpointState()!.intention).toBe("v1");
    await writeCheckpoint(2);
    expect(getLastCheckpointState()!.intention).toBe("v2");
  });

  // --- Metadados ---

  it("Checkpoint inclui metadados (checkpointNumber, contextPercent, durationMs, state)", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson() } }],
    });
    const result = await writeCheckpoint(2);
    expect(result).toHaveProperty("checkpointNumber");
    expect(result).toHaveProperty("contextPercent");
    expect(result).toHaveProperty("durationMs");
    expect(result).toHaveProperty("state");
    expect(typeof result.durationMs).toBe("number");
    expect(typeof result.contextPercent).toBe("number");
    expect(result.checkpointNumber).toBe(2);
  });

  // --- formatCheckpoint ---

  it("formatCheckpoint inclui todos os campos do estado", async () => {
    const { formatCheckpoint } = await import("./../checkpointWriter.js");
    const state = {
      intention: "Minha intenção",
      nextAction: "Próxima ação",
      constraints: ["regra1", "regra2"],
      taskTree: ["task1", "task2"],
      currentWork: "trabalho atual",
      filesInvolved: [{ path: "src/a.ts", change: "edit" }],
      crossTaskDiscoveries: ["descoberta"],
      errorsAndCorrections: [{ error: "err", fix: "fix" }],
      runtimeState: "all good",
      designDecisions: [{ decision: "decisão", rationale: "porquê" }],
      miscNotes: "notas importantes",
    };
    const out = formatCheckpoint(state as any);
    expect(out).toContain("CHECKPOINT STATE");
    expect(out).toContain("Minha intenção");
    expect(out).toContain("Próxima ação");
    expect(out).toContain("regra1");
    expect(out).toContain("regra2");
    expect(out).toContain("task1");
    expect(out).toContain("trabalho atual");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("err");
    expect(out).toContain("decisão");
    expect(out).toContain("all good");
    expect(out).toContain("notas importantes");
  });

  it("formatCheckpoint lida com estado vazio graciosamente", async () => {
    const { formatCheckpoint } = await import("./../checkpointWriter.js");
    const empty = {
      intention: "",
      nextAction: "",
      constraints: [],
      taskTree: [],
      currentWork: "",
      filesInvolved: [],
      crossTaskDiscoveries: [],
      errorsAndCorrections: [],
      runtimeState: "",
      designDecisions: [],
      miscNotes: "",
    };
    const out = formatCheckpoint(empty as any);
    expect(out).toContain("CHECKPOINT STATE");
    // Seções opcionais não devem aparecer quando vazias
    expect(out).not.toContain("Constraints:");
    expect(out).not.toContain("Remaining tasks:");
    expect(out).not.toContain("Files involved:");
    expect(out).not.toContain("Errors & corrections:");
    expect(out).not.toContain("Design decisions:");
    expect(out).not.toContain("Runtime:");
    expect(out).not.toContain("Notes:");
  });

  it("formatCheckpoint inclui runtimeState quando presente", async () => {
    const { formatCheckpoint } = await import("./../checkpointWriter.js");
    const state = {
      intention: "x",
      nextAction: "y",
      constraints: [],
      taskTree: [],
      currentWork: "z",
      filesInvolved: [],
      crossTaskDiscoveries: [],
      errorsAndCorrections: [],
      runtimeState: "build OK, 42 tests",
      designDecisions: [],
      miscNotes: "",
    };
    const out = formatCheckpoint(state as any);
    expect(out).toContain("Runtime: build OK, 42 tests");
  });

  // --- resetCheckpoints ---

  it("resetCheckpoints limpa estado e número do último checkpoint", async () => {
    const { writeCheckpoint, resetCheckpoints, getLastCheckpointNumber, getLastCheckpointState } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson() } }],
    });
    await writeCheckpoint(1);
    await writeCheckpoint(2);
    expect(getLastCheckpointNumber()).toBe(2);
    expect(getLastCheckpointState()).not.toBeNull();
    resetCheckpoints();
    expect(getLastCheckpointNumber()).toBe(0);
    expect(getLastCheckpointState()).toBeNull();
  });

  it("resetCheckpoints permite reescrever checkpoints após reset", async () => {
    const { writeCheckpoint, resetCheckpoints, getLastCheckpointNumber } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson() } }],
    });
    await writeCheckpoint(1);
    expect(getLastCheckpointNumber()).toBe(1);
    resetCheckpoints();
    expect(getLastCheckpointNumber()).toBe(0);
    // Após reset, deve permitir fazer checkpoint 1 novamente
    await writeCheckpoint(1);
    expect(getLastCheckpointNumber()).toBe(1);
  });
});
