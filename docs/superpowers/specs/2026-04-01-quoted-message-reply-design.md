# Quoted Message Reply — Design Spec

**Data:** 2026-04-01
**Status:** Aprovado

---

## Objetivo

Permitir que o usuário cite (quote/reply) uma mensagem específica no WhatsApp para dar contexto à sua ação. O bot identifica o recurso vinculado à mensagem citada e executa a ação no contexto correto — correções, exclusões, registro a partir de queries, detalhamento de resumos, etc.

---

## Decisões de Design

1. **Abordagem:** Quote como contexto puro — a mensagem citada é contexto extra passado ao pipeline existente (webhook → handler → router → flows). O router classifica a intent normalmente; os flows recebem `QuoteContext` como parâmetro opcional.
2. **Tabela `bot_messages`:** Genérica para todos os tipos de resposta do bot (não só refeições), com campo `metadata JSONB` para dados extras (ex: JSON da análise de query).
3. **Vínculo bidirecional:** Tanto a mensagem do usuário (incoming) quanto a resposta do bot (outgoing) são salvas vinculadas ao recurso. Assim, citar qualquer uma das duas funciona.
4. **Correção de nome:** Nova capacidade no edit flow — o usuário pode corrigir o nome de um alimento via LLM, respeitando o `calorie_mode` ativo.
5. **Fallback:** Se o quote não se encaixa em nenhum fluxo, responde que não suporta e volta ao estado idle.
6. **Retenção:** Cron job de limpeza para rows com mais de 30 dias.
7. **Mensagens anteriores à feature:** Quote é ignorado (não encontra na `bot_messages`), mensagem tratada normalmente.

---

## Nova Tabela: `bot_messages`

```sql
CREATE TABLE bot_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  resource_type TEXT CHECK (resource_type IS NULL OR resource_type IN ('meal', 'summary', 'query', 'weight')),
  resource_id UUID,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bot_messages_message_id ON bot_messages(message_id);
CREATE INDEX idx_bot_messages_user_resource ON bot_messages(user_id, resource_type, resource_id);
```

### Campos

| Campo | Descrição |
|-------|-----------|
| `message_id` | WhatsApp message ID (`wamid.xxx`) |
| `direction` | `'incoming'` (mensagem do usuário) ou `'outgoing'` (resposta do bot) |
| `resource_type` | Tipo do recurso vinculado: `'meal'`, `'summary'`, `'query'`, `'weight'`, ou `null` |
| `resource_id` | UUID do recurso (ex: `meal.id`, `weight_log.id`), ou `null` para tipos sem persistência |
| `metadata` | Dados extras em JSON (ex: análise de query para registro posterior) |

### Mapeamento por flow

| Flow | resource_type | resource_id | metadata |
|------|--------------|-------------|----------|
| meal_log | `meal` | `meal.id` | `null` |
| query | `query` | `null` | JSON da análise (items, calorias, macros) |
| summary | `summary` | `null` | `null` |
| weight | `weight` | `weight_log.id` | `null` |
| help, settings, etc. | `null` | `null` | `null` |

### Política de retenção

Cron job diário deleta rows com `created_at < NOW() - INTERVAL '30 days'`.

---

## Webhook Parsing

O `WhatsAppMessage` ganha um campo opcional:

```typescript
interface WhatsAppMessage {
  type: 'text' | 'image' | 'audio' | 'unknown'
  from: string
  messageId: string
  text?: string
  audioId?: string
  imageId?: string
  caption?: string
  timestamp: number
  quotedMessageId?: string  // NOVO
}
```

Extraído de `message.context?.id` no payload da Meta Cloud API.

---

## WhatsApp Client — Suporte a Reply

`sendTextMessage` ganha parâmetro opcional `replyToMessageId`:

```typescript
export async function sendTextMessage(
  to: string,
  text: string,
  replyToMessageId?: string
): Promise<string>
```

Quando presente, o payload inclui:

```json
{
  "messaging_product": "whatsapp",
  "to": "5511...",
  "type": "text",
  "text": { "body": "..." },
  "context": { "message_id": "wamid.xxx" }
}
```

Usado quando o bot responde a uma ação de quote (ex: confirmação de correção). Mensagens normais continuam sem `context`.

---

## QuoteContext — Tipo de Contexto

```typescript
interface QuoteContext {
  quotedMessageId: string
  direction: 'incoming' | 'outgoing'
  resourceType: 'meal' | 'summary' | 'query' | 'weight' | null
  resourceId: string | null
  metadata?: Record<string, unknown>
}
```

---

## Handler Pipeline

1. Mensagem chega com `quotedMessageId`
2. Handler busca na `bot_messages` pelo `message_id`
3. Se encontrou → monta `QuoteContext`
4. Se não encontrou → ignora quote, trata como mensagem normal
5. Router classifica intent normalmente (quote não afeta classificação)
6. Flow recebe `quoteContext` como parâmetro opcional
7. Se o flow não sabe usar o quote → mensagem de fallback + estado idle

### Assinatura dos flows

```typescript
// Todos os flows ganham parâmetro opcional
handleMealLog(supabase, userId, message, context?, userSettings?, quoteContext?)
handleEdit(supabase, userId, message, context?, quoteContext?)
handleSummary(supabase, userId, message, quoteContext?)
// etc.
```

