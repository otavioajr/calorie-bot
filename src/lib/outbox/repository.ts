import type { SupabaseClient } from '@supabase/supabase-js'
import { fromDB } from '@/lib/db/utils'
import {
  OUTBOX_MESSAGE_KINDS,
  OUTBOX_PROJECTION_STATES,
} from './types'
import type {
  MetaCallbackStatus,
  OutboxMessageKind,
  OutboxProjectionState,
} from './types'

export type OutboxRepositoryError = {
  message: string
  code?: string
}

export type OutboxRepositoryFailure = {
  ok: false
  error: OutboxRepositoryError
}

export type ResourceType = 'meal' | 'summary' | 'query' | 'weight'

export type EnqueueOutboxInput = {
  provider: string
  businessAccountId: string
  recipient: string
  userId: string | null
  workId: string | null
  emissionIndex: number | null
  idempotencyKey: string
  messageKind: OutboxMessageKind
  payload: Record<string, unknown>
  payloadHash: string
  replyToMessageId: string | null
  resourceType: ResourceType | null
  resourceId: string | null
  resourceMetadata: Record<string, unknown> | null
  rolloutMode: 'shadow' | 'active'
  rolloutGeneration: string
  maxAttempts: number
  expiresAt: string
}

export type EnqueueOutboxResult =
  | {
      ok: true
      outboxId: string
      status: OutboxProjectionState
      sequenceNo: number
      wasInserted: boolean
      idempotencyConflict: boolean
      providerMessageId: string | null
    }
  | OutboxRepositoryFailure

export type ClaimedOutboxMessage = {
  outboxId: string
  recipient: string
  messageKind: OutboxMessageKind
  payload: Record<string, unknown>
  payloadHash: string
  replyToMessageId: string | null
  sequenceNo: number
  attempt: number
  maxAttempts: number
  expiresAt: string
  leaseToken: string
  userId: string | null
  workId: string | null
  resourceType: ResourceType | null
  resourceId: string | null
  resourceMetadata: Record<string, unknown> | null
}

export type ClaimOutboxResult =
  | { ok: true; rows: ClaimedOutboxMessage[] }
  | OutboxRepositoryFailure

export type FenceOutboxFallbackInput = {
  provider: string
  businessAccountId: string
  recipient: string
  idempotencyKey: string
  payloadHash: string
  rolloutGeneration: string
  reason?: string
}

export type FenceOutboxFallbackResult =
  | {
      ok: true
      safeForDirect: boolean
      outboxId: string | null
      status: OutboxProjectionState | null
      providerMessageId: string | null
      idempotencyConflict: boolean
    }
  | OutboxRepositoryFailure

export type BeginOutboxFallbackAttemptResult =
  | {
      ok: true
      started: boolean
      leaseToken: string | null
      status: OutboxProjectionState | null
      attempt: number | null
    }
  | OutboxRepositoryFailure

type RecordAttemptBase = {
  outboxId: string
  leaseToken: string | null
  nextAttemptAt?: string | null
  httpStatus?: number | null
  metaCode?: number | null
  metaSubcode?: number | null
  errorCode?: string | null
  errorMessage?: string | null
  response?: Record<string, unknown> | null
}

export type RecordAttemptInput = RecordAttemptBase & (
  | {
      outcome: 'api_accepted'
      providerMessageId: string
    }
  | {
      outcome: 'retryable' | 'failed_terminal' | 'unknown'
      providerMessageId?: string | null
    }
)

export type RecordAttemptResult =
  | {
      ok: true
      applied: boolean
      status: OutboxProjectionState | null
      attempt: number | null
      providerMessageId: string | null
    }
  | OutboxRepositoryFailure

export type ApplyCallbackInput = {
  providerMessageId: string
  callbackStatus: MetaCallbackStatus
  eventAt: string
  outboxId?: string | null
  metaCode?: number | null
  metaSubcode?: number | null
  errorMessage?: string | null
  payload?: Record<string, unknown> | null
}

