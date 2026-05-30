import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist mock variables so they are available at vi.mock() factory call time
// ---------------------------------------------------------------------------
const {
  mockCreateServiceRoleClient,
  mockFindUserByPhone,
  mockCreateUser,
  mockGetUserWithSettings,
  mockGetState,
  mockClassifyByRules,
  mockHandleOnboarding,
  mockHandleMealLog,
  mockLogFoodToMeal,
  mockEnrichItemsWithTaco,
  mockHandleSummary,
  mockHandleQuery,
  mockHandleEdit,
  mockHandleWeight,
  mockHandleSettings,
  mockHandleHelp,
  mockHandleUserData,
  mockGetLLMProvider,
  mockClassifyIntent,
  mockSendTextMessage,
  mockFormatOutOfScope,
  mockFormatError,
  mockDownloadAudioMedia,
  mockTranscribeAudio,
  mockLogLLMUsage,
  mockDownloadImageMedia,
  mockDetectMimeType,
  mockAnalyzeImage,
  mockSetState,
  mockClearState,
  mockGetDailyCalories,
  mockCreateMeal,
  mockGetMealWithItems,
  mockFormatMealBreakdown,
  mockFormatMealAddition,
  mockSaveMessage,
  mockHandleAwaitingOffConfirm,
  mockHandleAwaitingLabelConfirm,
} = vi.hoisted(() => {
  const mockClassifyIntent = vi.fn()
  const mockAnalyzeImage = vi.fn()
  return {
    mockCreateServiceRoleClient: vi.fn(),
    mockFindUserByPhone: vi.fn(),
    mockCreateUser: vi.fn(),
    mockGetUserWithSettings: vi.fn(),
    mockGetState: vi.fn(),
    mockClassifyByRules: vi.fn(),
    mockHandleOnboarding: vi.fn(),
    mockHandleMealLog: vi.fn(),
    mockLogFoodToMeal: vi.fn(),
    mockEnrichItemsWithTaco: vi.fn(),
    mockHandleSummary: vi.fn(),
    mockHandleQuery: vi.fn(),
    mockHandleEdit: vi.fn(),
    mockHandleWeight: vi.fn(),
    mockHandleSettings: vi.fn(),
    mockHandleHelp: vi.fn(),
    mockHandleUserData: vi.fn(),
    mockGetLLMProvider: vi.fn(() => ({ classifyIntent: mockClassifyIntent, analyzeImage: mockAnalyzeImage })),
    mockClassifyIntent,
    mockAnalyzeImage,
    mockSendTextMessage: vi.fn().mockResolvedValue('msg-id-123'),
    mockFormatOutOfScope: vi.fn().mockReturnValue('out of scope message'),
    mockFormatError: vi.fn().mockReturnValue('error message'),
    mockDownloadAudioMedia: vi.fn(),
    mockTranscribeAudio: vi.fn(),
    mockLogLLMUsage: vi.fn().mockResolvedValue(undefined),
    mockDownloadImageMedia: vi.fn(),
    mockDetectMimeType: vi.fn().mockReturnValue('image/jpeg'),
    mockSetState: vi.fn().mockResolvedValue(undefined),
    mockClearState: vi.fn().mockResolvedValue(undefined),
    mockGetDailyCalories: vi.fn().mockResolvedValue(0),
    mockCreateMeal: vi.fn().mockResolvedValue('mock-meal-id'),
    mockGetMealWithItems: vi.fn().mockResolvedValue(null),
    mockFormatMealBreakdown: vi.fn().mockReturnValue('meal breakdown message'),
    mockFormatMealAddition: vi.fn().mockReturnValue('meal addition message'),
    mockSaveMessage: vi.fn().mockResolvedValue(undefined),
    mockHandleAwaitingOffConfirm: vi.fn(),
    mockHandleAwaitingLabelConfirm: vi.fn(),
  }
})

// ---------------------------------------------------------------------------
// Mock all dependencies
// ---------------------------------------------------------------------------

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: mockCreateServiceRoleClient,
}))

vi.mock('@/lib/db/queries/users', () => ({
  findUserByPhone: mockFindUserByPhone,
  createUser: mockCreateUser,
  getUserWithSettings: mockGetUserWithSettings,
}))

vi.mock('@/lib/bot/state', () => ({
  getState: mockGetState,
  setState: mockSetState,
  clearState: mockClearState,
}))

vi.mock('@/lib/bot/router', () => ({
  classifyByRules: mockClassifyByRules,
  isCancelCommand: vi.fn().mockReturnValue(false),
}))

vi.mock('@/lib/bot/flows/onboarding', () => ({
  handleOnboarding: mockHandleOnboarding,
}))

vi.mock('@/lib/bot/flows/meal-log', () => ({
  handleMealLog: mockHandleMealLog,
  logFoodToMeal: mockLogFoodToMeal,
  enrichItemsWithTaco: mockEnrichItemsWithTaco,
}))

vi.mock('@/lib/bot/flows/product-confirm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bot/flows/product-confirm')>()
  return {
    ...actual,
    handleAwaitingLabelConfirm: mockHandleAwaitingLabelConfirm,
    handleAwaitingLabelInput: vi.fn(),
    handleAwaitingOffBrand: vi.fn(),
    handleAwaitingOffChoice: vi.fn(),
    handleAwaitingOffConfirm: mockHandleAwaitingOffConfirm,
  }
})

vi.mock('@/lib/bot/flows/summary', () => ({
  handleSummary: mockHandleSummary,
}))

vi.mock('@/lib/bot/flows/query', () => ({
  handleQuery: mockHandleQuery,
}))

vi.mock('@/lib/bot/flows/edit', () => ({
  handleEdit: mockHandleEdit,
}))

vi.mock('@/lib/bot/flows/weight', () => ({
  handleWeight: mockHandleWeight,
}))

vi.mock('@/lib/bot/flows/settings', () => ({
  handleSettings: mockHandleSettings,
}))

vi.mock('@/lib/bot/flows/help', () => ({
  handleHelp: mockHandleHelp,
  handleUserData: mockHandleUserData,
}))

vi.mock('@/lib/llm/index', () => ({
  getLLMProvider: mockGetLLMProvider,
}))

vi.mock('@/lib/whatsapp/client', () => ({
  sendTextMessage: mockSendTextMessage,
}))

vi.mock('@/lib/utils/formatters', () => ({
  formatOutOfScope: mockFormatOutOfScope,
  formatError: mockFormatError,
  formatMealBreakdown: mockFormatMealBreakdown,
  formatMealAddition: mockFormatMealAddition,
}))

vi.mock('@/lib/audio/transcribe', () => ({
  downloadAudioMedia: mockDownloadAudioMedia,
  transcribeAudio: mockTranscribeAudio,
  AudioTooLargeError: class AudioTooLargeError extends Error {
    constructor() { super('Audio exceeds 30 second limit'); this.name = 'AudioTooLargeError' }
  },
}))

vi.mock('@/lib/db/queries/llm-usage', () => ({
  logLLMUsage: mockLogLLMUsage,
}))

vi.mock('@/lib/whatsapp/media', () => ({
  downloadWhatsAppMedia: mockDownloadImageMedia,
  MediaTooLargeError: class MediaTooLargeError extends Error {
    constructor(size: number, maxSize: number) { super(`Media size ${size} exceeds ${maxSize}`); this.name = 'MediaTooLargeError' }
  },
}))

vi.mock('@/lib/whatsapp/mime', () => ({
  detectMimeType: mockDetectMimeType,
}))

vi.mock('@/lib/db/queries/meals', () => ({
  createMeal: mockCreateMeal,
  getDailyCalories: mockGetDailyCalories,
  getMealWithItems: mockGetMealWithItems,
}))

vi.mock('@/lib/db/queries/message-history', () => ({
  saveMessage: mockSaveMessage,
}))

vi.mock('@/lib/llm/prompts/contextual-correction', () => ({
  buildContextualCorrectionPrompt: vi.fn().mockReturnValue('gatekeeper prompt'),
}))

vi.mock('@/lib/bot/quote', () => ({
  resolveQuote: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/db/queries/bot-messages', () => ({
  saveBotMessage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/bot/flows/recalculate', () => ({
  handleRecalculate: vi.fn().mockResolvedValue('recalculate response'),
}))

vi.mock('@/lib/bot/flows/meal-detail', () => ({
  handleMealDetail: vi.fn().mockResolvedValue('meal detail response'),
}))

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------
import { handleIncomingMessage, handleIncomingAudio, handleIncomingImage } from '@/lib/bot/handler'
import { MediaTooLargeError } from '@/lib/whatsapp/media'

