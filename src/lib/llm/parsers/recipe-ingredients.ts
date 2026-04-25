import { getLLMProvider } from '@/lib/llm/index'
import { RecipeParseSchema, type RecipeParseIngredient } from '@/lib/llm/schemas/recipe-parse'

const SYSTEM_PROMPT = `Voce eh um parser estruturado. Recebe lista textual de ingredientes em portugues e retorna JSON com cada ingrediente em gramas.
Regras:
- Se quantidade vier em outra unidade (xicara, colher, kg), CONVERTA para gramas usando estimativas razoaveis.
- "1 cebola media" ~= 110g; "1 dente de alho" ~= 5g; "1 xicara cha" ~= 240g; "1 colher sopa" ~= 15g.
- NUNCA invente ingredientes que nao estejam no texto.
- Responda apenas JSON valido no formato: {"ingredients":[{"food":"...","quantity_grams":N}]}.`

function safeParseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw.trim())
  } catch {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) {
      try {
        return JSON.parse(match[1].trim())
      } catch {
        return null
      }
    }
    return null
  }
}

export async function parseRecipeIngredients(text: string): Promise<RecipeParseIngredient[]> {
  const llm = getLLMProvider()
  const raw = await llm.chat(text, SYSTEM_PROMPT, true)
  const parsed = safeParseJSON(raw)
  const response = RecipeParseSchema.parse(parsed)

  return response.ingredients
}