export type ApplyCallbackResult =
  | {
      ok: true
      applied: boolean
      outboxId: string | null
      previousStatus: OutboxProjectionState | null
      status: OutboxProjectionState | null
      orphaned: boolean
    }
  | OutboxRepositoryFailure

export type FinalizeOutboxScopeResult =
  | {
      ok: true
      finalized: boolean
      responseCount: number
      status: OutboxProjectionState | null
    }
  | OutboxRepositoryFailure

export type SweeperWorkRow = {
  outboxId: string
  status: OutboxProjectionState
  recipient: string
  sequenceNo: number
  attempt: number
  nextAttemptAt: string | null
  expiresAt: string
}

type RpcError = { message?: string; code?: string } | null

const projectionStates = new Set<string>(OUTBOX_PROJECTION_STATES)
const messageKinds = new Set<string>(OUTBOX_MESSAGE_KINDS)

function isProjectionState(value: unknown): value is OutboxProjectionState {
  return typeof value === 'string' && projectionStates.has(value)
}

function isNullableProjectionState(
  value: unknown,
): value is OutboxProjectionState | null {
  return value === null || isProjectionState(value)
}

function isMessageKind(value: unknown): value is OutboxMessageKind {
  return typeof value === 'string' && messageKinds.has(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNullableRecord(
  value: unknown,
): value is Record<string, unknown> | null {
  return value === null || isRecord(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function asInteger(value: unknown, minimum: number): number | null {
  if (
    !(
      typeof value === 'number' ||
      (typeof value === 'string' && value.trim().length > 0)
    )
  ) {
    return null
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null
}

function isResourceType(value: unknown): value is ResourceType | null {
  return (
    value === null ||
    value === 'meal' ||
    value === 'summary' ||
    value === 'query' ||
    value === 'weight'
  )
}

function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  )
}

function repositoryError(
  error: RpcError,
  fallback: string,
): OutboxRepositoryFailure {
  return {
    ok: false,
    error: {
      message: error?.message ?? fallback,
      ...(error?.code ? { code: error.code } : {}),
    },
  }
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    const row = data[0]
    return isRecord(row) ? row : null
  }
  return isRecord(data) ? data : null
}

export async function enqueueOutboxMessage(
  supabase: SupabaseClient,
  input: EnqueueOutboxInput,
): Promise<EnqueueOutboxResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'enqueue_outbox_message',
    {
      p_provider: input.provider,
      p_business_account_id: input.businessAccountId,
      p_recipient: input.recipient,
      p_user_id: input.userId,
      p_work_id: input.workId,
      p_emission_index: input.emissionIndex,
      p_idempotency_key: input.idempotencyKey,
      p_message_kind: input.messageKind,
      p_payload_json: input.payload,
      p_payload_hash: input.payloadHash,
      p_reply_to_message_id: input.replyToMessageId,
      p_resource_type: input.resourceType,
      p_resource_id: input.resourceId,
      p_resource_metadata: input.resourceMetadata,
      p_rollout_mode: input.rolloutMode,
      p_rollout_generation: input.rolloutGeneration,
      p_max_attempts: input.maxAttempts,
      p_expires_at: input.expiresAt,
    },
  )
  if (error) return repositoryError(error, 'enqueue_outbox_message failed')

  const raw = firstRow(data)
  if (!raw) return repositoryError(null, 'enqueue_outbox_message returned no row')
  const row = fromDB<{
    outboxId: string
    status: OutboxProjectionState
    sequenceNo: number
    wasInserted: boolean
    idempotencyConflict: boolean
    providerMessageId: string | null
  }>(raw)

  const sequenceNo = asInteger(row.sequenceNo, 1)
  if (
    !isNonEmptyString(row.outboxId) ||
    !isProjectionState(row.status) ||
    sequenceNo === null ||
    typeof row.wasInserted !== 'boolean' ||
    typeof row.idempotencyConflict !== 'boolean' ||
    !isNullableString(row.providerMessageId)
  ) {
    return repositoryError(null, 'enqueue_outbox_message returned an invalid row')
  }

  return {
    ok: true,
    outboxId: row.outboxId,
    status: row.status,
    sequenceNo,
    wasInserted: row.wasInserted,
    idempotencyConflict: row.idempotencyConflict,
    providerMessageId: row.providerMessageId ?? null,
  }
}