// Real formatter (the module is mocked above) so we can assert the actual "Somei" output.
const { formatMealAddition: realFormatMealAddition } =
  await vi.importActual<typeof import('@/lib/utils/formatters')>('@/lib/utils/formatters')

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FROM = '5511999887766'
const MESSAGE_ID = 'wamid.test123'
const TEXT = 'oi'

const mockSupabase = {} as ReturnType<typeof mockCreateServiceRoleClient>

const newUser = {
  id: 'user-new-001',
  phone: FROM,
  name: '',
  onboardingComplete: false,
  onboardingStep: 0,
  authId: null,
  sex: null,
  age: null,
  weightKg: null,
  heightCm: null,
  activityLevel: null,
  goal: null,
  calorieMode: 'taco' as const,
  dailyCalorieTarget: null,
  dailyProteinG: null,
  dailyFatG: null,
  dailyCarbsG: null,
  calorieTargetManual: false,
  tmb: null,
  tdee: null,
  timezone: 'America/Sao_Paulo',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const existingUserIncomplete = {
  ...newUser,
  id: 'user-existing-001',
  name: 'João',
  onboardingComplete: false,
  onboardingStep: 3,
}

const completedUser = {
  ...newUser,
  id: 'user-complete-001',
  name: 'Maria',
  onboardingComplete: true,
  onboardingStep: 8,
}

const mockSettingsData = {
  user: completedUser,
  settings: {
    id: 'settings-001',
    userId: completedUser.id,
    remindersEnabled: false,
    dailySummaryTime: '20:00',
    reminderTime: '12:00',
    detailLevel: 'brief' as const,
    weightUnit: 'kg' as const,
    lastReminderSentAt: null,
    lastSummarySentAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateServiceRoleClient.mockReturnValue(mockSupabase)
  mockGetState.mockResolvedValue(null)
  mockHandleOnboarding.mockResolvedValue({ response: 'onboarding response', completed: false })
  mockHandleMealLog.mockResolvedValue({ response: 'meal log response', completed: false })
  // Default: brand-new meal (no consolidation). Derive the returned meal from the
  // params so existing food-photo assertions on formatMealBreakdown keep working.
  mockLogFoodToMeal.mockImplementation(async (_supabase: unknown, params: {
    mealType: string
    items: Array<{ foodName: string; quantityGrams: number; calories: number; proteinG?: number; carbsG?: number; fatG?: number }>
  }) => {
    const items = params.items.map((i, idx) => ({
      id: `item-${idx}`,
      foodName: i.foodName,
      quantityGrams: i.quantityGrams,
      quantityDisplay: null,
      calories: i.calories,
      proteinG: i.proteinG ?? 0,
      carbsG: i.carbsG ?? 0,
      fatG: i.fatG ?? 0,
      source: 'manual',
      confidence: 'high',
    }))
    const totalCalories = Math.round(items.reduce((sum, i) => sum + i.calories, 0))
    return {
      wasAppend: false,
      mealId: 'mock-meal-id',
      addedItems: params.items,
      meal: {
        id: 'mock-meal-id',
        mealType: params.mealType,
        totalCalories,
        registeredAt: '2026-04-23T18:00:00Z',
        items,
      },
    }
  })
  mockEnrichItemsWithTaco.mockResolvedValue([])
  mockHandleSummary.mockResolvedValue('summary response')
  mockHandleQuery.mockResolvedValue('query response')
  mockHandleEdit.mockResolvedValue('edit response')
  mockHandleWeight.mockResolvedValue('weight response')
  mockHandleSettings.mockResolvedValue('settings response')
  mockHandleHelp.mockResolvedValue('help response')
  mockHandleUserData.mockResolvedValue('user data response')
  mockGetUserWithSettings.mockResolvedValue(mockSettingsData)
  mockGetLLMProvider.mockReturnValue({ classifyIntent: mockClassifyIntent, analyzeImage: mockAnalyzeImage })
  mockDownloadAudioMedia.mockResolvedValue(Buffer.from('fake-audio'))
  mockTranscribeAudio.mockResolvedValue({ text: 'almocei arroz e feijão', latencyMs: 500 })
  mockDownloadImageMedia.mockResolvedValue(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]))
  mockDetectMimeType.mockReturnValue('image/jpeg')
  mockGetDailyCalories.mockResolvedValue(500)
  mockCreateMeal.mockResolvedValue('mock-meal-id')
  mockGetMealWithItems.mockResolvedValue(null)
  mockHandleAwaitingOffConfirm.mockResolvedValue({ response: 'product response', completed: false })
  mockHandleAwaitingLabelConfirm.mockResolvedValue({ response: 'product response', completed: false })
  mockAnalyzeImage.mockResolvedValue({
    image_type: 'food',
    meal_type: 'lunch',
    confidence: 'high',
    items: [{ food: 'Arroz', quantity_grams: 150, calories: 195, protein: 4, carbs: 42, fat: 0.5 }],
    unknown_items: [],
    needs_clarification: false,
  })
})

// ---------------------------------------------------------------------------
// Test 1: New user (not found) → creates user + starts onboarding
// ---------------------------------------------------------------------------

