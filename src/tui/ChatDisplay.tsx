/**
 * ChatDisplay.tsx - Renders the conversation history with styled messages.
 *
 * All messages use a single leading space (" ") for consistent left margin
 * alignment. Without this, the assistant content starts at column 1 while
 * the user content starts at column 2, making the conversation look jagged.
 *
 * Message types:
 *   - user:      what the user typed (cyan label "você:")
 *   - assistant: what the model replied (violet label "Claude-Killer:")
 *   - tool:      tool calls + results (grey, indented, with icon)
 *                — shown in CHRONOLOGICAL ORDER mixed with user/assistant
 *   - system:    filtered out (internal context, not shown to user)
 *
 * ─── Static + Live split (limite-historico fix) ─────────────────────────
 *
 * BUG FIX: Previously ChatDisplay rendered ALL messages in a single <Box>,
 * which caused two problems:
 *   1. When the conversation grew longer than the terminal, the Ink frame
 *      exceeded the viewport height, pushing the input box and placeholder
 *      ("digite sua mensagem...") off-screen.
 *   2. Even if the user scrolled up, older messages weren't in the terminal
 *      scrollback because Ink overwrites frames (cursor-up + repaint), so
 *      only the last frame is ever in the buffer.
 *
 * Fix: Use Ink's <Static> component to "graduate" old messages to the
 * terminal scrollback. <Static> writes each item to stdout ONCE (above the
 * live view) and never re-renders it. This is exactly how Claude Code does
 * it — old messages become permanent scrollback, recent messages + the
 * streaming message stay in the "live" viewport that gets repainted.
 *
 * Split strategy:
 *   - Find the streaming message (isStreaming=true). If none, all messages
 *     are candidates for static.
 *   - Keep at least MIN_LIVE_MESSAGES in the live view (so the user sees
 *     recent context and their latest message).
 *   - Everything before that goes to <Static> — written once, stays in
 *     scrollback forever, user can scroll up to read it.
 *   - The streaming message and anything after it (shouldn't happen normally)
 *     stay live so they can update on each token.
 *
 * The optional maxVisible prop is kept for backwards compatibility (tests)
 * but is now only applied to the live portion, not the total. Production
 * usage (App.tsx) doesn't pass it.
 */

import React from "react";
import { Box, Text, Static } from "ink";
import { colors, icons } from "./theme.js";

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  isStreaming?: boolean;
  /** For tool messages: the tool name (e.g., "ler_arquivo"). */
  toolName?: string;
  /** For tool messages: whether this is the call (false) or the result (true). */
  isResult?: boolean;
  /** For tool messages: whether the tool succeeded (only for isResult=true). */
  ok?: boolean;
  /** For assistant messages: whether this is an error message (displayed in red). */
  isError?: boolean;
}

interface ChatDisplayProps {
  messages: ChatMessage[];
  maxVisible?: number;
}

/** Minimum number of messages to keep in the live (re-rendered) view. */
const MIN_LIVE_MESSAGES = 4;

/**
 * Truncate a long string to fit in the terminal, preserving the start and end.
 * Examples:
 *   truncateMiddle("hello world this is a long string", 20) → "hello wor…ng string"
 */
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1; // 1 char for the ellipsis
  const start = Math.ceil(keep * 0.6);
  const end = Math.floor(keep * 0.4);
  return s.slice(0, start) + "…" + s.slice(s.length - end);
}

/**
 * Format tool args for display. Shows the most relevant field (path, comando, query)
 * in a compact single-line format.
 */
function formatToolArgs(args: Record<string, unknown>): string {
  // Tool "pensar" — não mostrar o pensamento no chat (é interno)
  // BUG FIX (always-true-condition): The previous condition
  //   `args.pensamento !== undefined || args.pensamento !== null`
  // was ALWAYS true (for any value X, at least one of `X !== undefined`
  // or `X !== null` holds — undefined !== null is true, null !== undefined
  // is true, anything else makes both true). The inner `typeof === "string"`
  // check happened to prevent incorrect output, so behavior was unchanged,
  // but the outer guard was logically broken. Switch to `!= null` which
  // correctly means "is neither undefined nor null".
  if (args.pensamento != null) {
    if (typeof args.pensamento === "string") {
      const cat = args.categoria ?? args.category;
      return cat ? `(${cat}, ${args.pensamento.length} chars)` : `(${args.pensamento.length} chars)`;
    }
  }
  const path = args.path ?? args.caminho ?? args.filePath;
  if (typeof path === "string") return truncateMiddle(path, 50);
  const cmd = args.comando ?? args.command;
  if (typeof cmd === "string") return truncateMiddle(cmd, 50);
  const query = args.query ?? args.consulta ?? args.questao;
  if (typeof query === "string") return truncateMiddle(query, 50);
  const json = JSON.stringify(args);
  return truncateMiddle(json, 50);
}

/**
 * Format tool result for display. Truncates long outputs to keep the chat readable.
 */
function formatToolResult(resultStr: string): string {
  // Take only the first 3 lines and truncate to 200 chars total
  const lines = resultStr.split("\n").slice(0, 3);
  const joined = lines.join("\n");
  return truncateMiddle(joined, 200);
}

/**
 * Render a single message as a React element. Used by both <Static> (old
 * messages) and the live view (recent messages).
 *
 * Extracted into a standalone function so the rendering logic is identical
 * in both contexts — no drift between static and live message appearance.
 */