export async function claimOutboxMessages(
  supabase: SupabaseClient,
  owner: string,
  generation: string,
  options: {
    limit?: number
    leaseSeconds?: number
    outboxId?: string | null
    allowUnfinalized?: boolean
  } = {},
): Promise<ClaimOutboxResult> {
  const limit = options.limit === undefined ? 5 : options.limit
  const leaseSeconds =
    options.leaseSeconds === undefined ? 90 : options.leaseSeconds
  if (
    !isNonEmptyString(owner) ||
    !isNonEmptyString(generation) ||
    !isBoundedInteger(limit, 0, 100) ||
    !isBoundedInteger(leaseSeconds, 1, 900) ||
    (options.allowUnfinalized !== undefined &&
      typeof options.allowUnfinalized !== 'boolean')
  ) {
    return repositoryError(null, 'invalid outbox claim input')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'claim_outbox_messages',
    {
      p_owner: owner,
      p_generation: generation,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
      p_outbox_id: options.outboxId ?? null,
      p_allow_unfinalized: options.allowUnfinalized ?? false,
    },
  )
  if (error) return repositoryError(error, 'claim_outbox_messages failed')
  if (!Array.isArray(data)) {
    return repositoryError(null, 'claim_outbox_messages returned invalid data')
  }

  const rows = data.map((raw) => {
    if (!isRecord(raw)) return null
    const row = fromDB<{
      outboxId: string
      recipient: string
      messageKind: OutboxMessageKind
      payloadJson: Record<string, unknown>
      payloadHash: string
      replyToMessageId: string | null
      sequenceNo: number
      attempt: number
      maxAttempts: number
      expiresAt: string
      leaseToken: string
      userId: string | null
      workId: string | null
      resourceType: ResourceType | null
      resourceId: string | null
      resourceMetadata: Record<string, unknown> | null
    }>(raw as Record<string, unknown>)

    const sequenceNo = asInteger(row.sequenceNo, 1)
    const attempt = asInteger(row.attempt, 1)
    const maxAttempts = asInteger(row.maxAttempts, 1)
    if (
      !isNonEmptyString(row.outboxId) ||
      !isNonEmptyString(row.recipient) ||
      !isMessageKind(row.messageKind) ||
      !isRecord(row.payloadJson) ||
      !isNonEmptyString(row.payloadHash) ||
      !isNullableString(row.replyToMessageId) ||
      sequenceNo === null ||
      attempt === null ||
      maxAttempts === null ||
      attempt > maxAttempts ||
      !isNonEmptyString(row.expiresAt) ||
      !isNonEmptyString(row.leaseToken) ||
      !isNullableString(row.userId) ||
      !isNullableString(row.workId) ||
      !isResourceType(row.resourceType) ||
      !isNullableString(row.resourceId) ||
      !isNullableRecord(row.resourceMetadata)
    ) {
      return null
    }

    return {
      outboxId: row.outboxId,
      recipient: row.recipient,
      messageKind: row.messageKind,
      payload: row.payloadJson,
      payloadHash: row.payloadHash,
      replyToMessageId: row.replyToMessageId ?? null,
      sequenceNo,
      attempt,
      maxAttempts,
      expiresAt: row.expiresAt,
      leaseToken: row.leaseToken,
      userId: row.userId ?? null,
      workId: row.workId ?? null,
      resourceType: row.resourceType ?? null,
      resourceId: row.resourceId ?? null,
      resourceMetadata: row.resourceMetadata ?? null,
    }
  })

  if (rows.some((row) => row === null)) {
    return repositoryError(null, 'claim_outbox_messages returned an invalid row')
  }

  return { ok: true, rows: rows as ClaimedOutboxMessage[] }
}

