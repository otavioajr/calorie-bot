export interface RecentMealItem {
  foodName: string
  quantityDisplay: string | null
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}

export function buildContextualCorrectionPrompt(
  items: RecentMealItem[],
  message: string,
): string {
  const itemLines = items.map(i => {
    const display = i.quantityDisplay || '?'
    return `• ${i.foodName} (${display}) — ${i.calories} kcal | P:${i.proteinG}g C:${i.carbsG}g G:${i.fatG}g`
  }).join('\n')

  return `O usuário ACABOU de registrar uma refeição com estes itens:

${itemLines}

Agora ele enviou esta mensagem: "${message}"

Determine se o usuário está CORRIGINDO algum dado de um item da refeição acima.

Exemplos de CORREÇÃO:
- "O arroz é 200g" → corrigindo quantidade
- "O magic toast é 93kcal" → corrigindo calorias
- "O leite tem 8g de proteína" → corrigindo proteína
- "Era queijo cottage, não minas" → trocando alimento
- "Tira o queijo" → removendo item
- "Faltou o suco" → adicionando item

Exemplos que NÃO são correção:
- "Almocei arroz e feijão" → nova refeição
- "Quantas calorias tem uma pizza?" → consulta
- "Como estou hoje?" → resumo
- "Obrigado" → agradecimento

Se for correção, reformule a mensagem como uma instrução explícita de correção.
Se NÃO for correção, retorne is_correction: false.

Responda APENAS com JSON:
{"is_correction": true, "corrected_message": "mensagem reformulada"} ou {"is_correction": false}`
}
