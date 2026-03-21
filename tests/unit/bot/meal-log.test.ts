import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ConversationContext } from '@/lib/bot/state'
import type { MealAnalysis } from '@/lib/llm/schemas/meal-analysis'

// ---------------------------------------------------------------------------
// Hoist mock variables so they are available at vi.mock() factory call time
// ---------------------------------------------------------------------------
const {
  mockSetState,
  mockClearState,
  mockGetLLMProvider,
  mockAnalyzeMeal,
  mockCreateMeal,
  mockGetDailyCalories,
  mockFormatMealBreakdown,
  mockFormatProgress,
} = vi.hoisted(() => {
  const mockAnalyzeMeal = vi.fn()
  return {
    mockSetState: vi.fn().mockResolvedValue(undefined),
    mockClearState: vi.fn().mockResolvedValue(undefined),
    mockAnalyzeMeal,
    mockGetLLMProvider: vi.fn(() => ({
      analyzeMeal: mockAnalyzeMeal,
      classifyIntent: vi.fn(),
      chat: vi.fn(),
    })),
    mockCreateMeal: vi.fn().mockResolvedValue('meal-id-123'),
    mockGetDailyCalories: vi.fn().mockResolvedValue(800),
    mockFormatMealBreakdown: vi.fn().mockReturnValue('Breakdown message\nTá certo? (sim / corrigir)'),
    mockFormatProgress: vi.fn().mockReturnValue('📊 Hoje: 800 / 2000 kcal (restam 1200)'),
  }
})

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/bot/state', () => ({
  setState: mockSetState,
  clearState: mockClearState,
}))

vi.mock('@/lib/llm/index', () => ({
  getLLMProvider: mockGetLLMProvider,
}))

vi.mock('@/lib/db/queries/meals', () => ({
  createMeal: mockCreateMeal,
  getDailyCalories: mockGetDailyCalories,
}))

vi.mock('@/lib/utils/formatters', () => ({
  formatMealBreakdown: mockFormatMealBreakdown,
  formatProgress: mockFormatProgress,
}))

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------
import { handleMealLog } from '@/lib/bot/flows/meal-log'
import type { MealLogResult } from '@/lib/bot/flows/meal-log'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user-meal-log-123'

const mockUser = {
  calorieMode: 'approximate',
  dailyCalorieTarget: 2000,
}

const mockMealAnalysis: MealAnalysis = {
  meal_type: 'lunch',
  confidence: 'high',
  items: [
    {
      food: 'Arroz',
      quantity_grams: 200,
      quantity_source: 'estimated',
      calories: 260,
      protein: 4,
      carbs: 57,
      fat: 0.4,
      taco_match: false,
      taco_id: null,
      confidence: 'high',
    },
    {
      food: 'Feijão',
      quantity_grams: 150,
      quantity_source: 'estimated',
      calories: 180,
      protein: 9,
      carbs: 30,
      fat: 1,
      taco_match: false,
      taco_id: null,
      confidence: 'medium',
    },
  ],
  unknown_items: [],
  needs_clarification: false,
  clarification_question: undefined,
}

function buildSupabase(): SupabaseClient {
  return {} as unknown as SupabaseClient
}

function buildConfirmationContext(mealAnalysis: MealAnalysis = mockMealAnalysis): ConversationContext {
  return {
    id: 'ctx-1',
    userId: USER_ID,
    contextType: 'awaiting_confirmation',
    contextData: {
      mealAnalysis: mealAnalysis as unknown as Record<string, unknown>,
      originalMessage: 'almocei arroz e feijão',
    },
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  }
}

