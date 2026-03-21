# PRD — CalorieBot 🍽️

## Product Requirements Document

**Versão:** 1.0
**Data:** 21/03/2026
**Status:** Rascunho

---

## 1. Visão Geral

O **CalorieBot** é um assistente de controle de calorias que funciona via WhatsApp. O usuário registra o que comeu por mensagem de texto e o bot calcula automaticamente as calorias usando IA (LLM). O sistema conta com uma página web simples para cadastro, configurações e visualização de histórico.

### 1.1 Problema

Aplicativos de contagem de calorias exigem que o usuário abra um app separado, busque alimentos em listas enormes e registre tudo manualmente. Isso gera atrito e a maioria das pessoas desiste em poucos dias.

### 1.2 Solução

Permitir que o usuário registre refeições onde já está — no WhatsApp — com linguagem natural (ex: "almocei arroz, feijão e frango grelhado"), enquanto a IA cuida do cálculo calórico.

### 1.3 Público-alvo

- **MVP:** Família e círculo próximo (validação)
- **Produto final:** Público geral que quer controlar calorias sem atrito — monetizado via assinatura

---

## 2. Stack Tecnológica

| Camada         | Tecnologia                          | Justificativa                                                          |
|----------------|-------------------------------------|------------------------------------------------------------------------|
| Frontend/Web   | **Next.js** (App Router)            | Frontend + API Routes no mesmo projeto; deploy fácil na Vercel         |
| Banco de Dados | **Supabase** (Postgres)             | Auth pronto, API REST automática, Edge Functions, Row Level Security   |
| WhatsApp API   | **Meta Cloud API** (Business)       | Gratuito até 1.000 conversas/mês; API oficial e estável               |
| LLM            | **OpenRouter** (principal) + **Ollama** (local) | OpenRouter: gateway único pra centenas de modelos (incl. gratuitos). Ollama: modelos locais, custo zero, fallback |
| Deploy         | **Vercel**                          | Integração nativa com Next.js; serverless sem config                   |
| Webhook        | **Next.js API Routes** (ou Vercel Serverless Functions) | Recebe mensagens do WhatsApp via webhook              |
| Dev Tunnel     | **ngrok**                           | Expõe localhost para a internet; necessário para receber webhooks do WhatsApp em ambiente local |

### 2.1 Ambiente de Desenvolvimento Local

O WhatsApp exige uma URL pública para enviar webhooks. Em dev local, o **ngrok** cria um túnel entre a internet e o `localhost:3000` do Next.js.

**Fluxo em desenvolvimento:**

```
WhatsApp (Meta) ──▶ https://abc123.ngrok-free.app/api/webhook/whatsapp
                         │
                    ngrok tunnel
                         │
                    localhost:3000/api/webhook/whatsapp
                         │
                    Next.js (dev server)
```

**Setup rápido:**

```bash
# Terminal 1 — Next.js dev server
npm run dev

# Terminal 2 — ngrok apontando para a porta do Next.js
ngrok http 3000
```

**Cuidados importantes:**

- A URL do ngrok muda a cada reinício (plano free). Cada vez que reiniciar, é necessário atualizar a Webhook URL no painel da Meta (App Dashboard > WhatsApp > Configuration).
- Para evitar essa dor de cabeça, considerar o plano gratuito do ngrok com **domínio estático** (`ngrok http --url=seu-subdominio.ngrok-free.app 3000`), que mantém a URL fixa.
- Usar variável de ambiente `WEBHOOK_BASE_URL` para alternar facilmente entre a URL do ngrok (dev) e a URL da Vercel (produção).
- Nunca commitar a URL do ngrok no código — ela vai no `.env.local`.

```env
# .env.local (desenvolvimento)
WEBHOOK_BASE_URL=https://abc123.ngrok-free.app

# .env.production (Vercel)
WEBHOOK_BASE_URL=https://caloriebot.vercel.app
```

---

## 3. Arquitetura de Alto Nível

```
┌──────────────┐       ┌──────────────────┐       ┌──────────────┐
│   Usuário     │──────▶│  Meta Cloud API  │──────▶│  Webhook     │
│  (WhatsApp)   │◀──────│  (WhatsApp Biz)  │◀──────│  (Next.js)   │
└──────────────┘       └──────────────────┘       └──────┬───────┘
                                                         │
                                              ┌──────────┴──────────┐
                                              │                     │
                                        ┌─────▼─────┐       ┌──────▼──────┐
                                        │ OpenRouter │       │  Supabase   │
                                        │ / Ollama   │       │  (Postgres) │
                                        └───────────┘       └─────────────┘

┌──────────────┐       ┌──────────────────┐
│   Usuário     │──────▶│   Página Web     │──────▶  Supabase (Auth + DB)
│  (Browser)    │◀──────│   (Next.js)      │
└──────────────┘       └──────────────────┘
```

---

## 4. Funcionalidades

### 4.1 Bot WhatsApp (Core)

#### 4.1.1 Onboarding (Primeiro Contato)

Quando o usuário manda a primeira mensagem, o bot inicia um fluxo de cadastro conversacional:

1. **Nome**
2. **Idade**
3. **Peso atual** (kg)
4. **Altura** (cm)
5. **Nível de atividade física** (sedentário / leve / moderado / intenso)
6. **Objetivo** (perder peso / manter / ganhar massa)
7. **Modo de cálculo calórico** (ver seção 4.1.2)

> O bot calcula automaticamente o **TMB** (Taxa Metabólica Basal) e o **TDEE** (Gasto Calórico Diário) com base nos dados informados, usando a fórmula de Mifflin-St Jeor.

#### 4.1.2 Modos de Cálculo Calórico

O usuário escolhe **um dos três modos** durante o onboarding (pode trocar depois nas configurações):

| Modo | Descrição | Quando usar |
|------|-----------|-------------|
| **Aproximado (IA)** | A LLM estima as calorias com base no seu conhecimento geral de nutrição | Praticidade máxima; aceita margem de erro |
| **Tabela TACO** | A LLM consulta a Tabela TACO (pré-carregada no sistema) para buscar valores nutricionais | Maior precisão com alimentos brasileiros |
| **Manual (Tabela Nutricional)** | O usuário envia foto ou texto da tabela nutricional do produto | Precisão máxima; para quem quer controle total |

> **Tabela TACO:** Tabela Brasileira de Composição de Alimentos da UNICAMP. Será armazenada como dados estruturados (JSON ou tabela no Supabase) e fornecida como contexto para a LLM quando esse modo estiver ativo.

