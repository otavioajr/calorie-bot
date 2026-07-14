import type { SupabaseClient } from '@supabase/supabase-js'
import { evaluateInboundTtl } from '@/lib/bot/inbound-freshness'
import { fromDB } from '@/lib/db/utils'
import {
  handleIncomingMessage,
  handleIncomingAudio,
  handleIncomingImage,
  handleUnsupportedMessage,
} from '@/lib/bot/handler'
import type { InboundPayload } from '@/lib/db/queries/inbound-work'
import {
  claimInboundWork,
  completeInboundWork,
  failureStatusForAttempt,
  hasNewerInboundWork,
  type InboundWorkStatus,
} from '@/lib/db/queries/inbound-work'
import { getActiveContextResult } from '@/lib/db/queries/context'
import { findUserByPhone } from '@/lib/db/queries/users'
import { finalizeOutboxScope } from '@/lib/outbox/repository'
import {
  runWithOutboxScope,
  type OutboxScopeSummary,
} from '@/lib/outbox/scope'
import { isRecipientSelected, parseOutboxConfig } from '@/lib/outbox/policy'

export type InboundProcessOutcome =
  | 'committed'
  | 'skipped'
  | 'failed_retryable'
  | 'failed_terminal'

async function dispatchInboundPayload(payload: InboundPayload): Promise<void> {
  if (payload.type === 'text') {
    await handleIncomingMessage(
      payload.from,
      payload.messageId,
      payload.text ?? '',
      payload.quotedMessageId,
    )
    return
  }

  if (payload.type === 'audio') {
    if (payload.audioId) {
      await handleIncomingAudio(
        payload.from,
        payload.messageId,
        payload.audioId,
        payload.quotedMessageId,
      )
    } else {
      await handleUnsupportedMessage(payload.from, 'audio')
    }
    return
  }

  if (payload.type === 'image') {
    if (payload.imageId) {
      await handleIncomingImage(
        payload.from,
        payload.messageId,
        payload.imageId,
        payload.caption,
        payload.quotedMessageId,
      )
    } else {
      await handleUnsupportedMessage(payload.from, 'image')
    }
    return
  }

  await handleUnsupportedMessage(payload.from, payload.rawType ?? 'unknown')
}

export type ProcessInboundWorkOptions = {
  /** Default true. Webhook inline must pass false (Task 4). */
  freshnessGate?: boolean
}

