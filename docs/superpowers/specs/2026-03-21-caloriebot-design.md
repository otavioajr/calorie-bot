# CalorieBot — Design Spec

**Data:** 2026-03-21
**Status:** Aprovado
**Base:** PRD.md v1.0

---

## 1. Visao Geral

CalorieBot e um assistente de controle de calorias via WhatsApp. O usuario registra refeicoes em linguagem natural e o bot calcula calorias usando LLM. Uma pagina web complementar oferece cadastro, configuracoes e dashboard.

Este documento captura as decisoes de design tomadas durante o brainstorming, complementando o PRD com escolhas de implementacao.

---

## 2. Decisoes de Design

### 2.1 Sexo Biologico no Onboarding

A formula Mifflin-St Jeor exige sexo biologico. Adicionado como **Passo 2.5** no onboarding conversacional.

**Fluxo:**
```
PASSO 2.5 — SEXO BIOLOGICO
Bot: "Para calcular sua meta calorica, preciso saber:
      1 Masculino
      2 Feminino"
Esperado: 1 ou 2
Validacao: match com uma das opcoes
Erro: "Escolhe: 1 (masculino) ou 2 (feminino)"
Salva: users.sex
Proximo: PASSO 3
```

**Impacto no banco:**
```sql
ALTER TABLE users ADD COLUMN sex VARCHAR(10) CHECK (sex IN ('male','female'));
```

Onboarding sobe de 7 para 8 passos (onboarding_step max = 8).

### 2.2 Autenticacao Web via WhatsApp OTP

Substituido magic link (email) por OTP customizado enviado via WhatsApp.

**Fluxo:**
1. Usuario digita numero de telefone na web
2. Backend gera codigo de 6 digitos, salva em `auth_codes` com TTL de 5 min
3. Bot envia via Meta Cloud API: "Seu codigo de acesso ao CalorieBot Web: **123456** (expira em 5 min)"
4. Usuario digita codigo na web
5. Backend valida, cria/recupera user no Supabase Auth, inicia sessao

**Tabela:**
```sql
CREATE TABLE auth_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(20) NOT NULL,
    code VARCHAR(6) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Seguranca:**
- Rate limit: maximo 3 codigos por telefone a cada 15 min
- Codigo expira em 5 min
- Codigo marcado como `used` apos validacao (single-use)
- Sem email, sem Twilio, sem custo extra

**Vantagens:**
- Codigo chega onde o usuario ja esta (WhatsApp)
- Vinculacao web <-> bot automatica pelo numero de telefone
- Zero dependencias externas adicionais

### 2.3 Estrategia de Testes

Testes completos: unitarios + integracao + e2e.

**Ferramentas:**
- **Vitest** — runner para unit + integration
- **Playwright** — e2e para a web
- **MSW (Mock Service Worker)** — mock da Meta API e OpenRouter
- **Supabase local** (`supabase start`) — banco real para testes de integracao + RLS

**Estrutura:**
```
tests/
├── unit/
│   ├── calc/tdee.test.ts                  # Mifflin-St Jeor: M/F, goals, activity levels
│   ├── bot/router.test.ts                 # Classificador de intencao (regras fixas)
│   ├── bot/onboarding.test.ts             # Validacoes de cada passo
│   ├── bot/state.test.ts                  # Gerenciamento de contexto + expiracao
│   ├── llm/schemas.test.ts               # Zod schemas validam/rejeitam
│   ├── llm/prompts.test.ts               # Prompts montados por modo
│   ├── whatsapp/webhook.test.ts           # Parsing de payloads Meta
│   ├── utils/validators.test.ts           # Validacoes de input
│   └── utils/formatters.test.ts           # Formatacao de mensagens
├── integration/
│   ├── db/queries.test.ts                 # CRUD users, meals, meal_items, weight_log
│   ├── db/rls.test.ts                     # RLS: user A nao ve dados do user B
│   ├── llm/providers.test.ts              # Chamada real ao OpenRouter/Ollama
│   └── auth/otp.test.ts                   # Fluxo OTP: gerar, validar, expirar, rate limit
└── e2e/
    ├── webhook.test.ts                    # Payload Meta -> webhook -> resposta
    └── flows/
        ├── onboarding.test.ts             # Onboarding completo (8 passos)
        └── meal-log.test.ts               # Registro de refeicao e2e
