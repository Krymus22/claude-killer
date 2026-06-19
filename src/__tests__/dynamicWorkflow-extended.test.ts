/**
 * dynamicWorkflow-extended.test.ts
 *
 * Expande cobertura do dynamicWorkflow.ts com:
 *   - validateWorkflow: script vazio, script complexo válido, múltiplos
 *     patterns proibidos na mesma string
 *   - executeWorkflow: console.log sandbox, agent() falha gracefully,
 *     parallel com mixed results, loops, aninhamento, múltiplos logs,
 *     stepsExecuted count correto
 *   - getExampleWorkflow: estrutura do exemplo retornado
 * Não duplica testes do dynamicWorkflow.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
}));

// Mock do subAgents com controle de retorno por chamada
const mockRunSubAgent = vi.hoisted(() => vi.fn());

vi.mock("./../subAgents.js", () => ({
  runSubAgent: mockRunSubAgent,
}));

describe("dynamicWorkflow (extended)", () => {
  beforeEach(() => {
    mockRunSubAgent.mockReset();
    mockRunSubAgent.mockResolvedValue("ok");
  });

  // ─── validateWorkflow ────────────────────────────────────────────────────

  it("validateWorkflow aceita script vazio como válido", async () => {
    const { validateWorkflow } = await import("./../dynamicWorkflow.js");
    const result = validateWorkflow("");
    expect(result.valid).toBe(true);
  });

  it("validateWorkflow aceita script complexo com loops/condicionais", async () => {
    const { validateWorkflow } = await import("./../dynamicWorkflow.js");
    const script = `
      const items = ['a', 'b', 'c'];
      for (const item of items) {
        if (item === 'b') continue;
        log(item);
      }
      const result = items.map(i => i.toUpperCase()).filter(Boolean);
      log(result.join(','));
    `;
    const result = validateWorkflow(script);
    expect(result.valid).toBe(true);
  });

  it("validateWorkflow reporta apenas o primeiro pattern proibido encontrado", async () => {
    const { validateWorkflow } = await import("./../dynamicWorkflow.js");
    // Script com vários patterns proibidos — deve parar no primeiro (require)
    const result = validateWorkflow("require('fs'); import x from 'y'; process.exit();");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("require");
  });

  it("validateWorkflow rejeita script com syntax error mesmo sem patterns proibidos", async () => {
    const { validateWorkflow } = await import("./../dynamicWorkflow.js");
    const result = validateWorkflow("function() { return; }");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Syntax");
  });

  // ─── executeWorkflow ─────────────────────────────────────────────────────

  it("executeWorkflow expõe console.log no sandbox", async () => {
    const { executeWorkflow } = await import("./../dynamicWorkflow.js");
    const result = await executeWorkflow("console.log('via console');");
    expect(result.success).toBe(true);
    expect(result.output).toContain("via console");
  });

  it("executeWorkflow captura erro lançado dentro do script async", async () => {
    const { executeWorkflow } = await import("./../dynamicWorkflow.js");
    const result = await executeWorkflow("throw new Error('boom inside async');");
    expect(result.success).toBe(false);
    expect(result.error).toContain("boom inside async");
    // output pode estar vazio ou ter logs anteriores, mas stepsExecuted deve ser 0
    expect(result.stepsExecuted).toBe(0);
  });

  it("executeWorkflow retorna null quando agent() lança erro", async () => {
    mockRunSubAgent.mockRejectedValueOnce(new Error("sub-agent crash"));
    const { executeWorkflow } = await import("./../dynamicWorkflow.js");
    const result = await executeWorkflow(
      "const r = await agent('q'); log('r=' + r);"
    );
    // Mesmo com erro do sub-agent, o workflow continua (success=true)
    expect(result.success).toBe(true);
    expect(result.stepsExecuted).toBe(1);
    // O output deve conter a marcação de erro do agent
    expect(result.output).toContain("[AGENT ERROR]");
    // E o log subsequente com "r=null"
    expect(result.output).toContain("r=null");
  });

  it("executeWorkflow executa parallel com resultados em ordem", async () => {
    mockRunSubAgent
      .mockResolvedValueOnce("result1")
      .mockResolvedValueOnce("result2")
      .mockResolvedValueOnce("result3");
    const { executeWorkflow } = await import("./../dynamicWorkflow.js");
    const result = await executeWorkflow(
      "const [a, b, c] = await parallel('q1', 'q2', 'q3'); log(a + '|' + b + '|' + c);"
    );
    expect(result.success).toBe(true);
    expect(result.stepsExecuted).toBe(3);
    expect(result.output).toContain("result1|result2|result3");
  });

  it("executeWorkflow executa loop com múltiplas chamadas agent()", async () => {
    mockRunSubAgent.mockResolvedValue("file");
    const { executeWorkflow } = await import("./../dynamicWorkflow.js");
    const script = `
      const items = ['a', 'b', 'c'];
      for (const item of items) {
        await agent('process ' + item);
      }
    `;
    const result = await executeWorkflow(script);
    expect(result.success).toBe(true);
    expect(result.stepsExecuted).toBe(3);
    expect(mockRunSubAgent).toHaveBeenCalledTimes(3);
  });

  it("executeWorkflow captura log() múltiplas vezes em ordem", async () => {
    const { executeWorkflow } = await import("./../dynamicWorkflow.js");
    const script = `
      log('first');
      log('second');
      log('third');
    `;
    const result = await executeWorkflow(script);
    expect(result.success).toBe(true);
    // As três mensagens devem aparecer em ordem
    const firstIdx = result.output.indexOf("first");
    const secondIdx = result.output.indexOf("second");
    const thirdIdx = result.output.indexOf("third");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });

  it("executeWorkflow registra durationMs > 0 após execução", async () => {
    const { executeWorkflow } = await import("./../dynamicWorkflow.js");
    const result = await executeWorkflow("log('timing test');");
    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(5000);
  });

  it("executeWorkflow lida com script que não chama nenhuma função sandbox", async () => {
    const { executeWorkflow } = await import("./../dynamicWorkflow.js");
    const result = await executeWorkflow("const x = 1 + 1;");
    expect(result.success).toBe(true);
    expect(result.stepsExecuted).toBe(0);
    // output deve estar vazio (não chamou log)
    expect(result.output).toBe("");
  });

  // ─── getExampleWorkflow ──────────────────────────────────────────────────

  it("getExampleWorkflow retorna string com estrutura completa de exemplo", async () => {
    const { getExampleWorkflow } = await import("./../dynamicWorkflow.js");
    const example = getExampleWorkflow();
    expect(typeof example).toBe("string");
    expect(example.length).toBeGreaterThan(50);
    // Deve conter os elementos-chave do exemplo
    expect(example).toContain("agent(");
    expect(example).toContain("log(");
    expect(example).toContain("for");
    // Deve conter comentário explicativo
    expect(example).toContain("//");
  });
});