export async function fenceOutboxFallback(
  supabase: SupabaseClient,
  input: FenceOutboxFallbackInput,
): Promise<FenceOutboxFallbackResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'fence_outbox_fallback',
    {
      p_provider: input.provider,
      p_business_account_id: input.businessAccountId,
      p_recipient: input.recipient,
      p_idempotency_key: input.idempotencyKey,
      p_payload_hash: input.payloadHash,
      p_rollout_generation: input.rolloutGeneration,
      p_reason: input.reason ?? 'ambiguous_enqueue_result',
    },
  )
  if (error) return repositoryError(error, 'fence_outbox_fallback failed')

  const raw = firstRow(data)
  if (!raw) return repositoryError(null, 'fence_outbox_fallback returned no row')
  const row = fromDB<{
    safeForDirect: boolean
    outboxId: string | null
    status: OutboxProjectionState | null
    providerMessageId: string | null
    idempotencyConflict: boolean
  }>(raw)
  if (
    typeof row.safeForDirect !== 'boolean' ||
    !isNullableString(row.outboxId) ||
    !isNullableProjectionState(row.status) ||
    !isNullableString(row.providerMessageId) ||
    typeof row.idempotencyConflict !== 'boolean'
  ) {
    return repositoryError(null, 'fence_outbox_fallback returned an invalid row')
  }

  return {
    ok: true,
    safeForDirect: row.safeForDirect,
    outboxId: row.outboxId ?? null,
    status: row.status ?? null,
    providerMessageId: row.providerMessageId ?? null,
    idempotencyConflict: row.idempotencyConflict,
  }
}

export async function beginOutboxFallbackAttempt(
  supabase: SupabaseClient,
  input: {
    outboxId: string
    idempotencyKey: string
    leaseSeconds?: number
  },
): Promise<BeginOutboxFallbackAttemptResult> {
  const leaseSeconds = input.leaseSeconds ?? 90
  if (!isBoundedInteger(leaseSeconds, 1, 900)) {
    return repositoryError(null, 'invalid fallback attempt lease')
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'begin_outbox_fallback_attempt',
    {
      p_outbox_id: input.outboxId,
      p_idempotency_key: input.idempotencyKey,
      p_lease_seconds: leaseSeconds,
    },
  )
  if (error) {
    return repositoryError(error, 'begin_outbox_fallback_attempt failed')
  }

  const raw = firstRow(data)
  if (!raw) {
    return repositoryError(null, 'begin_outbox_fallback_attempt returned no row')
  }
  const row = fromDB<{
    started: boolean
    leaseToken: string | null
    status: OutboxProjectionState | null
    attempt: number | null
  }>(raw)
  const attempt = row.attempt === null ? null : asInteger(row.attempt, 0)
  if (
    typeof row.started !== 'boolean' ||
    !isNullableString(row.leaseToken) ||
    !isNullableProjectionState(row.status) ||
    (row.attempt !== null && attempt === null) ||
    (row.started && !isNonEmptyString(row.leaseToken))
  ) {
    return repositoryError(
      null,
      'begin_outbox_fallback_attempt returned an invalid row',
    )
  }
  return {
    ok: true,
    started: row.started,
    leaseToken: row.leaseToken ?? null,
    status: row.status ?? null,
    attempt,
  }
}

