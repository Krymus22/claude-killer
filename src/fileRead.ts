/**
 * fileRead.ts - Advanced file reading with offset, limit, line numbers, and pattern search.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

export interface FileReadOptions {
  path: string;
  offset?: number;     // 1-indexed start line
  limit?: number;      // max lines to return
  grep?: string;       // regex pattern to filter lines
  contextLines?: number; // lines of context around matches
}

export function readFileAdvanced(opts: FileReadOptions): string {
  const resolved = path.resolve(opts.path);
  log.toolCall("ler_arquivo", { caminho: resolved, offset: opts.offset, limit: opts.limit });

  if (!fs.existsSync(resolved)) {
    return `[ERROR] File not found: ${resolved}`;
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return readDirectory(resolved);
  }

  const content = fs.readFileSync(resolved, "utf8");
  const lines = content.split(/\r?\n/);

  // Line numbers with content
  const numbered = lines.map((line, i) => ({ num: i + 1, content: line }));

  // Apply grep filter if specified
  if (opts.grep) {
    try {
      const re = new RegExp(opts.grep, "gi");
      const context = opts.contextLines ?? 3;
      const matchingIndices = new Set<number>();

      for (let i = 0; i < numbered.length; i++) {
        if (re.test(numbered[i]?.content ?? "")) {
          for (let j = Math.max(0, i - context); j <= Math.min(numbered.length - 1, i + context); j++) {
            matchingIndices.add(j);
          }
        }
        re.lastIndex = 0; // reset regex state
      }

      const filtered = numbered.filter((_, i) => matchingIndices.has(i));
      const result = filtered.map((l) => `${String(l.num).padStart(5)}: ${l.content}`).join("\n");
      log.toolResult("ler_arquivo", true, `${filtered.length} matching lines`);
      return result;
    } catch (e) {
      return `[ERROR] Regex inválida: ${(e as Error).message}`;
    }
  }

  // Apply offset and limit
  const start = Math.max(0, (opts.offset ?? 1) - 1);
  const end = opts.limit ? Math.min(numbered.length, start + opts.limit) : numbered.length;
  const sliced = numbered.slice(start, end);

  const result = sliced.map((l) => `${String(l.num).padStart(5)}: ${l.content}`).join("\n");
  log.toolResult("ler_arquivo", true, `lines ${start + 1}-${end}/${lines.length}`);
  return result;
}

function readDirectory(dirPath: string): string {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const items = entries.map((e) => {
    const full = path.join(dirPath, e.name);
    if (e.isDirectory()) return `[dir]  ${e.name}/`;
    const stat = fs.statSync(full);
    const size = stat.size;
    if (size > 1024 * 1024) return `[file] ${e.name} (${(size / 1024 / 1024).toFixed(1)} MB)`;
    if (size > 1024) return `[file] ${e.name} (${(size / 1024).toFixed(1)} KB)`;
    return `[file] ${e.name}`;
  });
  log.toolResult("ler_arquivo", true, `dir ${items.length} items`);
  return `[DIRECTORY: ${dirPath}]\n${items.join("\n")}`;
}

export function readBinarySafe(filePath: string): string | null {
  try {
    // BUG FIX (Bug Hunter #7): previously this called
    // `fs.readFileSync(filePath, "utf8")` first and then checked the
    // resulting string for null bytes. This had two problems:
    //
    //   1. Reading with the "utf8" encoding forces Node to decode the
    //      file as UTF-8 — invalid byte sequences are silently replaced
    //      with U+FFFD, which is a lossy operation on binary content.
    //      The decoded string was already corrupted by the time we
    //      checked it.
    //
    //   2. The null-byte check alone misses many binary files. A Latin-1
    //      file with accented chars (e.g., "café" as 0x63 0x61 0x66 0xE9)
    //      has no null bytes but is NOT valid UTF-8 — the old code would
    //      return "caf\uFFFD" as if it were text.
    //
    // Fix: read as a Buffer (raw bytes) and:
    //   - reject if it contains any NUL byte (most reliable binary signal)
    //   - reject if it isn't valid UTF-8 (detected via round-trip:
    //     decode → re-encode → compare). If the buffer had invalid
    //     sequences, Node replaced them with U+FFFD (3 bytes: EF BF BD),
    //     so the re-encoded buffer won't match the original.
    const buf = fs.readFileSync(filePath);
    if (buf.includes(0)) return null;
    const str = buf.toString("utf8");
    if (Buffer.from(str, "utf8").equals(buf)) {
      return str;
    }
    return null;
  } catch {
    return null;
  }
}

export function getFileStats(filePath: string): { size: number; modified: Date; lines: number } | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return null;
    const content = fs.readFileSync(filePath, "utf8");
    return {
      size: stat.size,
      modified: stat.mtime,
      lines: content.split("\n").length,
    };
  } catch {
    return null;
  }
}