#### 4.1.3 Registro de Refeição

**Fluxo principal:**

1. Usuário envia mensagem: `"almocei arroz, feijão, bife e salada"`
2. Bot processa com a LLM no modo configurado
3. Bot responde com breakdown:
   ```
   🍽️ Almoço registrado!

   • Arroz branco (150g) — 195 kcal
   • Feijão carioca (100g) — 77 kcal
   • Bife grelhado (120g) — 220 kcal
   • Salada verde (100g) — 18 kcal

   Total: 510 kcal

   📊 Hoje: 1.230 / 2.000 kcal (restam 770)
   ```
4. Usuário pode corrigir: `"o arroz era integral e foi menos, uns 100g"`
5. Bot ajusta e confirma

**Regras de negócio:**
- O bot deve classificar automaticamente a refeição (café da manhã, almoço, lanche, jantar, ceia) pelo horário, mas o usuário pode corrigir
- Se o bot não conseguir identificar um alimento, deve perguntar ao invés de chutar
- O bot armazena as quantidades em gramas; se o usuário informar em porções (ex: "1 colher de sopa"), o bot converte

#### 4.1.4 Consultas Rápidas

O usuário pode perguntar a qualquer momento:

| Comando (linguagem natural) | Resposta |
|-----------------------------|----------|
| "como tô hoje?" | Resumo do dia (calorias consumidas vs meta) |
| "resumo da semana" | Resumo dos últimos 7 dias com média diária |
| "quantas calorias tem uma coxinha?" | Consulta avulsa (não registra) |
| "apaga o último registro" | Remove o último registro de refeição |
| "meus dados" | Mostra peso, meta calórica, modo ativo |

#### 4.1.5 Lembretes Diários

O bot envia mensagens proativas (se o usuário ativar):

- **Lembrete de registro:** Se até às 14h não registrou almoço, manda um lembrete gentil
- **Resumo do dia:** Às 21h envia resumo do que foi consumido no dia
- **Resumo semanal:** Domingo à noite com média da semana e progresso

---

### 4.2 Página Web

A página web é **simples e focada em configurações** — o core é o WhatsApp.

#### 4.2.1 Autenticação

- Login via **OTP pelo WhatsApp** — usuário digita o número de telefone na web, recebe código de 6 dígitos no WhatsApp, digita na web
- O código é enviado via Meta Cloud API (mesma integração do bot, sem custo extra)
- Vinculação web ↔ WhatsApp é automática pelo número de telefone
- Rate limit: máximo 3 códigos por telefone a cada 15 min
- Tabela `auth_codes` armazena códigos com TTL de 5 min

#### 4.2.2 Telas

**Dashboard (Home)**
- Resumo calórico de hoje (gráfico simples tipo barra de progresso)
- Últimas refeições registradas
- Gráfico de evolução dos últimos 7 / 30 dias

**Perfil / Configurações**
- Dados pessoais (nome, peso, altura, idade, nível de atividade)
- Objetivo (perder / manter / ganhar)
- Meta calórica (auto-calculada ou override manual)
- Modo de cálculo (Aproximado / TACO / Manual)
- Configurações do Bot:
  - Ativar/desativar lembretes
  - Horário do resumo diário
  - Horário dos lembretes de registro
  - Idioma de resposta do bot (PT-BR padrão)
  - Nível de detalhe das respostas (resumido / detalhado)
  - Formato de peso (kg / lb)

**Histórico**
- Lista de todos os registros com filtro por data
- Possibilidade de editar/excluir registros antigos

---

## 5. Fluxos Conversacionais (Anti-Alucinação)

O bot opera como uma **máquina de estados**. Em cada estado, o bot sabe exatamente o que esperar do usuário e o que responder. A LLM **só é chamada dentro de estados específicos** e com instruções restritas. Isso impede que a IA invente funcionalidades, dê conselhos médicos ou saia do escopo.

### 5.1 Regras Globais do Bot

Estas regras se aplicam a **todos os estados**:

1. O bot **nunca** dá conselhos médicos, prescreve dietas ou sugere suplementos
2. O bot **nunca** faz diagnósticos (ex: "você pode estar com deficiência de ferro")
3. O bot **só** responde sobre os assuntos dentro do escopo (calorias, macros, refeições)
4. Se o usuário perguntar algo fora do escopo, o bot responde:
   > "Sou especializado em controle de calorias 🍽️ Não consigo te ajudar com isso, mas posso registrar uma refeição ou te mostrar seu resumo do dia!"
5. O bot **sempre** confirma antes de registrar — nunca registra silenciosamente
6. O bot **nunca** inventa dados nutricionais — se não souber, pergunta ao usuário
7. Mensagens do bot devem ter no máximo **300 caracteres** (exceto breakdown de refeição)
8. Em caso de erro de sistema, o bot responde:
   > "Ops, tive um probleminha aqui 😅 Tenta de novo em alguns segundos?"

### 5.2 Mapa de Estados

```
┌─────────────────────────────────────────────────────────┐
│                   MENSAGEM RECEBIDA                     │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
              ┌───────────────┐     NÃO     ┌──────────────────┐
              │ Tem cadastro? │────────────▶│  ONBOARDING      │
              └───────┬───────┘             │  (Fluxo 5.3)     │
                      │ SIM                 └──────────────────┘
                      ▼
              ┌───────────────┐     NÃO     ┌──────────────────┐
              │ Onboarding    │────────────▶│  CONTINUAR       │
              │ completo?     │             │  ONBOARDING      │
              └───────┬───────┘             └──────────────────┘
                      │ SIM
                      ▼
              ┌───────────────┐
              │ CLASSIFICAR   │
              │ INTENÇÃO      │
              └───────┬───────┘
                      │
      ┌──────┬────┬───┴────┬──────┬──────┬──────┐
      ▼      ▼    ▼        ▼      ▼      ▼      ▼
 ┌────────┐┌───┐┌─────┐┌──────┐┌────┐┌─────┐┌──────┐
 │REGISTAR││RES││EDITA││CONSUL││PESO││CONFI││ MENU │
 │REFEIÇÃO││UMO││R    ││TA   ││    ││G    ││AJUDA │
 │(5.4)   ││5.5││(5.6)││(5.7) ││5.8 ││(5.10││(5.9) │
 └────────┘└───┘└─────┘└──────┘└────┘└─────┘└──────┘
```

### 5.3 Fluxo: Onboarding (Primeiro Contato)

**Estado:** `onboarding`
**Trigger:** Primeira mensagem de um número não cadastrado
**A LLM NÃO é usada neste fluxo** — são perguntas fixas com validação.

