import { describe, it, expect } from 'vitest'
import { classifyByRules } from '@/lib/bot/router'
import type { IntentType } from '@/lib/bot/router'

describe('classifyByRules', () => {
  // --- HELP: exact matches ---
  describe('help intent (exact matches)', () => {
    it('returns help for "menu"', () => {
      expect(classifyByRules('menu')).toBe<IntentType>('help')
    })

    it('returns help for "ajuda"', () => {
      expect(classifyByRules('ajuda')).toBe<IntentType>('help')
    })

    it('returns help for "help"', () => {
      expect(classifyByRules('help')).toBe<IntentType>('help')
    })

    it('returns help for "o que voce faz"', () => {
      expect(classifyByRules('o que voce faz')).toBe<IntentType>('help')
    })

    it('returns help for "o que você faz"', () => {
      expect(classifyByRules('o que você faz')).toBe<IntentType>('help')
    })

    it('is case insensitive — "MENU" → help', () => {
      expect(classifyByRules('MENU')).toBe<IntentType>('help')
    })

    it('trims whitespace — "  menu  " → help', () => {
      expect(classifyByRules('  menu  ')).toBe<IntentType>('help')
    })

    it('trims whitespace and lowercases — "  AJUDA  " → help', () => {
      expect(classifyByRules('  AJUDA  ')).toBe<IntentType>('help')
    })
  })

  // --- SETTINGS ---
  describe('settings intent', () => {
    it('returns settings for "config"', () => {
      expect(classifyByRules('config')).toBe<IntentType>('settings')
    })

    it('returns settings for "configurações" (with accent)', () => {
      expect(classifyByRules('configurações')).toBe<IntentType>('settings')
    })

    it('returns settings for "configuracao" (no accent)', () => {
      expect(classifyByRules('configuracao')).toBe<IntentType>('settings')
    })

    it('returns settings for "mudar objetivo"', () => {
      expect(classifyByRules('mudar objetivo')).toBe<IntentType>('settings')
    })

    it('returns settings for "mudar modo"', () => {
      expect(classifyByRules('mudar modo')).toBe<IntentType>('settings')
    })

    it('returns settings for "mudar meta"', () => {
      expect(classifyByRules('mudar meta')).toBe<IntentType>('settings')
    })

    it('returns settings for "trocar modo"', () => {
      expect(classifyByRules('trocar modo')).toBe<IntentType>('settings')
    })

    it('returns settings for "trocar objetivo"', () => {
      expect(classifyByRules('trocar objetivo')).toBe<IntentType>('settings')
    })

    it('returns settings for "quero trocar modo"', () => {
      expect(classifyByRules('quero trocar modo')).toBe<IntentType>('settings')
    })
  })

  // --- SUMMARY ---
  describe('summary intent', () => {
    it('returns summary for "como tô hoje?"', () => {
      expect(classifyByRules('como tô hoje?')).toBe<IntentType>('summary')
    })

    it('returns summary for "resumo da semana"', () => {
      expect(classifyByRules('resumo da semana')).toBe<IntentType>('summary')
    })

    it('returns summary for "quanto comi hoje"', () => {
      expect(classifyByRules('quanto comi hoje')).toBe<IntentType>('summary')
    })

    it('returns summary for "como estou indo?"', () => {
      expect(classifyByRules('como estou indo?')).toBe<IntentType>('summary')
    })

    it('returns summary for "quanto já comi"', () => {
      expect(classifyByRules('quanto já comi')).toBe<IntentType>('summary')
    })

    it('returns summary for "como to de calorias"', () => {
      expect(classifyByRules('como to de calorias')).toBe<IntentType>('summary')
    })
  })

  // --- EDIT ---
  describe('edit intent', () => {
    it('returns edit for "apaga o último"', () => {
      expect(classifyByRules('apaga o último')).toBe<IntentType>('edit')
    })

    it('returns edit for "apagar lançamento"', () => {
      expect(classifyByRules('apagar lançamento')).toBe<IntentType>('edit')
    })

    it('returns edit for "corrigir"', () => {
      expect(classifyByRules('corrigir')).toBe<IntentType>('edit')
    })

    it('returns edit for "quero corrigir o café"', () => {
      expect(classifyByRules('quero corrigir o café')).toBe<IntentType>('edit')
    })

    it('returns edit for "tira o suco"', () => {
      expect(classifyByRules('tira o suco')).toBe<IntentType>('edit')
    })

    it('returns edit for "tira a banana"', () => {
      expect(classifyByRules('tira a banana')).toBe<IntentType>('edit')
    })

    it('returns edit for "remove o último item"', () => {
      expect(classifyByRules('remove o último item')).toBe<IntentType>('edit')
    })
  })

  // --- WEIGHT ---
  describe('weight intent', () => {
    it('returns weight for "pesei 78"', () => {
      expect(classifyByRules('pesei 78')).toBe<IntentType>('weight')
    })

    it('returns weight for "meu peso"', () => {
      expect(classifyByRules('meu peso')).toBe<IntentType>('weight')
    })

    it('returns weight for "registrar peso"', () => {
      expect(classifyByRules('registrar peso')).toBe<IntentType>('weight')
    })

    it('returns weight for "pesagem de hoje"', () => {
      expect(classifyByRules('pesagem de hoje')).toBe<IntentType>('weight')
    })
  })

  // --- QUERY ---
  describe('query intent', () => {
    it('returns query for "quantas calorias tem uma coxinha?"', () => {
      expect(classifyByRules('quantas calorias tem uma coxinha?')).toBe<IntentType>('query')
    })

    it('returns query for "quanto tem uma banana"', () => {
      expect(classifyByRules('quanto tem uma banana')).toBe<IntentType>('query')
    })

    it('returns query for "quantas calorias tem o arroz"', () => {
      expect(classifyByRules('quantas calorias tem o arroz')).toBe<IntentType>('query')
    })

    it('returns query for "quanto tem um copo de leite"', () => {
      expect(classifyByRules('quanto tem um copo de leite')).toBe<IntentType>('query')
    })

    it('returns query for "quantas calorias"', () => {
      expect(classifyByRules('quantas calorias')).toBe<IntentType>('query')
    })
  })

  // --- USER_DATA ---
  describe('user_data intent', () => {
    it('returns user_data for "meus dados"', () => {
      expect(classifyByRules('meus dados')).toBe<IntentType>('user_data')
    })

    it('returns user_data for "meu perfil"', () => {
      expect(classifyByRules('meu perfil')).toBe<IntentType>('user_data')
    })

    it('returns user_data for "minhas info"', () => {
      expect(classifyByRules('minhas info')).toBe<IntentType>('user_data')
    })

    it('returns user_data for "ver meus dados"', () => {
      expect(classifyByRules('ver meus dados')).toBe<IntentType>('user_data')
    })
  })

  // --- NULL (LLM fallback) ---
  describe('returns null when no rule matches (LLM fallback)', () => {
    it('returns null for "almocei arroz e feijão"', () => {
      expect(classifyByRules('almocei arroz e feijão')).toBeNull()
    })

    it('returns null for "comi um pão de queijo"', () => {
      expect(classifyByRules('comi um pão de queijo')).toBeNull()
    })

    it('returns null for "olá"', () => {
      expect(classifyByRules('olá')).toBeNull()
    })

    it('returns null for "bom dia"', () => {
      expect(classifyByRules('bom dia')).toBeNull()
    })

    it('returns null for "1 banana e granola no café"', () => {
      expect(classifyByRules('1 banana e granola no café')).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(classifyByRules('')).toBeNull()
    })

    it('returns null for "tudo bem?"', () => {
      expect(classifyByRules('tudo bem?')).toBeNull()
    })
  })

  // --- PRIORITY ORDER ---
  describe('priority order — help takes precedence', () => {
    it('exact match "menu" wins over any keyword rule', () => {
      // "menu" is an exact match for help
      expect(classifyByRules('menu')).toBe<IntentType>('help')
    })
  })
})
