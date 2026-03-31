import { describe, it, expect } from 'vitest'
import { MealAnalysisSchema, MealItemSchema, PortionTypeSchema } from '@/lib/llm/schemas/meal-analysis'
import { IntentClassificationSchema } from '@/lib/llm/schemas/intent'
import { CalorieModeSchema, MealTypeSchema, ConfidenceSchema } from '@/lib/llm/schemas/common'

const validItem = {
  food: 'Arroz branco',
  quantity_grams: 150,
  quantity_source: 'estimated' as const,
  calories: 195,
  protein: 4.0,
  carbs: 42.0,
  fat: 0.5,
}

const validMealAnalysis = {
  meal_type: 'lunch' as const,
  confidence: 'high' as const,
  items: [validItem],
  unknown_items: [],
  needs_clarification: false,
}

describe('MealAnalysisSchema', () => {
  it('parses valid meal analysis', () => {
    const result = MealAnalysisSchema.parse(validMealAnalysis)
    expect(result).toBeDefined()
    expect(result.meal_type).toBe('lunch')
    expect(result.confidence).toBe('high')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].food).toBe('Arroz branco')
  })

  it('applies defaults for optional fields', () => {
    const minimal = {
      meal_type: 'breakfast',
      confidence: 'medium',
      items: [
        {
          food: 'Pão',
          quantity_grams: 50,
          quantity_source: 'estimated',
          calories: 130,
          protein: 4.0,
          carbs: 25.0,
          fat: 1.5,
        },
      ],
    }
    const result = MealAnalysisSchema.parse(minimal)
    expect(result.unknown_items).toEqual([])
    expect(result.needs_clarification).toBe(false)
    expect(result.items[0].confidence).toBe('medium')
  })

  it('rejects missing meal_type', () => {
    const invalid = { ...validMealAnalysis }
    // @ts-expect-error intentional bad input
    delete invalid.meal_type
    expect(() => MealAnalysisSchema.parse(invalid)).toThrow()
  })

  it('rejects empty items array', () => {
    const invalid = { ...validMealAnalysis, items: [] }
    expect(() => MealAnalysisSchema.parse(invalid)).toThrow()
  })

  it('rejects invalid meal_type', () => {
    const invalid = { ...validMealAnalysis, meal_type: 'brunch' }
    expect(() => MealAnalysisSchema.parse(invalid)).toThrow()
  })

  it('rejects negative calories', () => {
    const invalidItem = { ...validItem, calories: -10 }
    const invalid = { ...validMealAnalysis, items: [invalidItem] }
    expect(() => MealAnalysisSchema.parse(invalid)).toThrow()
  })

  it('rejects invalid confidence value', () => {
    const invalid = { ...validMealAnalysis, confidence: 'very_high' }
    expect(() => MealAnalysisSchema.parse(invalid)).toThrow()
  })

  it('accepts optional clarification_question', () => {
    const withClarification = {
      ...validMealAnalysis,
      needs_clarification: true,
      clarification_question: 'Qual foi o tamanho da porção?',
    }
    const result = MealAnalysisSchema.parse(withClarification)
    expect(result.clarification_question).toBe('Qual foi o tamanho da porção?')
  })

  it('accepts unknown_items as array of strings', () => {
    const withUnknown = {
      ...validMealAnalysis,
      unknown_items: ['batata frita caseira'],
    }
    const result = MealAnalysisSchema.parse(withUnknown)
    expect(result.unknown_items).toEqual(['batata frita caseira'])
  })
})

