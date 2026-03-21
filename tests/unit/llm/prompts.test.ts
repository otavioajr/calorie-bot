import { describe, it, expect } from 'vitest'
import { buildApproximatePrompt } from '@/lib/llm/prompts/approximate'
import { buildTacoPrompt, type TacoFood } from '@/lib/llm/prompts/taco'
import { buildManualPrompt } from '@/lib/llm/prompts/manual'
import { buildClassifyPrompt } from '@/lib/llm/prompts/classify'

describe('buildApproximatePrompt', () => {
  it('contains key constraints', () => {
    const prompt = buildApproximatePrompt()
    expect(prompt).toContain('APENAS em JSON')
    expect(prompt).toContain('NUNCA dê conselhos')
    expect(prompt).toContain('unknown_items')
    expect(prompt).toContain('needs_clarification')
  })

  it('does NOT contain TACO references', () => {
    const prompt = buildApproximatePrompt()
    expect(prompt).not.toContain('TACO')
    expect(prompt).not.toContain('Tabela TACO')
  })

  it('contains JSON format specification', () => {
    const prompt = buildApproximatePrompt()
    expect(prompt).toContain('meal_type')
    expect(prompt).toContain('confidence')
    expect(prompt).toContain('items')
  })

  it('contains all meal type options', () => {
    const prompt = buildApproximatePrompt()
    expect(prompt).toContain('breakfast')
    expect(prompt).toContain('lunch')
    expect(prompt).toContain('dinner')
  })
})

describe('buildTacoPrompt', () => {
  it('contains TACO instruction', () => {
    const prompt = buildTacoPrompt([])
    expect(prompt).toContain('Tabela TACO')
  })

  it('includes TACO data in prompt', () => {
    const tacoData: TacoFood[] = [
      {
        id: 1,
        foodName: 'Arroz branco',
        caloriesPer100g: 128,
        proteinPer100g: 2.5,
        carbsPer100g: 28.1,
        fatPer100g: 0.2,
      },
    ]
    const prompt = buildTacoPrompt(tacoData)
    expect(prompt).toContain('Arroz branco')
    expect(prompt).toContain('128')
  })

  it('contains all base constraints too', () => {
    const prompt = buildTacoPrompt([])
    expect(prompt).toContain('APENAS em JSON')
    expect(prompt).toContain('NUNCA dê conselhos')
    expect(prompt).toContain('unknown_items')
    expect(prompt).toContain('needs_clarification')
  })

  it('instructs to prefer TACO data when available', () => {
    const prompt = buildTacoPrompt([])
    expect(prompt).toContain('Use APENAS dados da Tabela TACO')
  })

  it('handles empty TACO data gracefully', () => {
    const prompt = buildTacoPrompt([])
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
  })

  it('includes multiple TACO items when provided', () => {
    const tacoData: TacoFood[] = [
      { id: 1, foodName: 'Arroz branco', caloriesPer100g: 128, proteinPer100g: 2.5, carbsPer100g: 28.1, fatPer100g: 0.2 },
      { id: 2, foodName: 'Feijão preto', caloriesPer100g: 77, proteinPer100g: 4.5, carbsPer100g: 14.0, fatPer100g: 0.5 },
    ]
    const prompt = buildTacoPrompt(tacoData)
    expect(prompt).toContain('Arroz branco')
    expect(prompt).toContain('Feijão preto')
    expect(prompt).toContain('77')
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
