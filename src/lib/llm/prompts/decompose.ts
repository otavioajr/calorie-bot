export function buildDecomposePrompt(foodName: string, totalGrams: number): string {
  return `Você é um especialista em composição de alimentos. Sua ÚNICA função é decompor um alimento composto ou preparado nos seus ingredientes básicos.

ALIMENTO: "${foodName}" (${totalGrams}g no total)

REGRAS:
- Decomponha em ingredientes SIMPLES e BÁSICOS (farinha, carne, óleo, arroz, feijão, etc.)
- A soma dos gramas dos ingredientes deve ser aproximadamente igual a ${totalGrams}g
- Use nomes de ingredientes em português do Brasil
- Use nomes genéricos que possam ser encontrados em uma tabela nutricional (ex: "Farinha, de trigo" em vez de "farinha especial")
- Responda APENAS em JSON

FORMATO DE RESPOSTA (JSON):
{
  "ingredients": [
    { "food": "nome do ingrediente", "quantity_grams": 50 }
  ]
}

Responda SOMENTE com o JSON. Não inclua texto antes ou depois do JSON.`
}
