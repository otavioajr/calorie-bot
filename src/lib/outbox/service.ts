import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/db/supabase'
import {
  beginOutboxFallbackAttempt,
  claimOutboxMessages,
  enqueueOutboxMessage,
  fenceOutboxFallback,
  recordOutboxAttemptResult,
} from './repository'
import type {
  ClaimedOutboxMessage,
  EnqueueOutboxInput,
  ResourceType,
} from './repository'
import {
  classifySynchronousFailure,
  hashPayload,
  isRecipientSelected,
  normalizeRecipientIdentity,
  parseOutboxConfig,
  policyFor,
  retryDelayMs,
} from './policy'
import type {
  MetaSendOutcome,
  OutboxMessageKind,
  OutboxProjectionState,
  OutboxSource,
} from './types'
import { sendMetaTextMessage } from '@/lib/whatsapp/meta-client'
import type { SendMetaTextInput } from '@/lib/whatsapp/meta-client'

const INLINE_LEASE_SECONDS = 90

export class OutboxIdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutboxIdempotencyConflictError'
  }
}

export interface UnsafeFallbackIncident {
  workId: string | null
  messageKind: OutboxMessageKind
  error: { message: string; code?: string }
}

export interface SendTextMessageOptions {
  source?: OutboxSource
  messageKind: OutboxMessageKind
  idempotencyKey: string
  userId?: string | null
  workId?: string | null
  emissionIndex?: number | null
  expiresAt?: Date | string
  resourceType?: ResourceType | null
  resourceId?: string | null
  resourceMetadata?: Record<string, unknown> | null
  beforeUnsafeFallback?: (
    incident: UnsafeFallbackIncident,
  ) => Promise<void>
}

export interface OutboxTextInput {
  to: string
  text: string
  replyToMessageId?: string
  options?: SendTextMessageOptions
}

export type OutboxRoute =
  | 'direct-off'
  | 'direct-ineligible'
  | 'shadow'
  | 'active'
  | 'enqueue-fallback'

export interface OutboxSendResult {
  providerMessageId: string | null
  outboxId: string | null
  status: OutboxProjectionState | null
  route: OutboxRoute
  durablyEnqueued: boolean
  replayed: boolean
  preventInboundReplay: boolean
  attemptResultPersisted: boolean
}

export interface OutboxIncident {
  code:
    | 'outbox_idempotency_conflict'
    | 'outbox_enqueue_failed'
    | 'outbox_claim_failed'
    | 'outbox_claim_mismatch'
    | 'outbox_fallback_fence_failed'
    | 'outbox_fallback_start_failed'
    | 'outbox_attempt_result_not_persisted'
  message: string
  outboxId?: string | null
  workId?: string | null
  status?: OutboxProjectionState | null
}

export interface OutboxServiceDependencies {
  getSupabase: () => SupabaseClient
  enqueue: typeof enqueueOutboxMessage
  claim: typeof claimOutboxMessages
  fenceFallback: typeof fenceOutboxFallback
  beginFallback: typeof beginOutboxFallbackAttempt
  recordAttempt: typeof recordOutboxAttemptResult
  sendMeta: (input: SendMetaTextInput) => Promise<MetaSendOutcome>
  now: () => Date
  createOwner: () => string
  readEnv: () => Record<string, string | undefined>
  reportCritical: (incident: OutboxIncident) => void | Promise<void>
}

