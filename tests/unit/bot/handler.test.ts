import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist mock variables so they are available at vi.mock() factory call time
// ---------------------------------------------------------------------------
const {
  mockCreateServiceRoleClient,
  mockFindUserByPhone,
  mockCreateUser,
  mockGetState,
  mockClassifyByRules,
  mockHandleOnboarding,
  mockSendTextMessage,
  mockFormatOutOfScope,
  mockFormatError,
} = vi.hoisted(() => ({
  mockCreateServiceRoleClient: vi.fn(),
  mockFindUserByPhone: vi.fn(),
  mockCreateUser: vi.fn(),
  mockGetState: vi.fn(),
  mockClassifyByRules: vi.fn(),
  mockHandleOnboarding: vi.fn(),
  mockSendTextMessage: vi.fn().mockResolvedValue('msg-id-123'),
  mockFormatOutOfScope: vi.fn().mockReturnValue('out of scope message'),
  mockFormatError: vi.fn().mockReturnValue('error message'),
}))

// ---------------------------------------------------------------------------
// Mock all dependencies
// ---------------------------------------------------------------------------

vi.mock('@/lib/db/supabase', () => ({
  createServiceRoleClient: mockCreateServiceRoleClient,
}))

vi.mock('@/lib/db/queries/users', () => ({
  findUserByPhone: mockFindUserByPhone,
  createUser: mockCreateUser,
}))

vi.mock('@/lib/bot/state', () => ({
  getState: mockGetState,
}))

vi.mock('@/lib/bot/router', () => ({
  classifyByRules: mockClassifyByRules,
}))

vi.mock('@/lib/bot/flows/onboarding', () => ({
  handleOnboarding: mockHandleOnboarding,
}))

vi.mock('@/lib/whatsapp/client', () => ({
  sendTextMessage: mockSendTextMessage,
}))

vi.mock('@/lib/utils/formatters', () => ({
  formatOutOfScope: mockFormatOutOfScope,
  formatError: mockFormatError,
}))

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------
import { handleIncomingMessage } from '@/lib/bot/handler'

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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateServiceRoleClient.mockReturnValue(mockSupabase)
  mockGetState.mockResolvedValue(null)
  mockHandleOnboarding.mockResolvedValue({ response: 'onboarding response', completed: false })
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

  it('sends placeholder for summary intent', async () => {
    mockClassifyByRules.mockReturnValue('summary')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'como tô hoje?')

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      'Essa função ainda não está disponível. Aguarde! 🚧'
    )
  })

  it('sends placeholder for settings intent', async () => {
    mockClassifyByRules.mockReturnValue('settings')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'config')

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      'Essa função ainda não está disponível. Aguarde! 🚧'
    )
  })

  it('sends placeholder for weight intent', async () => {
    mockClassifyByRules.mockReturnValue('weight')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'pesei 72kg')

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      'Essa função ainda não está disponível. Aguarde! 🚧'
    )
  })

  it('sends placeholder for edit intent', async () => {
    mockClassifyByRules.mockReturnValue('edit')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'corrigir')

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      'Essa função ainda não está disponível. Aguarde! 🚧'
    )
  })

  it('sends placeholder for query intent', async () => {
    mockClassifyByRules.mockReturnValue('query')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'quantas calorias tem uma banana?')

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      'Essa função ainda não está disponível. Aguarde! 🚧'
    )
  })

  it('sends placeholder for user_data intent', async () => {
    mockClassifyByRules.mockReturnValue('user_data')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'meus dados')

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      'Essa função ainda não está disponível. Aguarde! 🚧'
    )
  })

  it('sends placeholder for meal_log intent', async () => {
    mockClassifyByRules.mockReturnValue('meal_log')

    await handleIncomingMessage(FROM, MESSAGE_ID, 'almocei arroz')

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      'Essa função ainda não está disponível. Aguarde! 🚧'
    )
  })

  it('sends helpful default message when no rule matches (null intent)', async () => {
    mockClassifyByRules.mockReturnValue(null)

    await handleIncomingMessage(FROM, MESSAGE_ID, 'alguma coisa aleatória')

    expect(mockSendTextMessage).toHaveBeenCalledWith(
      FROM,
      expect.stringContaining('menu')
    )
  })

  it('does not call handleOnboarding for a completed user', async () => {
    mockClassifyByRules.mockReturnValue('out_of_scope')

    await handleIncomingMessage(FROM, MESSAGE_ID, TEXT)

    expect(mockHandleOnboarding).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Test 4: Error in handler → sends error message
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