export async function recordOutboxAttemptResult(
  supabase: SupabaseClient,
  input: RecordAttemptInput,
): Promise<RecordAttemptResult> {
  if (
    input.outcome === 'api_accepted' &&
    !isNonEmptyString(input.providerMessageId)
  ) {
    return repositoryError(null, 'api_accepted requires a provider message id')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'record_outbox_attempt_result',
    {
      p_outbox_id: input.outboxId,
      p_lease_token: input.leaseToken,
      p_outcome: input.outcome,
      p_provider_message_id: input.providerMessageId ?? null,
      p_next_attempt_at: input.nextAttemptAt ?? null,
      p_http_status: input.httpStatus ?? null,
      p_meta_code: input.metaCode ?? null,
      p_meta_subcode: input.metaSubcode ?? null,
      p_error_code: input.errorCode ?? null,
      p_error_message: input.errorMessage ?? null,
      p_response_json: input.response ?? null,
    },
  )
  if (error) {
    return repositoryError(error, 'record_outbox_attempt_result failed')
  }

  const raw = firstRow(data)
  if (!raw) {
    return repositoryError(null, 'record_outbox_attempt_result returned no row')
  }
  const row = fromDB<{
    applied: boolean
    status: OutboxProjectionState | null
    attempt: number | null
    providerMessageId: string | null
  }>(raw)

  const attempt = row.attempt === null ? null : asInteger(row.attempt, 0)
  if (
    typeof row.applied !== 'boolean' ||
    !isNullableProjectionState(row.status) ||
    (row.attempt !== null && attempt === null) ||
    !isNullableString(row.providerMessageId)
  ) {
    return repositoryError(
      null,
      'record_outbox_attempt_result returned an invalid row',
    )
  }

  return {
    ok: true,
    applied: row.applied,
    status: row.status ?? null,
    attempt,
    providerMessageId: row.providerMessageId ?? null,
  }
}

export async function applyOutboxCallback(
  supabase: SupabaseClient,
  input: ApplyCallbackInput,
): Promise<ApplyCallbackResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'apply_outbox_callback',
    {
      p_provider_message_id: input.providerMessageId,
      p_callback_status: input.callbackStatus,
      p_event_at: input.eventAt,
      p_outbox_id: input.outboxId ?? null,
      p_meta_code: input.metaCode ?? null,
      p_meta_subcode: input.metaSubcode ?? null,
      p_error_message: input.errorMessage ?? null,
      p_callback_json: input.payload ?? null,
    },
  )
  if (error) return repositoryError(error, 'apply_outbox_callback failed')

  const raw = firstRow(data)
  if (!raw) return repositoryError(null, 'apply_outbox_callback returned no row')
  const row = fromDB<{
    applied: boolean
    outboxId: string | null
    previousStatus: OutboxProjectionState | null
    status: OutboxProjectionState | null
    orphaned: boolean
  }>(raw)

  if (
    typeof row.applied !== 'boolean' ||
    !isNullableString(row.outboxId) ||
    !isNullableProjectionState(row.previousStatus) ||
    !isNullableProjectionState(row.status) ||
    typeof row.orphaned !== 'boolean'
  ) {
    return repositoryError(null, 'apply_outbox_callback returned an invalid row')
  }

  return {
    ok: true,
    applied: row.applied,
    outboxId: row.outboxId ?? null,
    previousStatus: row.previousStatus ?? null,
    status: row.status ?? null,
    orphaned: row.orphaned,
  }
}

export async function finalizeOutboxScope(
  supabase: SupabaseClient,
  input: {
    workId: string
    lastOutboxId: string
    messageKind: 'prompt' | 'terminal'
    expiresAt: string
  },
): Promise<FinalizeOutboxScopeResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'finalize_outbox_scope',
    {
      p_work_id: input.workId,
      p_last_outbox_id: input.lastOutboxId,
      p_message_kind: input.messageKind,
      p_expires_at: input.expiresAt,
    },
  )
  if (error) return repositoryError(error, 'finalize_outbox_scope failed')

  const raw = firstRow(data)
  if (!raw) return repositoryError(null, 'finalize_outbox_scope returned no row')
  const row = fromDB<{
    finalized: boolean
    responseCount: number
    status: OutboxProjectionState | null
  }>(raw)

  const responseCount = asInteger(row.responseCount, 0)
  if (
    typeof row.finalized !== 'boolean' ||
    responseCount === null ||
    !isNullableProjectionState(row.status)
  ) {
    return repositoryError(null, 'finalize_outbox_scope returned an invalid row')
  }

  return {
    ok: true,
    finalized: row.finalized,
    responseCount,
    status: row.status ?? null,
  }
}

