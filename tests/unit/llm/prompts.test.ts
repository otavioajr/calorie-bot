import { describe, it, expect } from 'vitest'
import { buildAnalyzePrompt } from '@/lib/llm/prompts/analyze'
import { buildManualPrompt } from '@/lib/llm/prompts/manual'
import { buildClassifyPrompt } from '@/lib/llm/prompts/classify'
import { buildDecomposePrompt } from '@/lib/llm/prompts/decompose'
import { buildVisionPrompt } from '@/lib/llm/prompts/vision'

describe('buildAnalyzePrompt', () => {
  it('contains key constraints', () => {
    const prompt = buildAnalyzePrompt()
    expect(prompt).toContain('APENAS em JSON')
    expect(prompt).toContain('NUNCA dê conselhos')
    expect(prompt).toContain('unknown_items')
    expect(prompt).toContain('needs_clarification')
  })

  it('contains JSON format specification', () => {
    const prompt = buildAnalyzePrompt()
    expect(prompt).toContain('meal_type')
    expect(prompt).toContain('confidence')
    expect(prompt).toContain('items')
  })

  it('contains all meal type options', () => {
    const prompt = buildAnalyzePrompt()
    expect(prompt).toContain('breakfast')
    expect(prompt).toContain('lunch')
    expect(prompt).toContain('dinner')
  })

  it('contains multiple meals instruction', () => {
    const prompt = buildAnalyzePrompt()
    expect(prompt).toContain('meals')
  })

  it('contains reference to previous meals instruction', () => {
    const prompt = buildAnalyzePrompt()
    expect(prompt).toContain('references_previous')
    expect(prompt).toContain('reference_query')
  })
})

describe('buildAnalyzePrompt portion classification', () => {
  it('includes portion_type in the prompt', () => {
    const prompt = buildAnalyzePrompt()
    expect(prompt).toContain('portion_type')
    expect(prompt).toContain('"unit"')
    expect(prompt).toContain('"bulk"')
    expect(prompt).toContain('"packaged"')
  })

  it('includes has_user_quantity in the prompt', () => {
    const prompt = buildAnalyzePrompt()
    expect(prompt).toContain('has_user_quantity')
  })

  it('instructs to set quantity_grams null for bulk without user quantity', () => {
    const prompt = buildAnalyzePrompt()
    expect(prompt).toContain('quantity_grams": null')
  })
})

describe('buildManualPrompt', () => {
  it('instructs to extract from nutritional table', () => {
    const prompt = buildManualPrompt()
    expect(prompt).toContain('tabela nutricional')
  })

  it('returns a non-empty string', () => {
    const prompt = buildManualPrompt()
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
  })

  it('contains JSON response instruction', () => {
    const prompt = buildManualPrompt()
    expect(prompt).toContain('JSON')
  })

  it('mentions extraction of nutritional values', () => {
    const prompt = buildManualPrompt()
    expect(prompt).toContain('calorias')
  })
})

describe('buildClassifyPrompt', () => {
  it('lists all intent categories', () => {
    const prompt = buildClassifyPrompt()
    expect(prompt).toContain('meal_log')
    expect(prompt).toContain('summary')
    expect(prompt).toContain('edit')
    expect(prompt).toContain('query')
    expect(prompt).toContain('weight')
    expect(prompt).toContain('help')
    expect(prompt).toContain('settings')
    expect(prompt).toContain('out_of_scope')
  })

  it('specifies JSON response format', () => {
    const prompt = buildClassifyPrompt()
    expect(prompt).toContain('JSON')
    expect(prompt).toContain('"intent"')
  })

  it('contains all 8 categories', () => {
    const categories = ['meal_log', 'summary', 'edit', 'query', 'weight', 'help', 'settings', 'out_of_scope']
    const prompt = buildClassifyPrompt()
    for (const category of categories) {
      expect(prompt).toContain(category)
    }
  })

  it('instructs to classify into ONE category', () => {
    const prompt = buildClassifyPrompt()
    expect(prompt).toContain('UMA')
  })

  it('contains definitions for each intent', () => {
    const prompt = buildClassifyPrompt()
    expect(prompt).toContain('comeu')
    expect(prompt).toContain('resumo')
  })
})

describe('buildDecomposePrompt', () => {
  it('includes food name and grams', () => {
    const prompt = buildDecomposePrompt('Coxinha', 130)
    expect(prompt).toContain('Coxinha')
    expect(prompt).toContain('130')
  })

  it('instructs to decompose into basic ingredients', () => {
    const prompt = buildDecomposePrompt('Lasanha', 300)
    expect(prompt).toContain('ingredientes')
    expect(prompt).toContain('JSON')
  })

  it('returns a non-empty string', () => {
    const prompt = buildDecomposePrompt('Pizza', 200)
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
  })
})

describe('buildVisionPrompt', () => {
  it('returns base prompt with vision instructions', () => {
    const prompt = buildVisionPrompt()
    expect(prompt).toContain('analisador nutricional visual')
    expect(prompt).toContain('"food"')
    expect(prompt).toContain('"nutrition_label"')
  })

  it('contains JSON format specification', () => {
    const prompt = buildVisionPrompt()
    expect(prompt).toContain('JSON')
    expect(prompt).toContain('image_type')
  })
})
