import type { SupabaseClient } from '@supabase/supabase-js'
import { evaluateInboundTtl } from '@/lib/bot/inbound-freshness'
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

    const ttl = evaluateInboundTtl(new Date(meta.received_at))
    if (!ttl.ok) {
      const completed = await completeInboundWork(
        supabase,
        work.workId,
        leaseOwner,
        'failed_terminal',
        ttl.errorCode,
        `received_at ${meta.received_at} exceeded TTL`,
      )
      if (!completed.completed) {
        console.error('[inbound-processor] complete stale_expired failed for', work.workId)
        return 'failed_retryable'
      }
      return 'failed_terminal'
    }

    const superseded = await hasNewerInboundWork(supabase, {
      workId: work.workId,
      userPhone: meta.user_phone,
      receivedAt: meta.received_at,
      createdAt: meta.created_at,
    })
    if (superseded) {
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
  }

  try {
    await dispatchInboundPayload(work.payload)
    const completed = await completeInboundWork(supabase, work.workId, leaseOwner, 'committed')
    if (!completed.completed) {
      console.error('[inbound-processor] complete committed failed for', work.workId)
      return 'failed_retryable'
    }
    return 'committed'
  } catch (err) {
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
