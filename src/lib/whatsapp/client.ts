import {
  sendMetaTextMessage,
  type MetaClientOptions,
} from './meta-client'
import {
  sendTextThroughOutbox,
  type SendTextMessageOptions,
} from '@/lib/outbox/service'
import {
  createScopedSendOptions,
  recordScopedOutboxError,
  recordScopedOutboxResult,
  scheduleScopedOutboxSend,
} from '@/lib/outbox/scope'

export type { SendTextMessageOptions } from '@/lib/outbox/service'

export async function sendTextMessageDirect(
  to: string,
  text: string,
  replyToMessageId?: string,
  clientOptions?: MetaClientOptions,
): Promise<string> {
  const outcome = await sendMetaTextMessage(
    { to, text, replyToMessageId },
    clientOptions,
  )

  if (outcome.kind === 'accepted') {
    return outcome.providerMessageId
  }

  if (outcome.kind === 'outcome_unknown') {
    throw new Error(
      `WhatsApp API outcome unknown — ${outcome.message ?? 'POST result is unknown'}`,
    )
  }

  throw new Error(
    `WhatsApp API error: HTTP ${outcome.httpStatus ?? 'unknown'} — ${outcome.message ?? 'request rejected'}`,
  )
}

export async function sendTextMessage(
  to: string,
  text: string,
  replyToMessageId?: string,
  options?: SendTextMessageOptions,
): Promise<string | null> {
  const scopedOptions = options ?? createScopedSendOptions()
  return scheduleScopedOutboxSend(async () => {
    try {
      const result = await sendTextThroughOutbox({
        to,
        text,
        replyToMessageId,
        options: scopedOptions,
      })
      if (scopedOptions) recordScopedOutboxResult(scopedOptions, result)
      return result.providerMessageId
    } catch (error) {
      if (scopedOptions) recordScopedOutboxError(scopedOptions, error)
      throw error
    }
  })
}
