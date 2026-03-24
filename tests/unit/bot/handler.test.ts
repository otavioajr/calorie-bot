import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  mockGetDailyCalories,
  mockFormatMealBreakdown,
  mockSaveMessage,
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
    mockGetDailyCalories: vi.fn().mockResolvedValue(0),
    mockFormatMealBreakdown: vi.fn().mockReturnValue('meal breakdown message'),
    mockSaveMessage: vi.fn().mockResolvedValue(undefined),
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
}))

vi.mock('@/lib/bot/router', () => ({
  classifyByRules: mockClassifyByRules,
}))

vi.mock('@/lib/bot/flows/onboarding', () => ({
  handleOnboarding: mockHandleOnboarding,
}))

vi.mock('@/lib/bot/flows/meal-log', () => ({
  handleMealLog: mockHandleMealLog,
}))

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
  createMeal: vi.fn(),
  getDailyCalories: mockGetDailyCalories,
}))

vi.mock('@/lib/db/queries/message-history', () => ({
  saveMessage: mockSaveMessage,
}))

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------
import { handleIncomingMessage, handleIncomingAudio, handleIncomingImage } from '@/lib/bot/handler'
import { MediaTooLargeError } from '@/lib/whatsapp/media'

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
  calorieMode: 'approximate' as const,
  dailyCalorieTarget: null,
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
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'out of scope message')
  })

  it('routes summary intent to handleSummary and sends its response', async () => {
    mockClassifyByRules.mockReturnValue('summary')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'como tô hoje?')

    expect(mockHandleSummary).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      'como tô hoje?',
      { dailyCalorieTarget: completedUser.dailyCalorieTarget }
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'summary response')
  })

  it('routes query intent to handleQuery and sends its response', async () => {
    mockClassifyByRules.mockReturnValue('query')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'quantas calorias tem uma banana?')

    expect(mockHandleQuery).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      'quantas calorias tem uma banana?'
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'query response')
  })

  it('routes edit intent to handleEdit and sends its response', async () => {
    mockClassifyByRules.mockReturnValue('edit')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'corrigir')

    expect(mockHandleEdit).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      'corrigir',
      null
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'edit response')
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
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'weight response')
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
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'settings response')
  })

  it('routes help intent to handleHelp and sends its response', async () => {
    mockClassifyByRules.mockReturnValue('help')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'ajuda')

    expect(mockHandleHelp).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'help response')
  })

  it('routes user_data intent to handleUserData and sends its response', async () => {
    mockClassifyByRules.mockReturnValue('user_data')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'meus dados')

    expect(mockHandleUserData).toHaveBeenCalledWith(mockSupabase, completedUser.id)
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'user data response')
  })

  it('routes meal_log intent to handleMealLog and sends its response', async () => {
    mockClassifyByRules.mockReturnValue('meal_log')
    mockHandleMealLog.mockResolvedValue({ response: 'meal log response', completed: false })

    await handleIncomingMessage(FROM, MESSAGE_ID, 'almocei arroz')

    expect(mockHandleMealLog).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      'almocei arroz',
      { calorieMode: completedUser.calorieMode, dailyCalorieTarget: completedUser.dailyCalorieTarget },
      null
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal log response')
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
      { calorieMode: completedUser.calorieMode, dailyCalorieTarget: completedUser.dailyCalorieTarget },
      null
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal log response')
  })

  it('defaults to meal_log when LLM classifyIntent throws', async () => {
    mockClassifyIntent.mockRejectedValue(new Error('LLM timeout'))
    mockHandleMealLog.mockResolvedValue({ response: 'meal log response', completed: false })

    await handleIncomingMessage(FROM, MESSAGE_ID, 'comi pizza')

    expect(mockHandleMealLog).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      'comi pizza',
      { calorieMode: completedUser.calorieMode, dailyCalorieTarget: completedUser.dailyCalorieTarget },
      null
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal log response')
  })

  it('routes to out_of_scope when LLM classifies as out_of_scope', async () => {
    mockClassifyIntent.mockResolvedValue('out_of_scope')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'conta uma piada')

    expect(mockFormatOutOfScope).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'out of scope message')
  })
})

// ---------------------------------------------------------------------------
// Test 5: Context-based routing (active context → handleMealLog)
// ---------------------------------------------------------------------------

