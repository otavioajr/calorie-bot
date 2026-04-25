import { getLLMProvider } from '@/lib/llm/index'
import { RecipeParseSchema, type RecipeParseIngredient } from '@/lib/llm/schemas/recipe-parse'

const SYSTEM_PROMPT = `Voce eh um parser estruturado. Recebe lista textual de ingredientes em portugues e retorna JSON com cada ingrediente em gramas.
Regras:
- Se quantidade vier em outra unidade (xicara, colher, kg), CONVERTA para gramas usando estimativas razoaveis.
- "1 cebola media" ~= 110g; "1 dente de alho" ~= 5g; "1 xicara cha" ~= 240g; "1 colher sopa" ~= 15g.
- NUNCA invente ingredientes que nao estejam no texto.
- Responda apenas JSON valido no formato: {"ingredients":[{"food":"...","quantity_grams":N}]}.`

function rawExcerpt(raw: string): string {
  const normalized = raw.replace(/\s+/g, ' ').trim()
  return normalized.length > 200 ? `${normalized.slice(0, 200)}...` : normalized
}

function parseJSONResponse(raw: string): unknown {
  try {
    return JSON.parse(raw.trim())
  } catch (rawError) {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) {
      try {
        return JSON.parse(match[1].trim())
      } catch (fencedError) {
        throw new Error(`Failed to parse recipe ingredients JSON: ${rawExcerpt(raw)}`, {
          cause: fencedError,
        })
      }
    }

    throw new Error(`Failed to parse recipe ingredients JSON: ${rawExcerpt(raw)}`, {
      cause: rawError,
    })
  }
}

export async function parseRecipeIngredients(text: string): Promise<RecipeParseIngredient[]> {
  const llm = getLLMProvider()
  const raw = await llm.chat(text, SYSTEM_PROMPT, true)
  const parsed = parseJSONResponse(raw)

  try {
    const response = RecipeParseSchema.parse(parsed)

    return response.ingredients
  } catch (error) {
    throw new Error(`Invalid recipe ingredients response: ${rawExcerpt(raw)}`, {
      cause: error,
    })
  }
}
