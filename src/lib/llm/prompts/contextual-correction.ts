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

Classifique a mensagem em UMA das três categorias:

1. CORREÇÃO — o usuário quer modificar algum dado da refeição acima
2. CONFIRMAÇÃO — o usuário está confirmando que a refeição está correta/completa
3. OUTRO — qualquer outra coisa (nova refeição, consulta, resumo, etc.)

Exemplos de CORREÇÃO:
- "O arroz é 200g" → corrigindo quantidade
- "O magic toast é 93kcal" → corrigindo calorias
- "O leite tem 8g de proteína" → corrigindo proteína
- "Era queijo cottage, não minas" → trocando alimento
- "Tira o queijo" → removendo item
- "Faltou o suco" → adicionando item esquecido (mensagem curta, sem "comi", sem refeição nova completa)
- "Esqueci a banana" → adicionando item esquecido

Exemplos de CONFIRMAÇÃO:
- "É só isso" → confirmando que a refeição está completa
- "Café é só isso" → confirmando que o café da manhã é só isso
- "Só isso" → confirmando
- "Pronto" → confirmando
- "Ok" → confirmando
- "Tá certo" → confirmando
- "Isso mesmo" → confirmando
- "Pode registrar" → confirmando
- "É isso aí" → confirmando
- "Nada mais" → confirmando
- "Obrigado" → confirmando (agradecimento após registro = confirmação)
- "Valeu" → confirmando

Exemplos de OUTRO:
- "Almocei arroz e feijão" → nova refeição
- "Comi no café da manhã, 2 fatias de queijo e 220ml de suco" → nova refeição (mesmo tipo, novos itens com quantidade)
- "Comi também uma maçã no lanche" → nova refeição
- "No jantar comi frango com salada" → nova refeição
- "Quantas calorias tem uma pizza?" → consulta
- "Como estou hoje?" → resumo
- "Menu" → ajuda

REGRAS DE DESEMPATE (aplicar nesta ordem):

1. Se a mensagem começa com verbos de ingestão ("Comi", "Almocei", "Jantei", "Tomei", "Bebi") seguidos de itens com quantidades (ex: "2 fatias", "220ml", "100g", "uma unidade"), é OUTRO — nova refeição. NUNCA classificar como CORREÇÃO, mesmo que mencione o mesmo tipo de refeição já registrado.

2. Se a mensagem menciona o nome da refeição (café, almoço, jantar, lanche) + uma confirmação curta (ex: "Café é só isso", "Almoço pronto"), é CONFIRMAÇÃO.

3. CORREÇÃO só se aplica a mensagens curtas que claramente alteram um item existente ("o arroz é 200g", "tira o queijo") ou adicionam um item esquecido sem descrever uma refeição nova ("faltou o suco", "esqueci a banana").

Se for CORREÇÃO, reformule a mensagem como uma instrução explícita de correção.

Responda APENAS com JSON:
- Correção: {"type": "correction", "corrected_message": "mensagem reformulada"}
- Confirmação: {"type": "confirmation"}
- Outro: {"type": "other"}`
}