function renderMessage(msg: ChatMessage, keyPrefix: string): React.ReactElement | null {
  if (msg.role === "system") return null;

  // Tool messages: render with icon, indented, grey
  if (msg.role === "tool") {
    // Tool "pensar" / "think" — esconder resultado (é interno, não deve
    // aparecer no chat). "think" é um alias para "pensar" (ver TOOL_ALIASES
    // em agent.ts). Ambos devem ser filtrados para evitar que o pensamento
    // da IA vaze para o chat visível.
    // BUG FIX (thinking-vazando): o filtro anterior só checava "pensar",
    // então se a IA chamasse "think()" em vez de "pensar()", o resultado
    // vazava. Agora cobre ambos.
    const isThinkTool = msg.toolName === "pensar" || msg.toolName === "think";
    if (isThinkTool && msg.isResult) {
      return null; // não renderizar resultado do pensar/think
    }
    const label = msg.isResult
      ? (msg.ok ? `${icons.check} ${msg.toolName ?? "tool"}` : `${icons.cross} ${msg.toolName ?? "tool"}`)
      : `${icons.arrow} ${msg.toolName ?? "tool"}(${formatToolArgs(parseArgsSafe(msg.content))})`;
    return (
      <Box key={keyPrefix} flexDirection="column">
        <Text color={msg.isResult ? (msg.ok ? colors.success : colors.error) : colors.muted}>
          {"  "}{label}
        </Text>
        {msg.isResult && (
          <Text color={colors.muted}>{"    "}{formatToolResult(msg.content)}</Text>
        )}
      </Box>
    );
  }

  if (msg.role === "user") {
    return (
      <Box key={keyPrefix} flexDirection="column">
        <Text color={colors.primary} bold> you:</Text>
        <Text color={colors.white}> {msg.content}</Text>
        <Text></Text>
      </Box>
    );
  }

  // assistant - note the leading space in content for alignment
  return (
    <Box key={keyPrefix} flexDirection="column">
      <Text color={msg.isError ? colors.error : colors.secondary} bold> {msg.isError ? "❌ Erro:" : "Claude-Killer:"}</Text>
      <Text color={msg.isError ? colors.error : colors.white}> {msg.content}</Text>
      {msg.isStreaming ? null : <Text></Text>}
    </Box>
  );
}

/**
 * Split messages into "static" (old, written once to scrollback) and "live"
 * (recent, re-rendered on each update).
 *
 * Strategy:
 *   1. Find the streaming message (isStreaming=true). It MUST be live.
 *   2. Keep at least MIN_LIVE_MESSAGES before the split point so the user
 *      sees recent context.
 *   3. Everything before the split point is static.
 */
function splitStaticLive(messages: ChatMessage[]): { staticMsgs: ChatMessage[]; liveMsgs: ChatMessage[] } {
  if (messages.length <= MIN_LIVE_MESSAGES) {
    return { staticMsgs: [], liveMsgs: messages };
  }

  // Find the streaming message — it and everything after it must be live.
  const streamingIdx = messages.findIndex((m) => m.isStreaming);
  // If no streaming message, the split point is (length - MIN_LIVE_MESSAGES).
  // If there IS a streaming message, the split point is at most streamingIdx
  // (so the streaming message is always live).
  const maxStaticEnd = streamingIdx === -1 ? messages.length : streamingIdx;
  const staticEnd = Math.min(maxStaticEnd, messages.length - MIN_LIVE_MESSAGES);

  // Guard against negative (when messages.length < MIN_LIVE_MESSAGES, but
  // we already handled that above — this is just defensive).
  const safeStaticEnd = Math.max(0, staticEnd);

  return {
    staticMsgs: messages.slice(0, safeStaticEnd),
    liveMsgs: messages.slice(safeStaticEnd),
  };
}

export function ChatDisplay({ messages, maxVisible }: Readonly<ChatDisplayProps>) {
  // Apply maxVisible to the total message list if provided (backwards compat
  // for tests). Production usage (App.tsx) does NOT pass this prop, so all
  // messages are considered.
  const candidateMsgs = maxVisible !== undefined ? messages.slice(-maxVisible) : messages;

  const { staticMsgs, liveMsgs } = splitStaticLive(candidateMsgs);

  return (
    <Box flexDirection="column">
      {/*
        <Static> writes each item to stdout ONCE, above the live view. Once
        written, items are never re-rendered — they become permanent
        scrollback. This is how we keep old messages accessible without
        growing the live frame beyond the terminal viewport.

        Items graduate from live → static as new messages arrive. Ink
        detects new items in the `items` array (by reference/key) and
        writes only the new ones.

        IMPORTANT: keys must be stable across renders. We use the message
        index in the FULL messages array (not the staticMsgs slice) so that
        a message's key doesn't change when it moves from live to static.
      */}
      <Static items={staticMsgs}>
        {(msg, i) => {
          // Find the original index in the full messages array for a stable key.
          // This ensures the key doesn't change when the message graduates
          // from live to static (which would cause Ink to re-write it).
          const originalIdx = messages.indexOf(msg);
          const key = `msg-${originalIdx >= 0 ? originalIdx : i}`;
          return renderMessage(msg, key);
        }}
      </Static>

      {/* Live view: recent messages + the streaming message. These are
          re-rendered on every state update (each token, throttle flush,
          tool call, etc.). Kept small (MIN_LIVE_MESSAGES + streaming) so
          the frame never exceeds the terminal viewport. */}
      {liveMsgs.map((msg, i) => {
        const originalIdx = messages.indexOf(msg);
        const key = `msg-${originalIdx >= 0 ? originalIdx : `live-${i}`}`;
        return renderMessage(msg, key);
      })}
    </Box>
  );
}

/** Safely parse args stored as JSON string in msg.content (for tool call messages). */
function parseArgsSafe(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}