describe('MealItemSchema', () => {
  it('parses a valid meal item', () => {
    const result = MealItemSchema.parse(validItem)
    expect(result.food).toBe('Arroz branco')
    expect(result.quantity_grams).toBe(150)
  })

  it('rejects zero quantity_grams', () => {
    const invalid = { ...validItem, quantity_grams: 0 }
    expect(() => MealItemSchema.parse(invalid)).toThrow()
  })

  it('rejects negative quantity_grams', () => {
    const invalid = { ...validItem, quantity_grams: -5 }
    expect(() => MealItemSchema.parse(invalid)).toThrow()
  })

  it('accepts quantity_source user_provided', () => {
    const item = { ...validItem, quantity_source: 'user_provided' }
    const result = MealItemSchema.parse(item)
    expect(result.quantity_source).toBe('user_provided')
  })

  it('rejects invalid quantity_source', () => {
    const invalid = { ...validItem, quantity_source: 'guessed' }
    expect(() => MealItemSchema.parse(invalid)).toThrow()
  })

  it('accepts zero protein/carbs/fat', () => {
    const item = { ...validItem, protein: 0, carbs: 0, fat: 0 }
    expect(() => MealItemSchema.parse(item)).not.toThrow()
  })

  it('rejects negative protein', () => {
    const invalid = { ...validItem, protein: -1 }
    expect(() => MealItemSchema.parse(invalid)).toThrow()
  })
})

describe('MealItemSchema portion fields', () => {
  it('parses portion_type field', () => {
    const result = MealItemSchema.parse({
      food: 'Arroz branco',
      quantity_grams: 90,
      portion_type: 'bulk',
      has_user_quantity: false,
    })
    expect(result.portion_type).toBe('bulk')
    expect(result.has_user_quantity).toBe(false)
  })

  it('defaults portion_type to "unit" when not provided', () => {
    const result = MealItemSchema.parse({
      food: 'Banana',
      quantity_grams: 120,
    })
    expect(result.portion_type).toBe('unit')
    expect(result.has_user_quantity).toBe(false)
  })

  it('allows null quantity_grams for bulk items without user quantity', () => {
    const result = MealItemSchema.parse({
      food: 'Arroz branco',
      quantity_grams: null,
      portion_type: 'bulk',
      has_user_quantity: false,
    })
    expect(result.quantity_grams).toBeNull()
  })
})

describe('IntentClassificationSchema', () => {
  const validIntents = ['meal_log', 'summary', 'edit', 'query', 'weight', 'help', 'settings', 'out_of_scope'] as const

  it('parses all valid intent types', () => {
    for (const intent of validIntents) {
      const result = IntentClassificationSchema.parse({ intent })
      expect(result.intent).toBe(intent)
    }
  })

  it('rejects unknown intent', () => {
    expect(() => IntentClassificationSchema.parse({ intent: 'delete_all' })).toThrow()
  })

  it('rejects missing intent field', () => {
    expect(() => IntentClassificationSchema.parse({})).toThrow()
  })

  it('rejects non-string intent value', () => {
    expect(() => IntentClassificationSchema.parse({ intent: 42 })).toThrow()
  })
})

describe('Common schemas', () => {
  it('CalorieModeSchema accepts valid modes', () => {
    expect(CalorieModeSchema.parse('taco')).toBe('taco')
    expect(CalorieModeSchema.parse('manual')).toBe('manual')
  })

  it('CalorieModeSchema rejects invalid mode', () => {
    expect(() => CalorieModeSchema.parse('auto')).toThrow()
    expect(() => CalorieModeSchema.parse('approximate')).toThrow()
  })

  it('MealTypeSchema accepts valid types', () => {
    const types = ['breakfast', 'lunch', 'snack', 'dinner', 'supper']
    for (const t of types) {
      expect(MealTypeSchema.parse(t)).toBe(t)
    }
  })

  it('MealTypeSchema rejects invalid type', () => {
    expect(() => MealTypeSchema.parse('brunch')).toThrow()
  })

  it('ConfidenceSchema accepts valid values', () => {
    expect(ConfidenceSchema.parse('high')).toBe('high')
    expect(ConfidenceSchema.parse('medium')).toBe('medium')
    expect(ConfidenceSchema.parse('low')).toBe('low')
  })

  it('ConfidenceSchema rejects invalid value', () => {
    expect(() => ConfidenceSchema.parse('uncertain')).toThrow()
  })
})