```
PASSO 1 — BOAS-VINDAS
Bot: "Olá! 👋 Eu sou o CalorieBot, seu assistente de controle de calorias.
      Vou te fazer algumas perguntas rápidas pra configurar tudo (< 2 min).
      Qual é o seu nome?"
Esperado: texto livre
Validação: mínimo 2 caracteres, sem números
Erro: "Hmm, não entendi. Pode me dizer seu nome?"
Salva: users.name
Próximo: PASSO 2

PASSO 2 — IDADE
Bot: "Prazer, {nome}! Quantos anos você tem?"
Esperado: número inteiro
Validação: entre 12 e 120
Erro: "Preciso de um número válido. Quantos anos você tem?"
Salva: users.age
Próximo: PASSO 2.5

PASSO 2.5 — SEXO BIOLÓGICO
Bot: "Para calcular sua meta calórica, preciso saber:
      1️⃣ Masculino
      2️⃣ Feminino"
Esperado: 1 ou 2 (ou texto como "masculino", "feminino")
Validação: match com uma das opções
Erro: "Escolhe: 1 (masculino) ou 2 (feminino)"
Salva: users.sex
Próximo: PASSO 3

PASSO 3 — PESO
Bot: "Qual seu peso atual em kg? (ex: 72.5)"
Esperado: número (aceita decimal com . ou ,)
Validação: entre 30 e 300
Erro: "Preciso do peso em kg. Exemplo: 72.5"
Salva: users.weight_kg + cria entry em weight_log
Próximo: PASSO 4

PASSO 4 — ALTURA
Bot: "E sua altura em cm? (ex: 175)"
Esperado: número inteiro
Validação: entre 100 e 250
Erro: "Preciso da altura em cm. Exemplo: 175"
Salva: users.height_cm
Próximo: PASSO 5

PASSO 5 — NÍVEL DE ATIVIDADE
Bot: "Qual seu nível de atividade física?
      1️⃣ Sedentário (pouco ou nenhum exercício)
      2️⃣ Leve (1-3 dias/semana)
      3️⃣ Moderado (3-5 dias/semana)
      4️⃣ Intenso (6-7 dias/semana)"
Esperado: 1, 2, 3, 4 (ou texto como "sedentário", "leve" etc.)
Validação: match com uma das opções
Erro: "Escolhe uma das opções: 1, 2, 3 ou 4"
Salva: users.activity_level
Próximo: PASSO 6

PASSO 6 — OBJETIVO
Bot: "Qual seu objetivo?
      1️⃣ Perder peso
      2️⃣ Manter peso
      3️⃣ Ganhar massa"
Esperado: 1, 2, 3
Validação: match com uma das opções
Erro: "Escolhe: 1 (perder), 2 (manter) ou 3 (ganhar)"
Salva: users.goal
Próximo: PASSO 7

PASSO 7 — MODO DE CÁLCULO
Bot: "Como quer que eu calcule as calorias?
      1️⃣ Aproximado — eu estimo com IA (mais prático)
      2️⃣ Tabela TACO — uso a tabela oficial brasileira (mais preciso)
      3️⃣ Manual — você me envia a tabela nutricional (precisão total)"
Esperado: 1, 2, 3
Validação: match com uma das opções
Erro: "Escolhe: 1 (aproximado), 2 (TACO) ou 3 (manual)"
Salva: users.calorie_mode
Próximo: FINALIZAÇÃO

FINALIZAÇÃO
- Calcular TMB (Mifflin-St Jeor) usando sexo biológico do Passo 2.5:
  - Homens: 10 × peso(kg) + 6.25 × altura(cm) - 5 × idade + 5
  - Mulheres: 10 × peso(kg) + 6.25 × altura(cm) - 5 × idade - 161
- Calcular TDEE = TMB × fator de atividade
- Aplicar objetivo:
  - Perder: TDEE - 500 kcal
  - Manter: TDEE
  - Ganhar: TDEE + 300 kcal
- Salvar: users.tmb, users.tdee, users.daily_calorie_target
- Marcar: users.onboarding_complete = true

Bot: "Tudo pronto, {nome}! 🎉
      Sua meta diária é de {meta} kcal.

      Agora é só me mandar o que comeu! Exemplos:
      • 'almocei arroz, feijão e frango'
      • 'comi um pão com ovo no café'
      • 'lanche: 1 banana e granola'

      Dica: manda 'menu' a qualquer momento pra ver o que posso fazer."
```

> **✅ Resolvido:** Sexo biológico adicionado como Passo 2.5 no onboarding.

### 5.4 Fluxo: Registrar Refeição (Core)

**Estado:** `meal_logging`
**Trigger:** Usuário envia texto que parece ser uma refeição
**A LLM É usada aqui** — com prompt restrito ao modo ativo.

```
ETAPA 1 — DETECTAR INTENÇÃO
Entrada: mensagem do usuário
Classificação (via LLM com prompt restrito):
  - É refeição? → continua
  - É outro comando? → redireciona pro fluxo correto
  - Não entendeu? → "Não entendi 🤔 Me manda o que comeu ou digite 'menu'."

ETAPA 2 — ANALISAR COM LLM
Entrada: mensagem + modo de cálculo do usuário
LLM retorna JSON estruturado:

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

ETAPA 3 — TRATAR INCERTEZAS
SE unknown_items não vazio:
  Bot: "Não encontrei '{item}' na minha base. Pode me dar mais detalhes?
        Por exemplo: é caseiro ou industrializado? Sabe o peso aproximado?"
  Estado: aguardando_clarificacao
  → Volta pra ETAPA 2 com contexto extra

SE confidence = "low" em algum item:
  Bot: "Não tenho certeza sobre a porção de {item}.
        Considerei {X}g, tá certo? (sim / não, foi mais ou menos Xg)"
  Estado: aguardando_confirmacao_porcao
  → Ajusta e continua

SE needs_clarification = true:
  Bot: faz pergunta específica retornada pela LLM
  Estado: aguardando_clarificacao
  → Volta pra ETAPA 2

ETAPA 4 — CONFIRMAR
Bot: "🍽️ {tipo_refeição} registrado!

     • Arroz branco (150g) — 195 kcal
     • Feijão carioca (100g) — 77 kcal
     • Frango grelhado (120g) — 198 kcal

     Total: 470 kcal
     📊 Hoje: 1.230 / 2.000 kcal (restam 770)

     Tá certo? (sim / corrigir)"

SE "sim" ou sem resposta em 2 min → registra no banco
SE "corrigir" → Estado: correcao_refeicao (Fluxo 5.6)

ETAPA 5 — SALVAR
- Cria registro em meals
- Cria registros em meal_items para cada item
- Atualiza cache diário do usuário
```

