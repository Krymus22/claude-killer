/**
 * parallelTools.ts - Parallel tool execution with concurrency control.
 */

import * as log from "./logger.js";

export interface ParallelToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  execute: () => Promise<string>;
}

export interface ParallelResult {
  id: string;
  name: string;
  result: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

export async function executeParallelTools(
  tools: ParallelToolCall[],
  maxConcurrency: number = 5
): Promise<ParallelResult[]> {
  if (tools.length === 0) return [];

  log.debug(`Executing ${tools.length} tools in parallel (max concurrency: ${maxConcurrency})`);

  const results: ParallelResult[] = [];
  const executing: Set<Promise<void>> = new Set();

  for (const tool of tools) {
    const promise = executeOne(tool).then((result) => {
      results.push(result);
      executing.delete(promise);
    });

    executing.add(promise);

    // If we've hit the concurrency limit, wait for one to finish
    if (executing.size >= maxConcurrency) {
      await Promise.race(executing);
    }
  }

  // Wait for all remaining
  await Promise.all(executing);

  return results;
}

async function executeOne(tool: ParallelToolCall): Promise<ParallelResult> {
  const start = Date.now();
  try {
    const result = await tool.execute();
    const durationMs = Date.now() - start;
    log.debug(`Tool ${tool.name} completed in ${durationMs}ms`);
    return { id: tool.id, name: tool.name, result, durationMs, success: true };
  } catch (err) {
    const durationMs = Date.now() - start;
    const error = (err as Error).message;
    log.error(`Tool ${tool.name} failed: ${error}`);
    return { id: tool.id, name: tool.name, result: `[ERROR] ${error}`, durationMs, success: false, error };
  }
}

export function groupIndependentTools(toolCalls: Array<{ name: string; args: Record<string, unknown> }>): ParallelToolCall[][] {
  // BH20 LOW 5: §10.6 of BUSINESS_RULES.md says same-name+same-file writes
  // MUST be SEQUENTIAL (not parallel) — they're dependent operations on the
  // same file (e.g., two edits to file.ts must run in order, or the second
  // edit could clobber the first). The old code INVERTED this: when it saw
  // two consecutive same-name+same-file calls, it `continue`d without
  // flushing the current group — accumulating them in the SAME group, which
  // executeParallelTools runs concurrently. Now we flush the group whenever
  // the NEXT call is same-name+same-file, so each dependent write lands in
  // its own group (groups run sequentially; items inside a group run in
  // parallel). Different-name or different-file calls are independent and
  // can share a group.
  const groups: ParallelToolCall[][] = [];
  let currentGroup: ParallelToolCall[] = [];

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    currentGroup.push({
      id: `tool_${i}`,
      name: tc.name,
      args: tc.args,
      execute: async () => "", // placeholder
    });

    // Look ahead: if the NEXT call is same-name+same-file (a dependent write
    // on the same file), flush the current group NOW so this call runs in
    // its own sequential group — do NOT batch it with the next one.
    const next = toolCalls[i + 1];
    const nextIsDependent =
      next?.name === tc.name &&
      next?.args?.caminho === tc.args?.caminho;

    if (nextIsDependent) {
      // Flush: this call must run BEFORE the next one (same target file).
      // Pushing them into separate groups guarantees sequential execution.
      groups.push(currentGroup);
      currentGroup = [];
      continue;
    }

    // Otherwise, the current group is complete (next is independent or
    // this is the last call). Flush so the next iteration starts a fresh
    // group — every independent call lands in its own group of size 1,
    // which the caller can then choose to re-batch. (Existing tests rely
    // on this 1-call-per-group shape for different-name / different-file
    // inputs.)
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
    }
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

export class ToolExecutor {
  private readonly maxConcurrency: number;
  private activeCount = 0;
  private readonly queue: Array<() => void> = [];

  constructor(maxConcurrency: number = 5) {
    this.maxConcurrency = maxConcurrency;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.activeCount++;
        resolve();
      });
    });
  }

  private release(): void {
    this.activeCount--;
    const next = this.queue.shift();
    if (next) next();
  }

  getActiveCount(): number { return this.activeCount; }
  getQueueLength(): number { return this.queue.length; }
}
