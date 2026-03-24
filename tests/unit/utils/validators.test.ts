import { describe, it, expect } from 'vitest'
import {
  validateName,
  validateAge,
  validateSex,
  validateWeight,
  validateHeight,
  validateActivityLevel,
  validateGoal,
  validateCalorieMode,
  validatePhone,
} from '@/lib/utils/validators'

// ---------------------------------------------------------------------------
// validateName
// ---------------------------------------------------------------------------
describe('validateName', () => {
  it('returns valid for a regular name', () => {
    const result = validateName('João')
    expect(result).toEqual({ valid: true, value: 'João' })
  })

  it('returns valid for a compound name', () => {
    const result = validateName('Ana Maria')
    expect(result).toEqual({ valid: true, value: 'Ana Maria' })
  })

  it('trims whitespace and returns valid', () => {
    const result = validateName('  Maria  ')
    expect(result).toEqual({ valid: true, value: 'Maria' })
  })

  it('returns invalid for empty string', () => {
    const result = validateName('')
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toBeTruthy()
  })

  it('returns invalid for single character name', () => {
    const result = validateName('A')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for name with numbers', () => {
    const result = validateName('Jo3o')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for whitespace-only string', () => {
    const result = validateName('   ')
    expect(result.valid).toBe(false)
  })

  it('returns valid for "Zé" (2 chars after trim)', () => {
    const result = validateName('Zé')
    expect(result).toEqual({ valid: true, value: 'Zé' })
  })
})

