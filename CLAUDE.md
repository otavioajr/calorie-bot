# CLAUDE.md — CalorieBot

## O que é este projeto

CalorieBot é um assistente de controle de calorias via WhatsApp. O usuário manda o que comeu em linguagem natural e o bot calcula as calorias usando LLM. Existe uma página web simples para cadastro, configurações e dashboard.

O PRD completo está em `PRD.md` (raiz do projeto) — consulte-o para fluxos conversacionais detalhados, regras de negócio e decisões técnicas. O design spec está em `docs/superpowers/specs/2026-03-21-caloriebot-design.md`.

---

## Stack

- **Framework:** Next.js (App Router)
- **Linguagem:** TypeScript (strict mode)
- **Banco de dados:** Supabase (Postgres + Auth + Realtime)
- **LLM:** OpenRouter (principal) ou Ollama (local) — providers independentes, mesma interface
- **WhatsApp:** Meta Cloud API (Business)
- **Testes:** Vitest (unit/integration) + Playwright (e2e) + MSW (mocks)
- **UI:** shadcn/ui + Tailwind CSS (paleta colorida/amigável)
- **Gráficos:** recharts
- **Validação:** Zod (schemas de output da LLM)
- **Deploy:** Vercel
- **Dev tunnel:** ngrok (webhook local)

---

## Estrutura do Projeto