```

**O que mockar vs real:**
- Mock: Meta Cloud API, OpenRouter/Ollama (nos testes unitarios)
- Real: Supabase local, calculos TDEE, validacoes, state machine

### 2.4 Visual da Web

Estilo colorido e amigavel, remetendo a saude/alimentacao.

- **Base:** shadcn/ui + Tailwind CSS
- **Paleta:** greens (dentro da meta), oranges (atencao), reds (excedeu)
- **Componentes:** cards arredondados, icones de alimentos, barra de progresso calorico
- **Graficos:** recharts (leve, React)
- **Layout:** responsivo mobile-first (usuarios vem do link no WhatsApp)

### 2.5 Estrategia de Implementacao

**Abordagem: Vertical Slices** — cada fatia entrega um fluxo funcional de ponta a ponta.

**Ordem:**
1. Setup do projeto + banco (migrations, RLS, seed TACO)
2. Webhook WhatsApp + onboarding completo (primeiro fluxo funcional)
3. LLM service + registro de refeicao (core do produto)
4. Resumo + consulta + edicao + peso (fluxos secundarios)
5. Web app (auth OTP + dashboard + settings + history)
6. Cron jobs (lembretes)

---

## 3. Arquitetura

### 3.1 Estrutura do Projeto

Conforme CLAUDE.md com adicoes:

```
caloriebot/
├── src/
│   ├── app/                              # Next.js App Router
│   │   ├── page.tsx                      # Landing + login (campo telefone)
│   │   ├── (auth)/
│   │   │   ├── layout.tsx                # Layout autenticado (nav + protecao)
│   │   │   ├── dashboard/page.tsx        # Resumo calorico + graficos
│   │   │   ├── settings/page.tsx         # Dados pessoais + configs bot
│   │   │   └── history/page.tsx          # Registros com filtro + editar/excluir
│   │   ├── api/
│   │   │   ├── webhook/whatsapp/route.ts # Webhook WhatsApp (POST + GET)
│   │   │   ├── auth/otp/
│   │   │   │   ├── send/route.ts         # Gera e envia OTP via WhatsApp
│   │   │   │   └── verify/route.ts       # Valida OTP e cria sessao
│   │   │   └── cron/reminders/route.ts   # Cron jobs para lembretes
│   │
│   ├── lib/
│   │   ├── llm/
│   │   │   ├── provider.ts               # Interface LLMProvider
│   │   │   ├── providers/
│   │   │   │   ├── openrouter.ts
│   │   │   │   └── ollama.ts
│   │   │   ├── schemas/                  # Zod schemas para output da LLM
│   │   │   │   ├── meal-analysis.ts
│   │   │   │   ├── intent.ts
│   │   │   │   └── common.ts
│   │   │   ├── prompts/
│   │   │   │   ├── approximate.ts
│   │   │   │   ├── taco.ts
│   │   │   │   ├── manual.ts
│   │   │   │   └── classify.ts
│   │   │   └── index.ts                  # Factory getLLMProvider()
│   │   │
│   │   ├── whatsapp/
│   │   │   ├── client.ts                 # Envio de mensagens via Meta API
│   │   │   ├── webhook.ts                # Parsing de mensagens recebidas
│   │   │   └── templates.ts              # Message templates (lembretes)
│   │   │
│   │   ├── bot/
│   │   │   ├── router.ts                 # Classificador de intencao
│   │   │   ├── flows/
│   │   │   │   ├── onboarding.ts         # 8 passos (incl. sexo biologico)
│   │   │   │   ├── meal-log.ts
│   │   │   │   ├── summary.ts
│   │   │   │   ├── edit.ts
│   │   │   │   ├── query.ts
│   │   │   │   ├── weight.ts
│   │   │   │   ├── settings.ts
│   │   │   │   └── help.ts
│   │   │   └── state.ts                  # Gerenciamento conversation_context
│   │   │
│   │   ├── db/
│   │   │   ├── supabase.ts               # Clientes Supabase (server + client)
│   │   │   ├── queries/
│   │   │   │   ├── users.ts
│   │   │   │   ├── meals.ts
│   │   │   │   ├── settings.ts
│   │   │   │   ├── weight.ts
│   │   │   │   ├── taco.ts
│   │   │   │   ├── food-cache.ts
│   │   │   │   ├── context.ts
│   │   │   │   └── auth-codes.ts         # CRUD para auth_codes
│   │   │   └── types.ts                  # Tipos gerados pelo Supabase CLI
│   │   │
│   │   ├── auth/
│   │   │   └── otp.ts                    # Logica OTP: gerar, validar, rate limit
│   │   │
│   │   ├── calc/
│   │   │   └── tdee.ts                   # TMB/TDEE (Mifflin-St Jeor com sex)
│   │   │
│   │   └── utils/
│   │       ├── validators.ts
│   │       └── formatters.ts
│   │
│   └── components/
│       ├── ui/                           # shadcn/ui
│       ├── dashboard/
│       ├── settings/
│       └── history/
│
├── tests/                                # Estrutura descrita na secao 2.3
├── supabase/
│   ├── migrations/
│   └── seed.sql
├── scripts/
│   └── seed-taco.ts
├── docs/
│   └── PRD.md
├── .env.example
└── CLAUDE.md
```

### 3.2 Pipeline de Mensagem (Bot)

```
Webhook POST
  -> Validar payload Meta
  -> Deduplica por message_id
  -> Parsear mensagem (texto/imagem)
  -> Buscar user por phone
     -> Nao existe: criar user + iniciar onboarding
     -> Existe, onboarding incompleto: continuar onboarding
     -> Existe, onboarding completo:
        -> Verificar conversation_context ativo (nao expirado)
           -> Tem contexto: executar fluxo do contexto
           -> Sem contexto: classificar intencao
              -> Regras fixas (keywords/regex)
              -> LLM fallback (modelo gratuito)
              -> Out of scope: mensagem padrao
        -> Executar fluxo correspondente
  -> Enviar resposta via Meta API
  -> SEMPRE retornar 200
