import { createHash } from 'node:crypto'
import type {
  ClassifiedOutboxFailure,
  MetaCallbackProjection,
  MetaFailureDetails,
  OutboxDeliveryPolicy,
  OutboxMessageKind,
  OutboxMode,
  OutboxProjectionState,
  OutboxRolloutConfig,
  OutboxSource,
} from './types'

const MINUTE_MS = 60_000
const MAX_ATTEMPTS = 5

export const OUTBOX_BACKOFF_MS = [
  MINUTE_MS,
  2 * MINUTE_MS,
  5 * MINUTE_MS,
  5 * MINUTE_MS,
] as const

const DELIVERY_POLICIES: Record<OutboxMessageKind, OutboxDeliveryPolicy> = {
  progress: {
    maxAttempts: 1,
    ttlMs: 5 * MINUTE_MS,
    redactOnAcceptance: false,
  },
  otp: {
    maxAttempts: 3,
    ttlMs: 5 * MINUTE_MS,
    redactOnAcceptance: true,
  },
  prompt: {
    maxAttempts: MAX_ATTEMPTS,
    ttlMs: 10 * MINUTE_MS,
    redactOnAcceptance: false,
  },
  terminal: {
    maxAttempts: MAX_ATTEMPTS,
    ttlMs: 15 * MINUTE_MS,
    redactOnAcceptance: false,
  },
  reminder: {
    maxAttempts: MAX_ATTEMPTS,
    ttlMs: 15 * MINUTE_MS,
    redactOnAcceptance: false,
  },
}

const TRANSIENT_HTTP_STATUSES = new Set([
  408,
  409,
  425,
  429,
  500,
  502,
  503,
  504,
])
const TRANSIENT_META_CODES = new Set([
  1,
  2,
  4,
  17,
  130429,
  131016,
  131048,
])

function requireKeyPart(label: string, value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`${label} must not be empty`)
  }
  return normalized
}

export function buildInboundKey(workId: string, emissionIndex: number): string {
  if (!Number.isSafeInteger(emissionIndex) || emissionIndex < 0) {
    throw new Error('emissionIndex must be a non-negative safe integer')
  }
  return `inbound:${requireKeyPart('workId', workId)}:${emissionIndex}`
}

export function buildOtpKey(authCodeId: string): string {
  return `otp:${requireKeyPart('authCodeId', authCodeId)}`
}

export function buildReminderKey(
  userId: string,
  reminderType: string,
  localWindow: string,
): string {
  return [
    'reminder',
    requireKeyPart('userId', userId),
    requireKeyPart('reminderType', reminderType),
    requireKeyPart('localWindow', localWindow),
  ].join(':')
}

export function normalizeRecipientIdentity(recipient: string): string {
  const raw = recipient.trim()
  if (!/^\+?[\d\s().-]+$/.test(raw)) {
    throw new Error('recipient must be a valid phone identity')
  }
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) {
    throw new Error('recipient must contain 7 to 15 digits')
  }
  return digits
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        )
        .map(([key, nested]) => [key, sortJsonValue(nested)]),
    )
  }
  return value
}

export function canonicalizePayload(payload: unknown): string {
  const json = JSON.stringify(payload)
  if (json === undefined) {
    throw new Error('outbox payload must be JSON serializable')
  }
  return JSON.stringify(sortJsonValue(JSON.parse(json) as unknown))
}

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalizePayload(payload)).digest('hex')
}

export function policyFor(kind: OutboxMessageKind): OutboxDeliveryPolicy {
  return DELIVERY_POLICIES[kind]
}

export function retryDelayMs(completedAttempt: number): number | null {
  if (!Number.isSafeInteger(completedAttempt) || completedAttempt < 1) {
    throw new Error('completedAttempt must be a positive safe integer')
  }
  return OUTBOX_BACKOFF_MS[completedAttempt - 1] ?? null
}

function normalizedFailureCode(details: MetaFailureDetails): string {
  if (details.outcomeUnknown) return 'outcome_unknown'
  if (details.metaCode !== undefined) {
    return details.metaSubcode === undefined
      ? `meta:${details.metaCode}`
      : `meta:${details.metaCode}:${details.metaSubcode}`
  }
  if (details.httpStatus !== undefined) return `http:${details.httpStatus}`
  return 'unclassified'
}

