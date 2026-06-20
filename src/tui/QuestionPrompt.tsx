/**
 * QuestionPrompt.tsx — UI de pergunta interativa (AskUser)
 *
 * Renderiza uma pergunta com alternativas numeradas + input livre.
 * Inspirado no AskUserQuestion do Claude Code.
 *
 * Interação:
 *   Setas ↑↓     navega entre alternativas
 *   1-6           seleciona alternativa diretamente
 *   Enter         confirma seleção
 *   Tab           alterna entre "escolher alternativa" e "digitar resposta"
 *   Esc           cancela pergunta
 *
 * Quando o usuário confirma, chama onRespond com a resposta.
 * Quando cancela, chama onRespond com cancelled: true.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { colors, icons } from "./theme.js";
import type { AskUserQuestion, AskUserResponse } from "../askUser.js";

interface QuestionPromptProps {
  question: AskUserQuestion;
  onRespond: (response: AskUserResponse) => void;
}

type Mode = "select" | "type";

export function QuestionPrompt({ question, onRespond }: Readonly<QuestionPromptProps>) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<Mode>("select");
  const [typedText, setTypedText] = useState("");

  const alternatives = question.alternativas.slice(0, 6);

  useInput((inputChar, key) => {
    // Esc always cancels
    if (key.escape) {
      onRespond({ value: "", cancelled: true, fromAlternatives: false });
      return;
    }

    // Tab toggles between select and type mode
    if (key.tab) {
      setMode((prev) => (prev === "select" ? "type" : "select"));
      return;
    }

    if (mode === "select") {
      // Arrow navigation
      if (key.upArrow) {
        setSelectedIndex((prev) => (prev === 0 ? alternatives.length - 1 : prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((prev) => (prev === alternatives.length - 1 ? 0 : prev + 1));
        return;
      }
      // Number keys 1-6 select directly
      if (inputChar >= "1" && inputChar <= String(alternatives.length)) {
        const idx = Number.parseInt(inputChar, 10) - 1;
        if (idx >= 0 && idx < alternatives.length) {
          setSelectedIndex(idx);
          onRespond({
            value: alternatives[idx]!,
            cancelled: false,
            fromAlternatives: true,
          });
        }
        return;
      }
      // Enter confirms current selection
      if (key.return) {
        onRespond({
          value: alternatives[selectedIndex]!,
          cancelled: false,
          fromAlternatives: true,
        });
        return;
      }
      // If user starts typing non-number, switch to type mode
      if (inputChar && !key.ctrl && !key.meta && inputChar !== "" && inputChar !== " ") {
        setMode("type");
        setTypedText(inputChar);
        return;
      }
      if (inputChar === " ") {
        setMode("type");
        setTypedText(" ");
        return;
      }
    } else {
      // Type mode — free text input
      if (key.return) {
        const trimmed = typedText.trim();
        if (trimmed) {
          onRespond({
            value: trimmed,
            cancelled: false,
            fromAlternatives: false,
          });
        }
        return;
      }
      if (key.backspace || key.delete) {
        setTypedText((prev) => prev.slice(0, -1));
        return;
      }
      // Regular character
      if (inputChar && !key.ctrl && !key.meta && inputChar !== "") {
        setTypedText((prev) => prev + inputChar);
        return;
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.warning} paddingX={1} paddingY={0} marginY={1}>
      {/* Header */}
      <Box>
        <Text color={colors.warning} bold>
          {" "}{"❓"} {question.pergunta}
        </Text>
      </Box>

      {/* Context (if provided) */}
      {question.contexto && (
        <Box marginTop={0}>
          <Text color={colors.muted}> {" "}Contexto: {question.contexto}</Text>
        </Box>
      )}

      {/* Alternativas */}
      <Box flexDirection="column" marginTop={0}>
        {alternatives.map((alt, i) => {
          const isSelected = i === selectedIndex && mode === "select";
          const prefix = isSelected ? `${icons.arrowRight} ` : "  ";
          const num = `[${i + 1}]`;
          return (
            <Box key={`alt-${i}`}>
              <Text color={isSelected ? colors.primary : colors.muted}>
                {" "}{prefix}{num} {alt}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Input area */}
      <Box marginTop={0}>
        <Text color={colors.muted}>
          {" "}{mode === "select"
            ? `↑↓ navegar | 1-${alternatives.length} escolher | Tab digitar livre | Enter confirmar | Esc cancelar`
            : `Digite sua resposta (Tab: voltar pra alternativas | Enter: confirmar | Esc: cancelar)`}
        </Text>
      </Box>

      {/* Typed text (only in type mode) */}
      {mode === "type" && (
        <Box>
          <Text color={colors.white} bold>
            {" "}{">"} {typedText}
            <Text color={colors.primary}>_</Text>
          </Text>
        </Box>
      )}

      {/* Selected indicator (only in select mode) */}
      {mode === "select" && (
        <Box>
          <Text color={colors.primary}>
            {" "}Selecionado: {alternatives[selectedIndex]}
          </Text>
        </Box>
      )}
    </Box>
  );
}