```
caloriebot/
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── (auth)/                   # Rotas autenticadas
│   │   │   ├── dashboard/            # Dashboard com resumo calórico
│   │   │   ├── settings/             # Configurações do usuário
│   │   │   └── history/              # Histórico de refeições
│   │   ├── api/
│   │   │   ├── webhook/
│   │   │   │   └── whatsapp/route.ts # Webhook do WhatsApp (POST + GET para verificação, suporte a texto, áudio e imagem)
│   │   │   ├── auth/otp/
│   │   │   │   ├── send/route.ts     # Gera e envia OTP via WhatsApp
│   │   │   │   └── verify/route.ts   # Valida OTP e cria sessão
│   │   │   ├── user/
│   │   │   │   └── reset-data/route.ts # Limpa dados do usuário e reinicia onboarding
│   │   │   └── cron/
│   │   │       └── reminders/route.ts # Cron jobs para lembretes
│   │   ├── layout.tsx
│   │   └── page.tsx                  # Landing + Login (OTP via WhatsApp)
│   │
│   ├── lib/
│   │   ├── llm/
│   │   │   ├── provider.ts           # Interface LLMProvider
│   │   │   ├── providers/
│   │   │   │   ├── openrouter.ts     # Implementação OpenRouter
│   │   │   │   └── ollama.ts         # Implementação Ollama
│   │   │   ├── schemas/
│   │   │   │   ├── meal-analysis.ts  # Zod schema MealAnalysis
│   │   │   │   ├── image-analysis.ts # Zod schema ImageAnalysis
│   │   │   │   ├── intent.ts         # Zod schema IntentType
│   │   │   │   └── common.ts         # Tipos compartilhados
│   │   │   ├── prompts/
│   │   │   │   ├── approximate.ts    # System prompt — modo aproximado
│   │   │   │   ├── taco.ts           # System prompt — modo TACO
│   │   │   │   ├── manual.ts         # System prompt — modo manual
│   │   │   │   ├── classify.ts       # System prompt — classificador de intenção
│   │   │   │   └── vision.ts         # System prompt — análise de imagem (tabela nutricional)
│   │   │   └── index.ts              # Factory: retorna provider ativo via LLM_PROVIDER
│   │   │
│   │   ├── audio/
│   │   │   └── transcribe.ts         # Download WhatsApp media + Whisper transcription
│   │   │
│   │   ├── whatsapp/
│   │   │   ├── client.ts             # Envio de mensagens via Meta Cloud API
│   │   │   ├── webhook.ts            # Parsing de mensagens recebidas
│   │   │   ├── media.ts              # Shared media download utility (WhatsApp Media API)
│   │   │   ├── mime.ts               # MIME type detection from buffer
│   │   │   └── templates.ts          # Message templates (lembretes)
│   │   │
│   │   ├── bot/
│   │   │   ├── router.ts             # Classificador de intenção (regras + LLM fallback)
│   │   │   ├── flows/
│   │   │   │   ├── onboarding.ts     # Fluxo de cadastro conversacional (8 passos, incl. sexo)
│   │   │   │   ├── meal-log.ts       # Registro de refeição
│   │   │   │   ├── summary.ts        # Resumo do dia/semana
│   │   │   │   ├── edit.ts           # Corrigir/apagar registro
│   │   │   │   ├── query.ts          # Consulta avulsa de calorias
│   │   │   │   ├── weight.ts         # Registro de peso
│   │   │   │   ├── settings.ts       # Configurações via WhatsApp
│   │   │   │   └── help.ts           # Menu/ajuda
│   │   │   └── state.ts              # Gerenciamento de estado da conversa (conversation_context)
│   │   │
│   │   ├── db/
│   │   │   ├── supabase.ts           # Cliente Supabase (server + client)
│   │   │   ├── queries/              # Queries organizadas por domínio
│   │   │   │   ├── users.ts
│   │   │   │   ├── meals.ts
│   │   │   │   ├── settings.ts
│   │   │   │   ├── weight.ts
│   │   │   │   ├── taco.ts
│   │   │   │   ├── food-cache.ts
│   │   │   │   ├── context.ts
│   │   │   │   └── auth-codes.ts     # CRUD para auth_codes (OTP WhatsApp)
│   │   │   └── types.ts              # Tipos gerados pelo Supabase CLI
│   │   │
│   │   ├── auth/
│   │   │   └── otp.ts                # Lógica OTP: gerar, validar, rate limit
│   │   │
│   │   ├── calc/
│   │   │   └── tdee.ts               # Cálculo de TMB/TDEE (Mifflin-St Jeor, com sexo)
│   │   │
│   │   └── utils/
│   │       ├── validators.ts         # Validação de inputs do onboarding
│   │       └── formatters.ts         # Formatação de mensagens do bot
│   │
│   └── components/                   # Componentes React da web
│       ├── ui/                       # Componentes base (shadcn/ui)
│       ├── dashboard/
│       ├── settings/
│       │   └── ResetDataButton.tsx  # Botão de limpar dados com confirmação
│       └── history/
│
├── tests/
│   ├── unit/                         # Testes unitários (calc, validators, bot, llm)
│   ├── integration/                  # Testes com Supabase local (queries, RLS, OTP)
│   └── e2e/                          # Testes e2e (webhook, onboarding, meal-log)
│
├── scripts/
│   └── seed-taco.ts                  # Script para carregar Tabela TACO
│
├── supabase/
│   ├── migrations/                   # SQL migrations
│   └── seed.sql                      # Seed da Tabela TACO
│
├── docs/
│   └── PRD.md                        # PRD completo do projeto
│
├── .env.local                        # Variáveis de ambiente (NÃO commitar)
├── .env.example                      # Template de variáveis
└── CLAUDE.md                         # Este arquivo
```

---

## Variáveis de Ambiente

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# WhatsApp (Meta Cloud API)
WHATSAPP_VERIFY_TOKEN=token-aleatorio-que-voce-define
WHATSAPP_ACCESS_TOKEN=EAAx...
WHATSAPP_PHONE_NUMBER_ID=123456789
WEBHOOK_BASE_URL=https://abc123.ngrok-free.app  # dev: ngrok | prod: domínio Vercel

# LLM — basta configurar UM provider
LLM_PROVIDER=openrouter                                     # openrouter | ollama
LLM_API_KEY=sk-or-v1-...                                    # só pra openrouter
LLM_MODEL_MEAL=openai/gpt-4o-mini                           # análise de refeição
LLM_MODEL_CLASSIFY=meta-llama/llama-3.1-8b-instruct:free    # classificar intenção
LLM_MODEL_VISION=openai/gpt-4o                              # foto de tabela nutricional