describe('handleIncomingMessage — new user', () => {
  it('calls createUser when findUserByPhone returns null', async () => {
    mockFindUserByPhone.mockResolvedValue(null)
    mockCreateUser.mockResolvedValue(newUser)

    await handleIncomingMessage(FROM, MESSAGE_ID, TEXT)

    expect(mockFindUserByPhone).toHaveBeenCalledWith(mockSupabase, FROM)
    expect(mockCreateUser).toHaveBeenCalledWith(mockSupabase, FROM)
  })

  it('calls handleOnboarding with step 0 after creating a new user', async () => {
    mockFindUserByPhone.mockResolvedValue(null)
    mockCreateUser.mockResolvedValue(newUser)

    await handleIncomingMessage(FROM, MESSAGE_ID, TEXT)

    expect(mockHandleOnboarding).toHaveBeenCalledWith(
      mockSupabase,
      newUser.id,
      TEXT,
      0
    )
  })

  it('calls sendTextMessage with the onboarding response', async () => {
    mockFindUserByPhone.mockResolvedValue(null)
    mockCreateUser.mockResolvedValue(newUser)

    await handleIncomingMessage(FROM, MESSAGE_ID, TEXT)

    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'onboarding response')
  })

  it('does not call classifyByRules for a new user', async () => {
    mockFindUserByPhone.mockResolvedValue(null)
    mockCreateUser.mockResolvedValue(newUser)

    await handleIncomingMessage(FROM, MESSAGE_ID, TEXT)

    expect(mockClassifyByRules).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Test 2: Existing user with incomplete onboarding → continues onboarding
// ---------------------------------------------------------------------------

describe('handleIncomingMessage — existing user, onboarding incomplete', () => {
  it('calls handleOnboarding with the user current step', async () => {
    mockFindUserByPhone.mockResolvedValue(existingUserIncomplete)

    await handleIncomingMessage(FROM, MESSAGE_ID, 'meu nome')

    expect(mockHandleOnboarding).toHaveBeenCalledWith(
      mockSupabase,
      existingUserIncomplete.id,
      'meu nome',
      existingUserIncomplete.onboardingStep
    )
  })

  it('does not call createUser when user already exists', async () => {
    mockFindUserByPhone.mockResolvedValue(existingUserIncomplete)

    await handleIncomingMessage(FROM, MESSAGE_ID, TEXT)

    expect(mockCreateUser).not.toHaveBeenCalled()
  })

  it('calls sendTextMessage with the onboarding response', async () => {
    mockFindUserByPhone.mockResolvedValue(existingUserIncomplete)
    mockHandleOnboarding.mockResolvedValue({ response: 'continue onboarding', completed: false })

    await handleIncomingMessage(FROM, MESSAGE_ID, TEXT)

    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'continue onboarding')
  })

  it('does not call classifyByRules while onboarding is incomplete', async () => {
    mockFindUserByPhone.mockResolvedValue(existingUserIncomplete)

    await handleIncomingMessage(FROM, MESSAGE_ID, TEXT)

    expect(mockClassifyByRules).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Test 3: Completed user, message matches rule → routes correctly
// ---------------------------------------------------------------------------

describe('handleIncomingMessage — completed user, intent routing', () => {
  beforeEach(() => {
    mockFindUserByPhone.mockResolvedValue(completedUser)
  })

  it('calls classifyByRules with the message text', async () => {
    mockClassifyByRules.mockReturnValue('out_of_scope')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'tell me a joke')

    expect(mockClassifyByRules).toHaveBeenCalledWith('tell me a joke')
  })

  it('sends formatOutOfScope() response for out_of_scope intent', async () => {
    mockClassifyByRules.mockReturnValue('out_of_scope')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'tell me a joke')

    expect(mockFormatOutOfScope).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'out of scope message', undefined)
  })

  it('routes summary intent to handleSummary and sends its response', async () => {
    mockClassifyByRules.mockReturnValue('summary')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'como tô hoje?')

    expect(mockHandleSummary).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      'como tô hoje?',
      {
        dailyCalorieTarget: completedUser.dailyCalorieTarget,
        dailyProteinG: completedUser.dailyProteinG,
        dailyFatG: completedUser.dailyFatG,
        dailyCarbsG: completedUser.dailyCarbsG,
        timezone: completedUser.timezone,
      }
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'summary response', undefined)
  })

  it('routes query intent to handleQuery and sends its response', async () => {
    mockClassifyByRules.mockReturnValue('query')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'quantas calorias tem uma banana?')

    expect(mockHandleQuery).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      'quantas calorias tem uma banana?'
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'query response', undefined)
  })

  it('routes edit intent to handleEdit and sends its response', async () => {
    mockClassifyByRules.mockReturnValue('edit')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'corrigir')

    expect(mockHandleEdit).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      'corrigir',
      null,
      { timezone: completedUser.timezone, dailyCalorieTarget: completedUser.dailyCalorieTarget },
      undefined
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'edit response', undefined)
  })

  it('routes weight intent to handleWeight and sends its response', async () => {
    mockClassifyByRules.mockReturnValue('weight')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'pesei 72kg')

    expect(mockHandleWeight).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      'pesei 72kg',
      completedUser
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'weight response', undefined)
  })

  it('routes settings intent to handleSettings and sends its response', async () => {
    mockClassifyByRules.mockReturnValue('settings')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'config')

    expect(mockGetUserWithSettings).toHaveBeenCalledWith(mockSupabase, completedUser.id)
    expect(mockHandleSettings).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      'config',
      completedUser,
      mockSettingsData.settings,
      null
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'settings response', undefined)
  })

  it('routes help intent to handleHelp and sends its response', async () => {
    mockClassifyByRules.mockReturnValue('help')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'ajuda')

    expect(mockHandleHelp).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'help response', undefined)
  })

  it('routes user_data intent to handleUserData and sends its response', async () => {
    mockClassifyByRules.mockReturnValue('user_data')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'meus dados')

    expect(mockHandleUserData).toHaveBeenCalledWith(mockSupabase, completedUser.id)
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'user data response', undefined)
  })

  it('routes meal_log intent to handleMealLog and sends its response', async () => {
    mockClassifyByRules.mockReturnValue('meal_log')
    mockHandleMealLog.mockResolvedValue({ response: 'meal log response', completed: false })

    await handleIncomingMessage(FROM, MESSAGE_ID, 'almocei arroz')

    expect(mockHandleMealLog).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      'almocei arroz',
      { calorieMode: completedUser.calorieMode, dailyCalorieTarget: completedUser.dailyCalorieTarget, dailyProteinG: completedUser.dailyProteinG, dailyFatG: completedUser.dailyFatG, dailyCarbsG: completedUser.dailyCarbsG, phone: FROM, timezone: completedUser.timezone },
      null
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal log response', undefined)
  })

  it('does not call handleOnboarding for a completed user', async () => {
    mockClassifyByRules.mockReturnValue('out_of_scope')

    await handleIncomingMessage(FROM, MESSAGE_ID, TEXT)

    expect(mockHandleOnboarding).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Test 4: LLM classification fallback when rules return null
// ---------------------------------------------------------------------------

describe('handleIncomingMessage — LLM classification fallback', () => {
  beforeEach(() => {
    mockFindUserByPhone.mockResolvedValue(completedUser)
    mockClassifyByRules.mockReturnValue(null)
  })

  it('calls getLLMProvider().classifyIntent when classifyByRules returns null', async () => {
    mockClassifyIntent.mockResolvedValue('meal_log')
    mockHandleMealLog.mockResolvedValue({ response: 'meal log response', completed: false })

    await handleIncomingMessage(FROM, MESSAGE_ID, 'almocei frango grelhado')

    expect(mockGetLLMProvider).toHaveBeenCalled()
    expect(mockClassifyIntent).toHaveBeenCalledWith('almocei frango grelhado')
  })

  it('routes to handleMealLog when LLM classifies as meal_log', async () => {
    mockClassifyIntent.mockResolvedValue('meal_log')
    mockHandleMealLog.mockResolvedValue({ response: 'meal log response', completed: false })

    await handleIncomingMessage(FROM, MESSAGE_ID, 'almocei frango grelhado')

    expect(mockHandleMealLog).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      'almocei frango grelhado',
      { calorieMode: completedUser.calorieMode, dailyCalorieTarget: completedUser.dailyCalorieTarget, dailyProteinG: completedUser.dailyProteinG, dailyFatG: completedUser.dailyFatG, dailyCarbsG: completedUser.dailyCarbsG, phone: FROM, timezone: completedUser.timezone },
      null
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal log response', undefined)
  })

  it('defaults to meal_log when LLM classifyIntent throws', async () => {
    mockClassifyIntent.mockRejectedValue(new Error('LLM timeout'))
    mockHandleMealLog.mockResolvedValue({ response: 'meal log response', completed: false })

    await handleIncomingMessage(FROM, MESSAGE_ID, 'comi pizza')

    expect(mockHandleMealLog).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      'comi pizza',
      { calorieMode: completedUser.calorieMode, dailyCalorieTarget: completedUser.dailyCalorieTarget, dailyProteinG: completedUser.dailyProteinG, dailyFatG: completedUser.dailyFatG, dailyCarbsG: completedUser.dailyCarbsG, phone: FROM, timezone: completedUser.timezone },
      null
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal log response', undefined)
  })

  it('routes to out_of_scope when LLM classifies as out_of_scope', async () => {
    mockClassifyIntent.mockResolvedValue('out_of_scope')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'conta uma piada')

    expect(mockFormatOutOfScope).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'out of scope message', undefined)
  })
})

// ---------------------------------------------------------------------------
// Test 5: Context-based routing (active context → handleMealLog)
// ---------------------------------------------------------------------------