**Instruções de restrição para a LLM neste fluxo:**

```
SYSTEM PROMPT (anexado a toda chamada de análise de refeição):

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

### 5.5 Fluxo: Resumo

**Estado:** `summary`
**Trigger:** Intenções como "como tô hoje", "resumo", "quanto comi"
**A LLM NÃO é usada** — dados vêm direto do banco.

```
DETECTAR TIPO:
- "hoje" / "como tô" / sem especificar → resumo diário
- "semana" / "últimos 7 dias" → resumo semanal
- "mês" → resumo mensal

RESUMO DIÁRIO:
Bot: "📊 Resumo de hoje ({data}):

     ☕ Café: 320 kcal
     🍽️ Almoço: 510 kcal
     🍎 Lanche: — (não registrado)
     🌙 Jantar: — (não registrado)

     Total: 830 / 2.000 kcal
     Restam: 1.170 kcal"

RESUMO SEMANAL:
Bot: "📊 Resumo da semana (15/03 - 21/03):

     Seg: 1.850 kcal ✅
     Ter: 2.200 kcal ⚠️ (+200)
     Qua: 1.750 kcal ✅
     Qui: 1.900 kcal ✅
     Sex: 2.400 kcal ❌ (+400)
     Sáb: 1.600 kcal ✅
     Dom: — (hoje)

     Média: 1.950 kcal/dia
     Meta: 2.000 kcal/dia"
```

### 5.6 Fluxo: Editar / Corrigir / Apagar

**Estado:** `editing`
**Trigger:** "corrigir", "apagar último", "o arroz era integral", "tira o suco"

```
CENÁRIO A — Correção logo após registro (contexto na memória):
Usuário: "o arroz era integral e foi menos, uns 100g"
Bot: recalcula com novo item/quantidade via LLM
Bot: "Corrigido! ✏️
     • Arroz integral (100g) — 124 kcal (era: branco 150g, 195 kcal)
     Novo total da refeição: 399 kcal
     📊 Hoje: 1.159 / 2.000 kcal"

CENÁRIO B — Apagar último registro:
Usuário: "apaga o último"
Bot: "Quer apagar o registro de Almoço (470 kcal) de hoje às 12:30? (sim/não)"
Usuário: "sim"
Bot: "Removido! ✅ Hoje: 760 / 2.000 kcal"

CENÁRIO C — Correção sem contexto recente:
Usuário: "corrigir" (sem contexto)
Bot: "Qual registro quer corrigir?
     Últimos 3 de hoje:
     1️⃣ Café (08:15) — 320 kcal
     2️⃣ Almoço (12:30) — 470 kcal
     3️⃣ Lanche (16:00) — 180 kcal"
Usuário: "2"
Bot: "O que quer mudar no Almoço?"
→ Segue como Cenário A
```

### 5.7 Fluxo: Consulta Avulsa

**Estado:** `query`
**Trigger:** "quantas calorias tem...", "quanto tem um...", perguntas informativas
**A LLM É usada** — mas apenas para estimar, **sem registrar**.

```
Usuário: "quantas calorias tem uma coxinha?"
Bot: "🔍 Uma coxinha de frango (~130g) tem aproximadamente:
     • 290 kcal
     • 13g proteína | 22g carbs | 17g gordura
     (estimativa — pode variar conforme preparo)

     Quer registrar como uma refeição? (sim/não)"

SE "sim" → vai pro Fluxo 5.4 etapa 4 (confirmação)
SE "não" → volta ao estado padrão
```

### 5.8 Fluxo: Registro de Peso

**Estado:** `weight_logging`
**Trigger:** "peso hoje", "meu peso", "pesei X"
**A LLM NÃO é usada.**

```
CENÁRIO A — Com valor:
Usuário: "pesei 76.3 hoje"
Validação: número entre 30-300
Bot: "Peso registrado! ⚖️
     Hoje: 76.3 kg
     Última pesagem: 77.0 kg (há 3 dias)
     Variação: -0.7 kg 📉"
Salva: weight_log + atualiza users.weight_kg

CENÁRIO B — Sem valor:
Usuário: "quero registrar meu peso"
Bot: "Qual seu peso hoje? (em kg)"
→ Aguarda número → Cenário A
```

### 5.9 Fluxo: Menu / Ajuda

**Estado:** `help`
**Trigger:** "menu", "ajuda", "help", "o que você faz"
**A LLM NÃO é usada.**

```
Bot: "📋 O que posso fazer:

     🍽️ Registrar refeição — me conta o que comeu
     📊 Resumo do dia — 'como tô hoje?'
     📈 Resumo da semana — 'resumo da semana'
     ⚖️ Registrar peso — 'pesei Xkg'
     🔍 Consulta — 'quantas calorias tem...'
     ✏️ Corrigir — 'corrigir' ou 'apagar último'
     ⚙️ Configurações — 'config' ou acesse {url_web}
     ❓ Meus dados — 'meus dados'

     Ou só me manda o que comeu que eu resolvo! 😉"
```

### 5.10 Fluxo: Configurações via WhatsApp

**Estado:** `settings`
**Trigger:** "config", "configurações", "mudar objetivo", "trocar modo", "mudar meta"
**A LLM NÃO é usada** — menu fixo com opções numeradas.

```
ETAPA 1 — MENU DE CONFIGURAÇÕES
Usuário: "config"
Bot: "⚙️ Configurações:

     1️⃣ Objetivo (atual: Perder peso)
     2️⃣ Modo de cálculo (atual: Tabela TACO)
     3️⃣ Meta calórica (atual: 2.000 kcal)
     4️⃣ Lembretes (atual: ✅ ligados)
     5️⃣ Nível de detalhe (atual: Detalhado)
     6️⃣ Atualizar peso
     7️⃣ Abrir painel completo na web

     Qual quer alterar?"

ETAPA 2 — ALTERAR CONFIGURAÇÃO

OPÇÃO 1 — Objetivo:
Bot: "Qual seu novo objetivo?
      1️⃣ Perder peso
      2️⃣ Manter peso
      3️⃣ Ganhar massa"
Usuário: "1"
→ Atualiza users.goal
→ Recalcula daily_calorie_target
Bot: "Objetivo atualizado pra Perder peso! ✅
     Nova meta diária: 1.800 kcal (era 2.000)"