function buildClarificationContext(): ConversationContext {
  return {
    id: 'ctx-2',
    userId: USER_ID,
    contextType: 'awaiting_clarification',
    contextData: {
      originalMessage: 'comi uma tigela de arroz',
    },
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleMealLog', () => {
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    supabase = buildSupabase()
    mockAnalyzeMeal.mockResolvedValue(mockMealAnalysis)
    mockGetLLMProvider.mockReturnValue({
      analyzeMeal: mockAnalyzeMeal,
      classifyIntent: vi.fn(),
      chat: vi.fn(),
    })
    mockCreateMeal.mockResolvedValue('meal-id-123')
    mockGetDailyCalories.mockResolvedValue(800)
    mockFormatMealBreakdown.mockReturnValue('Breakdown message\nTá certo? (sim / corrigir)')
    mockFormatProgress.mockReturnValue('📊 Hoje: 800 / 2000 kcal (restam 1200)')
  })

  // -------------------------------------------------------------------------
  // New meal — calls LLM, returns breakdown for confirmation
  // -------------------------------------------------------------------------

  describe('new meal (no context)', () => {
    it('analyzes new meal and asks for confirmation', async () => {
      const result: MealLogResult = await handleMealLog(
        supabase,
        USER_ID,
        'almocei arroz e feijão',
        mockUser,
        null,
      )

      expect(mockAnalyzeMeal).toHaveBeenCalledWith(
        'almocei arroz e feijão',
        'approximate',
        undefined,
      )
      expect(result.response).toContain('Tá certo?')
      expect(result.completed).toBe(false)
    })

    it('calls getLLMProvider to get the LLM', async () => {
      await handleMealLog(supabase, USER_ID, 'almocei arroz e feijão', mockUser, null)

      expect(mockGetLLMProvider).toHaveBeenCalled()
    })

    it('sets state to awaiting_confirmation with meal analysis', async () => {
      await handleMealLog(supabase, USER_ID, 'almocei arroz e feijão', mockUser, null)

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_confirmation',
        expect.objectContaining({
          mealAnalysis: expect.objectContaining({ meal_type: 'lunch' }),
          originalMessage: 'almocei arroz e feijão',
        }),
      )
    })

    it('calls formatMealBreakdown with correct args', async () => {
      await handleMealLog(supabase, USER_ID, 'almocei arroz e feijão', mockUser, null)

      expect(mockFormatMealBreakdown).toHaveBeenCalledWith(
        'lunch',
        expect.arrayContaining([
          expect.objectContaining({ food: 'Arroz' }),
        ]),
        expect.any(Number),
        expect.any(Number),
        2000,
      )
    })

    it('completed is false when waiting for confirmation', async () => {
      const result = await handleMealLog(supabase, USER_ID, 'almocei', mockUser, null)

      expect(result.completed).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Confirmation — "sim"
  // -------------------------------------------------------------------------

  describe('confirmation (awaiting_confirmation context)', () => {
    it('saves meal on "sim" confirmation', async () => {
      const context = buildConfirmationContext()
      const result: MealLogResult = await handleMealLog(
        supabase,
        USER_ID,
        'sim',
        mockUser,
        context,
      )

      expect(mockCreateMeal).toHaveBeenCalled()
      expect(result.completed).toBe(true)
    })

    it('saves meal on "s" confirmation', async () => {
      const context = buildConfirmationContext()
      await handleMealLog(supabase, USER_ID, 's', mockUser, context)

      expect(mockCreateMeal).toHaveBeenCalled()
    })

    it('saves meal on "ok" confirmation', async () => {
      const context = buildConfirmationContext()
      await handleMealLog(supabase, USER_ID, 'ok', mockUser, context)

      expect(mockCreateMeal).toHaveBeenCalled()
    })

    it('saves meal on "confirma" confirmation', async () => {
      const context = buildConfirmationContext()
      await handleMealLog(supabase, USER_ID, 'confirma', mockUser, context)

      expect(mockCreateMeal).toHaveBeenCalled()
    })

    it('saves meal with case-insensitive "SIM"', async () => {
      const context = buildConfirmationContext()
      await handleMealLog(supabase, USER_ID, 'SIM', mockUser, context)

      expect(mockCreateMeal).toHaveBeenCalled()
    })

    it('calls clearState after saving', async () => {
      const context = buildConfirmationContext()
      await handleMealLog(supabase, USER_ID, 'sim', mockUser, context)

      expect(mockClearState).toHaveBeenCalledWith(USER_ID)
    })

    it('includes daily progress in response after saving', async () => {
      const context = buildConfirmationContext()
      mockGetDailyCalories.mockResolvedValue(1060)
      mockFormatProgress.mockReturnValue('📊 Hoje: 1060 / 2000 kcal (restam 940)')

      const result = await handleMealLog(supabase, USER_ID, 'sim', mockUser, context)

      expect(mockGetDailyCalories).toHaveBeenCalled()
      expect(result.response).toContain('📊')
    })

    it('createMeal receives userId and meal data', async () => {
      const context = buildConfirmationContext()
      await handleMealLog(supabase, USER_ID, 'sim', mockUser, context)

      expect(mockCreateMeal).toHaveBeenCalledWith(
        supabase,
        expect.objectContaining({
          userId: USER_ID,
          mealType: 'lunch',
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // Rejection — "corrigir" / "não"
  // -------------------------------------------------------------------------

  describe('correction request (awaiting_confirmation context)', () => {
    it('handles "corrigir" — asks what to correct', async () => {
      const context = buildConfirmationContext()
      const result: MealLogResult = await handleMealLog(
        supabase,
        USER_ID,
        'corrigir',
        mockUser,
        context,
      )

      expect(mockClearState).toHaveBeenCalledWith(USER_ID)
      expect(result.response).toMatch(/corrigir|corrij|o que/i)
      expect(result.completed).toBe(false)
    })

    it('handles "não" — asks what to correct', async () => {
      const context = buildConfirmationContext()
      const result = await handleMealLog(supabase, USER_ID, 'não', mockUser, context)

      expect(mockClearState).toHaveBeenCalledWith(USER_ID)
      expect(result.completed).toBe(false)
    })

    it('handles "nao" — asks what to correct', async () => {
      const context = buildConfirmationContext()
      const result = await handleMealLog(supabase, USER_ID, 'nao', mockUser, context)

      expect(mockClearState).toHaveBeenCalledWith(USER_ID)
      expect(result.completed).toBe(false)
    })

    it('handles "n" — asks what to correct', async () => {
      const context = buildConfirmationContext()
      const result = await handleMealLog(supabase, USER_ID, 'n', mockUser, context)

      expect(mockClearState).toHaveBeenCalledWith(USER_ID)
      expect(result.completed).toBe(false)
    })

    it('does NOT call createMeal on rejection', async () => {
      const context = buildConfirmationContext()
      await handleMealLog(supabase, USER_ID, 'corrigir', mockUser, context)

      expect(mockCreateMeal).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Clarification needed
  // -------------------------------------------------------------------------

  describe('clarification needed', () => {
    it('asks for clarification when LLM needs it', async () => {
      const clarificationAnalysis: MealAnalysis = {
        ...mockMealAnalysis,
        needs_clarification: true,
        clarification_question: 'Qual o tamanho da porção de arroz?',
      }
      mockAnalyzeMeal.mockResolvedValue(clarificationAnalysis)

      const result: MealLogResult = await handleMealLog(
        supabase,
        USER_ID,
        'comi arroz',
        mockUser,
        null,
      )

      expect(result.response).toContain('Qual o tamanho da porção de arroz?')
      expect(result.completed).toBe(false)
    })

    it('sets state to awaiting_clarification when LLM needs clarification', async () => {
      const clarificationAnalysis: MealAnalysis = {
        ...mockMealAnalysis,
        needs_clarification: true,
        clarification_question: 'Qual o tamanho da porção?',
      }
      mockAnalyzeMeal.mockResolvedValue(clarificationAnalysis)

      await handleMealLog(supabase, USER_ID, 'comi arroz', mockUser, null)

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_clarification',
        expect.objectContaining({
          originalMessage: 'comi arroz',
        }),
      )
    })

    it('does NOT call setState awaiting_confirmation on clarification', async () => {
      const clarificationAnalysis: MealAnalysis = {
        ...mockMealAnalysis,
        needs_clarification: true,
        clarification_question: 'Qual o tamanho?',
      }
      mockAnalyzeMeal.mockResolvedValue(clarificationAnalysis)

      await handleMealLog(supabase, USER_ID, 'comi arroz', mockUser, null)

      expect(mockSetState).not.toHaveBeenCalledWith(
        USER_ID,
        'awaiting_confirmation',
        expect.anything(),
      )
    })
  })

  // -------------------------------------------------------------------------
  // Unknown items
  // -------------------------------------------------------------------------

  describe('unknown items', () => {
    it('asks about unknown items', async () => {
      const unknownItemsAnalysis: MealAnalysis = {
        ...mockMealAnalysis,
        unknown_items: ['brigadeiro artesanal'],
        needs_clarification: false,
      }
      mockAnalyzeMeal.mockResolvedValue(unknownItemsAnalysis)

      const result: MealLogResult = await handleMealLog(
        supabase,
        USER_ID,
        'comi brigadeiro artesanal',
        mockUser,
        null,
      )

      expect(result.response).toContain('brigadeiro artesanal')
      expect(result.completed).toBe(false)
    })

    it('sets state to awaiting_clarification for unknown items', async () => {
      const unknownItemsAnalysis: MealAnalysis = {
        ...mockMealAnalysis,
        unknown_items: ['bolo de fubá caseiro'],
      }
      mockAnalyzeMeal.mockResolvedValue(unknownItemsAnalysis)

      await handleMealLog(supabase, USER_ID, 'comi bolo de fubá caseiro', mockUser, null)

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_clarification',
        expect.objectContaining({
          originalMessage: 'comi bolo de fubá caseiro',
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // Clarification response (awaiting_clarification context)
  // -------------------------------------------------------------------------

  describe('clarification response (awaiting_clarification context)', () => {
    it('re-calls LLM with original message and clarification combined', async () => {
      const context = buildClarificationContext()

      await handleMealLog(
        supabase,
        USER_ID,
        'era uma tigela média de arroz, uns 200g',
        mockUser,
        context,
      )

      expect(mockAnalyzeMeal).toHaveBeenCalled()
    })

    it('moves to awaiting_confirmation after clarification', async () => {
      const context = buildClarificationContext()

      await handleMealLog(
        supabase,
        USER_ID,
        'era uma tigela média de arroz',
        mockUser,
        context,
      )

      expect(mockSetState).toHaveBeenCalledWith(
        USER_ID,
        'awaiting_confirmation',
        expect.objectContaining({
          mealAnalysis: expect.anything(),
        }),
      )
    })

    it('returns breakdown response after successful clarification', async () => {
      const context = buildClarificationContext()

      const result = await handleMealLog(
        supabase,
        USER_ID,
        'era uma tigela média',
        mockUser,
        context,
      )

      expect(result.response).toContain('Tá certo?')
      expect(result.completed).toBe(false)
    })
  })
})
