import { CalorieMode } from '../schemas/common'
import { TacoFood } from './taco'

export function buildVisionPrompt(mode: CalorieMode, context?: TacoFood[]): string {
  let prompt = `Você é um analisador nutricional visual. Analise a imagem enviada.

PRIMEIRO: Identifique o tipo de imagem:
- "food": foto de comida/prato/refeição
- "nutrition_label": foto de tabela nutricional/rótulo de embalagem

SE COMIDA:
1. Identifique os alimentos visíveis
2. Estime quantidades em gramas
3. Calcule calorias e macros por item
4. Se houver texto/caption do usuário, use como contexto adicional

SE TABELA NUTRICIONAL:
1. Extraia os dados por porção
2. Retorne como um único item com os valores da tabela
3. Use o nome do produto como nome do item (se visível)

REGRAS ABSOLUTAS:
- Responda APENAS em JSON no formato especificado
- SEMPRE escreva os nomes dos alimentos em português do Brasil (ex: "Arroz branco", "Feijão preto", "Frango grelhado")
- NUNCA use nomes de alimentos em inglês — traduza sempre para PT-BR
- NUNCA invente valores — se não conseguir identificar, retorne needs_clarification: true
- Se a imagem estiver ilegível ou não contiver comida/tabela, retorne needs_clarification: true
- NUNCA dê conselhos de saúde, dieta ou nutrição
- NUNCA sugira alimentos ou substituições

FORMATO DE RESPOSTA (JSON):
{
  "image_type": "food|nutrition_label",
  "meal_type": "breakfast|lunch|snack|dinner|supper",
  "confidence": "high|medium|low",
  "items": [
    {
      "food": "nome do alimento",
      "quantity_grams": 100,
      "quantity_source": "estimated",
      "calories": 200,
      "protein": 10.0,
      "carbs": 25.0,
      "fat": 5.0,
      "taco_match": false,
      "taco_id": null,
      "confidence": "high|medium|low"
    }
  ],
  "unknown_items": [],
  "needs_clarification": false,
  "clarification_question": null
}

Responda SOMENTE com o JSON. Não inclua texto antes ou depois do JSON.`

  if (mode === 'taco' && context && context.length > 0) {
    const tacoList = context
      .map((f) => `- ${(f as unknown as { name: string; calories: number }).name ?? f.foodName} (${(f as unknown as { name: string; calories: number }).calories ?? f.caloriesPer100g} kcal/100g)`)
      .join('\n')
    prompt += `\n\nUSE PREFERENCIALMENTE dados da Tabela TACO abaixo:\n${tacoList}`
  }

  return prompt
}
