# Message History — Design Spec

## Problema

O bot não mantém histórico de conversa. Quando o usuário pede uma correção durante o fluxo de confirmação, o contexto (incluindo a análise da refeição) é apagado. O usuário precisa repetir tudo do zero.

Exemplo: usuário manda refeição → bot analisa → usuário diz "corrigir" → bot limpa o contexto → usuário explica a correção → bot não sabe do que ele tá falando.

## Solução

Nova tabela `message_history` que armazena as últimas 5 trocas completas (10 registros: 5 do usuário + 5 do bot) por usuário. O histórico é passado ao LLM apenas nos fluxos que precisam de contexto conversacional.

## Tabela `message_history`

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `id` | uuid (PK, default gen_random_uuid()) | ID único |
| `user_id` | uuid (FK → users.id ON DELETE CASCADE) | Referência ao usuário |
| `role` | text (CHECK: 'user' ou 'assistant') | Quem enviou |
| `content` | text (NOT NULL) | Conteúdo da mensagem |
| `created_at` | timestamptz (default now()) | Timestamp |

### Regras

- Máximo 10 registros por usuário (5 trocas completas) — definido como constante `MAX_HISTORY_MESSAGES = 10`
- Ao inserir, remove excedentes com: `DELETE FROM message_history WHERE user_id = $1 AND id NOT IN (SELECT id FROM message_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10)`
- RLS ativo: somente service role gerencia a tabela (bot usa `createServiceRoleClient()`)
- Sem TTL — a rotação natural das 10 mensagens cuida da limpeza
- Index em `(user_id, created_at)` para queries eficientes
- Mensagens de onboarding **não** são gravadas (handler retorna antes de chegar na gravação)

## Quando o histórico é usado

| Fluxo | Manda histórico pro LLM? | Motivo |
|-------|--------------------------|--------|
| `meal_log` | Sim | Entender correções e referências contextuais |
| `edit` | Sim | Saber o que o usuário quer corrigir/apagar |
| `classify` (intent) | Não | Modelo gratuito, keywords resolvem a maioria |
| `query` | Não | Consulta isolada |
| `summary`, `weight`, `settings`, `help`, `onboarding` | Não | Sem LLM ou sem necessidade de contexto |

## Integração

### Gravação (handler.ts)

Após processar cada mensagem (texto, áudio e imagem), gravar no `message_history`:
1. Mensagem do usuário (role: 'user') — para áudio, grava o texto transcrito; para imagem, grava "[imagem de alimento]"
2. Resposta do bot (role: 'assistant')

A gravação acontece **depois** do processamento, num ponto central do handler que cobre os 3 tipos de entrada (texto, áudio, imagem).

### Leitura (meal_log.ts, edit.ts)

Buscar as últimas 10 mensagens do usuário ordenadas por `created_at ASC` e passar como mensagens anteriores na chamada do LLM, antes da mensagem atual.

### Formato pro LLM

As mensagens do histórico entram como array de `{role, content}` no formato chat, inseridas entre o system prompt e a mensagem atual do usuário.

### Mudança na interface LLMProvider

Adicionar parâmetro opcional `history` nas funções que precisam de contexto:

```typescript
analyzeMeal(
  message: string,
  mode: CalorieMode,
  context?: TacoFood[],
  history?: { role: string; content: string }[]
): Promise<MealAnalysis>
```

No `callAPI` do OpenRouter/Ollama, o `history` é inserido entre a mensagem de sistema e a mensagem atual do usuário no array `messages[]`.

## Query layer (src/lib/db/queries/message-history.ts)

Constante e três funções:

- `MAX_HISTORY_MESSAGES = 10`
- `getRecentMessages(userId: string): Promise<{role: string, content: string}[]>` — retorna últimas 10 mensagens ordenadas por created_at ASC
- `saveMessage(userId: string, role: 'user' | 'assistant', content: string): Promise<void>` — insere mensagem e remove excedentes (mantém só 10)
- `clearHistory(userId: string): Promise<void>` — limpa histórico do usuário (usado no reset de dados)

## Migration (supabase/migrations/00007_message_history.sql)

```sql
CREATE TABLE message_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_message_history_user_created ON message_history (user_id, created_at);

ALTER TABLE message_history ENABLE ROW LEVEL SECURITY;

-- Somente service role gerencia esta tabela (bot usa createServiceRoleClient)
-- Nenhuma policy para usuários autenticados via web
```

### Atualização do reset_user_data RPC

Adicionar `DELETE FROM message_history WHERE user_id = p_user_id;` na função `reset_user_data` existente (nova migration ou ALTER).

## Impacto em custo

- ~200-500 tokens extras por chamada nos fluxos meal_log e edit
- Com gpt-4o-mini, custo desprezível (frações de centavo por chamada)
- Classificação de intent continua sem histórico (modelo gratuito)
- Fluxos sem LLM não são afetados
