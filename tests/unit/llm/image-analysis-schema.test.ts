import { describe, it, expect } from 'vitest'
import { ImageAnalysisSchema } from '@/lib/llm/schemas/image-analysis'
import { buildVisionPrompt } from '@/lib/llm/prompts/vision'

describe('ImageAnalysisSchema', () => {
  it('validates a food image analysis result', () => {
    const input = {
      image_type: 'food',
      meal_type: 'lunch',
      confidence: 'high',
      items: [{ food: 'Arroz branco', quantity_grams: 150, calories: 195, protein: 4, carbs: 42, fat: 0.5 }],
    }
    const result = ImageAnalysisSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.image_type).toBe('food')
      expect(result.data.meal_type).toBe('lunch')
      expect(result.data.items).toHaveLength(1)
    }
  })

  it('validates a nutrition_label result with optional meal_type', () => {
    const input = {
      image_type: 'nutrition_label',
      confidence: 'high',
      items: [{ food: 'Granola', quantity_grams: 40, calories: 180, protein: 4, carbs: 28, fat: 6 }],
    }
    const result = ImageAnalysisSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.image_type).toBe('nutrition_label')
      expect(result.data.meal_type).toBeUndefined()
    }
  })

  it('allows empty items when needs_clarification is true', () => {
    const input = {
      image_type: 'food',
      confidence: 'low',
      items: [],
      needs_clarification: true,
      clarification_question: 'Não consegui identificar os alimentos.',
    }
    const result = ImageAnalysisSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.items).toHaveLength(0)
      expect(result.data.needs_clarification).toBe(true)
    }
  })

  it('defaults needs_clarification to false', () => {
    const input = {
      image_type: 'food',
      confidence: 'high',
      items: [{ food: 'Banana', quantity_grams: 120, calories: 107, protein: 1.3, carbs: 27, fat: 0.3 }],
    }
    const result = ImageAnalysisSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.needs_clarification).toBe(false)
    }
  })

  it('rejects invalid image_type', () => {
    const input = { image_type: 'selfie', confidence: 'high', items: [] }
    const result = ImageAnalysisSchema.safeParse(input)
    expect(result.success).toBe(false)
  })
})

describe('buildVisionPrompt', () => {
  it('returns base prompt for approximate mode', () => {
    const prompt = buildVisionPrompt('approximate')
    expect(prompt).toContain('analisador nutricional visual')
    expect(prompt).toContain('"food"')
    expect(prompt).toContain('"nutrition_label"')
    expect(prompt).not.toContain('Tabela TACO')
  })

  it('appends TACO data for taco mode', () => {
    const context = [{ name: 'Arroz branco', calories: 128 }]
    const prompt = buildVisionPrompt('taco', context as any)
    expect(prompt).toContain('Tabela TACO')
    expect(prompt).toContain('Arroz branco')
  })
})
