import { describe, it, expect } from 'vitest'
import { CorrectionSchema } from '@/lib/llm/schemas/correction'

describe('CorrectionSchema', () => {
  it('parses update_quantity action', () => {
    const result = CorrectionSchema.parse({
      action: 'update_quantity',
      target_meal_type: 'lunch',
      target_food: 'arroz',
      new_quantity: '2 escumadeiras',
      new_food: null,
      confidence: 'high',
    })
    expect(result.action).toBe('update_quantity')
    expect(result.target_food).toBe('arroz')
    expect(result.new_quantity).toBe('2 escumadeiras')
  })

  it('parses remove_item action', () => {
    const result = CorrectionSchema.parse({
      action: 'remove_item',
      target_meal_type: null,
      target_food: 'queijo',
      new_quantity: null,
      new_food: null,
      confidence: 'high',
    })
    expect(result.action).toBe('remove_item')
  })

  it('parses replace_item action', () => {
    const result = CorrectionSchema.parse({
      action: 'replace_item',
      target_meal_type: 'breakfast',
      target_food: 'queijo minas',
      new_quantity: null,
      new_food: 'queijo cottage',
      confidence: 'medium',
    })
    expect(result.action).toBe('replace_item')
    expect(result.new_food).toBe('queijo cottage')
  })

  it('parses add_item action', () => {
    const result = CorrectionSchema.parse({
      action: 'add_item',
      target_meal_type: 'lunch',
      target_food: 'suco de laranja',
      new_quantity: '200ml',
      new_food: null,
      confidence: 'high',
    })
    expect(result.action).toBe('add_item')
  })
})