describe('handleIncomingMessage — context-based routing', () => {
  beforeEach(() => {
    mockFindUserByPhone.mockResolvedValue(completedUser)
  })

  it('does not route to handleMealLog when context is awaiting_confirmation', async () => {
    const mockContext = {
      contextType: 'awaiting_confirmation',
      contextData: { mealAnalysis: {}, originalMessage: 'arroz e feijão' },
    }
    mockGetState.mockResolvedValue(mockContext)
    mockClassifyByRules.mockReturnValue('out_of_scope')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'sim')

    expect(mockHandleMealLog).not.toHaveBeenCalled()
  })

  it('routes to handleMealLog when context is awaiting_clarification', async () => {
    const mockContext = {
      contextType: 'awaiting_clarification',
      contextData: { originalMessage: 'comi algo' },
    }
    mockGetState.mockResolvedValue(mockContext)
    mockHandleMealLog.mockResolvedValue({ response: 'clarification received', completed: false })

    await handleIncomingMessage(FROM, MESSAGE_ID, '200g de frango')

    expect(mockHandleMealLog).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      '200g de frango',
      { calorieMode: completedUser.calorieMode, dailyCalorieTarget: completedUser.dailyCalorieTarget, dailyProteinG: completedUser.dailyProteinG, dailyFatG: completedUser.dailyFatG, dailyCarbsG: completedUser.dailyCarbsG, phone: FROM, timezone: completedUser.timezone },
      mockContext
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'clarification received')
  })

  it('routes to handleEdit when context is awaiting_correction', async () => {
    const mockContext = {
      contextType: 'awaiting_correction',
      contextData: { originalMessage: 'comi arroz' },
    }
    mockGetState.mockResolvedValue(mockContext)
    mockHandleEdit.mockResolvedValue('correction received')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'na verdade foi 300g')

    expect(mockHandleEdit).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      'na verdade foi 300g',
      mockContext,
      { timezone: completedUser.timezone, dailyCalorieTarget: completedUser.dailyCalorieTarget }
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'correction received')
  })

  it('does not call classifyByRules when context is awaiting_clarification', async () => {
    const mockContext = {
      contextType: 'awaiting_clarification',
      contextData: { originalMessage: 'pizza' },
    }
    mockGetState.mockResolvedValue(mockContext)
    mockHandleMealLog.mockResolvedValue({ response: 'done', completed: true })

    await handleIncomingMessage(FROM, MESSAGE_ID, '200g de frango')

    expect(mockClassifyByRules).not.toHaveBeenCalled()
  })

  it('returns early (does not call sendTextMessage twice) when context routes to handleMealLog', async () => {
    const mockContext = {
      contextType: 'awaiting_clarification',
      contextData: { originalMessage: 'pizza' },
    }
    mockGetState.mockResolvedValue(mockContext)
    mockHandleMealLog.mockResolvedValue({ response: 'done', completed: true })

    await handleIncomingMessage(FROM, MESSAGE_ID, '200g de frango')

    expect(mockSendTextMessage).toHaveBeenCalledTimes(1)
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'done')
  })

  it('routes to handleWeight when context is awaiting_weight', async () => {
    const mockContext = {
      contextType: 'awaiting_weight',
      contextData: {},
    }
    mockGetState.mockResolvedValue(mockContext)
    mockHandleWeight.mockResolvedValue('weight logged response')

    await handleIncomingMessage(FROM, MESSAGE_ID, '72kg')

    expect(mockHandleWeight).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      '72kg',
      completedUser
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'weight logged response')
  })

  it('does not call classifyByRules when context is awaiting_weight', async () => {
    const mockContext = {
      contextType: 'awaiting_weight',
      contextData: {},
    }
    mockGetState.mockResolvedValue(mockContext)
    mockHandleWeight.mockResolvedValue('weight logged response')

    await handleIncomingMessage(FROM, MESSAGE_ID, '72kg')

    expect(mockClassifyByRules).not.toHaveBeenCalled()
  })

  it('routes to handleSettings when context is settings_menu', async () => {
    const mockContext = {
      contextType: 'settings_menu',
      contextData: {},
    }
    mockGetState.mockResolvedValue(mockContext)
    mockHandleSettings.mockResolvedValue('settings menu response')

    await handleIncomingMessage(FROM, MESSAGE_ID, '1')

    expect(mockGetUserWithSettings).toHaveBeenCalledWith(mockSupabase, completedUser.id)
    expect(mockHandleSettings).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      '1',
      completedUser,
      mockSettingsData.settings,
      mockContext
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'settings menu response')
  })

  it('routes to handleSettings when context is settings_change', async () => {
    const mockContext = {
      contextType: 'settings_change',
      contextData: { option: 1, field: 'goal' },
    }
    mockGetState.mockResolvedValue(mockContext)
    mockHandleSettings.mockResolvedValue('settings change response')

    await handleIncomingMessage(FROM, MESSAGE_ID, '2')

    expect(mockGetUserWithSettings).toHaveBeenCalledWith(mockSupabase, completedUser.id)
    expect(mockHandleSettings).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      '2',
      completedUser,
      mockSettingsData.settings,
      mockContext
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'settings change response')
  })

  it('does not call classifyByRules when context is settings_menu', async () => {
    const mockContext = {
      contextType: 'settings_menu',
      contextData: {},
    }
    mockGetState.mockResolvedValue(mockContext)
    mockHandleSettings.mockResolvedValue('settings menu response')

    await handleIncomingMessage(FROM, MESSAGE_ID, '1')

    expect(mockClassifyByRules).not.toHaveBeenCalled()
  })

  it('routes to handleSettings when context is awaiting_reset_confirmation', async () => {
    const mockContext = {
      contextType: 'awaiting_reset_confirmation',
      contextData: {},
    }
    mockGetState.mockResolvedValue(mockContext)
    mockHandleSettings.mockResolvedValue('reset response')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'sim')

    expect(mockHandleSettings).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'reset response')
  })

  it('preserves other parsed meal items when product confirmation completes', async () => {
    const product = {
      id: 'product-1',
      name: 'Magic Toast',
      nameNormalized: 'magic toast',
      brand: 'Marilan',
      brandNormalized: 'marilan',
      barcode: '789',
      servingSizeG: 25,
      servingDisplay: '1 pacote',
      caloriesPer100g: 400,
      proteinPer100g: 8,
      carbsPer100g: 70,
      fatPer100g: 10,
      fiberPer100g: null,
      sodiumPer100g: null,
      source: 'open_food_facts' as const,
      sourceRef: null,
      status: 'aprovado' as const,
      createdBy: null,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
      promotedAt: null,
      contributorIds: null,
    }
    const mockContext = {
      contextType: 'awaiting_off_confirm',
      contextData: {
        quantityGrams: 25,
        pendingMeal: {
          mealType: 'lunch',
          originalMessage: 'almocei magic toast e arroz',
          food: 'Magic Toast',
          quantityDisplay: '1 pacote',
          productItemIndex: 0,
          mealItems: [
            {
              food: 'Magic Toast',
              quantity_grams: 25,
              quantity_display: '1 pacote',
              quantity_source: 'user_reported',
              portion_type: 'packaged',
              has_user_quantity: true,
              calories: null,
              protein: null,
              carbs: null,
              fat: null,
              confidence: 'high',
            },
            {
              food: 'Arroz',
              quantity_grams: 100,
              quantity_display: '100g',
              quantity_source: 'user_reported',
              portion_type: 'bulk',
              has_user_quantity: true,
              calories: null,
              protein: null,
              carbs: null,
              fat: null,
              confidence: 'high',
            },
          ],
        },
      },
    }
    mockGetState.mockResolvedValue(mockContext)
    mockHandleAwaitingOffConfirm.mockResolvedValue({
      response: 'Produto salvo',
      completed: true,
      product,
      productId: product.id,
    })
    mockEnrichItemsWithTaco.mockResolvedValue([{
      food: 'Arroz',
      quantityGrams: 100,
      quantityDisplay: '100g',
      calories: 128,
      protein: 2.5,
      carbs: 28.1,
      fat: 0.2,
      source: 'taco',
      tacoId: 3,
    }])

    await handleIncomingMessage(FROM, MESSAGE_ID, 'sim')

    expect(mockCreateMeal).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        totalCalories: 228,
        items: [
          expect.objectContaining({ foodName: 'Magic Toast', calories: 100, productId: 'product-1' }),
          expect.objectContaining({ foodName: 'Arroz', calories: 128, tacoId: 3 }),
        ],
      }),
    )
    expect(mockFormatMealBreakdown).toHaveBeenCalledWith(
      'lunch',
      [
        expect.objectContaining({ food: 'Magic Toast', calories: 100 }),
        expect.objectContaining({ food: 'Arroz', calories: 128 }),
      ],
      228,
      500,
      2000,
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal breakdown message')
  })

  it('asks for product quantity after confirmation when original message had no quantity', async () => {
    const product = {
      id: 'product-1',
      name: 'Magic Toast',
      nameNormalized: 'magic toast',
      brand: 'Marilan',
      brandNormalized: 'marilan',
      barcode: '789',
      servingSizeG: 25,
      servingDisplay: '1 pacote',
      caloriesPer100g: 400,
      proteinPer100g: 8,
      carbsPer100g: 70,
      fatPer100g: 10,
      fiberPer100g: null,
      sodiumPer100g: null,
      source: 'open_food_facts' as const,
      sourceRef: null,
      status: 'aprovado' as const,
      createdBy: null,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
      promotedAt: null,
      contributorIds: null,
    }
    const pendingMeal = {
      mealType: 'dinner',
      originalMessage: 'jantei magic toast',
      food: 'Magic Toast',
      quantityDisplay: null,
      productItemIndex: 0,
      mealItems: [{
        food: 'Magic Toast',
        quantity_grams: null,
        quantity_display: null,
        quantity_source: 'unknown',
        portion_type: 'packaged',
        has_user_quantity: false,
        calories: null,
        protein: null,
        carbs: null,
        fat: null,
        confidence: 'high',
      }],
    }
    const mockContext = {
      contextType: 'awaiting_off_confirm',
      contextData: {
        quantityGrams: null,
        pendingMeal,
      },
    }
    mockGetState.mockResolvedValue(mockContext)
    mockHandleAwaitingOffConfirm.mockResolvedValue({
      response: 'Produto salvo',
      completed: true,
      product,
      productId: product.id,
    })

    await handleIncomingMessage(FROM, MESSAGE_ID, 'sim')

    expect(mockCreateMeal).not.toHaveBeenCalled()
    expect(mockSetState).toHaveBeenCalledWith(
      completedUser.id,
      'awaiting_product_quantity',
      expect.objectContaining({
        product,
        pendingMeal,
      }),
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('Não sei quanto pesa uma unidade de Magic Toast.'),
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('porções do rótulo'),
    )
  })

  it('registers confirmed product with the exact grams provided after quantity prompt', async () => {
    const product = {
      id: 'product-1',
      name: 'Magic Toast',
      nameNormalized: 'magic toast',
      brand: 'Marilan',
      brandNormalized: 'marilan',
      barcode: '789',
      servingSizeG: 25,
      servingDisplay: '1 pacote',
      caloriesPer100g: 400,
      proteinPer100g: 8,
      carbsPer100g: 70,
      fatPer100g: 10,
      fiberPer100g: null,
      sodiumPer100g: null,
      source: 'open_food_facts' as const,
      sourceRef: null,
      status: 'aprovado' as const,
      createdBy: null,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
      promotedAt: null,
      contributorIds: null,
    }
    const pendingMeal = {
      mealType: 'dinner',
      originalMessage: 'jantei magic toast',
      food: 'Magic Toast',
      quantityDisplay: null,
      productItemIndex: 0,
      mealItems: [{
        food: 'Magic Toast',
        quantity_grams: null,
        quantity_display: null,
        quantity_source: 'unknown',
        portion_type: 'packaged',
        has_user_quantity: false,
        calories: null,
        protein: null,
        carbs: null,
        fat: null,
        confidence: 'high',
      }],
    }
    mockGetState.mockResolvedValue({
      contextType: 'awaiting_product_quantity',
      contextData: {
        product,
        pendingMeal,
      },
    })

    await handleIncomingMessage(FROM, MESSAGE_ID, '30g')

    expect(mockCreateMeal).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        totalCalories: 120,
        items: [
          expect.objectContaining({
            foodName: 'Magic Toast',
            quantityGrams: 30,
            quantityDisplay: '30g',
            calories: 120,
            productId: 'product-1',
          }),
        ],
      }),
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal breakdown message')
  })

  it('does not register unit quantity when product has no serving weight', async () => {
    const product = {
      id: 'product-1',
      name: 'Magic Toast',
      nameNormalized: 'magic toast',
      brand: 'Marilan',
      brandNormalized: 'marilan',
      barcode: '789',
      servingSizeG: null,
      servingDisplay: '1 unidade',
      caloriesPer100g: 400,
      proteinPer100g: 8,
      carbsPer100g: 70,
      fatPer100g: 10,
      fiberPer100g: null,
      sodiumPer100g: null,
      source: 'open_food_facts' as const,
      sourceRef: null,
      status: 'aprovado' as const,
      createdBy: null,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
      promotedAt: null,
      contributorIds: null,
    }
    mockGetState.mockResolvedValue({
      contextType: 'awaiting_product_quantity',
      contextData: {
        product,
        pendingMeal: {
          mealType: 'dinner',
          originalMessage: 'jantei magic toast',
          food: 'Magic Toast',
          quantityDisplay: null,
        },
      },
    })

    await handleIncomingMessage(FROM, MESSAGE_ID, '2 torradas')

    expect(mockCreateMeal).not.toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('Não consegui converter "2 torradas" para gramas.'),
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('Me manda o peso em gramas (ex: "30g").'),
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.not.stringMatching(/porções do rótulo/),
    )
  })
})