OPÇÃO 2 — Modo de cálculo:
Bot: "Qual modo quer usar?
      1️⃣ Aproximado (IA estima)
      2️⃣ Tabela TACO (tabela brasileira)
      3️⃣ Manual (você envia tabela nutricional)"
Usuário: "2"
→ Atualiza users.calorie_mode
Bot: "Modo atualizado pra Tabela TACO! ✅"

OPÇÃO 3 — Meta calórica:
Bot: "Sua meta calculada é {tdee_ajustado} kcal.
     Quer usar esse valor ou definir um personalizado?
      1️⃣ Usar calculado ({tdee_ajustado} kcal)
      2️⃣ Definir manualmente"
SE opção 2:
  Bot: "Qual a meta em kcal? (ex: 1800)"
  Validação: entre 800 e 5000
  → Atualiza users.daily_calorie_target
Bot: "Meta atualizada pra {nova_meta} kcal! ✅"

OPÇÃO 4 — Lembretes:
Bot: "Lembretes:
      1️⃣ Ligar lembretes
      2️⃣ Desligar lembretes
      3️⃣ Mudar horário do resumo (atual: 21:00)
      4️⃣ Mudar horário do lembrete (atual: 14:00)"
SE opção 3 ou 4:
  Bot: "Qual horário? (ex: 20:30)"
  Validação: formato HH:MM
  → Atualiza user_settings
Bot: "Atualizado! ✅"

OPÇÃO 5 — Nível de detalhe:
Bot: "Como quer que eu responda?
      1️⃣ Resumido — só total de calorias
      2️⃣ Detalhado — breakdown com macros"
→ Atualiza user_settings.detail_level

OPÇÃO 6 — Atualizar peso:
→ Redireciona pro Fluxo 5.8

OPÇÃO 7 — Web:
Bot: "Acesse suas configurações completas em: {url_web}/settings"
```

### 5.11 Sincronização Web ↔ Bot (Single Source of Truth)

Tanto a página web quanto o bot WhatsApp leem e escrevem no **mesmo banco Supabase**. Isso significa que qualquer alteração feita em um lado é automaticamente refletida no outro.

**Princípio: o banco é a única fonte de verdade.**

```
┌──────────────┐                              ┌──────────────┐
│   Página Web │──── WRITE ────┐  ┌── READ ───│  Bot WhatsApp│
│   (Next.js)  │◀── READ ─────┐│  │┌─ WRITE ─▶│  (Webhook)   │
└──────────────┘              ││  ││          └──────────────┘
                              ▼▼  ▼▼
                        ┌──────────────┐
                        │   Supabase   │
                        │  (Postgres)  │
                        │              │
                        │  users       │
                        │  user_settings│
                        │  meals       │
                        │  meal_items  │
                        │  weight_log  │
                        └──────────────┘
```

**Como funciona na prática:**

| Ação                                      | Onde acontece | O que muda no banco         | Outro lado vê?                          |
|-------------------------------------------|---------------|-----------------------------|-----------------------------------------|
| Usuário troca modo de cálculo pelo site   | Web           | `users.calorie_mode`        | ✅ Próxima msg no bot já usa novo modo  |
| Usuário manda "config" e muda objetivo    | Bot           | `users.goal` + recalc meta  | ✅ Dashboard na web mostra nova meta    |
| Usuário desliga lembretes na web          | Web           | `user_settings.reminders_enabled` | ✅ Cron do bot para de enviar     |
| Usuário registra refeição pelo bot        | Bot           | `meals` + `meal_items`      | ✅ Dashboard na web atualiza            |
| Usuário edita registro antigo na web      | Web           | `meals` / `meal_items`      | ✅ Próximo resumo no bot reflete edição |
| Usuário atualiza peso pelo bot            | Bot           | `weight_log` + `users.weight_kg` | ✅ Web mostra novo peso e gráfico  |

**Regras de implementação:**

1. **Nunca cachear configs no bot** — a cada mensagem recebida, o webhook busca as configurações atuais do usuário no banco. Isso garante que qualquer mudança feita na web é imediatamente refletida.

2. **Nunca cachear dados na web por mais de 30s** — o dashboard deve fazer fetch dos dados a cada carregamento de página (ou usar Supabase Realtime para atualização automática).

3. **Supabase Realtime (opcional, recomendado)** — para o dashboard atualizar em tempo real quando o bot registra uma refeição:
   ```javascript
   // Na página web — escuta mudanças na tabela meals
   supabase
     .channel('meals')
     .on('postgres_changes',
       { event: 'INSERT', schema: 'public', table: 'meals',
         filter: `user_id=eq.${userId}` },
       (payload) => { refreshDashboard(); }
     )
     .subscribe();
   ```

4. **updated_at em todas as tabelas** — toda tabela que pode ser editada dos dois lados tem coluna `updated_at` com trigger automático, útil para debug e resolução de conflitos.

5. **Sem conflito de escrita** — na prática, o usuário não vai editar a mesma config na web e no bot simultaneamente. Mas como garantia, a última escrita vence (last-write-wins), o que é aceitável pra esse tipo de dado.

### 5.12 Classificador de Intenção

A primeira camada antes de qualquer fluxo é o **classificador de intenção**. Ele decide para qual fluxo enviar a mensagem. Pode ser feito via LLM com prompt restrito ou via regras simples (recomendado para MVP).

**Abordagem híbrida (recomendada):**

```
1. PRIMEIRO — Regras fixas (sem LLM, sem custo):
   - Mensagem = "menu" / "ajuda" / "help"         → Fluxo 5.9
   - Mensagem contém "config" / "configuração"     → Fluxo 5.10
   - Mensagem contém "resum" / "como tô"          → Fluxo 5.5
   - Mensagem contém "apaga" / "corrig" / "tira"  → Fluxo 5.6
   - Mensagem contém "peso" / "pesei"              → Fluxo 5.8
   - Mensagem contém "quantas calorias tem"        → Fluxo 5.7
   - Mensagem contém "mudar objetivo/modo/meta"    → Fluxo 5.10
   - Mensagem contém "meus dados"                  → retorna dados do user

2. SEGUNDO — Se nenhuma regra matchou, usa LLM pra classificar:
   System prompt: "Classifique a intenção do usuário em UMA das categorias:
   meal_log, summary, edit, query, weight, help, settings, out_of_scope.
   Responda APENAS com o nome da categoria, nada mais."

3. FALLBACK — Se LLM retorna "out_of_scope":
   Bot: "Sou especializado em controle de calorias 🍽️
         Me manda o que comeu ou digita 'menu' pra ver o que posso fazer!"