export async function listOutboxSweeperWork(
  supabase: SupabaseClient,
  generation: string,
  limit: number = 25,
): Promise<{ ok: true; rows: SweeperWorkRow[] } | OutboxRepositoryFailure> {
  if (
    !isNonEmptyString(generation) ||
    !isBoundedInteger(limit, 0, 100)
  ) {
    return repositoryError(null, 'invalid outbox sweeper input')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'list_outbox_sweeper_work',
    { p_generation: generation, p_limit: limit },
  )
  if (error) return repositoryError(error, 'list_outbox_sweeper_work failed')
  if (!Array.isArray(data)) {
    return repositoryError(null, 'list_outbox_sweeper_work returned invalid data')
  }
  const rows = data.map((raw) => {
    if (!isRecord(raw)) return null
    const row = fromDB<SweeperWorkRow>(raw)
    const sequenceNo = asInteger(row.sequenceNo, 1)
    const attempt = asInteger(row.attempt, 0)
    if (
      !isNonEmptyString(row.outboxId) ||
      !isProjectionState(row.status) ||
      !isNonEmptyString(row.recipient) ||
      sequenceNo === null ||
      attempt === null ||
      !isNullableString(row.nextAttemptAt) ||
      !isNonEmptyString(row.expiresAt)
    ) {
      return null
    }
    return { ...row, sequenceNo, attempt }
  })
  if (rows.some((row) => row === null)) {
    return repositoryError(null, 'list_outbox_sweeper_work returned an invalid row')
  }
  return { ok: true, rows: rows as SweeperWorkRow[] }
}

export async function suspendOutboxGeneration(
  supabase: SupabaseClient,
  generation: string,
  reason: string,
): Promise<{ ok: true; suspendedCount: number } | OutboxRepositoryFailure> {
  if (!isNonEmptyString(generation)) {
    return repositoryError(null, 'generation is required')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'suspend_outbox_generation',
    { p_generation: generation, p_reason: reason },
  )
  if (error) return repositoryError(error, 'suspend_outbox_generation failed')
  const raw = firstRow(data)
  if (!raw) {
    return repositoryError(null, 'suspend_outbox_generation returned no row')
  }
  const row = fromDB<{ suspendedCount: number }>(raw)
  const suspendedCount = asInteger(row.suspendedCount, 0)
  if (suspendedCount === null) {
    return repositoryError(null, 'suspend_outbox_generation returned an invalid row')
  }
  return { ok: true, suspendedCount }
}

export async function redactOutboxPayloads(
  supabase: SupabaseClient,
  limit: number = 100,
): Promise<{ ok: true; redactedCount: number } | OutboxRepositoryFailure> {
  if (!isBoundedInteger(limit, 0, 1000)) {
    return repositoryError(null, 'invalid outbox redaction limit')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc(
    'redact_outbox_payloads',
    { p_limit: limit },
  )
  if (error) return repositoryError(error, 'redact_outbox_payloads failed')
  const raw = firstRow(data)
  if (!raw) return repositoryError(null, 'redact_outbox_payloads returned no row')
  const row = fromDB<{ redactedCount: number }>(raw)
  const redactedCount = asInteger(row.redactedCount, 0)
  if (redactedCount === null) {
    return repositoryError(null, 'redact_outbox_payloads returned an invalid row')
  }
  return { ok: true, redactedCount }
}