// ---------------------------------------------------------------------------
// Test 6: Error in handler → sends error message
// ---------------------------------------------------------------------------

describe('handleIncomingMessage — error handling', () => {
  it('sends formatError() message when findUserByPhone throws', async () => {
    mockFindUserByPhone.mockRejectedValue(new Error('DB connection failed'))

    await handleIncomingMessage(FROM, MESSAGE_ID, TEXT)

    expect(mockFormatError).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'error message')
  })

  it('sends formatError() message when handleOnboarding throws', async () => {
    mockFindUserByPhone.mockResolvedValue(null)
    mockCreateUser.mockResolvedValue(newUser)
    mockHandleOnboarding.mockRejectedValue(new Error('onboarding error'))

    await handleIncomingMessage(FROM, MESSAGE_ID, TEXT)

    expect(mockFormatError).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'error message')
  })

  it('sends formatError() message when classifyByRules throws', async () => {
    mockFindUserByPhone.mockResolvedValue(completedUser)
    mockClassifyByRules.mockImplementation(() => { throw new Error('classify error') })

    await handleIncomingMessage(FROM, MESSAGE_ID, TEXT)

    expect(mockFormatError).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'error message')
  })

  it('does not throw even when sendTextMessage (error fallback) also fails', async () => {
    mockFindUserByPhone.mockRejectedValue(new Error('DB connection failed'))
    mockSendTextMessage.mockRejectedValue(new Error('WhatsApp API down'))

    // Should resolve without throwing
    await expect(handleIncomingMessage(FROM, MESSAGE_ID, TEXT)).resolves.toBeUndefined()
  })

  it('logs error when sendTextMessage fails in error handler', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockFindUserByPhone.mockRejectedValue(new Error('DB connection failed'))
    mockSendTextMessage.mockRejectedValue(new Error('WhatsApp API error: HTTP 401 — Unauthorized'))

    await handleIncomingMessage(FROM, MESSAGE_ID, TEXT)

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[handler]'),
      expect.any(Error)
    )
    // Should have been called twice: once for original error, once for send failure
    const sendFailCalls = consoleSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('send error')
    )
    expect(sendFailCalls.length).toBe(1)
    consoleSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Test 7: handleIncomingAudio
// ---------------------------------------------------------------------------

// Local AudioTooLargeError for use in tests (matches the mock's class by name)
class AudioTooLargeError extends Error {
  constructor() { super('Audio exceeds 30 second limit'); this.name = 'AudioTooLargeError' }
}

const AUDIO_ID = 'media_audio_123'

describe('handleIncomingAudio', () => {
  beforeEach(() => {
    mockFindUserByPhone.mockResolvedValue(completedUser)
    mockClassifyByRules.mockReturnValue('meal_log')
    mockSendTextMessage.mockResolvedValue('msg-id-123')
  })

  it('downloads audio, transcribes it, sends feedback, then runs the pipeline', async () => {
    await handleIncomingAudio(FROM, MESSAGE_ID, AUDIO_ID)

    expect(mockDownloadAudioMedia).toHaveBeenCalledWith(AUDIO_ID)
    expect(mockTranscribeAudio).toHaveBeenCalledWith(Buffer.from('fake-audio'))
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, '🎤 Entendi: *almocei arroz e feijão*\n\n⏳ Registrando...')
    // Pipeline ran — findUserByPhone is called inside handleIncomingMessage
    expect(mockFindUserByPhone).toHaveBeenCalled()
    // At least two sends: feedback + pipeline response
    expect(mockSendTextMessage.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('sends AudioTooLargeError message when download throws AudioTooLargeError', async () => {
    mockDownloadAudioMedia.mockRejectedValue(new AudioTooLargeError())

    await handleIncomingAudio(FROM, MESSAGE_ID, AUDIO_ID)

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      '🎤 Áudio muito longo! Manda um áudio de até 30 segundos 😊'
    )
    expect(mockFindUserByPhone).not.toHaveBeenCalled()
  })

  it('sends empty transcription message when transcription is empty', async () => {
    mockTranscribeAudio.mockResolvedValue({ text: '', latencyMs: 200 })

    await handleIncomingAudio(FROM, MESSAGE_ID, AUDIO_ID)

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      '🎤 Não consegui entender o áudio. Tenta mandar de novo ou digita o que comeu?'
    )
    expect(mockFindUserByPhone).not.toHaveBeenCalled()
  })

  it('sends unavailable message when OPENAI_API_KEY is not configured', async () => {
    mockTranscribeAudio.mockRejectedValue(new Error('OPENAI_API_KEY is not configured'))

    await handleIncomingAudio(FROM, MESSAGE_ID, AUDIO_ID)

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      '🎤 Suporte a áudio não está disponível. Digita o que comeu?'
    )
    expect(mockFindUserByPhone).not.toHaveBeenCalled()
  })

  it('sends formatError() when download throws an unexpected error', async () => {
    mockDownloadAudioMedia.mockRejectedValue(new Error('Network error'))

    await handleIncomingAudio(FROM, MESSAGE_ID, AUDIO_ID)

    expect(mockFormatError).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'error message')
  })

  it('sends feedback BEFORE running the pipeline (feedback is the first sendTextMessage call)', async () => {
    await handleIncomingAudio(FROM, MESSAGE_ID, AUDIO_ID)

    expect(mockSendTextMessage).toHaveBeenNthCalledWith(
      1,
      FROM,
      '🎤 Entendi: *almocei arroz e feijão*\n\n⏳ Registrando...'
    )
  })

  it('delegates transcribed text to handleIncomingMessage (findUserByPhone is called)', async () => {
    await handleIncomingAudio(FROM, MESSAGE_ID, AUDIO_ID)

    expect(mockFindUserByPhone).toHaveBeenCalledWith(mockSupabase, FROM)
  })

  it('logs error when sendTextMessage fails in audio error handler', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockDownloadAudioMedia.mockRejectedValue(new Error('network error'))
    mockSendTextMessage.mockRejectedValue(new Error('WhatsApp API error: HTTP 401'))

    await handleIncomingAudio(FROM, MESSAGE_ID, 'audio-id')

    const sendFailCalls = consoleSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('send error')
    )
    expect(sendFailCalls.length).toBe(1)
    mockSendTextMessage.mockResolvedValue('msg-id-123')
    consoleSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Test 8: handleIncomingImage
