export interface RecentMealItem {
  foodName: string
  quantityDisplay: string | null
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}

const MEAL_TYPE_LABELS: Record<string, string> = {
  breakfast: 'Café da manhã',
  lunch: 'Almoço',
  snack: 'Lanche',
  dinner: 'Jantar',
  supper: 'Ceia',
}

export function buildContextualCorrectionPrompt(
  items: RecentMealItem[],
  message: string,
  currentMealType: string,
): string {
  const itemLines = items.map(i => {
    const display = i.quantityDisplay || '?'
    return `• ${i.foodName} (${display}) — ${i.calories} kcal | P:${i.proteinG}g C:${i.carbsG}g G:${i.fatG}g`
  }).join('\n')

  const currentMealLabel = MEAL_TYPE_LABELS[currentMealType] ?? currentMealType

  return `O usuário ACABOU de registrar uma refeição com estes itens:

${itemLines}

TIPO ATUAL DA REFEIÇÃO: ${currentMealType} (${currentMealLabel})

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
- "Comi também 110ml de suco" → adicionando item esquecido à MESMA refeição (sem novo meal_type)
- "Tomei também um café" → adicionando item esquecido à MESMA refeição
- "Também 2 fatias de pão" → adicionando item esquecido
- "Adicionar 30g de pastel de nata" → adicionando item à mesma refeição
- "Adiciona um café" → adicionando item à mesma refeição
- "Coloca mais uma banana" → adicionando item à mesma refeição
- "Mais 100ml de suco" → adicionando item à mesma refeição

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
- "Comi no café da manhã, 2 fatias de queijo e 220ml de suco" → nova refeição (mesmo tipo, novos itens com quantidade — usuário descreve refeição completa)
- "Comi também uma maçã no lanche" → nova refeição SOMENTE se snack/lanche for diferente do TIPO ATUAL
- "No jantar comi frango com salada" → nova refeição (meal_type explícito)
- "Quantas calorias tem uma pizza?" → consulta
- "Como estou hoje?" → resumo
- "Menu" → ajuda

REGRAS DE DESEMPATE (aplicar nesta ordem):

1. Se a mensagem usa "também" ou "esqueci"/"faltou" SEM indicar um destino explicitamente diferente do tipo atual, é CORREÇÃO com add_item — o usuário está adicionando um item que esqueceu na mesma refeição. Exemplos: "comi também 110ml de suco", "tomei também um café", "também 2 fatias de pão".

2. Se a mensagem começa com verbo de adição ("adicionar", "adiciona", "acrescenta", "coloca", "inclui", "mais") SEM indicar um tipo explicitamente diferente do tipo atual, é CORREÇÃO com add_item — o usuário quer incluir um item na mesma refeição. Exemplos: "adicionar 30g de pastel de nata", "adiciona um café", "coloca mais uma banana", "mais 100ml de suco".

3. Só considere meal_type explicitamente diferente quando a mensagem indicar o destino, por exemplo "no almoço", "para o jantar" ou "no café da manhã", e esse destino for diferente do TIPO ATUAL. A expressão "um café" é uma bebida, não um meal_type. Nesse caso de destino diferente, é OUTRO — nova refeição.

4. Se a mensagem começa com verbos de ingestão e DESCREVE uma refeição completa com múltiplos itens e quantidades, sem "também"/"esqueci"/"faltou"/verbo de adição, é OUTRO — nova refeição.

5. Se a mensagem menciona o nome da refeição (café, almoço, jantar, lanche) + uma confirmação curta (ex: "Café é só isso", "Almoço pronto"), é CONFIRMAÇÃO.

6. Um pedido explícito para reclassificar a refeição atual (ex: "isso era almoço") continua sendo CORREÇÃO. Outros tipos de CORREÇÃO só se aplicam a mensagens curtas que claramente alteram um item existente ("o arroz é 200g", "tira o queijo").

Se for CORREÇÃO, reformule a mensagem como uma instrução explícita de correção.

Responda APENAS com JSON:
- Correção: {"type": "correction", "corrected_message": "mensagem reformulada"}
- Confirmação: {"type": "confirmation"}
- Outro: {"type": "other"}`
}
