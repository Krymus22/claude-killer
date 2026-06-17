# Claude-Killer 🤖

> **MVP CLI** — Agente de código local alimentado pelo **Kimi K2.6** via **NVIDIA NIM API**

Uma ferramenta de linha de comando que conecta o modelo Kimi K2.6 ao seu repositório local, permitindo que ele leia, analise, crie e edite arquivos de código diretamente — com um sistema anti-alucinação integrado que valida a sintaxe **antes** de salvar qualquer alteração.

---

## ✨ Funcionalidades

| Módulo | Descrição |
|---|---|
| **Cliente NVIDIA NIM** | Usa a biblioteca OpenAI apontada para `integrate.api.nvidia.com/v1` |
| **Mutex de Concorrência** | Máximo de 1 requisição em andamento — a segunda espera na fila |
| **Rate Limiter** | Janela deslizante de 60 s — nunca ultrapassa N rpm (padrão: 40) |
| **Histórico Stateless** | Array em memória enviado completo a cada requisição |
| **Tool Calling** | `ler_arquivo`, `aplicar_diff`, `desfazer_edicao`, `executar_comando` e mais |
| **Loop do Agente** | Ciclo ReAct automático: chama tools → recebe resultado → continua |
| **Guardrail Anti-Alucinação** | Valida sintaxe antes de salvar; auto-cura em até 3 tentativas |
| **Think Tool (pensar)** | Espaço estruturado de raciocínio obrigatório antes de cada escrita |
| **Read-before-Write** | Gate programático: bloqueia editar arquivos não lidos antes |
| **Rollback automático** | Backup de cada edição em `.rollback/` + tool `desfazer_edicao` |
| **Strict Quality Gate** | `tsc --noEmit` + `npm run lint` obrigatórios antes de finish_reason (STRICT_MODE) |
| **Tool Schema Validation** | Validação de argumentos contra JSON Schema antes de executar |
| **Poka-Yoke** | Paths absolutos obrigatórios, descrições expandidas com exemplos |
| **Structured Note-Taking** | `TASK_STATE.md` (feito/falta/decisões/bugs/dependências) atualizado a cada turno |
| **Async Command Execution** | `executar_comando` usa `spawn` com streaming — não bloqueia o event loop |
| **LSP Integration** | Conecta a tsserver/pylsp reais, com fallback para tree-sitter |
| **TASK_STATE Tools** | `atualizar_estado`, `marcar_feito`, `ler_estado` |

---

## 🗂 Estrutura de Arquivos

```
claude-killer/
├── src/
│   ├── index.ts                 ← Entry point: Ink TUI app
│   ├── agent.ts                 ← Loop do agente ReAct + integração de gates
│   ├── apiClient.ts             ← Cliente NVIDIA NIM + TOOL_DEFINITIONS
│   ├── history.ts               ← Histórico em memória + system prompt
│   ├── tools.ts                 ← ler_arquivo / aplicar_diff / desfazer_edicao / executar_comando
│   ├── guardrail.ts             ← Validação de sintaxe por extensão (advisory)
│   ├── strictQualityGate.ts     ← Quality Gate determinístico (STRICT_MODE)
│   ├── readBeforeWrite.ts       ← Gate programático: bloqueia edits sem leitura prévia
│   ├── rollbackStore.ts         ← Backups automáticos em .rollback/ + restore
│   ├── thinkTool.ts             ← Tool "pensar" — espaço estruturado de raciocínio
│   ├── toolSchemaValidation.ts  ← Validação de args contra JSON Schema
│   ├── pokaYoke.ts              ← Error-proofing + descrições expandidas com exemplos
│   ├── taskState.ts             ← TASK_STATE.md estruturado
│   ├── lspClient.ts             ← Cliente LSP real (tsserver/pylsp) com fallback
│   ├── lspAst.ts                ← AST parsing via tree-sitter (fallback do LSP)
│   ├── memory.ts                ← Memória persistente (checkpoint, project, global, history)
│   ├── shell.ts                 ← runShell (async) + runShellSync
│   ├── config.ts                ← Config centralizada via env vars
│   └── logger.ts                ← Output estilizado com chalk
├── src/__tests__/               ← 1700+ testes (vitest)
├── src/tools/                   ← External tool integrations (python, node, rust, go, docker, roblox)
├── src/tui/                     ← Ink-based TUI components
├── package.json
└── tsconfig.json
```

---

## ⚙️ Variáveis de Ambiente (além das originais)

