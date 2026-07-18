export const OUTBOX_PROJECTION_STATES = [
  'pending',
  'sending',
  'retryable',
  'unknown',
  'api_accepted',
  'sent',
  'delivered',
  'read',
  'failed_terminal',
  'expired',
  'superseded',
  'suspended',
] as const

export type OutboxProjectionState =
  (typeof OUTBOX_PROJECTION_STATES)[number]

export const OUTBOX_MESSAGE_KINDS = [
  'progress',
  'prompt',
  'terminal',
  'otp',
  'reminder',
] as const

export type OutboxMessageKind = (typeof OUTBOX_MESSAGE_KINDS)[number]

export type OutboxMode = 'off' | 'shadow' | 'active'
export type OutboxSource = 'bot' | 'otp' | 'reminder' | 'sweeper'

export type MetaCallbackStatus =
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'unknown'

export interface MetaCallbackProjection {
  status: MetaCallbackStatus
}

export interface MetaResponseMetadata {
  httpStatus?: number
  requestId?: string
  response?: Record<string, unknown> | null
}

export interface MetaAcceptedOutcome extends MetaResponseMetadata {
  kind: 'accepted'
  providerMessageId: string
  recipientId?: string
}

export interface MetaFailureDetails {
  httpStatus?: number
  metaCode?: number
  metaSubcode?: number
  message?: string
  outcomeUnknown?: boolean
}

export interface MetaRejectedOutcome
  extends MetaFailureDetails, MetaResponseMetadata {
  kind: 'rejected'
}

export interface MetaUnknownOutcome
  extends MetaFailureDetails, MetaResponseMetadata {
  kind: 'outcome_unknown'
  outcomeUnknown: true
}

export type MetaSendOutcome =
  | MetaAcceptedOutcome
  | MetaRejectedOutcome
  | MetaUnknownOutcome

export interface OutboxDeliveryPolicy {
  readonly maxAttempts: number
  readonly ttlMs: number
  readonly redactOnAcceptance: boolean
}

export interface ClassifiedOutboxFailure {
  projection: 'retryable' | 'unknown' | 'failed_terminal'
  retryable: boolean
  normalizedCode: string
  message: string | null
}

export interface OutboxRolloutConfig {
  mode: OutboxMode
  generation: string | null
  canaryPhones: ReadonlySet<string>
  canaryPercent: number
  inboundWorkEnabled: boolean
  source: OutboxSource
}
