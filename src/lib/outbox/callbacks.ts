import type { SupabaseClient } from '@supabase/supabase-js'
import {
  applyOutboxCallback,
  type ApplyCallbackResult,
  type OutboxRepositoryFailure,
} from './repository'
import type { MetaCallbackStatus } from './types'

interface CallbackError {
  code?: number
  subcode?: number
  title?: string
  message?: string
  details?: string
  errorData?: { details?: string }
}

export interface OutboxCallbackEvent {
  providerMessageId: string
  status: string
  timestamp: number
  opaqueCallbackData?: string
  recipientId?: string
  phoneNumberId?: string
  businessAccountId?: string
  /** Compatibility for older internal fixtures. */
  wabaId?: string
  errors?: CallbackError[]
  rawStatus?: string | Record<string, unknown>
  payload?: Record<string, unknown>
}

export interface OutboxCallbackIncident {
  code:
    | 'outbox_callback_invalid_correlation'
    | 'outbox_callback_orphaned'
    | 'outbox_callback_failed'
  providerMessageId: string
  outboxId?: string | null
  message?: string | null
}

export interface OutboxCallbackDependencies {
  applyCallback: typeof applyOutboxCallback
  reportCritical: (
    incident: OutboxCallbackIncident,
  ) => void | Promise<void>
}

export type ProjectOutboxCallbackResult =
  | { ok: true; result: Extract<ApplyCallbackResult, { ok: true }> }
  | OutboxRepositoryFailure

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function defaultDependencies(): OutboxCallbackDependencies {
  return {
    applyCallback: applyOutboxCallback,
    reportCritical: (incident) => {
      console.error('[outbox] callback incident:', incident)
    },
  }
}

function callbackStatus(status: string): MetaCallbackStatus {
  return status === 'sent' ||
    status === 'delivered' ||
    status === 'read' ||
    status === 'failed'
    ? status
    : 'unknown'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function callbackPayload(event: OutboxCallbackEvent): Record<string, unknown> {
  const raw = event.payload ?? (
    event.rawStatus && typeof event.rawStatus === 'object'
      ? event.rawStatus
      : {}
  )
  const rawStatus = typeof event.rawStatus === 'string'
    ? event.rawStatus
    : event.status
  const businessAccountId = event.businessAccountId ?? event.wabaId
  return {
    ...raw,
    raw_status: rawStatus,
    ...(event.phoneNumberId
      ? { phone_number_id: event.phoneNumberId }
      : {}),
    ...(businessAccountId
      ? { business_account_id: businessAccountId }
      : {}),
    ...(event.recipientId
      ? { recipient_id: event.recipientId }
      : {}),
  }
}

async function report(
  dependencies: OutboxCallbackDependencies,
  incident: OutboxCallbackIncident,
): Promise<void> {
  try {
    await dependencies.reportCritical(incident)
  } catch (error) {
    console.error('[outbox] callback reporter failed:', errorMessage(error))
  }
}

export async function projectOutboxCallback(
  supabase: SupabaseClient,
  event: OutboxCallbackEvent,
  dependencies: OutboxCallbackDependencies = defaultDependencies(),
): Promise<ProjectOutboxCallbackResult> {
  const eventDate = new Date(event.timestamp * 1000)
  if (
    !Number.isSafeInteger(event.timestamp) ||
    event.timestamp < 0 ||
    !Number.isFinite(eventDate.getTime())
  ) {
    return {
      ok: false,
      error: { message: 'Invalid outbox callback timestamp' },
    }
  }

  const opaque = event.opaqueCallbackData?.trim()
  const outboxId = opaque && UUID_PATTERN.test(opaque) ? opaque : null
  if (opaque && !outboxId) {
    await report(dependencies, {
      code: 'outbox_callback_invalid_correlation',
      providerMessageId: event.providerMessageId,
      message: 'biz_opaque_callback_data is not a valid outbox UUID',
    })
  }

  const firstError = event.errors?.[0]
  const normalizedError = firstError?.details ??
    firstError?.errorData?.details ??
    firstError?.message ??
    firstError?.title ??
    null

  let result: ApplyCallbackResult
  try {
    result = await dependencies.applyCallback(supabase, {
      outboxId,
      providerMessageId: event.providerMessageId,
      callbackStatus: callbackStatus(event.status),
      eventAt: eventDate.toISOString(),
      metaCode: firstError?.code ?? null,
      metaSubcode: firstError?.subcode ?? null,
      errorMessage: normalizedError,
      payload: callbackPayload(event),
    })
  } catch (error) {
    return {
      ok: false,
      error: { message: errorMessage(error) },
    }
  }

  if (!result.ok) return result

  if (result.orphaned) {
    await report(dependencies, {
      code: 'outbox_callback_orphaned',
      providerMessageId: event.providerMessageId,
      outboxId: result.outboxId,
      message: 'Callback was durably recorded without a current outbox match',
    })
  }

  if (
    event.status === 'failed' &&
    result.applied &&
    result.status === 'failed_terminal' &&
    result.previousStatus !== 'failed_terminal'
  ) {
    await report(dependencies, {
      code: 'outbox_callback_failed',
      providerMessageId: event.providerMessageId,
      outboxId: result.outboxId,
      message: normalizedError,
    })
  }

  return { ok: true, result }
}
