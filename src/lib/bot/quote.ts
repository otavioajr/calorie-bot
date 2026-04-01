import { createServiceRoleClient } from '@/lib/db/supabase'
import { getMessageResource } from '@/lib/db/queries/bot-messages'
import type { BotMessageResourceType, BotMessageDirection } from '@/lib/db/queries/bot-messages'

export interface QuoteContext {
  quotedMessageId: string
  direction: BotMessageDirection
  resourceType: BotMessageResourceType | null
  resourceId: string | null
  metadata?: Record<string, unknown>
}

export async function resolveQuote(
  quotedMessageId: string | undefined,
): Promise<QuoteContext | null> {
  if (!quotedMessageId) return null

  const supabase = createServiceRoleClient()
  const resource = await getMessageResource(supabase, quotedMessageId)

  if (!resource) return null

  return {
    quotedMessageId,
    direction: resource.direction,
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
    ...(resource.metadata ? { metadata: resource.metadata } : {}),
  }
}