# Ollama — só se LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL_MEAL=llama3.1:8b
OLLAMA_MODEL_CLASSIFY=llama3.1:8b
OLLAMA_MODEL_VISION=llava:13b

# Fallback (opcional — vazio = sem fallback)
LLM_FALLBACK_PROVIDER=

# Audio (OpenAI Whisper)
OPENAI_API_KEY=sk-...                                       # transcrição de áudio via Whisper
```

---

## Banco de Dados

### Tabelas principais

| Tabela                 | Descrição                                                    |
|------------------------|--------------------------------------------------------------|
| `users`                | Dados do usuário + configurações de cálculo (phone, sexo, peso, meta, modo) |
| `user_settings`        | Configurações do bot (lembretes, horários, nível de detalhe) |
| `meals`                | Refeições registradas (total de calorias, tipo, mensagem original) |
| `meal_items`           | Itens individuais de cada refeição (alimento, gramas, calorias, macros) |
| `taco_foods`           | Tabela TACO pré-carregada (alimentos brasileiros — somente leitura) |
| `food_cache`           | Cache de respostas da LLM para alimentos comuns              |
| `weight_log`           | Histórico de pesagens do usuário                              |
| `conversation_context` | Estado atual da conversa no WhatsApp (máquina de estados)     |
| `auth_codes`           | Códigos OTP para autenticação web via WhatsApp                |
| `llm_usage_log`        | Log de chamadas à LLM (tokens, custo, modelo, latência)      |

### Regras de RLS

Todas as tabelas de usuário usam Row Level Security. Cada usuário só acessa seus próprios dados. `taco_foods` e `food_cache` são leitura pública, escrita via service role.

### Sincronização Web ↔ Bot

O banco Supabase é a **única fonte de verdade**. Nunca cachear configs do usuário no bot — a cada mensagem recebida, buscar configs atuais do banco. Mudanças na web refletem imediatamente no bot e vice-versa.

---

## Arquitetura do Bot (Máquina de Estados)

O bot WhatsApp opera como máquina de estados. Cada mensagem recebida passa por este pipeline:

```
Mensagem → Tem cadastro? → Onboarding completo? → Classificar intenção → Executar fluxo
```

### Classificação de intenção (híbrida)

1. **Primeiro:** regras fixas via keywords (custo zero, sem LLM)
2. **Segundo:** se nenhuma regra matchou, usa LLM para classificar
3. **Fallback:** se LLM retorna "out_of_scope", responde com mensagem padrão

### Fluxos disponíveis

| Fluxo            | Usa LLM? | Descrição                               |
|------------------|----------|-----------------------------------------|
| `onboarding`     | NÃO      | Cadastro conversacional (8 passos fixos, incl. sexo)|
| `meal_log`       | SIM      | Registro de refeição                    |
| `summary`        | NÃO      | Resumo do dia/semana (dados do banco)   |
| `edit`           | SIM      | Corrigir/apagar registro                |
| `query`          | SIM      | Consulta avulsa (sem registrar)         |
| `weight`         | NÃO      | Registro de peso                        |
| `settings`       | NÃO      | Configurações via menu numerado (8 opções, incl. reset de dados) |
| `help`           | NÃO      | Menu de opções                          |

### Estado da conversa (`conversation_context`)

Cada estado ativo é salvo na tabela `conversation_context` com TTL de expiração. Se expirar, a próxima mensagem é tratada como nova. Tipos: `onboarding`, `awaiting_confirmation`, `awaiting_clarification`, `awaiting_correction`, `awaiting_weight`, `awaiting_label_portions`, `settings_menu`, `settings_change`, `awaiting_reset_confirmation`.

---

## LLM Service

### Interface (ambos providers implementam)

```typescript
interface LLMProvider {
  analyzeMeal(message: string, mode: CalorieMode, context?: TacoFood[]): Promise<MealAnalysis>;
  classifyIntent(message: string): Promise<IntentType>;
  chat(message: string, systemPrompt: string): Promise<string>;
}
```

### Providers

- **OpenRouter:** API compatível com OpenAI (`https://openrouter.ai/api/v1/chat/completions`). Exige headers `HTTP-Referer` e `X-Title`.
- **Ollama:** API local (`http://localhost:11434/api/chat`). Usar `format: "json"` e `stream: false`.