```

### 5.13 Tabela de Estados (conversation_context)

Cada conversa ativa é rastreada no banco para manter contexto entre mensagens:

| context_type              | context_data (JSONB)                                           | Expira em  |
|---------------------------|----------------------------------------------------------------|------------|
| `onboarding`              | `{"step": 3, "name": "João", "age": 28}`                      | 24h        |
| `awaiting_confirmation`   | `{"meal_id": "temp_123", "items": [...], "total": 470}`       | 5 min      |
| `awaiting_clarification`  | `{"original_msg": "comi aquele negócio", "question": "..."}`  | 10 min     |
| `awaiting_correction`     | `{"meal_id": "uuid", "selected_meal": 2}`                     | 10 min     |
| `awaiting_weight`         | `{}`                                                           | 5 min      |
| `settings_menu`           | `{"awaiting_option": true}`                                    | 5 min      |
| `settings_change`         | `{"setting": "goal", "awaiting_value": true}`                  | 5 min      |

> Se o contexto expirar, o bot volta ao estado padrão e trata a próxima mensagem como nova.

---

## 6. Modelo de Dados (Supabase / Postgres)

### 6.1 Tabelas Principais

```sql
-- Usuários
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_id UUID REFERENCES auth.users(id),
    phone VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    sex VARCHAR(10) CHECK (sex IN ('male','female')),
    age INTEGER,
    weight_kg DECIMAL(5,2),
    height_cm DECIMAL(5,2),
    activity_level VARCHAR(20) CHECK (activity_level IN ('sedentary','light','moderate','intense')),
    goal VARCHAR(20) CHECK (goal IN ('lose','maintain','gain')),
    calorie_mode VARCHAR(20) DEFAULT 'approximate' CHECK (calorie_mode IN ('approximate','taco','manual')),
    daily_calorie_target INTEGER,
    calorie_target_manual BOOLEAN DEFAULT FALSE,
    tmb DECIMAL(7,2),
    tdee DECIMAL(7,2),
    timezone VARCHAR(50) DEFAULT 'America/Sao_Paulo',
    onboarding_complete BOOLEAN DEFAULT FALSE,
    onboarding_step INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Configurações do bot
CREATE TABLE user_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    reminders_enabled BOOLEAN DEFAULT TRUE,
    daily_summary_time TIME DEFAULT '21:00',
    reminder_time TIME DEFAULT '14:00',
    detail_level VARCHAR(10) DEFAULT 'detailed' CHECK (detail_level IN ('brief','detailed')),
    weight_unit VARCHAR(5) DEFAULT 'kg' CHECK (weight_unit IN ('kg','lb')),
    last_reminder_sent_at TIMESTAMPTZ,
    last_summary_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Códigos OTP para autenticação web via WhatsApp
CREATE TABLE auth_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(20) NOT NULL,
    code VARCHAR(6) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Refeições
CREATE TABLE meals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    meal_type VARCHAR(20) CHECK (meal_type IN ('breakfast','lunch','snack','dinner','supper')),
    total_calories INTEGER NOT NULL,
    original_message TEXT,
    llm_response JSONB,
    registered_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Itens de cada refeição
CREATE TABLE meal_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meal_id UUID REFERENCES meals(id) ON DELETE CASCADE,
    food_name VARCHAR(200) NOT NULL,
    quantity_grams DECIMAL(7,2),
    calories INTEGER NOT NULL,
    protein_g DECIMAL(7,2),
    carbs_g DECIMAL(7,2),
    fat_g DECIMAL(7,2),
    source VARCHAR(20) DEFAULT 'approximate' CHECK (source IN ('approximate','taco','manual')),
    taco_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabela TACO (pré-carregada)
CREATE TABLE taco_foods (
    id SERIAL PRIMARY KEY,
    food_name VARCHAR(300) NOT NULL,
    category VARCHAR(100),
    calories_per_100g DECIMAL(7,2),
    protein_per_100g DECIMAL(7,2),
    carbs_per_100g DECIMAL(7,2),
    fat_per_100g DECIMAL(7,2),
    fiber_per_100g DECIMAL(7,2),
    sodium_per_100g DECIMAL(7,2)
);

-- Histórico de peso (para acompanhar evolução)
CREATE TABLE weight_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    weight_kg DECIMAL(5,2) NOT NULL,
    logged_at TIMESTAMPTZ DEFAULT NOW()
);