function defaultDependencies(): OutboxServiceDependencies {
  return {
    getSupabase: createServiceRoleClient,
    enqueue: enqueueOutboxMessage,
    claim: claimOutboxMessages,
    fenceFallback: fenceOutboxFallback,
    beginFallback: beginOutboxFallbackAttempt,
    recordAttempt: recordOutboxAttemptResult,
    sendMeta: sendMetaTextMessage,
    now: () => new Date(),
    createOwner: () => `inline:${randomUUID()}`,
    readEnv: () => process.env,
    reportCritical: (incident) => {
      console.error('[outbox] critical incident:', incident)
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function directFailure(outcome: Exclude<MetaSendOutcome, { kind: 'accepted' }>): Error {
  if (outcome.kind === 'outcome_unknown') {
    return new Error(
      `WhatsApp API outcome unknown — ${outcome.message ?? 'POST result is unknown'}`,
    )
  }
  return new Error(
    `WhatsApp API error: HTTP ${outcome.httpStatus ?? 'unknown'} — ${outcome.message ?? 'request rejected'}`,
  )
}

function directResult(
  outcome: MetaSendOutcome,
  route: 'direct-off' | 'direct-ineligible',
): OutboxSendResult {
  if (outcome.kind !== 'accepted') throw directFailure(outcome)
  return {
    providerMessageId: outcome.providerMessageId,
    outboxId: null,
    status: null,
    route,
    durablyEnqueued: false,
    replayed: false,
    preventInboundReplay: false,
    attemptResultPersisted: false,
  }
}

function durableOptions(input: OutboxTextInput): SendTextMessageOptions {
  if (!input.options) {
    throw new Error('Durable outbox delivery requires semantic message options')
  }
  if (!input.options.idempotencyKey.trim()) {
    throw new Error('Durable outbox delivery requires an idempotency key')
  }
  return input.options
}

function payloadFor(input: OutboxTextInput): Record<string, unknown> {
  return { version: 1, type: 'text', text: input.text }
}

function hashEnvelope(
  input: OutboxTextInput,
  options: SendTextMessageOptions,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    version: 1,
    messageKind: options.messageKind,
    payload,
    replyToMessageId: input.replyToMessageId ?? null,
    userId: options.userId ?? null,
    resourceType: options.resourceType ?? null,
    resourceId: options.resourceId ?? null,
    resourceMetadata: options.resourceMetadata ?? null,
  }
}

function expiresAt(
  now: Date,
  options: SendTextMessageOptions,
): string {
  const value = options.expiresAt === undefined
    ? new Date(now.getTime() + policyFor(options.messageKind).ttlMs)
    : new Date(options.expiresAt)
  if (!Number.isFinite(value.getTime()) || value.getTime() <= now.getTime()) {
    throw new Error('Outbox expiry must be a valid future date')
  }
  return value.toISOString()
}

function claimedPayload(row: ClaimedOutboxMessage): {
  text: string
} | null {
  if (
    row.payload.version !== 1 ||
    row.payload.type !== 'text' ||
    typeof row.payload.text !== 'string'
  ) {
    return null
  }
  return { text: row.payload.text }
}

function responsePayload(outcome: MetaSendOutcome): Record<string, unknown> | null {
  return outcome.response ?? null
}

function activeResult(
  row: ClaimedOutboxMessage,
  providerMessageId: string | null,
  status: OutboxProjectionState,
  attemptResultPersisted: boolean,
  replayed = false,
): OutboxSendResult {
  return {
    providerMessageId,
    outboxId: row.outboxId,
    status,
    route: 'active',
    durablyEnqueued: true,
    replayed,
    preventInboundReplay: false,
    attemptResultPersisted,
  }
}

export function createOutboxDeliveryService(
  dependencies: OutboxServiceDependencies,
) {
  async function report(incident: OutboxIncident): Promise<void> {
    try {
      await dependencies.reportCritical(incident)
    } catch (error) {
      console.error('[outbox] critical incident reporter failed:', {
        code: incident.code,
        message: errorMessage(error),
      })
    }
  }

  async function recordAttempt(
    supabase: SupabaseClient,
    input: Parameters<typeof recordOutboxAttemptResult>[1],
  ) {
    try {
      return await dependencies.recordAttempt(supabase, input)
    } catch (error) {
      return {
        ok: false as const,
        error: { message: errorMessage(error) },
      }
    }
  }

  async function persistClaimedOutcome(
    supabase: SupabaseClient,
    row: ClaimedOutboxMessage,
    outcome: MetaSendOutcome,
    replayed: boolean,
  ): Promise<OutboxSendResult> {
    let recordInput: Parameters<typeof recordOutboxAttemptResult>[1]
    let projectedStatus: OutboxProjectionState

    if (outcome.kind === 'accepted') {
      projectedStatus = 'api_accepted'
      recordInput = {
        outboxId: row.outboxId,
        leaseToken: row.leaseToken,
        outcome: 'api_accepted',
        providerMessageId: outcome.providerMessageId,
        httpStatus: outcome.httpStatus ?? null,
        response: responsePayload(outcome),
      }
    } else {
      const failure = classifySynchronousFailure(outcome)
      const delay = failure.retryable ? retryDelayMs(row.attempt) : null
      const candidateNextAttempt = delay === null
        ? null
        : new Date(dependencies.now().getTime() + delay)
      const canRetry =
        failure.retryable &&
        row.attempt < row.maxAttempts &&
        candidateNextAttempt !== null &&
        candidateNextAttempt.getTime() < new Date(row.expiresAt).getTime()
      const recordOutcome = failure.projection === 'unknown'
        ? 'unknown'
        : canRetry
          ? 'retryable'
          : 'failed_terminal'
      projectedStatus = recordOutcome
      recordInput = {
        outboxId: row.outboxId,
        leaseToken: row.leaseToken,
        outcome: recordOutcome,
        providerMessageId: null,
        nextAttemptAt: canRetry ? candidateNextAttempt?.toISOString() : null,
        httpStatus: outcome.httpStatus ?? null,
        metaCode: outcome.metaCode ?? null,
        metaSubcode: outcome.metaSubcode ?? null,
        errorCode: failure.normalizedCode,
        errorMessage: failure.message,
        response: responsePayload(outcome),
      }
    }

    const recorded = await recordAttempt(supabase, recordInput)
    if (!recorded.ok || !recorded.applied) {
      await report({
        code: 'outbox_attempt_result_not_persisted',
        message: recorded.ok
          ? 'record_outbox_attempt_result did not apply the claimed result'
          : recorded.error.message,
        outboxId: row.outboxId,
        workId: row.workId,
        status: projectedStatus,
      })
    }

    return activeResult(
      row,
      outcome.kind === 'accepted' ? outcome.providerMessageId : null,
      recorded.ok && recorded.status ? recorded.status : projectedStatus,
      recorded.ok && recorded.applied,
      replayed,
    )
  }

  async function deliverClaimed(
    supabase: SupabaseClient,
    row: ClaimedOutboxMessage,
    replayed = false,
  ): Promise<OutboxSendResult> {
    const payload = claimedPayload(row)
    if (!payload) {
      const recorded = await recordAttempt(supabase, {
        outboxId: row.outboxId,
        leaseToken: row.leaseToken,
        outcome: 'failed_terminal',
        providerMessageId: null,
        nextAttemptAt: null,
        errorCode: 'invalid_persisted_payload',
        errorMessage: 'Persisted outbox payload is not a supported text message',
      })
      if (!recorded.ok || !recorded.applied) {
        await report({
          code: 'outbox_attempt_result_not_persisted',
          message: recorded.ok
            ? 'record_outbox_attempt_result did not apply the invalid-payload result'
            : recorded.error.message,
          outboxId: row.outboxId,
          workId: row.workId,
          status: 'failed_terminal',
        })
      }
      return activeResult(
        row,
        null,
        'failed_terminal',
        recorded.ok && recorded.applied,
        replayed,
      )
    }

    let outcome: MetaSendOutcome
    try {
      outcome = await dependencies.sendMeta({
        to: row.recipient,
        text: payload.text,
        ...(row.replyToMessageId
          ? { replyToMessageId: row.replyToMessageId }
          : {}),
        bizOpaqueCallbackData: row.outboxId,
      })
    } catch (error) {
      outcome = {
        kind: 'rejected',
        message: errorMessage(error),
      }
    }

    return persistClaimedOutcome(supabase, row, outcome, replayed)
  }

  async function persistDirectOutcome(
    supabase: SupabaseClient,
    input: OutboxTextInput,
    outboxId: string,
    leaseToken: string,
    outcome: MetaSendOutcome,
    route: 'shadow' | 'enqueue-fallback',
    preventInboundReplay: boolean,
  ): Promise<OutboxSendResult> {
    let recordInput: Parameters<typeof recordOutboxAttemptResult>[1]
    let status: OutboxProjectionState
    if (outcome.kind === 'accepted') {
      status = 'api_accepted'
      recordInput = {
        outboxId,
        leaseToken,
        outcome: 'api_accepted',
        providerMessageId: outcome.providerMessageId,
        httpStatus: outcome.httpStatus ?? null,
        response: responsePayload(outcome),
      }
    } else {
      const failure = classifySynchronousFailure(outcome)
      status = failure.projection === 'unknown' ? 'unknown' : 'failed_terminal'
      recordInput = {
        outboxId,
        leaseToken,
        outcome: status,
        providerMessageId: null,
        nextAttemptAt: null,
        httpStatus: outcome.httpStatus ?? null,
        metaCode: outcome.metaCode ?? null,
        metaSubcode: outcome.metaSubcode ?? null,
        errorCode: failure.normalizedCode,
        errorMessage: failure.message,
        response: responsePayload(outcome),
      }
    }

    const recorded = await recordAttempt(supabase, recordInput)
    if (!recorded.ok || !recorded.applied) {
      await report({
        code: 'outbox_attempt_result_not_persisted',
        message: recorded.ok
          ? `record_outbox_attempt_result did not apply the ${route} result`
          : recorded.error.message,
        outboxId,
        workId: input.options?.workId ?? null,
        status,
      })
    }

    if (route === 'shadow' && outcome.kind !== 'accepted') {
      throw directFailure(outcome)
    }
    return {
      providerMessageId:
        outcome.kind === 'accepted' ? outcome.providerMessageId : null,
      outboxId,
      status: recorded.ok && recorded.status
        ? recorded.status
        : status,
      route,
      durablyEnqueued: true,
      replayed: false,
      preventInboundReplay,
      attemptResultPersisted: recorded.ok && recorded.applied,
    }
  }

  async function unsafeFallback(
    supabase: SupabaseClient,
    input: OutboxTextInput,
    options: SendTextMessageOptions,
    error: { message: string; code?: string },
    requiresInboundReplayFence: boolean,
    outboxId: string,
    mode: 'shadow' | 'active',
  ): Promise<OutboxSendResult> {
    if (options.source === 'bot' && options.messageKind === 'progress') {
      await report({
        code: 'outbox_enqueue_failed',
        message: `${error.message}; bot progress cannot use direct fallback`,
        workId: options.workId ?? null,
      })
      throw new Error(
        `Outbox enqueue failed and no durable replay fence is available for bot progress; direct fallback is disabled: ${error.message}`,
      )
    }

    if (requiresInboundReplayFence && !options.beforeUnsafeFallback) {
      await report({
        code: 'outbox_enqueue_failed',
        message: `${error.message}; no durable replay fence is available`,
        workId: options.workId ?? null,
      })
      throw new Error(
        `Outbox enqueue failed and no durable replay fence is available: ${error.message}`,
      )
    }

    if (requiresInboundReplayFence && options.beforeUnsafeFallback) {
      try {
        await options.beforeUnsafeFallback({
          workId: options.workId ?? null,
          messageKind: options.messageKind,
          error,
        })
      } catch (fenceError) {
        await report({
          code: 'outbox_enqueue_failed',
          message: `${error.message}; durable replay fence failed: ${errorMessage(fenceError)}`,
          workId: options.workId ?? null,
        })
        throw fenceError
      }
    }

    let begun
    try {
      begun = await dependencies.beginFallback(supabase, {
        outboxId,
        idempotencyKey: options.idempotencyKey,
        leaseSeconds: INLINE_LEASE_SECONDS,
      })
    } catch (beginError) {
      begun = {
        ok: false as const,
        error: { message: errorMessage(beginError) },
      }
    }
    if (
      begun.ok &&
      !begun.started &&
      begun.status === 'pending' &&
      mode === 'active'
    ) {
      await report({
        code: 'outbox_enqueue_failed',
        message: error.message,
        outboxId,
        workId: options.workId ?? null,
        status: 'pending',
      })
      return {
        providerMessageId: null,
        outboxId,
        status: 'pending',
        route: 'active',
        durablyEnqueued: true,
        replayed: true,
        preventInboundReplay: requiresInboundReplayFence,
        attemptResultPersisted: false,
      }
    }
    if (!begun.ok || !begun.started || !begun.leaseToken) {
      const message = !begun.ok
        ? begun.error.message
        : 'fallback permission was already consumed'
      await report({
        code: 'outbox_fallback_start_failed',
        message,
        outboxId,
        workId: options.workId ?? null,
        status: begun.ok ? begun.status : 'suspended',
      })
      throw new Error(`Outbox direct fallback was not started: ${message}`)
    }

    await report({
      code: 'outbox_enqueue_failed',
      message: error.message,
      workId: options.workId ?? null,
    })
    let outcome: MetaSendOutcome
    try {
      outcome = await dependencies.sendMeta({
        to: input.to,
        text: input.text,
        ...(input.replyToMessageId
          ? { replyToMessageId: input.replyToMessageId }
          : {}),
        bizOpaqueCallbackData: outboxId,
      })
    } catch (sendError) {
      outcome = { kind: 'rejected', message: errorMessage(sendError) }
    }
    return persistDirectOutcome(
      supabase,
      input,
      outboxId,
      begun.leaseToken,
      outcome,
      'enqueue-fallback',
      requiresInboundReplayFence,
    )
  }

  async function handleEnqueueFailure(
    supabase: SupabaseClient,
    input: OutboxTextInput,
    options: SendTextMessageOptions,
    enqueueInput: EnqueueOutboxInput,
    error: { message: string; code?: string },
    mode: 'shadow' | 'active',
    requiresInboundReplayFence: boolean,
  ): Promise<OutboxSendResult> {
    let fenced
    try {
      fenced = await dependencies.fenceFallback(supabase, {
        provider: enqueueInput.provider,
        businessAccountId: enqueueInput.businessAccountId,
        recipient: enqueueInput.recipient,
        idempotencyKey: enqueueInput.idempotencyKey,
        payloadHash: enqueueInput.payloadHash,
        rolloutGeneration: enqueueInput.rolloutGeneration,
        reason: 'ambiguous_enqueue_result',
      })
    } catch (fenceError) {
      fenced = {
        ok: false as const,
        error: { message: errorMessage(fenceError) },
      }
    }

    if (!fenced.ok) {
      await report({
        code: 'outbox_fallback_fence_failed',
        message: fenced.error.message,
        workId: options.workId ?? null,
      })
      throw new Error(
        `Outbox enqueue failed and its durable fallback fence could not be confirmed: ${fenced.error.message}`,
      )
    }
    if (fenced.idempotencyConflict) {
      await report({
        code: 'outbox_idempotency_conflict',
        message: 'Outbox fallback fence found conflicting immutable content',
        outboxId: fenced.outboxId,
        workId: options.workId ?? null,
        status: fenced.status,
      })
      throw new OutboxIdempotencyConflictError(
        'Outbox fallback fence found an idempotency conflict',
      )
    }
    if (!fenced.safeForDirect) {
      if (!fenced.outboxId) {
        await report({
          code: 'outbox_fallback_fence_failed',
          message: 'Fallback fence was unsafe without a durable outbox row',
          workId: options.workId ?? null,
        })
        throw new Error('Outbox fallback fence did not make direct delivery safe')
      }
      return {
        providerMessageId: fenced.providerMessageId,
        outboxId: fenced.outboxId,
        status: fenced.status,
        route: mode,
        durablyEnqueued: true,
        replayed: true,
        preventInboundReplay: false,
        attemptResultPersisted: false,
      }
    }

    let tombstone
    try {
      tombstone = await dependencies.enqueue(supabase, enqueueInput)
    } catch (tombstoneError) {
      tombstone = {
        ok: false as const,
        error: { message: errorMessage(tombstoneError) },
      }
    }
    if (
      !tombstone.ok ||
      tombstone.idempotencyConflict ||
      tombstone.status !== 'suspended'
    ) {
      const message = !tombstone.ok
        ? tombstone.error.message
        : tombstone.idempotencyConflict
          ? 'fallback tombstone has conflicting immutable content'
          : `fallback tombstone returned unsafe status ${tombstone.status}`
      await report({
        code: 'outbox_fallback_fence_failed',
        message,
        outboxId: tombstone.ok ? tombstone.outboxId : fenced.outboxId,
        workId: options.workId ?? null,
        status: tombstone.ok ? tombstone.status : fenced.status,
      })
      if (tombstone.ok && tombstone.idempotencyConflict) {
        throw new OutboxIdempotencyConflictError(
          `Outbox fallback tombstone has conflicting immutable content: ${message}`,
        )
      }
      throw new Error(`Outbox fallback tombstone could not be persisted: ${message}`)
    }

    return unsafeFallback(
      supabase,
      input,
      options,
      error,
      requiresInboundReplayFence,
      tombstone.outboxId,
      mode,
    )
  }

  async function sendText(input: OutboxTextInput): Promise<OutboxSendResult> {
    const source = input.options?.source ?? 'bot'
    const config = parseOutboxConfig(dependencies.readEnv(), { source })
    if (config.mode === 'off') {
      return directResult(await dependencies.sendMeta({
        to: input.to,
        text: input.text,
        ...(input.replyToMessageId
          ? { replyToMessageId: input.replyToMessageId }
          : {}),
      }), 'direct-off')
    }

    const recipient = normalizeRecipientIdentity(input.to)
    if (config.mode === 'active' && !isRecipientSelected(config, recipient)) {
      return directResult(await dependencies.sendMeta({
        to: recipient,
        text: input.text,
        ...(input.replyToMessageId
          ? { replyToMessageId: input.replyToMessageId }
          : {}),
      }), 'direct-ineligible')
    }

    const options = { ...durableOptions(input), source }
    const requiresInboundReplayFence =
      options.source === 'bot' && options.messageKind !== 'progress'
    const env = dependencies.readEnv()
    const businessAccountId = env.WHATSAPP_PHONE_NUMBER_ID?.trim()
    if (!businessAccountId) {
      throw new Error('WHATSAPP_PHONE_NUMBER_ID is not configured')
    }
    const generation = config.generation
    if (!generation) {
      throw new Error('OUTBOX_GENERATION is required for durable delivery')
    }
    const now = dependencies.now()
    const payload = payloadFor(input)
    const policy = policyFor(options.messageKind)
    const enqueueInput: EnqueueOutboxInput = {
      provider: 'whatsapp_cloud',
      businessAccountId,
      recipient,
      userId: options.userId ?? null,
      workId: options.workId ?? null,
      emissionIndex: options.emissionIndex ?? null,
      idempotencyKey: options.idempotencyKey,
      messageKind: options.messageKind,
      payload,
      payloadHash: hashPayload(hashEnvelope(input, options, payload)),
      replyToMessageId: input.replyToMessageId ?? null,
      resourceType: options.resourceType ?? null,
      resourceId: options.resourceId ?? null,
      resourceMetadata: options.resourceMetadata ?? null,
      rolloutMode: config.mode,
      rolloutGeneration: generation,
      maxAttempts: policy.maxAttempts,
      expiresAt: expiresAt(now, options),
    }
    const supabase = dependencies.getSupabase()
    let enqueued
    try {
      enqueued = await dependencies.enqueue(supabase, enqueueInput)
    } catch (error) {
      return handleEnqueueFailure(
        supabase,
        { ...input, to: recipient },
        options,
        enqueueInput,
        { message: errorMessage(error) },
        config.mode,
        requiresInboundReplayFence,
      )
    }
    if (!enqueued.ok) {
      return handleEnqueueFailure(
        supabase,
        { ...input, to: recipient },
        options,
        enqueueInput,
        enqueued.error,
        config.mode,
        requiresInboundReplayFence,
      )
    }

    if (enqueued.idempotencyConflict) {
      await report({
        code: 'outbox_idempotency_conflict',
        message: 'Outbox idempotency key was reused with different content',
        outboxId: enqueued.outboxId,
        workId: options.workId ?? null,
        status: enqueued.status,
      })
      throw new OutboxIdempotencyConflictError(
        'Outbox idempotency conflict; message was not sent',
      )
    }

    if (enqueued.providerMessageId) {
      return {
        providerMessageId: enqueued.providerMessageId,
        outboxId: enqueued.outboxId,
        status: enqueued.status,
        route: config.mode,
        durablyEnqueued: true,
        replayed: !enqueued.wasInserted,
        preventInboundReplay: false,
        attemptResultPersisted: false,
      }
    }

    if (config.mode === 'shadow' && !enqueued.wasInserted) {
      throw new Error(
        'Shadow outbox delivery previously failed or is unresolved; refusing replay',
      )
    }

    if (enqueued.status !== 'pending' && enqueued.status !== 'retryable') {
      return {
        providerMessageId: null,
        outboxId: enqueued.outboxId,
        status: enqueued.status,
        route: config.mode,
        durablyEnqueued: true,
        replayed: !enqueued.wasInserted,
        preventInboundReplay: false,
        attemptResultPersisted: false,
      }
    }

    if (config.mode === 'shadow') {
      let begun
      try {
        begun = await dependencies.beginFallback(supabase, {
          outboxId: enqueued.outboxId,
          idempotencyKey: options.idempotencyKey,
          leaseSeconds: INLINE_LEASE_SECONDS,
        })
      } catch (beginError) {
        begun = {
          ok: false as const,
          error: { message: errorMessage(beginError) },
        }
      }
      if (!begun.ok || !begun.started || !begun.leaseToken) {
        const message = !begun.ok
          ? begun.error.message
          : 'shadow direct delivery was not authorized'
        await report({
          code: 'outbox_fallback_start_failed',
          message,
          outboxId: enqueued.outboxId,
          workId: options.workId ?? null,
          status: begun.ok ? begun.status : enqueued.status,
        })
        throw new Error(`Outbox shadow delivery was not started: ${message}`)
      }

      let outcome: MetaSendOutcome
      try {
        outcome = await dependencies.sendMeta({
          to: recipient,
          text: input.text,
          ...(input.replyToMessageId
            ? { replyToMessageId: input.replyToMessageId }
            : {}),
          bizOpaqueCallbackData: enqueued.outboxId,
        })
      } catch (error) {
        outcome = { kind: 'rejected', message: errorMessage(error) }
      }
      return persistDirectOutcome(
        supabase,
        input,
        enqueued.outboxId,
        begun.leaseToken,
        outcome,
        'shadow',
        false,
      )
    }

    let claimed
    try {
      claimed = await dependencies.claim(
        supabase,
        dependencies.createOwner(),
        generation,
        {
          limit: 1,
          leaseSeconds: INLINE_LEASE_SECONDS,
          outboxId: enqueued.outboxId,
          allowUnfinalized: true,
        },
      )
    } catch (error) {
      claimed = {
        ok: false as const,
        error: { message: errorMessage(error) },
      }
    }
    if (!claimed.ok) {
      await report({
        code: 'outbox_claim_failed',
        message: claimed.error.message,
        outboxId: enqueued.outboxId,
        workId: options.workId ?? null,
        status: enqueued.status,
      })
      return {
        providerMessageId: null,
        outboxId: enqueued.outboxId,
        status: enqueued.status,
        route: 'active',
        durablyEnqueued: true,
        replayed: !enqueued.wasInserted,
        preventInboundReplay: false,
        attemptResultPersisted: false,
      }
    }

    const row = claimed.rows[0]
    if (!row) {
      return {
        providerMessageId: null,
        outboxId: enqueued.outboxId,
        status: enqueued.status,
        route: 'active',
        durablyEnqueued: true,
        replayed: !enqueued.wasInserted,
        preventInboundReplay: false,
        attemptResultPersisted: false,
      }
    }
    if (row.outboxId !== enqueued.outboxId) {
      await report({
        code: 'outbox_claim_mismatch',
        message: 'Targeted inline claim returned a different outbox message',
        outboxId: enqueued.outboxId,
        workId: options.workId ?? null,
        status: enqueued.status,
      })
      return {
        providerMessageId: null,
        outboxId: enqueued.outboxId,
        status: enqueued.status,
        route: 'active',
        durablyEnqueued: true,
        replayed: !enqueued.wasInserted,
        preventInboundReplay: false,
        attemptResultPersisted: false,
      }
    }
    return deliverClaimed(supabase, row, !enqueued.wasInserted)
  }

  return { sendText, deliverClaimed }
}

export async function sendTextThroughOutbox(
  input: OutboxTextInput,
): Promise<OutboxSendResult> {
  return createOutboxDeliveryService(defaultDependencies()).sendText(input)
}

/** Deliver a row already atomically claimed by the outbox sweeper. */
export async function deliverClaimedOutboxMessage(
  supabase: SupabaseClient,
  row: ClaimedOutboxMessage,
): Promise<OutboxSendResult> {
  return createOutboxDeliveryService(defaultDependencies())
    .deliverClaimed(supabase, row)
}