---

## Cenários Suportados

### 1. Edit flow — Correção via quote

Usuário cita uma mensagem vinculada a uma refeição:

**Apagar item específico:**
> Usuário cita "Registrado! Arroz 150g, Feijão 100g" e escreve "apaga o arroz"
> → Remove só o item "arroz", recalcula total

**Apagar refeição inteira:**
> Usuário cita a mesma mensagem e escreve "apaga" ou "remove"
> → Deleta a refeição toda

**Regra:** Mencionou item específico → ação só naquele item. Não mencionou → ação na refeição inteira.

**Corrigir nome de alimento (NOVO):**
> Usuário cita e escreve "era quinoa, não arroz"
> → Identifica "arroz" na refeição, chama LLM para analisar "quinoa" (respeitando `calorie_mode`), substitui food_name + calories + macros, recalcula total

Pipeline da correção de nome:
1. Recebe `quoteContext` com `resourceType='meal'` + `resourceId`
2. Busca refeição com `getMealWithItems(mealId)`
3. Identifica item por match de texto no `food_name`
4. Chama LLM com novo alimento via `analyzeMeal` (respeitando `calorie_mode`)
5. Atualiza item: `food_name`, `calories`, `protein_g`, `carbs_g`, `fat_g`, `quantity_grams`
6. Recalcula total via `recalculateMealTotal`
7. Responde com antes/depois:

```
✏️ Corrigido!
  Arroz branco 150g → Quinoa 150g
  195 kcal → 172 kcal

📊 Novo total da refeição: 467 kcal
📊 Hoje: 1250 / 2000 kcal
```

**Item não encontrado:**
> "Não encontrei *batata* nessa refeição. Os itens são: Arroz branco, Feijão preto, Frango grelhado. Qual você quer corrigir?"
> Estado → `awaiting_correction_item` com `quoteContext` preservado.

**Corrigir quantidade:**
> Usuário cita e escreve "era 200g" → se 1 item, aplica direto; se vários, pergunta qual
> Usuário cita e escreve "era 200g de arroz" → corrige quantidade do item especificado

### 2. Meal log — Registrar a partir de query

Usuário cita uma resposta de query (ex: "Arroz branco 150g = 195 kcal") e escreve "registra" ou "anota":
- Busca `metadata` da `bot_messages` (JSON da análise)
- Cria refeição direto a partir dos dados, sem re-chamar LLM

### 3. Summary — Pedir detalhes

Usuário cita um resumo e escreve "mais detalhes" ou "detalha o almoço":
- Redireciona para `meal_detail` com data/tipo resolvidos do contexto

### 4. Fallback — Sem fluxo aplicável

Quando quote não se encaixa em nenhum cenário:
> "Ainda não consigo fazer isso com mensagens citadas 😅 Mas posso te ajudar com outra coisa! Digite *menu* para ver as opções."

Estado → idle (clearState).

---

## Salvamento na `bot_messages`

### Incoming (mensagem do usuário)

No handler, após o flow criar o recurso:
```
bot_messages(message_id=messageId, direction='incoming', resource_type='meal', resource_id=mealId)
```

### Outgoing (resposta do bot)

Após `sendTextMessage` retornar o `message_id`:
```
bot_messages(message_id=sentMessageId, direction='outgoing', resource_type='meal', resource_id=mealId)
```

### Sem recurso

Mensagens de help, out_of_scope, etc.: `resource_type=null`, `resource_id=null`.

---

## Nova Query: `getMessageResource`

```typescript
// src/lib/db/queries/bot-messages.ts

export async function saveMessage(
  supabase: SupabaseClient,
  data: {
    userId: string
    messageId: string
    direction: 'incoming' | 'outgoing'
    resourceType?: 'meal' | 'summary' | 'query' | 'weight' | null
    resourceId?: string | null
    metadata?: Record<string, unknown> | null
  }
): Promise<void>

export async function getMessageResource(
  supabase: SupabaseClient,
  messageId: string
): Promise<{
  direction: 'incoming' | 'outgoing'
  resourceType: string | null
  resourceId: string | null
  metadata: Record<string, unknown> | null
} | null>

export async function cleanupOldMessages(
  supabase: SupabaseClient,
  retentionDays: number
): Promise<number>  // retorna quantidade de rows deletadas
```

---

## O que NÃO muda

- Router/classificação de intent (quote é contexto, não afeta classificação)
- Onboarding, weight, settings, help flows (não usam quote por agora)
- LLM prompts existentes
- Tabelas existentes (meals, meal_items, conversation_context, etc.)

---

## Riscos e Mitigações

| Risco | Mitigação |
|-------|-----------|
| Mensagens anteriores à feature não têm vínculo | Quote ignorado, mensagem tratada normalmente |
| `sendTextMessage` falha → outgoing não salvo | Aceitável — pior caso o usuário não consegue citar aquela resposta |
| Volume de dados no free tier | Retenção de 30 dias + estimativa: ~9 MB/mês para 100 usuários ativos |
| Match de nome de item impreciso (ex: "arroz" vs "arroz branco") | Match parcial case-insensitive no `food_name` |