| Variável | Default | Descrição |
|---|---|---|
| `NVIDIA_API_KEY` | (required) | API key NVIDIA NIM |
| `MODEL` | `moonshotai/kimi-k2.6` | Modelo a usar |
| `STRICT_MODE` | `true` | Liga o Quality Gate determinístico |
| `STRICT_GATE_TSC` | `true` | Roda `tsc --noEmit` no gate |
| `STRICT_GATE_LINT` | `true` | Roda `npm run lint` no gate |
| `STRICT_GATE_MAX_BLOCKS` | `8` | Máximo de bloqueios consecutivos |
| `STRICT_GATE_SKIP_PATTERNS` | (vazio) | Globs para pular o gate (ex.: `**/*.md,**/*.json`) |
| `LSP_ENABLED` | `true` | Liga LSP real (tsserver/pylsp) |
| `LSP_TSSERVER_PATH` | auto-detected | Caminho do tsserver / typescript-language-server |
| `LSP_PYLSP_PATH` | auto-detected | Caminho do pylsp |
| `LSP_REQUEST_TIMEOUT_MS` | `5000` | Timeout por request LSP |
| `MAX_HEAL_RETRIES` | `3` | Tentativas de auto-cura do guardrail advisory |

---

## 🚀 Setup & Execução

### 1. Instalar dependências

```bash
cd c:\Users\kryst\Downloads\Claude-Killer
npm install
```

### 2. Configurar a API Key

```bash
# Copie o template
copy .env.example .env

# Edite o arquivo .env e coloque sua chave da NVIDIA NIM
# NVIDIA_API_KEY=nvapi-xxxxxxxxxxxxxxxxxxxx
```

> 🔑 Obtenha sua chave em: https://build.nvidia.com/ → Kimi K2.6 → Get API Key

### 3. Build e execução

```bash
# Build TypeScript
npm run build

# Executar a CLI
npm start

# Ou em modo dev (sem build)
npm run dev
```

---

## 💬 Uso Interativo

```
╰─ ❯ Leia o arquivo src/index.ts e me explique o que ele faz
╰─ ❯ Crie um arquivo chamado utils/math.ts com funções de soma e multiplicação
╰─ ❯ Refatore o arquivo src/tools.ts para usar async/await em vez de callbacks
```

### Slash Commands

| Comando | Ação |
|---|---|
| `/help` | Lista de comandos disponíveis |
| `/reset` | Limpa o histórico da conversa |
| `/history` | Mostra estatísticas do histórico atual |
| `/exit` | Sai da CLI |

---

## 🛡 Sistema Anti-Alucinação

Quando o Claude-Killer tenta editar um arquivo:

```
1. Claude-Killer chama aplicar_diff(caminho, bloco_diff)
         │
         ▼
2. Modificação é aplicada em memória e o Guardrail analisa a extensão do arquivo
         │
   ┌─────┴─────┐
   │           │
 VÁLIDO     INVÁLIDO
   │           │
   ▼           ▼
3a. Salva   3b. Injeta erro no histórico
  no disco      → Reenvia ao Claude-Killer
                → Claude-Killer corrige e retenta
                │ Até 3 tentativas
                └ Se falhar: alteração NÃO é salva
```

### Extensões suportadas pelo guardrail

| Extensão | Validador |
|---|---|
| `.js` `.mjs` `.cjs` | `node --check` (built-in) |
| `.ts` `.tsx` | `tsc --noEmit` via npx |
| `.json` | `JSON.parse()` nativo |
| `.py` | `python3 -m py_compile` |
| `.java` | `javac` (requer JDK) |
| `.html` `.htm` | Heurística de tags |
| `.css` `.scss` | Heurística de chaves |
| outros | Passthrough (sem checagem) |

---

## ⚙️ Variáveis de Ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `NVIDIA_API_KEY` | **obrigatório** | Chave da API NVIDIA NIM |
| `RATE_LIMIT_RPM` | `40` | Máximo de requisições por minuto |
| `MAX_CONCURRENCY` | `1` | Máximo de chamadas simultâneas (fixo em 1) |
| `MAX_HEAL_RETRIES` | `3` | Tentativas de auto-cura do guardrail |
| `DEBUG` | `false` | Ativa logs internos detalhados |

---

## 🏗 Arquitetura Técnica

```
┌─────────────────────────────────────────────────────┐
│                   index.ts (REPL)                   │
│  readline → slash cmds → ora spinner → agent loop   │
└─────────────────────┬───────────────────────────────┘
                      │ userInput
                      ▼
┌─────────────────────────────────────────────────────┐
│                  agent.ts (Loop)                    │
│  addUserMessage → chat() → tool_calls? → dispatch   │
│  [recursivo até finish_reason = "stop"]             │
└──────┬──────────────────────────────┬───────────────┘
       │                              │
       ▼                              ▼
┌─────────────────┐    ┌──────────────────────────────┐
│  apiClient.ts   │    │          tools.ts            │
│  Mutex          │    │  ler_arquivo()               │
│  RateLimiter    │    │  aplicarDiff()               │
│  OpenAI client  │    │      └── guardrail.ts        │
└─────────────────┘    └──────────────────────────────┘
       │
       ▼
┌─────────────────┐
│  history.ts     │
│  Message[]      │
│  System Prompt  │
└─────────────────┘
```

---

## 📋 Requisitos

- **Node.js** ≥ 18.0.0
- **NVIDIA NIM API Key** (modelo: `moonshotai/kimi-k2.6`)
- Opcional: `python3`, `javac` para validação das respectivas extensões