Cada provider funciona **sozinho**. Se `LLM_PROVIDER=openrouter`, as variáveis do Ollama são ignoradas. Fallback é opcional.

### Modelos por função

Usar modelos diferentes conforme a tarefa:
- **Classificação de intenção:** modelo gratuito (ex: `meta-llama/llama-3.1-8b-instruct:free`)
- **Análise de refeição:** modelo com bom raciocínio (ex: `openai/gpt-4o-mini`)
- **Visão (foto de tabela):** modelo com suporte a imagem (ex: `openai/gpt-4o`)

### Output estruturado

Toda chamada à LLM exige resposta em JSON. A camada de abstração valida o schema antes de retornar. Se inválido, retenta uma vez.

---

## Modos de Cálculo Calórico

| Modo          | Chave no banco   | Comportamento da LLM                                           |
|---------------|------------------|----------------------------------------------------------------|
| Aproximado    | `approximate`    | LLM estima livremente com conhecimento geral                    |
| Tabela TACO   | `taco`           | LLM recebe dados da Tabela TACO como contexto e prioriza eles  |
| Manual        | `manual`         | Usuário envia foto/texto da tabela nutricional, LLM extrai dados|

O modo ativo vem de `users.calorie_mode` (buscar do banco a cada chamada, nunca cachear).

---

## Regras Invioláveis do Bot

Estas regras devem ser respeitadas em TODO código que gera respostas do bot:

1. **NUNCA** dar conselhos médicos, prescrever dietas ou sugerir suplementos
2. **NUNCA** fazer diagnósticos de saúde
3. **NUNCA** inventar dados nutricionais — se não souber, perguntar ao usuário
4. **SEMPRE** confirmar antes de registrar no banco
5. **NUNCA** responder sobre assuntos fora do escopo (calorias, macros, refeições)
6. Mensagens do bot: máximo **300 caracteres** (exceto breakdown de refeição)
7. Fora do escopo, responder: "Sou especializado em controle de calorias 🍽️ Não consigo te ajudar com isso, mas posso registrar uma refeição ou te mostrar seu resumo do dia!"
8. Erro de sistema: "Ops, tive um probleminha aqui 😅 Tenta de novo em alguns segundos?"

### System prompt para análise de refeição

```
Você é um analisador nutricional. Sua ÚNICA função é:
1. Identificar alimentos mencionados
2. Estimar quantidades em gramas
3. Calcular calorias e macros

REGRAS ABSOLUTAS:
- Responda APENAS em JSON no formato especificado
- NUNCA dê conselhos de saúde, dieta ou nutrição
- NUNCA sugira alimentos ou substituições
- NUNCA comente sobre a qualidade da refeição
- Se não reconhecer um alimento, coloque em "unknown_items"
- Se não tiver certeza da quantidade, marque "confidence": "low"
- NUNCA invente valores — se não souber, retorne needs_clarification: true
- Use APENAS dados da Tabela TACO quando o modo for "taco"
```

### JSON esperado da LLM (análise de refeição)

```json
{
  "meal_type": "lunch",
  "confidence": "high",
  "items": [
    {
      "food": "Arroz branco",
      "quantity_grams": 150,
      "quantity_source": "estimated",
      "calories": 195,
      "protein": 4.0,
      "carbs": 42.0,
      "fat": 0.5,
      "taco_match": true,
      "taco_id": 123
    }
  ],
  "unknown_items": [],
  "needs_clarification": false
}
```

---

## Cálculos (TMB / TDEE)

Usar fórmula de **Mifflin-St Jeor**:

```
TMB Homem   = 10 × peso(kg) + 6.25 × altura(cm) - 5 × idade + 5
TMB Mulher  = 10 × peso(kg) + 6.25 × altura(cm) - 5 × idade - 161
```

Fatores de atividade para TDEE:
- Sedentário: TMB × 1.2
- Leve: TMB × 1.375
- Moderado: TMB × 1.55
- Intenso: TMB × 1.725

