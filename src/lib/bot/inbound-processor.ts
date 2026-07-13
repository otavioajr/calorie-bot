import type { SupabaseClient } from '@supabase/supabase-js'
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

export async function processInboundWork(
  supabase: SupabaseClient,
  work: { workId: string; payload: InboundPayload; status?: InboundWorkStatus },
  leaseOwner: string,
): Promise<InboundProcessOutcome> {
  const claim = await claimInboundWork(supabase, work.workId, leaseOwner)
  if (!claim.claimed) {
    return 'skipped'
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