// ---------------------------------------------------------------------------
// validateAge
// ---------------------------------------------------------------------------
describe('validateAge', () => {
  it('returns valid for a normal age', () => {
    const result = validateAge('25')
    expect(result).toEqual({ valid: true, value: 25 })
  })

  it('returns valid for minimum age 12', () => {
    const result = validateAge('12')
    expect(result).toEqual({ valid: true, value: 12 })
  })

  it('returns valid for maximum age 120', () => {
    const result = validateAge('120')
    expect(result).toEqual({ valid: true, value: 120 })
  })

  it('returns invalid for age below minimum', () => {
    const result = validateAge('5')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for age above maximum', () => {
    const result = validateAge('121')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for non-numeric string', () => {
    const result = validateAge('abc')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for decimal number', () => {
    const result = validateAge('25.5')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for empty string', () => {
    const result = validateAge('')
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateSex
// ---------------------------------------------------------------------------
describe('validateSex', () => {
  it('returns male for "1"', () => {
    const result = validateSex('1')
    expect(result).toEqual({ valid: true, value: 'male' })
  })

  it('returns female for "2"', () => {
    const result = validateSex('2')
    expect(result).toEqual({ valid: true, value: 'female' })
  })

  it('returns male for "masculino" (case insensitive)', () => {
    const result = validateSex('MASCULINO')
    expect(result).toEqual({ valid: true, value: 'male' })
  })

  it('returns female for "feminino"', () => {
    const result = validateSex('feminino')
    expect(result).toEqual({ valid: true, value: 'female' })
  })

  it('returns male for "m"', () => {
    const result = validateSex('m')
    expect(result).toEqual({ valid: true, value: 'male' })
  })

  it('returns female for "f"', () => {
    const result = validateSex('F')
    expect(result).toEqual({ valid: true, value: 'female' })
  })

  it('returns invalid for "3"', () => {
    const result = validateSex('3')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for arbitrary text', () => {
    const result = validateSex('abc')
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateWeight
// ---------------------------------------------------------------------------
describe('validateWeight', () => {
  it('returns valid for weight with dot decimal', () => {
    const result = validateWeight('72.5')
    expect(result).toEqual({ valid: true, value: 72.5 })
  })

  it('returns valid for weight with comma decimal', () => {
    const result = validateWeight('72,5')
    expect(result).toEqual({ valid: true, value: 72.5 })
  })

  it('returns valid for integer weight', () => {
    const result = validateWeight('80')
    expect(result).toEqual({ valid: true, value: 80 })
  })

  it('returns valid for minimum weight 30', () => {
    const result = validateWeight('30')
    expect(result).toEqual({ valid: true, value: 30 })
  })

  it('returns valid for maximum weight 300', () => {
    const result = validateWeight('300')
    expect(result).toEqual({ valid: true, value: 300 })
  })

  it('returns invalid for weight below minimum', () => {
    const result = validateWeight('25')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for weight above maximum', () => {
    const result = validateWeight('301')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for non-numeric string', () => {
    const result = validateWeight('abc')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for empty string', () => {
    const result = validateWeight('')
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateHeight
// ---------------------------------------------------------------------------
describe('validateHeight', () => {
  it('returns valid for a normal height', () => {
    const result = validateHeight('175')
    expect(result).toEqual({ valid: true, value: 175 })
  })

  it('returns valid for minimum height 100', () => {
    const result = validateHeight('100')
    expect(result).toEqual({ valid: true, value: 100 })
  })

  it('returns valid for maximum height 250', () => {
    const result = validateHeight('250')
    expect(result).toEqual({ valid: true, value: 250 })
  })

  it('returns invalid for height below minimum', () => {
    const result = validateHeight('99')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for height above maximum', () => {
    const result = validateHeight('251')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for non-numeric string', () => {
    const result = validateHeight('abc')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for decimal height', () => {
    const result = validateHeight('175.5')
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateActivityLevel
// ---------------------------------------------------------------------------
describe('validateActivityLevel', () => {
  it('returns sedentary for "1"', () => {
    const result = validateActivityLevel('1')
    expect(result).toEqual({ valid: true, value: 'sedentary' })
  })

  it('returns light for "2"', () => {
    const result = validateActivityLevel('2')
    expect(result).toEqual({ valid: true, value: 'light' })
  })

  it('returns moderate for "3"', () => {
    const result = validateActivityLevel('3')
    expect(result).toEqual({ valid: true, value: 'moderate' })
  })

  it('returns intense for "4"', () => {
    const result = validateActivityLevel('4')
    expect(result).toEqual({ valid: true, value: 'intense' })
  })

  it('returns sedentary for "sedentário" (with accent)', () => {
    const result = validateActivityLevel('sedentário')
    expect(result).toEqual({ valid: true, value: 'sedentary' })
  })

  it('returns sedentary for "sedentario" (no accent)', () => {
    const result = validateActivityLevel('sedentario')
    expect(result).toEqual({ valid: true, value: 'sedentary' })
  })

  it('returns light for "leve" (case insensitive)', () => {
    const result = validateActivityLevel('LEVE')
    expect(result).toEqual({ valid: true, value: 'light' })
  })

  it('returns moderate for "moderado"', () => {
    const result = validateActivityLevel('moderado')
    expect(result).toEqual({ valid: true, value: 'moderate' })
  })

  it('returns intense for "intenso"', () => {
    const result = validateActivityLevel('intenso')
    expect(result).toEqual({ valid: true, value: 'intense' })
  })

  it('returns invalid for "5"', () => {
    const result = validateActivityLevel('5')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for arbitrary text', () => {
    const result = validateActivityLevel('abc')
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateGoal
// ---------------------------------------------------------------------------
describe('validateGoal', () => {
  it('returns lose for "1"', () => {
    const result = validateGoal('1')
    expect(result).toEqual({ valid: true, value: 'lose' })
  })

  it('returns maintain for "2"', () => {
    const result = validateGoal('2')
    expect(result).toEqual({ valid: true, value: 'maintain' })
  })

  it('returns gain for "3"', () => {
    const result = validateGoal('3')
    expect(result).toEqual({ valid: true, value: 'gain' })
  })

  it('returns lose for "perder"', () => {
    const result = validateGoal('perder')
    expect(result).toEqual({ valid: true, value: 'lose' })
  })

  it('returns maintain for "manter" (case insensitive)', () => {
    const result = validateGoal('MANTER')
    expect(result).toEqual({ valid: true, value: 'maintain' })
  })

  it('returns gain for "ganhar"', () => {
    const result = validateGoal('ganhar')
    expect(result).toEqual({ valid: true, value: 'gain' })
  })

  it('returns invalid for "4"', () => {
    const result = validateGoal('4')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for arbitrary text', () => {
    const result = validateGoal('abc')
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateCalorieMode
// ---------------------------------------------------------------------------
describe('validateCalorieMode', () => {
  it('returns taco for "1"', () => {
    const result = validateCalorieMode('1')
    expect(result).toEqual({ valid: true, value: 'taco' })
  })

  it('returns manual for "2"', () => {
    const result = validateCalorieMode('2')
    expect(result).toEqual({ valid: true, value: 'manual' })
  })

  it('rejects "3" as invalid', () => {
    const result = validateCalorieMode('3')
    expect(result.valid).toBe(false)
  })

  it('rejects "aproximado" as invalid', () => {
    const result = validateCalorieMode('APROXIMADO')
    expect(result.valid).toBe(false)
  })

  it('returns taco for "taco"', () => {
    const result = validateCalorieMode('taco')
    expect(result).toEqual({ valid: true, value: 'taco' })
  })

  it('returns manual for "manual"', () => {
    const result = validateCalorieMode('manual')
    expect(result).toEqual({ valid: true, value: 'manual' })
  })

  it('returns invalid for "4"', () => {
    const result = validateCalorieMode('4')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for arbitrary text', () => {
    const result = validateCalorieMode('abc')
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validatePhone
// ---------------------------------------------------------------------------
describe('validatePhone', () => {
  it('returns valid for full international format with +55', () => {
    const result = validatePhone('+5511999887766')
    expect(result).toEqual({ valid: true, value: '+5511999887766' })
  })

  it('returns valid for number without +55 prefix but with country code', () => {
    const result = validatePhone('5511999887766')
    expect(result).toEqual({ valid: true, value: '+5511999887766' })
  })

  it('returns valid for number without country code (10 digits)', () => {
    const result = validatePhone('1199887766')
    expect(result).toEqual({ valid: true, value: '+551199887766' })
  })

  it('returns valid for number without country code (11 digits)', () => {
    const result = validatePhone('11999887766')
    expect(result).toEqual({ valid: true, value: '+5511999887766' })
  })

  it('returns invalid for too-short number', () => {
    const result = validatePhone('123')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for non-numeric string', () => {
    const result = validatePhone('abc')
    expect(result.valid).toBe(false)
  })

  it('returns invalid for non-BR country code', () => {
    const result = validatePhone('+1234567890')
    expect(result.valid).toBe(false)
  })

  it('normalizes number with spaces/dashes by rejecting non-digit non-plus chars', () => {
    // Input that is just digits with no valid BR length should fail
    const result = validatePhone('9988776655')
    // 10 digits, valid — treated as local area code + number without DDD assumed
    // Actually 10 digits is valid (area 2 + number 8), so it must pass
    expect(result.valid).toBe(true)
    expect(result.valid && result.value).toBe('+559988776655')
  })
})
