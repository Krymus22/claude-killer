/**
 * clipboard.ts - Clipboard integration: copy/paste text and images.
 */

import { execSync } from "node:child_process";
import * as log from "./logger.js";

/**
 * Wrap a string in single quotes for bash, escaping any embedded single
 * quotes via the standard `'\''` idiom. This is the only fully
 * shell-injection-safe way to embed an arbitrary string in a bash command.
 *
 * BUG FIX (shell injection): the previous code interpolated `text` and
 * `filePath` directly into shell strings, allowing characters like `'`,
 * `"`, `$()`, backticks, or `;` to break out of the intended argument
 * and run arbitrary commands. All shell-interpolated values are now
 * escaped via this helper (or PowerShell's analogous `''` escaping).
 */
function bashSingleQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/**
 * Escape a string for use inside a PowerShell single-quoted string.
 * PowerShell single-quoted strings treat everything literally except
 * the closing `'`, which is escaped by doubling it (`''`).
 */
function powershellSingleQuote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/**
 * Escape a string for use inside an AppleScript double-quoted string.
 * AppleScript escapes `\` and `"` with a leading backslash.
 *
 * BUG FIX (shell injection via single quote): the result of this function
 * is embedded inside a bash single-quoted argument (`osascript -e '...'`).
 * A single `'` in the path would terminate the bash single-quoted string
 * early, allowing the rest of the path to be interpreted by bash as
 * arbitrary commands. We now also escape `'` using the standard bash
 * `'\''` idiom (close, escaped-quote, reopen) so it survives the bash
 * layer and reaches AppleScript as a literal single quote.
 */
function applescriptDoubleQuote(s: string): string {
  // First, escape for the AppleScript double-quoted string context.
  const applescriptSafe = s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  // Then, escape `'` for the bash single-quoted context (the AppleScript
  // is embedded inside `osascript -e '...'`).
  const bashSafe = applescriptSafe.replaceAll("'", "'\\''");
  return `"${bashSafe}"`;
}

export function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === "win32") {
      // BUG FIX (shell injection + escaping): previously the code wrapped
      // `text` in single quotes inside the PowerShell command but only
      // escaped double quotes (`"` → `""`), which is the wrong escaping
      // for a single-quoted PowerShell string. A single `'` in `text`
      // would terminate the string and allow arbitrary PowerShell to run.
      // The safe fix is to pipe the text via stdin (`$input | Set-Clipboard`)
      // so no string escaping is needed at all.
      execSync(`powershell -NoProfile -Command "$input | Set-Clipboard"`, {
        input: text,
        encoding: "utf8",
      });
    } else if (process.platform === "darwin") {
      execSync("pbcopy", { input: text, encoding: "utf8" });
    } else {
      // Linux: try xclip, then xsel
      try {
        execSync("xclip -selection clipboard", { input: text, encoding: "utf8" });
      } catch {
        execSync("xsel --clipboard --input", { input: text, encoding: "utf8" });
      }
    }
    log.success("Copied to clipboard");
    return true;
  } catch (err) {
    log.error(`Clipboard copy failed: ${(err as Error).message}`);
    return false;
  }
}

export function pasteFromClipboard(): string | null {
  try {
    if (process.platform === "win32") {
      return execSync("powershell -NoProfile -Command \"Get-Clipboard\"", { encoding: "utf8" }).trim();
    } else if (process.platform === "darwin") {
      return execSync("pbpaste", { encoding: "utf8" }).trim();
    } else {
      try {
        return execSync("xclip -selection clipboard -o", { encoding: "utf8" }).trim();
      } catch {
        return execSync("xsel --clipboard --output", { encoding: "utf8" }).trim();
      }
    }
  } catch {
    return null;
  }
}

export function copyFileToClipboard(filePath: string): boolean {
  try {
    if (process.platform === "win32") {
      // BUG FIX (shell injection): previously `filePath` was interpolated
      // directly into `Get-Item '${filePath}'`, allowing a `'` in the path
      // to break out and run arbitrary PowerShell. Now the path is escaped
      // for a PowerShell single-quoted string and passed via -LiteralPath
      // so wildcard characters in the path are not interpreted.
      // We use `Get-Item -LiteralPath | Set-Clipboard` (rather than
      // `Set-Clipboard -LiteralPath`) because the latter is only available
      // in PowerShell 5.0+, while Get-Item -LiteralPath works in all
      // supported versions.
      const safePath = powershellSingleQuote(filePath);
      execSync(`powershell -NoProfile -Command "Get-Item -LiteralPath ${safePath} | Set-Clipboard"`, { encoding: "utf8" });
    } else if (process.platform === "darwin") {
      // BUG FIX (shell injection): previously `filePath` was interpolated
      // unescaped into both the AppleScript string AND the bash `cat`
      // fallback. A `"`, `'`, `$()`, or backtick in the path could break
      // out and run arbitrary commands. Now we escape for both layers:
      //   - applescriptDoubleQuote escapes `\` and `"` for the AppleScript
      //     double-quoted string AND `'` for the bash single-quoted -e
      //     argument that wraps the AppleScript.
      //   - bashSingleQuote wraps the path for the `cat` fallback so any
      //     shell metacharacter is treated literally.
      const appPath = applescriptDoubleQuote(filePath);
      const bashPath = bashSingleQuote(filePath);
      execSync(
        `osascript -e 'set the clipboard to (read (POSIX file ${appPath}) as JPEG)' 2>/dev/null || cat ${bashPath} | pbcopy`
      );
    } else {
      // BUG FIX (shell injection): previously `xclip -selection clipboard < "${filePath}"`
      // allowed `"`, `$()`, backticks, or `;` in `filePath` to break out of
      // the double-quoted shell argument. Now the path is wrapped in bash
      // single quotes which treat everything literally.
      const safePath = bashSingleQuote(filePath);
      execSync(`xclip -selection clipboard < ${safePath}`);
    }
    return true;
  } catch {
    return false;
  }
}
