import type { Sex, ActivityLevel, Goal } from '@/lib/calc/tdee'

export type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; error: string }

// ---------------------------------------------------------------------------
// Helper: remove diacritics and lowercase
// ---------------------------------------------------------------------------
function normalize(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

// ---------------------------------------------------------------------------
// validateName
// ---------------------------------------------------------------------------
export function validateName(input: string): ValidationResult<string> {
  const trimmed = input.trim()

  if (trimmed.length < 2) {
    return { valid: false, error: 'O nome precisa ter pelo menos 2 caracteres.' }
  }

  if (/\d/.test(trimmed)) {
    return { valid: false, error: 'O nome não pode conter números.' }
  }

  return { valid: true, value: trimmed }
}

// ---------------------------------------------------------------------------
// validateAge
// ---------------------------------------------------------------------------
export function validateAge(input: string): ValidationResult<number> {
  const trimmed = input.trim()

  if (trimmed === '') {
    return { valid: false, error: 'Preciso de um número válido.' }
  }

  // Must be an integer: no dot or comma allowed
  if (!/^\d+$/.test(trimmed)) {
    return { valid: false, error: 'Preciso de um número inteiro válido.' }
  }

  const value = parseInt(trimmed, 10)

  if (value < 12 || value > 120) {
    return { valid: false, error: 'A idade precisa estar entre 12 e 120 anos.' }
  }

  return { valid: true, value }
}

// ---------------------------------------------------------------------------
// validateSex
// ---------------------------------------------------------------------------
export function validateSex(input: string): ValidationResult<Sex> {
  const key = normalize(input)

  if (key === '1' || key === 'masculino' || key === 'm') {
    return { valid: true, value: 'male' }
  }

  if (key === '2' || key === 'feminino' || key === 'f') {
    return { valid: true, value: 'female' }
  }

  return { valid: false, error: 'Opção inválida. Digite 1 para masculino ou 2 para feminino.' }
}

// ---------------------------------------------------------------------------
// validateWeight
// ---------------------------------------------------------------------------
export function validateWeight(input: string): ValidationResult<number> {
  const trimmed = input.trim()

  if (trimmed === '') {
    return { valid: false, error: 'Preciso de um número válido.' }
  }

  // Accept comma or dot as decimal separator
  const normalized = trimmed.replace(',', '.')

  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return { valid: false, error: 'Preciso de um número válido para o peso.' }
  }

  const value = parseFloat(normalized)

  if (value < 30 || value > 300) {
    return { valid: false, error: 'O peso precisa estar entre 30 e 300 kg.' }
  }

  return { valid: true, value }
}

// ---------------------------------------------------------------------------
// validateHeight
// ---------------------------------------------------------------------------
export function validateHeight(input: string): ValidationResult<number> {
  const trimmed = input.trim()

  if (trimmed === '') {
    return { valid: false, error: 'Preciso de um número válido.' }
  }

  // Must be an integer: no dot or comma allowed
  if (!/^\d+$/.test(trimmed)) {
    return { valid: false, error: 'Preciso de um número inteiro válido para a altura.' }
  }

  const value = parseInt(trimmed, 10)

  if (value < 100 || value > 250) {
    return { valid: false, error: 'A altura precisa estar entre 100 e 250 cm.' }
  }

  return { valid: true, value }
}

// ---------------------------------------------------------------------------
// validateActivityLevel
// ---------------------------------------------------------------------------
export function validateActivityLevel(input: string): ValidationResult<ActivityLevel> {
  const key = normalize(input)

  if (key === '1' || key === 'sedentario') {
    return { valid: true, value: 'sedentary' }
  }

  if (key === '2' || key === 'leve') {
    return { valid: true, value: 'light' }
  }

  if (key === '3' || key === 'moderado') {
    return { valid: true, value: 'moderate' }
  }

  if (key === '4' || key === 'intenso') {
    return { valid: true, value: 'intense' }
  }

  return {
    valid: false,
    error:
      'Opção inválida. Digite 1 (sedentário), 2 (leve), 3 (moderado) ou 4 (intenso).',
  }
}

// ---------------------------------------------------------------------------
// validateGoal
// ---------------------------------------------------------------------------
export function validateGoal(input: string): ValidationResult<Goal> {
  const key = normalize(input)

  if (key === '1' || key === 'perder') {
    return { valid: true, value: 'lose' }
  }

  if (key === '2' || key === 'manter') {
    return { valid: true, value: 'maintain' }
  }

  if (key === '3' || key === 'ganhar') {
    return { valid: true, value: 'gain' }
  }

  return {
    valid: false,
    error: 'Opção inválida. Digite 1 (perder), 2 (manter) ou 3 (ganhar).',
  }
}

// ---------------------------------------------------------------------------
// validateCalorieMode
// ---------------------------------------------------------------------------
export function validateCalorieMode(
  input: string,
): ValidationResult<'taco' | 'manual'> {
  const key = normalize(input)

  if (key === '1' || key === 'taco') {
    return { valid: true, value: 'taco' }
  }

  if (key === '2' || key === 'manual') {
    return { valid: true, value: 'manual' }
  }

  return {
    valid: false,
    error: 'Opção inválida. Digite 1 (TACO) ou 2 (manual).',
  }
}

// ---------------------------------------------------------------------------
// validatePhone
// ---------------------------------------------------------------------------
export function validatePhone(input: string): ValidationResult<string> {
  const trimmed = input.trim()

  // Strip leading + if present, keep only digits
  const digitsWithPlus = trimmed.startsWith('+') ? '+' + trimmed.slice(1).replace(/\D/g, '') : trimmed.replace(/\D/g, '')

  const digits = digitsWithPlus.replace('+', '')

  if (!/^\d+$/.test(digits) || digits.length === 0) {
    return { valid: false, error: 'Número de telefone inválido.' }
  }

  let localDigits: string

  if (trimmed.startsWith('+')) {
    // Must start with +55
    if (!digitsWithPlus.startsWith('+55')) {
      return { valid: false, error: 'Apenas números brasileiros (+55) são aceitos.' }
    }
    localDigits = digits.slice(2) // remove "55"
  } else if (digits.startsWith('55') && digits.length >= 12) {
    // Country code included without +
    localDigits = digits.slice(2)
  } else {
    // No country code
    localDigits = digits
  }

  if (localDigits.length < 10 || localDigits.length > 11) {
    return {
      valid: false,
      error: 'O número precisa ter 10 ou 11 dígitos (com DDD).',
    }
  }

  return { valid: true, value: `+55${localDigits}` }
}