export async function processInboundWork(
  supabase: SupabaseClient,
  work: { workId: string; payload: InboundPayload; status?: InboundWorkStatus },
  leaseOwner: string,
  options: ProcessInboundWorkOptions = {},
): Promise<InboundProcessOutcome> {
  const outboxConfig = parseOutboxConfig(process.env, { source: 'bot' })
  const requiresDurableTerminal = isRecipientSelected(
    outboxConfig,
    work.payload.from,
  )
  const claim = await claimInboundWork(supabase, work.workId, leaseOwner)
  if (!claim.claimed) {
    return 'skipped'
  }

  if (options.freshnessGate ?? true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: meta, error: metaError } = await (supabase as any)
      .from('inbound_work')
      .select('received_at, created_at, user_phone')
      .eq('id', work.workId)
      .single()

    if (metaError || !meta) {
      console.error('[inbound-processor] freshness meta load failed for', work.workId, metaError?.message)
      const completed = await completeInboundWork(
        supabase,
        work.workId,
        leaseOwner,
        'failed_retryable',
        'freshness_meta_error',
        metaError?.message ?? 'missing_meta',
      )
      if (!completed.completed) {
        console.error('[inbound-processor] complete freshness_meta_error failed for', work.workId)
        return 'failed_retryable'
      }
      return 'failed_retryable'
    }

    const metaRow = fromDB<{ receivedAt: string; createdAt: string; userPhone: string | null }>(meta)

    const ttl = evaluateInboundTtl(new Date(metaRow.receivedAt))
    if (!ttl.ok) {
      const completed = await completeInboundWork(
        supabase,
        work.workId,
        leaseOwner,
        'failed_terminal',
        ttl.errorCode,
        `received_at ${metaRow.receivedAt} exceeded TTL`,
      )
      if (!completed.completed) {
        console.error('[inbound-processor] complete stale_expired failed for', work.workId)
        return 'failed_retryable'
      }
      return 'failed_terminal'
    }

    const newerResult = await hasNewerInboundWork(supabase, {
      workId: work.workId,
      userPhone: metaRow.userPhone,
      receivedAt: metaRow.receivedAt,
      createdAt: metaRow.createdAt,
    })
    if (newerResult.status === 'newer') {
      const completed = await completeInboundWork(
        supabase,
        work.workId,
        leaseOwner,
        'failed_terminal',
        'superseded',
        'newer inbound_work exists for same phone',
      )
      if (!completed.completed) {
        console.error('[inbound-processor] complete superseded failed for', work.workId)
        return 'failed_retryable'
      }
      return 'failed_terminal'
    }
    if (newerResult.status === 'error') {
      const completed = await completeInboundWork(
        supabase,
        work.workId,
        leaseOwner,
        'failed_retryable',
        'has_newer_lookup_error',
        newerResult.message,
      )
      if (!completed.completed) {
        console.error('[inbound-processor] complete has_newer_lookup_error failed for', work.workId)
        return 'failed_retryable'
      }
      return 'failed_retryable'
    }
  }

  try {
    const existingUser = await findUserByPhone(supabase, work.payload.from)
    const { summary } = await runWithOutboxScope(
      {
        workId: work.workId,
        recipient: work.payload.from,
        userId: existingUser?.id ?? null,
        beforeUnsafeFallback: async (incident) => {
          const completed = await completeInboundWork(
            supabase,
            work.workId,
            leaseOwner,
            'committed',
            'outbox_enqueue_fallback',
            incident.error.message,
          )
          if (!completed.completed) {
            throw new Error('Could not durably fence inbound replay before direct fallback')
          }
        },
      },
      () => dispatchInboundPayload(work.payload),
    )

    if (summary.idempotencyConflict) {
      return completeInboundConflict(
        supabase,
        work.workId,
        leaseOwner,
        summary.conflictError,
      )
    }

    if (summary.unsafeFallbackFenced) {
      return finalizeFencedDurableInboundResponse(
        supabase,
        work.workId,
        leaseOwner,
        summary,
      )
    }

    if (outboxConfig.mode === 'shadow') {
      await finalizeDurableInboundResponse(
        supabase,
        work.workId,
        leaseOwner,
        summary,
        false,
      )
    } else if (requiresDurableTerminal) {
      const durableOutcome = await finalizeDurableInboundResponse(
        supabase,
        work.workId,
        leaseOwner,
        summary,
        true,
      )
      if (durableOutcome) return durableOutcome
    }

    const completed = await completeInboundWork(supabase, work.workId, leaseOwner, 'committed')
    if (!completed.completed) {
      console.error('[inbound-processor] complete committed failed for', work.workId)
      return 'failed_retryable'
    }
    return 'committed'
  } catch (err) {
    const scopeSummary = scopeSummaryFromError(err)
    if (scopeSummary?.idempotencyConflict) {
      return completeInboundConflict(
        supabase,
        work.workId,
        leaseOwner,
        scopeSummary.conflictError,
      )
    }
    if (scopeSummary?.unsafeFallbackFenced) {
      return finalizeFencedDurableInboundResponse(
        supabase,
        work.workId,
        leaseOwner,
        scopeSummary,
      )
    }
    const message = err instanceof Error ? err.message : 'unknown_error'
    console.error('[inbound-processor] processing failed for', work.workId, message)
    const failureStatus = failureStatusForAttempt(claim.attempt)
    await completeInboundWork(
      supabase,
      work.workId,
      leaseOwner,
      failureStatus,
      'handler_error',
      message,
    )
    return failureStatus
  }
}

async function completeInboundConflict(
  supabase: SupabaseClient,
  workId: string,
  leaseOwner: string,
  message: string | null,
): Promise<InboundProcessOutcome> {
  console.error('[outbox] critical incident:', {
    code: 'outbox_idempotency_conflict',
    workId,
    message,
  })
  const completed = await completeInboundWork(
    supabase,
    workId,
    leaseOwner,
    'failed_terminal',
    'outbox_idempotency_conflict',
    message ?? 'Inbound emission key was reused with different immutable content',
  )
  return completed.completed ? 'failed_terminal' : 'failed_retryable'
}

