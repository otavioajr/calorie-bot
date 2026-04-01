# Contextual Correction — Design Spec

## Problema

Quando o usuario registra uma refeicao e em seguida envia uma mensagem corrigindo um item (ex: "O magic toast e 93kcal"), o bot nao reconhece como correcao. Isso acontece porque:

1. O classificador de intencao (regras + LLM) nao tem contexto sobre a refeicao recente
2. A LLM ve "magic toast e 93kcal" isoladamente e classifica como `query`
3. O `CorrectionSchema` nao suporta correcoes diretas de valor (so quantidade)

## Solucao

Usar um estado `recent_meal` com TTL curto e um prompt LLM focado ("gatekeeper") para detectar correcoes contextuais.

## Design

### 1. Estado `recent_meal`

Novo tipo de contexto com TTL de 5 minutos. Salvo apos registrar qualquer refeicao.

```json
{
  "mealId": "uuid",
  "mealType": "breakfast",
  "items": [
    {
      "id": "item-uuid",
      "foodName": "Magic Toast",
      "quantityGrams": 30,
      "quantityDisplay": "1 pacote com 6 torradas",
      "calories": 120,
      "proteinG": 3,
      "carbsG": 20,
      "fatG": 3
    }
  ]
}
```

Pontos de insercao do `setState('recent_meal', ...)`:
- `meal-log.ts` — apos `saveMeals()` (registro via texto/audio)
- `handler.ts` — apos `createMeal()` no fluxo de imagem
- `handler.ts` — apos `createMeal()` no fluxo de label portions

### 2. LLM Gatekeeper

Prompt focado que recebe os itens da refeicao recente e a mensagem do usuario. Determina se a mensagem e uma correcao.

Input: itens da refeicao + mensagem do usuario
Output:
```json
{
  "is_correction": true,
  "corrected_message": "corrigir o magic toast para 93kcal"
}
```

O campo `corrected_message` reformula a mensagem do usuario como uma correcao explicita, permitindo reusar o fluxo de edit existente (`handleNaturalLanguageCorrection`).

Exemplos de correcao que o gatekeeper deve detectar:
- "O arroz e 200g" — corrigindo quantidade
- "O magic toast e 93kcal" — corrigindo calorias
- "O leite tem 8g de proteina" — corrigindo proteina
- "Era queijo cottage, nao minas" — trocando alimento
- "Tira o queijo" — removendo item
- "Faltou o suco" — adicionando item

Se NAO for correcao (nova refeicao, pergunta, etc.), retorna `is_correction: false`.

### 3. Expansao do CorrectionSchema

Nova action `update_value` para correcoes diretas de valores nutricionais.

```typescript
// Nova action
'update_value'

// Novo campo
new_value: z.object({
  field: z.enum(['calories', 'protein', 'carbs', 'fat']),
  amount: z.number(),
}).nullable().default(null)
```

Prompt de correcao atualizado para incluir:
- `update_value`: corrigir diretamente um valor nutricional (ex: "o magic toast e 93kcal", "o arroz tem 5g de proteina")

Handler `update_value` no edit.ts:
- Encontra o item pelo `target_food`
- Atualiza diretamente o campo indicado (calories, protein, carbs, fat)
- Recalcula o total da refeicao

### 4. Fluxo no handler

```
Mensagem chega
  -> context = recent_meal?
    -> LLM gatekeeper: "e correcao?"
      -> SIM: passa corrected_message ao handleEdit com mealId do context
      -> NAO: clearState + segue classificacao normal (mensagem original continua)
```

Comportamentos:
- `handleEdit` recebe o `mealId` direto do context (nao precisa perguntar "qual refeicao?")
- Apos a correcao, o estado `recent_meal` e substituido por um novo `recent_meal` atualizado (permite corrigir mais de um item em sequencia)
- Se o gatekeeper diz que nao e correcao, a mensagem segue o fluxo normal sem impacto

## Arquivos Afetados

| Arquivo | Mudanca |
|---------|---------|
| `src/lib/db/queries/context.ts` | Adicionar `recent_meal` ao `ContextType` e `CONTEXT_TTLS` |
| `src/lib/bot/state.ts` | Re-exporta novo tipo (automatico) |
| `src/lib/llm/prompts/correction.ts` | Atualizar prompt com `update_value` |
| `src/lib/llm/schemas/correction.ts` | Adicionar `update_value` e `new_value` |
| `src/lib/llm/prompts/contextual-correction.ts` | Novo arquivo — prompt do gatekeeper |
| `src/lib/bot/flows/edit.ts` | Handler para `update_value`, aceitar mealId direto |
| `src/lib/bot/flows/meal-log.ts` | Salvar `recent_meal` apos registro |
| `src/lib/bot/handler.ts` | Case `recent_meal` com gatekeeper + roteamento |