```

### 3.3 LLM Service

**Interface:**
```typescript
interface LLMProvider {
  analyzeMeal(message: string, mode: CalorieMode, context?: TacoFood[]): Promise<MealAnalysis>;
  classifyIntent(message: string): Promise<IntentType>;
  chat(message: string, systemPrompt: string): Promise<string>;
}
```

**Fluxo de chamada:**
```
Montar prompt (system + user)
  -> Checar food_cache (para meal analysis)
  -> Cache hit: retornar sem chamar LLM
  -> Cache miss: chamar provider
     -> Parsear JSON
     -> Validar com Zod schema
        -> OK: logar em llm_usage_log, retornar
        -> Falhou: retry 1x
           -> OK: retornar
           -> Falhou: tentar fallback provider (se configurado)
              -> Falhou: throw erro
  -> Se confidence=high, salvar no food_cache
```

**Modelo por funcao:**
| Funcao | Modelo | Custo |
|--------|--------|-------|
| Classificacao intencao | gratuito (llama-3.1-8b:free) | $0 |
| Analise refeicao | gpt-4o-mini ou gemini-flash | ~$0.075-0.15/1M tokens |
| Visao/foto (fase 2) | gpt-4o | ~$2.50/1M tokens |

### 3.4 Modelo de Dados

Conforme PRD secao 6.1 com adicoes:

**Alteracoes ao schema do PRD:**
- `users`: adicionada coluna `sex VARCHAR(10) CHECK (sex IN ('male','female'))`
- Nova tabela `auth_codes` (secao 2.2)
- `user_settings`: adicionadas colunas `last_reminder_sent_at TIMESTAMPTZ` e `last_summary_sent_at TIMESTAMPTZ`

Demais tabelas seguem exatamente o PRD: `users`, `user_settings`, `meals`, `meal_items`, `taco_foods`, `weight_log`, `conversation_context`, `llm_usage_log`, `food_cache`.

**Adicoes extras identificadas no review:**

- `users`: adicionada coluna `timezone VARCHAR(50) DEFAULT 'America/Sao_Paulo'` — necessario para cron enviar lembretes no horario local do usuario
- `users`: adicionada coluna `calorie_target_manual BOOLEAN DEFAULT FALSE` — flag para distinguir meta calculada de meta override manual. Quando `TRUE`, recalcular TMB/TDEE ao mudar peso NAO sobrescreve `daily_calorie_target`
- Tabela `processed_messages` para deduplicacao de webhooks (ver secao 3.6)
- Trigger `updated_at` automatico em todas as tabelas editaveis (ver secao 3.7)

**LGPD (deferido para Fase 2, documentado aqui):**
- Consentimento explicito sera adicionado ao onboarding (passo 0, antes de coletar dados)
- Endpoint `/api/user/export` para exportar dados em JSON
- Endpoint `/api/user/delete` para exclusao completa (cascade)
- Coluna `consent_given_at TIMESTAMPTZ` na tabela `users`

### 3.5 Cron Jobs

- **Engine:** Vercel Cron Jobs chamando API Routes
- **Frequencia:** a cada 15 minutos
- **Rota:** `POST /api/cron/reminders`
- **Seguranca:** header `CRON_SECRET` validado

**Fluxo:**
```
Cron trigger (15min)
  -> Buscar users com reminders_enabled=true
  -> Para cada tipo de lembrete:
     -> Filtrar users cujo horario cai na janela de 15min atual
     -> Verificar last_reminder_sent_at / last_summary_sent_at (evitar duplicata)
     -> Montar mensagem
     -> Enviar via Meta API (message template)
     -> Atualizar last_*_sent_at