function scopeSummaryFromError(error: unknown): OutboxScopeSummary | null {
  if (!error || typeof error !== 'object' || !('summary' in error)) return null
  const summary = (error as { summary?: unknown }).summary
  if (!summary || typeof summary !== 'object') return null
  return summary as OutboxScopeSummary
}

async function finalizeFencedDurableInboundResponse(
  supabase: SupabaseClient,
  workId: string,
  leaseOwner: string,
  summary: OutboxScopeSummary,
): Promise<InboundProcessOutcome> {
  if (summary.hasDurableTerminal) {
    await finalizeDurableInboundResponse(
      supabase,
      workId,
      leaseOwner,
      summary,
      false,
    )
  }
  return 'committed'
}

async function finalizeDurableInboundResponse(
  supabase: SupabaseClient,
  workId: string,
  leaseOwner: string,
  summary: OutboxScopeSummary,
  enforce: boolean,
): Promise<InboundProcessOutcome | null> {
  if (!summary.lastNonProgressOutboxId) {
    console.error('[outbox] critical incident:', {
      code: 'missing_terminal_outbox',
      workId,
      hasProgress: summary.hasProgress,
    })
    if (!enforce) return null
    const completed = await completeInboundWork(
      supabase,
      workId,
      leaseOwner,
      'failed_terminal',
      'missing_terminal_outbox',
      summary.hasProgress
        ? 'Handler completed after progress without a durable prompt or terminal response'
        : 'Handler completed without a durable prompt or terminal response',
    )
    return completed.completed ? 'failed_terminal' : 'failed_retryable'
  }

  const contextResult = summary.userId
    ? await getActiveContextResult(supabase, summary.userId)
    : { ok: true as const, context: null }
  if (!contextResult.ok) {
    const expiresAt = new Date().toISOString()
    const expired = await finalizeOutboxScope(supabase, {
      workId,
      lastOutboxId: summary.lastNonProgressOutboxId,
      messageKind: 'terminal',
      expiresAt,
    })
    const expirationConfirmed = expired.ok && expired.finalized
    const message = expirationConfirmed
      ? `Active context lookup failed: ${contextResult.error.message}`
      : `Active context lookup failed and the scoped row remains quarantined: ${contextResult.error.message}`
    console.error('[outbox] critical incident:', {
      code: 'outbox_context_lookup_failed',
      workId,
      outboxId: summary.lastNonProgressOutboxId,
      message,
      outboxExpired: expirationConfirmed,
      outboxQuarantined: !expirationConfirmed,
    })
    if (!enforce) return null
    const completed = await completeInboundWork(
      supabase,
      workId,
      leaseOwner,
      'failed_terminal',
      'outbox_context_lookup_failed',
      message,
    )
    return completed.completed ? 'failed_terminal' : 'failed_retryable'
  }

  const context = contextResult.context
  const isPrompt = context !== null && context.contextType !== 'recent_meal'
  const messageKind = isPrompt ? 'prompt' : 'terminal'
  const expiresAt = isPrompt
    ? context.expiresAt
    : new Date(Date.now() + 15 * 60_000).toISOString()
  const finalized = await finalizeOutboxScope(supabase, {
    workId,
    lastOutboxId: summary.lastNonProgressOutboxId,
    messageKind,
    expiresAt,
  })

  if (!finalized.ok || !finalized.finalized) {
    const message = finalized.ok
      ? 'finalize_outbox_scope did not find the durable terminal row'
      : finalized.error.message
    console.error('[outbox] critical incident:', {
      code: 'outbox_scope_finalize_failed',
      workId,
      outboxId: summary.lastNonProgressOutboxId,
      message,
    })
    if (!enforce) return null
    const completed = await completeInboundWork(
      supabase,
      workId,
      leaseOwner,
      'failed_terminal',
      'outbox_scope_finalize_failed',
      message,
    )
    return completed.completed ? 'failed_terminal' : 'failed_retryable'
  }

  return null
}