export function classifySynchronousFailure(
  details: MetaFailureDetails,
): ClassifiedOutboxFailure {
  if (details.outcomeUnknown) {
    return {
      projection: 'unknown',
      retryable: false,
      normalizedCode: normalizedFailureCode(details),
      message: details.message ?? null,
    }
  }

  const transientHttp =
    details.httpStatus !== undefined &&
    TRANSIENT_HTTP_STATUSES.has(details.httpStatus)
  const transientMeta =
    details.metaCode !== undefined && TRANSIENT_META_CODES.has(details.metaCode)
  const retryable = transientHttp || transientMeta

  return {
    projection: retryable ? 'retryable' : 'failed_terminal',
    retryable,
    normalizedCode: normalizedFailureCode(details),
    message: details.message ?? null,
  }
}

export function classifyCallbackFailure(
  details: { code?: number; message?: string },
): ClassifiedOutboxFailure {
  return {
    projection: 'failed_terminal',
    retryable: false,
    normalizedCode:
      details.code === undefined ? 'callback:failed' : `meta:${details.code}`,
    message: details.message ?? null,
  }
}

export function nextProjection(
  current: OutboxProjectionState,
  callback: MetaCallbackProjection,
): OutboxProjectionState {
  switch (callback.status) {
    case 'unknown':
      return current
    case 'read':
      return 'read'
    case 'delivered':
      return current === 'read' ? 'read' : 'delivered'
    case 'sent':
      if (
        current === 'read' ||
        current === 'delivered' ||
        current === 'failed_terminal' ||
        current === 'expired' ||
        current === 'superseded' ||
        current === 'suspended'
      ) {
        return current
      }
      return 'sent'
    case 'failed':
      if (
        current === 'read' ||
        current === 'delivered' ||
        current === 'expired' ||
        current === 'superseded' ||
        current === 'suspended'
      ) {
        return current
      }
      return 'failed_terminal'
  }
}

function parseMode(rawMode: string | undefined): OutboxMode {
  const mode = rawMode?.trim() || 'off'
  if (mode !== 'off' && mode !== 'shadow' && mode !== 'active') {
    throw new Error('OUTBOX_MODE must be off, shadow, or active')
  }
  return mode
}

function parsePercent(rawPercent: string | undefined): number {
  if (rawPercent === undefined || rawPercent.trim() === '') return 0
  const percent = Number(rawPercent)
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error('OUTBOX_CANARY_PERCENT must be between 0 and 100')
  }
  return percent
}

export function parseOutboxConfig(
  env: Record<string, string | undefined>,
  options: { source?: OutboxSource } = {},
): OutboxRolloutConfig {
  const mode = parseMode(env.OUTBOX_MODE)
  const generation = env.OUTBOX_GENERATION?.trim() || null
  const source = options.source ?? 'bot'
  const inboundWorkEnabled = env.INBOUND_WORK_ENABLED?.trim() === 'true'

  if (mode !== 'off' && generation === null) {
    throw new Error('OUTBOX_GENERATION is required in shadow or active mode')
  }
  if (mode !== 'off' && source === 'bot' && !inboundWorkEnabled) {
    throw new Error(
      'INBOUND_WORK_ENABLED must be true for shadow or active bot outbox',
    )
  }

  return {
    mode,
    generation,
    canaryPhones: new Set(
      (env.OUTBOX_CANARY_PHONES ?? '')
        .split(',')
        .map((phone) => phone.trim())
        .filter(Boolean)
        .map(normalizeRecipientIdentity),
    ),
    canaryPercent: parsePercent(env.OUTBOX_CANARY_PERCENT),
    inboundWorkEnabled,
    source,
  }
}

function recipientBucket(recipient: string): number {
  const prefix = createHash('sha256')
    .update(recipient)
    .digest('hex')
    .slice(0, 8)
  return (Number.parseInt(prefix, 16) / 0x1_0000_0000) * 100
}

export function isRecipientSelected(
  config: OutboxRolloutConfig,
  recipient: string,
): boolean {
  if (config.mode !== 'active') return false
  const identity = normalizeRecipientIdentity(recipient)
  if (config.canaryPhones.has(identity)) return true
  if (config.canaryPercent <= 0) return false
  if (config.canaryPercent >= 100) return true
  return recipientBucket(identity) < config.canaryPercent
}
