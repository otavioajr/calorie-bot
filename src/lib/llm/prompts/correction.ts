export function buildCorrectionPromptWithItems(
  message: string,
  items: Array<{ foodName: string; quantityGrams: number; calories: number; proteinG?: number; carbsG?: number; fatG?: number }>,
): string {
  const itemsContext = items
    .map((i, idx) =>
      `${idx + 1}. ${i.foodName} — ${i.quantityGrams}g — ${i.calories} kcal` +
      (i.proteinG ? ` — P: ${i.proteinG}g` : '') +
      (i.carbsG ? ` / C: ${i.carbsG}g` : '') +
      (i.fatG ? ` / G: ${i.fatG}g` : '')
    )
    .join('\n')

  return `Analise a mensagem do usuário e extraia a intenção de CORREÇÃO de uma refeição já registrada.

ITENS ATUAIS DA REFEIÇÃO:
${itemsContext}

MENSAGEM DO USUÁRIO: "${message}"

AÇÕES POSSÍVEIS:
- "update_quantity": mudar a quantidade de um item (ex: "o arroz era 2 escumadeiras", "era 200ml")
- "update_value": corrigir diretamente um valor nutricional (ex: "o magic toast é 95kcal", "a proteína é 10g", "arroz tem 5g de gordura")
- "remove_item": remover um item (ex: "tira o queijo", "apaga o arroz")
- "add_item": adicionar um item que faltou (ex: "faltou o ovo", "esqueci do suco")
- "replace_item": trocar um alimento por outro (ex: "era quinoa, não arroz", "troca arroz por quinoa")
- "delete_meal": apagar a refeição inteira (ex: "apaga tudo", "deleta essa refeição")

REGRAS CRÍTICAS:
- Se o usuário menciona "food X é/tem/são N calorias/kcal/cal", isso é SEMPRE "update_value" com field "calories", NUNCA "replace_item"
- Se o usuário menciona "food X é/tem Ng de proteína/prot", isso é "update_value" com field "protein"
- Se o usuário menciona "food X é Y" onde Y é outro ALIMENTO (não número), isso é "replace_item"
- Use os ITENS ATUAIS DA REFEIÇÃO para identificar "target_food" — prefira nomes exatos da lista
- "target_food": nome do alimento alvo conforme aparece na lista acima
- "new_quantity": nova quantidade em texto livre. Null se não aplicável.
- "new_food": novo alimento (para replace_item). Null se não aplicável.
- "new_value": para update_value: {"field": "calories|protein|carbs|fat", "amount": number}. Null se não aplicável.
- "confidence": "high" se clara, "medium" se precisa confirmar, "low" se ambíguo

Responda SOMENTE com JSON:
{
  "action": "update_quantity|update_value|remove_item|add_item|replace_item|delete_meal",
  "target_meal_type": null,
  "target_food": "nome do alimento ou null",
  "new_quantity": "quantidade nova ou null",
  "new_food": "novo alimento ou null",
  "new_value": {"field": "calories|protein|carbs|fat", "amount": number} ou null,
  "confidence": "high|medium|low"
}`
}

export function buildCorrectionPrompt(message: string): string {
  return `Analise a mensagem do usuário e extraia a intenção de CORREÇÃO de uma refeição já registrada.

MENSAGEM DO USUÁRIO: "${message}"

AÇÕES POSSÍVEIS:
- "update_quantity": mudar a quantidade de um item (ex: "o arroz era 2 escumadeiras", "era 200ml, não 100ml")
- "update_value": corrigir diretamente um valor nutricional (ex: "o magic toast é 93kcal", "o arroz tem 5g de proteína", "o leite tem 8g de gordura")
- "remove_item": remover um item (ex: "tira o queijo", "remove o suco")
- "add_item": adicionar um item que faltou (ex: "faltou o suco", "esqueci de colocar a salada")
- "replace_item": trocar um alimento por outro (ex: "era queijo cottage, não minas")
- "delete_meal": apagar a refeição inteira (ex: "apaga o almoço", "deleta tudo")

REGRAS:
- "target_meal_type": tipo da refeição alvo (breakfast, lunch, snack, dinner, supper). Se o usuário não especificou, deixe null.
- "target_food": nome do alimento alvo (o que está no registro atual). Para add_item, é o nome do item a adicionar.
- "new_quantity": nova quantidade descrita pelo usuário (texto livre, ex: "2 escumadeiras", "200ml"). Null se não aplicável.
- "new_food": novo alimento (para replace_item). Null se não aplicável.
- "new_value": para update_value, o campo e valor a corrigir. Null se não aplicável.
  - "field": "calories", "protein", "carbs" ou "fat"
  - "amount": valor numérico
- "confidence": "high" se a intenção é clara, "medium" se precisa confirmar, "low" se ambíguo.

Responda SOMENTE com JSON no formato:
{
  "action": "update_quantity|update_value|remove_item|add_item|replace_item|delete_meal",
  "target_meal_type": "breakfast|lunch|snack|dinner|supper|null",
  "target_food": "nome do alimento",
  "new_quantity": "quantidade nova ou null",
  "new_food": "novo alimento ou null",
  "new_value": {"field": "calories|protein|carbs|fat", "amount": number} ou null,
  "confidence": "high|medium|low"
}`
}