// ---------------------------------------------------------------------------

const IMAGE_ID = 'img_media_123'

describe('handleIncomingImage', () => {
  beforeEach(() => {
    // Freeze time so meal-type classification is deterministic.
    // 2026-04-23T18:00:00Z → America/Sao_Paulo 15:00 → "snack" window.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-23T18:00:00Z'))
    mockFindUserByPhone.mockResolvedValue(completedUser)
    mockGetLLMProvider.mockReturnValue({
      classifyIntent: mockClassifyIntent,
      analyzeImage: mockAnalyzeImage,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('downloads image, analyzes via LLM vision, and consolidates the meal via logFoodToMeal', async () => {
    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID, 'meu almoço')

    expect(mockDownloadImageMedia).toHaveBeenCalledWith(IMAGE_ID, 5_242_880)
    expect(mockDetectMimeType).toHaveBeenCalled()
    expect(mockAnalyzeImage).toHaveBeenCalledWith(
      expect.stringContaining('data:image/jpeg;base64,'),
      'meu almoço',
      '15:00',
    )
    expect(mockLogFoodToMeal).toHaveBeenCalledTimes(1)
    expect(mockLogFoodToMeal).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        userId: completedUser.id,
        mealType: 'lunch',
        items: [expect.objectContaining({ foodName: 'Arroz', quantityGrams: 150, calories: 195 })],
        originalMessage: 'meu almoço',
      }),
    )
    // Brand-new meal (wasAppend:false) → renders via formatMealBreakdown
    expect(mockFormatMealBreakdown).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal breakdown message')
  })

  it('appends a food photo to the existing breakfast and replies with "Somei"', async () => {
    mockAnalyzeImage.mockResolvedValue({
      image_type: 'food',
      meal_type: 'breakfast',
      confidence: 'high',
      items: [{ food: 'Açaí', quantity_grams: 67, calories: 80, protein: 1, carbs: 18, fat: 2 }],
      unknown_items: [],
      needs_clarification: false,
    })
    mockLogFoodToMeal.mockResolvedValue({
      wasAppend: true,
      mealId: 'meal-1',
      addedItems: [{ foodName: 'Açaí', quantityGrams: 67, calories: 80, proteinG: 1, carbsG: 18, fatG: 2, source: 'manual' }],
      meal: {
        id: 'meal-1',
        mealType: 'breakfast',
        totalCalories: 292,
        registeredAt: '2026-04-23T18:00:00Z',
        items: [
          { id: 'i1', foodName: 'Ovo', quantityGrams: 100, quantityDisplay: null, calories: 143, proteinG: 13, carbsG: 1, fatG: 10, source: 'taco', confidence: 'high' },
          { id: 'i2', foodName: 'Queijo', quantityGrams: 30, quantityDisplay: null, calories: 69, proteinG: 6, carbsG: 1, fatG: 5, source: 'taco', confidence: 'high' },
          { id: 'i3', foodName: 'Açaí', quantityGrams: 67, quantityDisplay: null, calories: 80, proteinG: 1, carbsG: 18, fatG: 2, source: 'manual', confidence: 'high' },
        ],
      },
    })
    // Use the real formatter so we assert the actual "Somei" rendering.
    mockFormatMealAddition.mockImplementation((...args: unknown[]) =>
      realFormatMealAddition(...(args as Parameters<typeof realFormatMealAddition>)),
    )

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID, 'Comi também no café da manhã 67g desse açaí')

    expect(mockLogFoodToMeal).toHaveBeenCalledTimes(1)
    const sent = mockSendTextMessage.mock.calls.map(c => c[1]).join('\n')
    expect(sent).toContain('Somei')
    expect(sent).toContain('Café da manhã agora:')
    expect(sent).toContain('Total: 292 kcal')
  })

  it('sends clarification message when LLM returns needs_clarification', async () => {
    mockAnalyzeImage.mockResolvedValue({
      image_type: 'food',
      confidence: 'low',
      items: [],
      needs_clarification: true,
      clarification_question: 'Não consegui identificar.',
    })

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID)

    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'Não consegui identificar.')
    expect(mockSetState).not.toHaveBeenCalled()
  })

  it('sends default clarification when items empty and no question', async () => {
    mockAnalyzeImage.mockResolvedValue({
      image_type: 'food',
      confidence: 'low',
      items: [],
      needs_clarification: false,
    })

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID)

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('Não consegui identificar'),
    )
    expect(mockSetState).not.toHaveBeenCalled()
  })

  it('enters awaiting_label_portions for nutrition_label images', async () => {
    mockAnalyzeImage.mockResolvedValue({
      image_type: 'nutrition_label',
      confidence: 'high',
      items: [{ food: 'Granola', quantity_grams: 40, calories: 180, protein: 4, carbs: 28, fat: 6 }],
      unknown_items: [],
      needs_clarification: false,
    })

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID, 'tabela nutricional')

    expect(mockSetState).toHaveBeenCalledWith(
      completedUser.id,
      'awaiting_label_portions',
      expect.objectContaining({
        mealAnalysis: expect.objectContaining({ meal_type: 'snack' }),
      }),
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('Quantas porções'),
    )
  })

  it('registers nutrition label immediately when caption already includes portions', async () => {
    mockAnalyzeImage.mockResolvedValue({
      image_type: 'nutrition_label',
      meal_type: 'breakfast',
      confidence: 'high',
      items: [{
        food: 'Pré-treino',
        quantity_grams: 7.5,
        nutrition_basis_grams: 5,
        calories: 13,
        protein: 0,
        carbs: 0.9,
        fat: 0,
      }],
      unknown_items: [],
      needs_clarification: false,
    })

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID, 'café da manhã 1 dose')

    // Registers immediately (no "awaiting_label_portions" prompt). The consolidated
    // meal is tracked via recent_meal state for contextual corrections.
    expect(mockSetState).not.toHaveBeenCalledWith(
      expect.anything(),
      'awaiting_label_portions',
      expect.anything(),
    )
    expect(mockFormatMealBreakdown).toHaveBeenCalledWith(
      'breakfast',
      expect.arrayContaining([
        expect.objectContaining({
          food: 'Pré-treino',
          quantityGrams: 7.5,
          calories: 19,
        }),
      ]),
      19,
      expect.any(Number),
      expect.any(Number),
      undefined,
      expect.any(String),
    )
    expect(mockSendTextMessage).not.toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('Quantas porções'),
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal breakdown message')
  })

  it('registers nutrition label immediately when caption specifies grams', async () => {
    mockAnalyzeImage.mockResolvedValue({
      image_type: 'nutrition_label',
      meal_type: 'breakfast',
      confidence: 'high',
      items: [{
        food: 'Açaí',
        quantity_grams: 55,
        nutrition_basis_grams: 55,
        calories: 54,
        protein: 0,
        carbs: 13.8,
        fat: 0,
      }],
      unknown_items: [],
      needs_clarification: false,
    })

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID, 'Adicionar 55g desse açaí no café da manhã')

    expect(mockSetState).not.toHaveBeenCalledWith(
      expect.anything(),
      'awaiting_label_portions',
      expect.anything(),
    )
    expect(mockSendTextMessage).not.toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('Quantas porções'),
    )
    expect(mockFormatMealBreakdown).toHaveBeenCalledWith(
      'breakfast',
      expect.arrayContaining([
        expect.objectContaining({
          food: 'Açaí',
          quantityGrams: 55,
          calories: 54,
        }),
      ]),
      54,
      expect.any(Number),
      expect.any(Number),
      undefined,
      expect.any(String),
    )
  })

  it('consolidates a nutrition-label photo into the same-day breakfast and replies with "Somei"', async () => {
    mockAnalyzeImage.mockResolvedValue({
      image_type: 'nutrition_label',
      meal_type: 'breakfast',
      confidence: 'high',
      needs_clarification: false,
      unknown_items: [],
      items: [{ food: 'Açaí', quantity_grams: 60, calories: 72, protein: 1, carbs: 16, fat: 0.4 }],
    })
    mockLogFoodToMeal.mockResolvedValue({
      wasAppend: true,
      mealId: 'm1',
      addedItems: [{ foodName: 'Açaí', quantityGrams: 67, quantityDisplay: null, calories: 80, proteinG: 1, carbsG: 18, fatG: 0.4, source: 'manual' }],
      meal: {
        id: 'm1',
        mealType: 'breakfast',
        totalCalories: 292,
        registeredAt: '2026-04-23T18:00:00Z',
        items: [
          { id: 'i1', foodName: 'Ovo', quantityGrams: 100, quantityDisplay: null, calories: 143, proteinG: 13, carbsG: 1, fatG: 10, source: 'taco', confidence: 'high' },
          { id: 'i2', foodName: 'Queijo', quantityGrams: 30, quantityDisplay: null, calories: 69, proteinG: 6, carbsG: 1, fatG: 5, source: 'taco', confidence: 'high' },
          { id: 'i3', foodName: 'Açaí', quantityGrams: 67, quantityDisplay: null, calories: 80, proteinG: 1, carbsG: 18, fatG: 0.4, source: 'manual', confidence: 'high' },
        ],
      },
    })
    // Use the real formatter so we assert the actual "Somei" rendering.
    mockFormatMealAddition.mockImplementation((...args: unknown[]) =>
      realFormatMealAddition(...(args as Parameters<typeof realFormatMealAddition>)),
    )

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID, 'Comi também no café da manhã 67g desse açaí')

    expect(mockLogFoodToMeal).toHaveBeenCalledTimes(1)
    expect(mockLogFoodToMeal).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({ mealType: 'breakfast' }),
    )
    const sent = mockSendTextMessage.mock.calls.map(c => c[1]).join('\n')
    expect(sent).toContain('Somei')
  })

  it('handles MediaTooLargeError gracefully', async () => {
    mockDownloadImageMedia.mockRejectedValue(new MediaTooLargeError(6_000_000, 5_242_880))

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID)

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('Imagem muito grande'),
    )
    expect(mockAnalyzeImage).not.toHaveBeenCalled()
  })

  it('sends onboarding message for incomplete user', async () => {
    mockFindUserByPhone.mockResolvedValue(existingUserIncomplete)

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID)

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('Primeiro preciso te conhecer'),
    )
    expect(mockDownloadImageMedia).not.toHaveBeenCalled()
  })

  it('sends formatError on unexpected error', async () => {
    mockDownloadImageMedia.mockRejectedValue(new Error('Network timeout'))

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID)

    expect(mockFormatError).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'error message')
  })

  it('uses "[imagem]" as originalMessage when no caption', async () => {
    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID)

    expect(mockFormatMealBreakdown).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal breakdown message')
  })

  it('logs vision API usage', async () => {
    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID)

    expect(mockLogLLMUsage).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        functionType: 'vision',
        success: true,
      }),
    )
  })

  it('overrides LLM meal_type with user local time when caption has no explicit meal keyword', async () => {
    // 2026-04-23T10:23:00Z → America/Sao_Paulo 07:23 → "breakfast" window
    vi.setSystemTime(new Date('2026-04-23T10:23:00Z'))
    mockAnalyzeImage.mockResolvedValue({
      image_type: 'nutrition_label',
      meal_type: 'snack', // LLM guess based on food content
      confidence: 'high',
      items: [{
        food: 'Pré-treino sabor limão',
        quantity_grams: 7.5,
        nutrition_basis_grams: 5,
        calories: 13,
        protein: 0,
        carbs: 0.9,
        fat: 0,
      }],
      unknown_items: [],
      needs_clarification: false,
    })

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID, '1 dose desse pré treino')

    expect(mockAnalyzeImage).toHaveBeenCalledWith(
      expect.any(String),
      '1 dose desse pré treino',
      '07:23',
    )
    // Caption "1 dose" triggers immediate registration (handleLabelPortions),
    // so meal_type flows through formatMealBreakdown as first arg.
    expect(mockFormatMealBreakdown).toHaveBeenCalledWith(
      'breakfast',
      expect.any(Array),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      undefined,
      expect.any(String),
    )
  })

  it('keeps explicit meal keyword from caption regardless of time', async () => {
    vi.setSystemTime(new Date('2026-04-23T10:23:00Z')) // 07:23 SP (breakfast window)
    mockAnalyzeImage.mockResolvedValue({
      image_type: 'food',
      meal_type: 'breakfast',
      confidence: 'high',
      items: [{ food: 'Salada', quantity_grams: 200, calories: 100, protein: 5, carbs: 10, fat: 2 }],
      unknown_items: [],
      needs_clarification: false,
    })

    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID, 'meu almoço de ontem')

    expect(mockFormatMealBreakdown).toHaveBeenCalledWith(
      'lunch',
      expect.any(Array),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      undefined,
      'Ontem',
    )
  })

  it('logs error when sendTextMessage fails in image error handler', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockFindUserByPhone.mockRejectedValue(new Error('DB error'))
    mockSendTextMessage.mockRejectedValue(new Error('WhatsApp API error: HTTP 401'))

    await handleIncomingImage(FROM, MESSAGE_ID, 'image-id')

    const sendFailCalls = consoleSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('send error')
    )
    expect(sendFailCalls.length).toBe(1)
    mockFindUserByPhone.mockResolvedValue(completedUser)
    mockSendTextMessage.mockResolvedValue('msg-id-123')
    consoleSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Test 9: handleIncomingMessage — awaiting_label_portions context