describe('handleIncomingMessage — context-based routing', () => {
  beforeEach(() => {
    mockFindUserByPhone.mockResolvedValue(completedUser)
  })

  it('routes to handleMealLog when context is awaiting_confirmation', async () => {
    const mockContext = {
      contextType: 'awaiting_confirmation',
      contextData: { mealAnalysis: {}, originalMessage: 'arroz e feijão' },
    }
    mockGetState.mockResolvedValue(mockContext)
    mockHandleMealLog.mockResolvedValue({ response: 'confirmed!', completed: true })

    await handleIncomingMessage(FROM, MESSAGE_ID, 'sim')

    expect(mockHandleMealLog).toHaveBeenCalledWith(
      mockSupabase,
      completedUser.id,
      'sim',
      { calorieMode: completedUser.calorieMode, dailyCalorieTarget: completedUser.dailyCalorieTarget },
      mockContext
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'confirmed!')
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
      { calorieMode: completedUser.calorieMode, dailyCalorieTarget: completedUser.dailyCalorieTarget },
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
      mockContext
    )
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'correction received')
  })

  it('does not call classifyByRules when an active meal context is present', async () => {
    const mockContext = {
      contextType: 'awaiting_confirmation',
      contextData: { mealAnalysis: {}, originalMessage: 'pizza' },
    }
    mockGetState.mockResolvedValue(mockContext)
    mockHandleMealLog.mockResolvedValue({ response: 'done', completed: true })

    await handleIncomingMessage(FROM, MESSAGE_ID, 'sim')

    expect(mockClassifyByRules).not.toHaveBeenCalled()
  })

  it('returns early (does not call sendTextMessage twice) when context routes to handleMealLog', async () => {
    const mockContext = {
      contextType: 'awaiting_confirmation',
      contextData: { mealAnalysis: {}, originalMessage: 'pizza' },
    }
    mockGetState.mockResolvedValue(mockContext)
    mockHandleMealLog.mockResolvedValue({ response: 'done', completed: true })

    await handleIncomingMessage(FROM, MESSAGE_ID, 'sim')

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
})

// ---------------------------------------------------------------------------
// Test 8: handleIncomingImage
// ---------------------------------------------------------------------------

const IMAGE_ID = 'img_media_123'

describe('handleIncomingImage', () => {
  beforeEach(() => {
    mockFindUserByPhone.mockResolvedValue(completedUser)
    mockGetLLMProvider.mockReturnValue({
      classifyIntent: mockClassifyIntent,
      analyzeImage: mockAnalyzeImage,
    })
  })

  it('downloads image, analyzes via LLM vision, and sends food confirmation', async () => {
    await handleIncomingImage(FROM, MESSAGE_ID, IMAGE_ID, 'meu almoço')

    expect(mockDownloadImageMedia).toHaveBeenCalledWith(IMAGE_ID, 5_242_880)
    expect(mockDetectMimeType).toHaveBeenCalled()
    expect(mockAnalyzeImage).toHaveBeenCalledWith(
      expect.stringContaining('data:image/jpeg;base64,'),
      'meu almoço',
      'approximate',
    )
    expect(mockSetState).toHaveBeenCalledWith(
      completedUser.id,
      'awaiting_confirmation',
      expect.objectContaining({ originalMessage: 'meu almoço' }),
    )
    expect(mockFormatMealBreakdown).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal breakdown message')
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

    expect(mockSetState).toHaveBeenCalledWith(
      completedUser.id,
      'awaiting_confirmation',
      expect.objectContaining({ originalMessage: '[imagem]' }),
    )
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

  it('multiplies nutrition values by portion count and enters awaiting_confirmation', async () => {
    await handleIncomingMessage(FROM, MESSAGE_ID, '2')

    expect(mockSetState).toHaveBeenCalledWith(
      completedUser.id,
      'awaiting_confirmation',
      expect.objectContaining({
        mealAnalysis: expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({
              food: 'Granola',
              quantity_grams: 80,
              calories: 360,
            }),
          ]),
        }),
      }),
    )
    expect(mockFormatMealBreakdown).toHaveBeenCalled()
    expect(mockSendTextMessage).toHaveBeenCalledWith(FROM, 'meal breakdown message')
  })

  it('handles decimal portions like "1.5"', async () => {
    await handleIncomingMessage(FROM, MESSAGE_ID, '1.5')

    expect(mockSetState).toHaveBeenCalledWith(
      completedUser.id,
      'awaiting_confirmation',
      expect.objectContaining({
        mealAnalysis: expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({
              quantity_grams: 60,
              calories: 270,
            }),
          ]),
        }),
      }),
    )
  })

  it('handles comma decimal "1,5"', async () => {
    await handleIncomingMessage(FROM, MESSAGE_ID, '1,5')

    expect(mockSetState).toHaveBeenCalledWith(
      completedUser.id,
      'awaiting_confirmation',
      expect.objectContaining({
        mealAnalysis: expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({ calories: 270 }),
          ]),
        }),
      }),
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