Meta calórica:
- Perder peso: TDEE - 500 kcal
- Manter peso: TDEE
- Ganhar massa: TDEE + 300 kcal

Implementar em `src/lib/calc/tdee.ts`. Recalcular automaticamente quando peso, altura, idade, atividade ou objetivo mudarem.

---

## Convenções de Código

### Geral

- TypeScript strict mode em todo o projeto
- Usar `async/await`, nunca callbacks
- Um arquivo = uma responsabilidade
- Nomear arquivos em kebab-case (`meal-log.ts`, `food-cache.ts`)
- Nomear componentes React em PascalCase (`DashboardCard.tsx`)
- Exportar tipos/interfaces junto ao módulo que os define
- Nunca usar `any` — tipar tudo

### Next.js

- Usar App Router (não Pages Router)
- API Routes em `src/app/api/`
- Server Components por padrão, `"use client"` só quando necessário
- Usar Supabase SSR helpers para auth nas server components

### Supabase

- Usar `@supabase/supabase-js` para client-side
- Usar `@supabase/ssr` para server-side (API routes, server components)
- Gerar tipos com `supabase gen types typescript` e manter em `src/lib/db/types.ts`
- Toda query de dados de usuário DEVE passar pelo RLS (nunca usar service role para queries de usuário)
- Service role APENAS para: seed da Tabela TACO, food_cache writes, cron jobs

### Tratamento de erros

- Webhook do WhatsApp: SEMPRE retornar 200 (mesmo em erro) para a Meta não reenviar
- Chamadas à LLM: try/catch com retry (1x), logar em `llm_usage_log`
- Erros de validação no onboarding: mensagem amigável, manter estado atual
- Nunca expor stack traces ou erros internos para o usuário

### Mensagens do bot

- Tom: amigável, conciso, com emojis moderados
- Idioma: PT-BR
- Sempre incluir progresso diário após registro (`📊 Hoje: X / Y kcal`)
- Menus com opções numeradas (1️⃣ 2️⃣ 3️⃣) para facilitar resposta

---

## Comandos

```bash
# Desenvolvimento
npm run dev                    # Next.js dev server (localhost:3000)
ngrok http 3000                # Tunnel para webhook (terminal separado)

# Banco de dados
npx supabase gen types typescript --project-id <id> > src/lib/db/types.ts
npx supabase db push           # Aplicar migrations
npx supabase db reset          # Reset + seed

# Testes
npm run test                   # Vitest (unit + integration)
npm run test:unit              # Apenas testes unitários
npm run test:integration       # Apenas testes de integração (requer supabase start)
npm run test:e2e               # Playwright (e2e)

# Deploy
vercel                         # Deploy para Vercel
```

---

## Checklist antes de commitar

- [ ] TypeScript compila sem erros (`npx tsc --noEmit`)
- [ ] Webhook retorna 200 em todos os cenários
- [ ] Nenhuma config do usuário está cacheada no bot
- [ ] LLM responses são validadas contra o schema esperado
- [ ] Nenhuma chave de API está hardcoded (tudo via env)
- [ ] Mensagens do bot respeitam as regras invioláveis (seção acima)
- [ ] Queries de usuário passam pelo RLS (não usam service role)

---

## O que NÃO fazer

- **NÃO** cachear configurações do usuário no bot — sempre buscar do banco
- **NÃO** usar a LLM para fluxos que não precisam (onboarding, resumo, peso, menu, config)
- **NÃO** deixar a LLM dar conselhos de saúde/dieta em nenhuma resposta
- **NÃO** registrar refeição sem confirmação do usuário
- **NÃO** usar `localStorage`/`sessionStorage` — estado do bot fica em `conversation_context`
- **NÃO** commitar `.env.local`, URLs do ngrok, ou chaves de API
- **NÃO** usar Pages Router — o projeto usa App Router
- **NÃO** misturar lógica de fluxo do bot com lógica de LLM — são camadas separadas
- **NÃO** assumir que ambos providers (OpenRouter + Ollama) estão configurados — cada um funciona sozinho