```

**Timezone handling:**
- Horarios de lembrete (`reminder_time`, `daily_summary_time`) sao armazenados como TIME (hora local do usuario)
- Coluna `timezone` em `users` (default `America/Sao_Paulo`) permite converter para UTC na hora de comparar
- Cron compara: `NOW() AT TIME ZONE user.timezone` com a janela de 15min ao redor do horario configurado

**Templates Meta (precisam aprovacao):**
- `daily_reminder` — lembrete de registro
- `daily_summary` — resumo do dia
- `weekly_summary` — resumo semanal

### 3.6 Deduplicacao de Mensagens

Vercel serverless nao tem memoria compartilhada entre invocacoes. Para evitar processar a mesma mensagem duas vezes (Meta pode reenviar):

```sql
CREATE TABLE processed_messages (
    message_id VARCHAR(100) PRIMARY KEY,
    processed_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Fluxo:**
```
Webhook recebe message_id
  -> INSERT INTO processed_messages (message_id) ON CONFLICT DO NOTHING
  -> Se inseriu (rows affected = 1): processar mensagem
  -> Se nao inseriu (duplicata): retornar 200 e ignorar
```

- Limpeza: cron diario apaga registros com mais de 24h (mensagens nao sao reenviadas apos esse periodo)

### 3.7 Trigger updated_at

Todas as tabelas editaveis (users, user_settings, meals, meal_items, food_cache) precisam de trigger automatico para `updated_at`:

```sql
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Aplicar a cada tabela editavel:
CREATE TRIGGER set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
-- (repetir para user_settings, meals, meal_items, food_cache)
```

### 3.8 Confirmacao Automatica de Refeicao

O PRD especifica que se o usuario nao responder em 2 min apos a confirmacao, a refeicao e registrada automaticamente. Em arquitetura serverless (Vercel), nao ha processo persistente para observar timeouts.

**Solucao:** O cron de 15 minutos (mesmo que ja existe para lembretes) tambem verifica contextos `awaiting_confirmation` com mais de 2 minutos e os registra automaticamente.

**Fluxo:**
```
Cron trigger (15min)
  -> Buscar conversation_context WHERE context_type = 'awaiting_confirmation'
     AND created_at < NOW() - INTERVAL '2 minutes'
  -> Para cada: registrar refeicao no banco + limpar contexto
```

**Nota:** O TTL de `awaiting_confirmation` no conversation_context e 5 minutos (PRD). Se o cron nao pegar nos primeiros 2 min (janela de 15 min), o contexto expira naturalmente aos 5 min e a proxima mensagem do usuario e tratada como nova. Isso e aceitavel para MVP — a refeicao nao e perdida, apenas nao registrada automaticamente nesse edge case.

---

## 4. Paginas Web

### 4.1 Landing / Login (`page.tsx`)

- Campo de telefone (com mascara BR)
- Botao "Enviar codigo pelo WhatsApp"
- Campo de codigo (6 digitos)
- Botao "Entrar"

### 4.2 Dashboard (`(auth)/dashboard/page.tsx`)

- Barra de progresso calorico diario (consumido vs meta) — elemento central
- Breakdown por refeicao (cafe, almoco, lanche, jantar) com icones
- Grafico de linha 7/30 dias (recharts)
- Ultimas 5 refeicoes registradas
- Supabase Realtime para atualizar quando bot registra refeicao

### 4.3 Settings (`(auth)/settings/page.tsx`)

- Formulario: nome, idade, sexo, peso, altura, atividade, objetivo
- Ao salvar: recalcula TMB/TDEE automaticamente
- Toggle lembretes + campos de horario
- Seletor modo de calculo (approximate/taco/manual)
- Seletor nivel de detalhe (brief/detailed)
- Seletor formato de peso (kg/lb)

### 4.4 History (`(auth)/history/page.tsx`)

- Lista de refeicoes com filtro por data (date picker)
- Registros expansiveis (items + macros)
- Botoes editar/excluir com confirmacao

---

## 5. Servicos Externos Necessarios

| Servico | Status | Acao necessaria |
|---------|--------|-----------------|
| Supabase | Pronto | Criar migrations, habilitar RLS |
| OpenRouter | Pronto | Configurar API key no .env |
| Vercel | Pronto | Conectar repo, configurar env vars |
| Meta WhatsApp Business | Pendente | Criar app, configurar webhook, aprovar templates |
| ngrok | Pendente | Criar conta, configurar dominio estatico |

---

## 6. Documentos Vivos

PRD.md e CLAUDE.md serao atualizados conforme decisoes sao tomadas durante o desenvolvimento. Alteracoes aprovadas neste design spec que afetam o PRD/CLAUDE.md:

- **PRD.md:** adicionar passo 2.5 (sexo biologico) no onboarding, trocar auth de magic link para WhatsApp OTP, adicionar tabela auth_codes ao schema
- **CLAUDE.md:** adicionar secao de testes, atualizar estrutura de pastas com adicoes (schemas/, auth/, tests/), atualizar secao de banco com novas tabelas/colunas