-- Contexto de conversa (para manter estado do onboarding e conversas)
CREATE TABLE conversation_context (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    context_type VARCHAR(30) NOT NULL,
    context_data JSONB NOT NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Log de uso da LLM (controle de custo)
CREATE TABLE llm_usage_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    provider VARCHAR(20) NOT NULL,          -- 'openrouter' | 'ollama'
    model VARCHAR(100) NOT NULL,            -- ex: 'openai/gpt-4o-mini'
    function_type VARCHAR(30) NOT NULL,     -- 'meal_analysis' | 'classify_intent' | 'vision'
    tokens_input INTEGER,
    tokens_output INTEGER,
    cost_usd DECIMAL(10,6),                 -- custo estimado da chamada
    latency_ms INTEGER,                     -- tempo de resposta
    success BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cache de alimentos comuns (reduz chamadas à LLM)
CREATE TABLE food_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    food_name_normalized VARCHAR(200) UNIQUE NOT NULL,  -- ex: 'arroz branco'
    calories_per_100g DECIMAL(7,2) NOT NULL,
    protein_per_100g DECIMAL(7,2),
    carbs_per_100g DECIMAL(7,2),
    fat_per_100g DECIMAL(7,2),
    typical_portion_grams DECIMAL(7,2),                 -- porção típica (ex: 150g)
    source VARCHAR(20) NOT NULL,                        -- 'taco' | 'llm_consensus'
    hit_count INTEGER DEFAULT 0,                        -- quantas vezes foi usado
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deduplicação de mensagens do WhatsApp (evita processar a mesma mensagem 2x)
CREATE TABLE processed_messages (
    message_id VARCHAR(100) PRIMARY KEY,
    processed_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 6.2 Row Level Security (RLS)

Todas as tabelas terão RLS habilitado com as seguintes regras:
- **Tabelas de usuário** (`users`, `user_settings`, `meals`, `meal_items`, `weight_log`, `conversation_context`): cada usuário só acessa seus próprios dados
- **`taco_foods` e `food_cache`**: leitura pública, escrita apenas via service role (admin/backend)
- **`llm_usage_log`**: cada usuário vê apenas seu próprio uso; admin vê tudo (pra controlar custo)

---

## 7. Integrações

### 7.1 Meta Cloud API (WhatsApp Business)

- **Webhook de entrada:** Recebe mensagens em `/api/webhook/whatsapp`
- **Envio de mensagens:** API REST da Meta para responder
- **Templates:** Necessários para mensagens proativas (lembretes)
  - `daily_reminder` — Lembrete de registro
  - `daily_summary` — Resumo do dia
  - `weekly_summary` — Resumo da semana
- **Verificação:** Webhook verification token no setup

### 7.2 LLM Service (OpenRouter + Ollama)

O sistema suporta **dois providers independentes**: **OpenRouter** (gateway cloud com centenas de modelos, incluindo gratuitos) e **Ollama** (modelos locais, custo zero). Cada um funciona sozinho — **não é necessário configurar os dois**. Basta definir `LLM_PROVIDER` e o sistema usa apenas o provider escolhido.

#### Por que OpenRouter?

O OpenRouter é um gateway unificado — uma API só, compatível com o formato OpenAI, que dá acesso a modelos de todos os providers (OpenAI, Anthropic, Google, Meta, Mistral, etc.). Vantagens:

- **Uma API, todos os modelos** — trocar de modelo é mudar uma string, sem alterar código
- **Modelos gratuitos** — vários modelos open-source disponíveis sem custo (Llama, Gemma, Mistral, etc.)
- **Fallback automático** — se um modelo cair, o OpenRouter pode redirecionar pra outro
- **Billing unificado** — um painel só pra controlar custo de todos os modelos
- **Rate limits mais altos** — agrega cotas de múltiplos providers

#### Por que Ollama como alternativa?

- **Custo zero** — roda modelos localmente na sua máquina
- **Sem dependência de internet** — funciona offline
- **Privacidade** — dados não saem do seu servidor
- **Dev/teste** — ideal pra desenvolver sem gastar créditos
- **Self-hosted em produção** — se escalar muito, pode rodar Ollama num servidor próprio pra eliminar custo de API

#### Arquitetura

```
src/lib/llm/
├── provider.ts          # Interface que ambos providers implementam
├── providers/
│   ├── openrouter.ts    # OpenRouter (API compatível com OpenAI)
│   └── ollama.ts        # Ollama (modelos locais)
├── prompts/
│   ├── approximate.ts   # System prompt — modo aproximado
│   ├── taco.ts          # System prompt — modo TACO (com dados da tabela)
│   ├── manual.ts        # System prompt — modo manual (extração nutricional)
│   └── classify.ts      # System prompt — classificador de intenção
└── index.ts             # Factory que retorna o provider ativo via env var
```

#### Configuração

```env
# ===== OBRIGATÓRIO =====
LLM_PROVIDER=openrouter                    # openrouter | ollama

# ===== SE LLM_PROVIDER=openrouter (ignorado se ollama) =====
LLM_API_KEY=sk-or-v1-...                   # chave do OpenRouter
LLM_MODEL_MEAL=openai/gpt-4o-mini          # análise de refeição
LLM_MODEL_CLASSIFY=meta-llama/llama-3.1-8b-instruct:free  # classificação de intenção
LLM_MODEL_VISION=openai/gpt-4o             # extração de tabela nutricional (foto)

# ===== SE LLM_PROVIDER=ollama (ignorado se openrouter) =====
OLLAMA_BASE_URL=http://localhost:11434      # URL padrão do Ollama
OLLAMA_MODEL_MEAL=llama3.1:8b
OLLAMA_MODEL_CLASSIFY=llama3.1:8b

# ===== OPCIONAL — fallback =====
# Se não configurar, o sistema usa APENAS o provider principal.
# Se configurar, quando o provider principal falhar, tenta o fallback.
LLM_FALLBACK_PROVIDER=                     # vazio = sem fallback | openrouter | ollama
```

> **Resumo:** Só precisa preencher a seção do provider que escolheu. Se usar OpenRouter, ignora as variáveis do Ollama (e vice-versa). O fallback é 100% opcional.

#### Interface do provider

Ambos providers implementam a mesma interface:

```typescript
interface LLMProvider {
  analyzeMeal(message: string, mode: CalorieMode, context?: TacoFood[]): Promise<MealAnalysis>;
  classifyIntent(message: string): Promise<IntentType>;
  chat(message: string, systemPrompt: string): Promise<string>;
}
```

#### Exemplo: chamada via OpenRouter

```typescript
// src/lib/llm/providers/openrouter.ts
const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.LLM_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://caloriebot.vercel.app",  // exigido pelo OpenRouter
    "X-Title": "CalorieBot"                            // nome do app
  },
  body: JSON.stringify({
    model: process.env.LLM_MODEL_MEAL,  // ex: "openai/gpt-4o-mini"
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ],
    response_format: { type: "json_object" }
  })
});
```

#### Exemplo: chamada via Ollama

```typescript
// src/lib/llm/providers/ollama.ts
const response = await fetch(`${process.env.OLLAMA_BASE_URL}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: process.env.OLLAMA_MODEL_MEAL,  // ex: "llama3.1:8b"
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ],
    format: "json",
    stream: false
  })
});
```

#### Modelos recomendados (OpenRouter)

| Função                  | Modelo recomendado                    | Custo       | Notas                              |
|-------------------------|---------------------------------------|-------------|------------------------------------|
| Análise de refeição     | `openai/gpt-4o-mini`                 | ~$0.15/1M tokens | Ótimo custo-benefício        |
| Análise de refeição     | `google/gemini-flash-1.5`            | ~$0.075/1M tokens | Mais barato, qualidade similar |
| Classificação intenção  | `meta-llama/llama-3.1-8b-instruct:free` | Grátis   | Suficiente pra classificar    |
| Extração tabela (foto)  | `openai/gpt-4o`                      | ~$2.50/1M tokens | Necessário pra modo manual com foto |
| Dev/teste               | `meta-llama/llama-3.1-8b-instruct:free` | Grátis   | Pra desenvolver sem gastar   |

> Preços podem mudar — consultar https://openrouter.ai/models pra valores atualizados.

#### Considerações

- **Cada provider funciona sozinho:** Definiu `LLM_PROVIDER=openrouter`? Pronto, o sistema roda 100% com OpenRouter. Não precisa instalar Ollama, nem configurar variáveis dele. O inverso também vale.
- **Dica de economia:** Usar modelos gratuitos do OpenRouter (tags `:free`) para classificação de intenção e modelos pagos apenas para análise de refeição, onde a qualidade importa mais.
- **Modelo por função:** Usar modelos diferentes pra tarefas diferentes. Classificar intenção não precisa de GPT-4o — um modelo gratuito resolve. Análise de refeição se beneficia de um modelo melhor.
- **Fallback (opcional):** Se `LLM_FALLBACK_PROVIDER` estiver configurado e o provider principal falhar (timeout, rate limit, fora do ar), o sistema tenta o fallback automaticamente. Se não estiver configurado, retorna erro pro usuário normalmente.
- **Cache de alimentos comuns:** Respostas para alimentos frequentes (arroz, feijão, frango, pão, ovo) são cacheadas no banco. Isso reduz chamadas de API e acelera a resposta.
- **Output estruturado:** Todos os prompts exigem resposta em JSON. A camada de abstração valida o schema antes de retornar — se o JSON for inválido, retenta uma vez.
- **Monitorar custo:** Tabela `llm_usage_log` rastreia tokens consumidos por modelo/função e controla gasto mensal.

### 7.3 Cron Jobs (Lembretes)

- Usar **Vercel Cron** ou **Supabase pg_cron** para disparar lembretes
- Consulta os horários configurados por cada usuário
- Envia via Meta Cloud API (usando message templates aprovados)

---

## 8. Segurança & Privacidade

- **Autenticação Web:** OTP via WhatsApp (código de 6 dígitos, TTL 5 min, rate limit 3/15min)
- **Autenticação WhatsApp:** Verificação pelo número de telefone
- **RLS:** Row Level Security em todas as tabelas de dados do usuário
- **Dados sensíveis:** Peso e dados de saúde protegidos por criptografia at-rest (Supabase padrão)
- **LGPD:** Incluir tela de consentimento no onboarding e opção de exportar/excluir dados
- **Rate limiting:** Limite de mensagens por minuto para evitar abuso da API

---

## 9. Monetização (Pós-MVP)

| Plano       | Preço     | Inclui                                                              |
|-------------|-----------|---------------------------------------------------------------------|
| **Free**    | R$ 0      | 10 registros/dia, modo aproximado apenas, sem lembretes             |
| **Pro**     | R$ 14,90/mês | Registros ilimitados, todos os modos, lembretes, histórico completo |
| **Premium** | R$ 29,90/mês | Tudo do Pro + relatórios semanais detalhados, sugestão de cardápio  |

> Preços são sugestão inicial — validar com o mercado.

---

## 10. Métricas de Sucesso

| Métrica                        | Meta (MVP)         |
|--------------------------------|--------------------|
| Retenção D7 (7 dias)          | > 60%              |
| Registros por usuário/dia     | ≥ 3                |
| Tempo de resposta do bot      | < 5 segundos       |
| Precisão calórica (modo TACO) | ≥ 90% vs referência|
| NPS                           | > 50               |

---

## 11. Roadmap

### Fase 1 — MVP (4-6 semanas)

- [x] Definição do PRD
- [ ] Setup do projeto (Next.js + Supabase + Vercel)
- [ ] Modelo de dados e migrations
- [ ] Carregar Tabela TACO no banco
- [ ] Webhook WhatsApp (receber/enviar mensagens)
- [ ] Fluxo de onboarding conversacional
- [ ] Registro de refeição (modo aproximado)
- [ ] Registro de refeição (modo TACO)
- [ ] Consultas rápidas (resumo do dia, da semana)
- [ ] Página web: login + configurações básicas
- [ ] Página web: dashboard simples

### Fase 2 — Melhorias (semanas 7-10)

- [ ] Modo manual (foto da tabela nutricional)
- [ ] Lembretes proativos via WhatsApp templates
- [ ] Histórico completo na web com filtros
- [ ] Gráficos de evolução (peso + calorias)
- [ ] Registro de peso via bot ("peso hoje 78kg")
- [ ] Edição/exclusão de registros via bot

### Fase 3 — Monetização (semanas 11-14)

- [ ] Sistema de planos (Free / Pro / Premium)
- [ ] Integração com gateway de pagamento (Stripe ou Mercado Pago)
- [ ] Landing page
- [ ] Limites por plano
- [ ] Relatórios semanais detalhados (Premium)

### Fase 4 — Crescimento

- [ ] Sugestão de cardápio com base no que falta no dia
- [ ] Registro por áudio (transcrição + análise)
- [ ] Registro por foto do prato (visão computacional)
- [ ] Metas de macros (proteína, carbs, gordura) além de calorias
- [ ] Integração com balança smart (via API)

---

## 12. Riscos e Mitigações

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| Imprecisão da LLM no cálculo calórico | Usuário perde confiança | Modo TACO como padrão recomendado; feedback loop para corrigir |
| Custo da API de LLM escalar | Margem apertada | Modelos gratuitos do OpenRouter pra tarefas simples; cache de alimentos comuns; Ollama como fallback sem custo |
| Limite de conversas gratuitas do WhatsApp | Não conseguir escalar | Migrar para plano pago da Meta quando necessário |
| Usuário não completar onboarding | Perda de conversão | Onboarding curto (< 2 min); permitir pular etapas opcionais |
| Conformidade LGPD | Multa / problemas legais | Consentimento explícito; opção de deletar dados |

---

## 13. Decisões Técnicas

### Por que Supabase e não Neon?

| Critério              | Supabase                              | Neon                          |
|-----------------------|---------------------------------------|-------------------------------|
| Banco Postgres        | ✅ Sim                                | ✅ Sim                        |
| Autenticação pronta   | ✅ Supabase Auth (magic link, OAuth)  | ❌ Precisa implementar        |
| API REST automática   | ✅ PostgREST embutido                 | ❌ Precisa criar              |
| Edge Functions        | ✅ Deno-based                         | ❌ Não tem                    |
| Row Level Security    | ✅ Integrado com Auth                 | ✅ Postgres padrão (manual)   |
| Dashboard visual      | ✅ Table editor, SQL editor           | ✅ SQL editor                 |
| Cron Jobs             | ✅ pg_cron integrado                  | ❌ Precisa externo            |
| Free tier             | ✅ Generoso                           | ✅ Generoso                   |
| **Veredicto**         | **Melhor pra esse projeto**           | Ótimo, mas precisaria mais código |

**Resumo:** Neon é excelente como Postgres puro, mas pra esse projeto o Supabase entrega mais "de graça" — auth, API REST, cron, e RLS integrado. Menos código = MVP mais rápido.

---

*Documento vivo — atualizar conforme decisões forem tomadas durante o desenvolvimento.*