// ---------------------------------------------------------------------------

describe('handleIncomingMessage — awaiting_label_portions context', () => {
  const labelContext = {
    contextType: 'awaiting_label_portions',
    contextData: {
      mealAnalysis: {
        meal_type: 'snack',
        confidence: 'high',
        items: [{ food: 'Granola', quantity_grams: 40, calories: 180, protein: 4, carbs: 28, fat: 6 }],
        unknown_items: [],
        needs_clarification: false,
      },
      originalMessage: '[imagem]',
    },
  }

  beforeEach(() => {
    mockFindUserByPhone.mockResolvedValue(completedUser)
    mockGetState.mockResolvedValue(labelContext)
    mockGetLLMProvider.mockReturnValue({
      classifyIntent: mockClassifyIntent,
      analyzeImage: mockAnalyzeImage,
    })
  })

  it('multiplies nutrition values by portion count and saves meal directly', async () => {
    await handleIncomingMessage(FROM, MESSAGE_ID, '2')

    expect(mockFormatMealBreakdown).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({
          food: 'Granola',
          quantityGrams: 80,
          calories: 360,
        }),
      ]),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      undefined,
      expect.any(String),
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal breakdown message')
  })

  it('rescales label nutrition when basis grams differ from serving grams', async () => {
    mockGetState.mockResolvedValue({
      contextType: 'awaiting_label_portions',
      contextData: {
        mealAnalysis: {
          meal_type: 'breakfast',
          confidence: 'high',
          items: [{
            food: 'Pré-treino',
            quantity_grams: 7.5,
            nutrition_basis_grams: 5,
            calories: 13,
            protein: 0,
            carbs: 0.9,
            fat: 0,
          }],
          unknown_items: [],
          needs_clarification: false,
        },
        originalMessage: '[imagem]',
      },
    })

    await handleIncomingMessage(FROM, MESSAGE_ID, '2')

    expect(mockFormatMealBreakdown).toHaveBeenCalledWith(
      'breakfast',
      expect.arrayContaining([
        expect.objectContaining({
          quantityGrams: 15,
          calories: 39,
        }),
      ]),
      39,
      expect.any(Number),
      expect.any(Number),
      undefined,
      expect.any(String),
    )
  })

  it('uses explicit basis nutrition values when the extracted serving values are already scaled', async () => {
    mockGetState.mockResolvedValue({
      contextType: 'awaiting_label_portions',
      contextData: {
        mealAnalysis: {
          meal_type: 'breakfast',
          confidence: 'high',
          items: [{
            food: 'Pré-treino',
            quantity_grams: 7.5,
            nutrition_basis_grams: 5,
            nutrition_basis_calories: 13,
            nutrition_basis_protein: 0,
            nutrition_basis_carbs: 0.9,
            nutrition_basis_fat: 0,
            calories: 19,
            protein: 0,
            carbs: 1.4,
            fat: 0,
          }],
          unknown_items: [],
          needs_clarification: false,
        },
        originalMessage: '[imagem]',
      },
    })

    await handleIncomingMessage(FROM, MESSAGE_ID, '1')

    expect(mockFormatMealBreakdown).toHaveBeenCalledWith(
      'breakfast',
      expect.arrayContaining([
        expect.objectContaining({
          quantityGrams: 7.5,
          calories: 19,
        }),
      ]),
      19,
      expect.any(Number),
      expect.any(Number),
      undefined,
      expect.any(String),
    )
  })

  it('handles decimal portions like "1.5"', async () => {
    await handleIncomingMessage(FROM, MESSAGE_ID, '1.5')

    expect(mockFormatMealBreakdown).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({
          quantityGrams: 60,
          calories: 270,
        }),
      ]),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      undefined,
      expect.any(String),
    )
  })

  it('handles comma decimal "1,5"', async () => {
    await handleIncomingMessage(FROM, MESSAGE_ID, '1,5')

    expect(mockFormatMealBreakdown).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ calories: 270 }),
      ]),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      undefined,
      expect.any(String),
    )
  })

  it('asks again when message is not a number', async () => {
    await handleIncomingMessage(FROM, MESSAGE_ID, 'banana')

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('número de porções'),
    )
    expect(mockSetState).not.toHaveBeenCalled()
  })

  it('asks again when number is zero or negative', async () => {
    await handleIncomingMessage(FROM, MESSAGE_ID, '0')

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('número de porções'),
    )
    expect(mockSetState).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Test 10: Message history saving
// ---------------------------------------------------------------------------

describe('handleIncomingMessage — message history', () => {
  it('saves user message and bot response to message history', async () => {
    mockFindUserByPhone.mockResolvedValueOnce(completedUser)
    mockGetState.mockResolvedValueOnce(null)
    mockClassifyByRules.mockReturnValueOnce('meal_log')
    mockHandleMealLog.mockResolvedValueOnce({ response: 'Almoço registrado!', completed: true })

    await handleIncomingMessage('5511999999999', 'msg-1', 'arroz com feijão')

    expect(mockSaveMessage).toHaveBeenCalledWith(expect.anything(), completedUser.id, 'user', 'arroz com feijão')
    expect(mockSaveMessage).toHaveBeenCalledWith(expect.anything(), completedUser.id, 'assistant', 'Almoço registrado!')
  })

  it('does NOT save onboarding messages to history', async () => {
    const onboardingUser = { ...completedUser, onboardingComplete: false, onboardingStep: 0 }
    mockFindUserByPhone.mockResolvedValueOnce(onboardingUser)
    mockHandleOnboarding.mockResolvedValueOnce({ response: 'Qual seu nome?' })

    await handleIncomingMessage('5511999999999', 'msg-1', 'oi')

    expect(mockSaveMessage).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Test 11: recent_meal context with LLM gatekeeper
// ---------------------------------------------------------------------------

describe('handleIncomingMessage — recent_meal context', () => {
  const onboardedUser = {
    id: 'user-123',
    phone: '+5511999999999',
    onboardingComplete: true,
    onboardingStep: 8,
    calorieMode: 'approximate',
    dailyCalorieTarget: 2000,
    dailyProteinG: null,
    dailyFatG: null,
    dailyCarbsG: null,
    timezone: 'America/Sao_Paulo',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockFindUserByPhone.mockResolvedValue(onboardedUser)
    mockCreateServiceRoleClient.mockReturnValue({})
  })

  it('routes to edit when gatekeeper detects correction', async () => {
    mockGetState.mockResolvedValue({
      id: 'ctx-1',
      userId: 'user-123',
      contextType: 'recent_meal',
      contextData: {
        mealId: 'meal-1',
        mealType: 'breakfast',
        items: [
          { id: 'item-1', foodName: 'Magic Toast', quantityGrams: 30, quantityDisplay: '1 pacote', calories: 120, proteinG: 3, carbsG: 20, fatG: 3 },
        ],
      },
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      createdAt: new Date().toISOString(),
    })

    const mockChat = vi.fn().mockResolvedValue(JSON.stringify({
      type: 'correction',
      corrected_message: 'corrigir o magic toast para 93kcal',
    }))
    mockGetLLMProvider.mockReturnValue({
      classifyIntent: mockClassifyIntent,
      analyzeImage: mockAnalyzeImage,
      chat: mockChat,
    })

    mockHandleEdit.mockResolvedValue('✅ Magic Toast: 120 → 93 kcal')

    await handleIncomingMessage('+5511999999999', 'msg-1', 'O magic toast é 93kcal')

    expect(mockHandleEdit).toHaveBeenCalledWith(
      expect.anything(),
      'user-123',
      'corrigir o magic toast para 93kcal',
      null,
      expect.objectContaining({ timezone: 'America/Sao_Paulo' }),
      undefined,
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith('+5511999999999', '✅ Magic Toast: 120 → 93 kcal')
  })

  it('falls through to normal classification when gatekeeper says not a correction', async () => {
    mockGetState.mockResolvedValue({
      id: 'ctx-1',
      userId: 'user-123',
      contextType: 'recent_meal',
      contextData: {
        mealId: 'meal-1',
        mealType: 'breakfast',
        items: [
          { id: 'item-1', foodName: 'Magic Toast', quantityGrams: 30, quantityDisplay: '1 pacote', calories: 120, proteinG: 3, carbsG: 20, fatG: 3 },
        ],
      },
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      createdAt: new Date().toISOString(),
    })

    const mockChat = vi.fn().mockResolvedValue(JSON.stringify({ type: 'other' }))
    mockGetLLMProvider.mockReturnValue({
      classifyIntent: mockClassifyIntent,
      analyzeImage: mockAnalyzeImage,
      chat: mockChat,
    })

    mockClassifyByRules.mockReturnValue('meal_log')
    mockHandleMealLog.mockResolvedValue({ response: 'Refeição registrada!', completed: true })

    await handleIncomingMessage('+5511999999999', 'msg-1', 'Almocei arroz e feijão')

    expect(mockHandleMealLog).toHaveBeenCalled()
    expect(mockHandleEdit).not.toHaveBeenCalled()
  })

  it('sends confirmation and clears state when gatekeeper detects confirmation', async () => {
    mockGetState.mockResolvedValue({
      id: 'ctx-1',
      userId: 'user-123',
      contextType: 'recent_meal',
      contextData: {
        mealId: 'meal-1',
        mealType: 'breakfast',
        items: [
          { id: 'item-1', foodName: 'Cuscuz', quantityGrams: 60, quantityDisplay: '2 colheres de sopa', calories: 57, proteinG: 1, carbsG: 12, fatG: 0 },
          { id: 'item-2', foodName: 'Bacon', quantityGrams: 15, quantityDisplay: '15g', calories: 62, proteinG: 4, carbsG: 0, fatG: 5 },
        ],
      },
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      createdAt: new Date().toISOString(),
    })

    const mockChat = vi.fn().mockResolvedValue(JSON.stringify({ type: 'confirmation' }))
    mockGetLLMProvider.mockReturnValue({
      classifyIntent: mockClassifyIntent,
      analyzeImage: mockAnalyzeImage,
      chat: mockChat,
    })

    await handleIncomingMessage('+5511999999999', 'msg-1', 'Café é só isso')

    expect(mockSendTextMessage).toHaveBeenCalledWith('+5511999999999', 'Tudo certo! ✅ Refeição registrada.')
    expect(mockHandleMealLog).not.toHaveBeenCalled()
    expect(mockHandleEdit).not.toHaveBeenCalled()
  })
})
