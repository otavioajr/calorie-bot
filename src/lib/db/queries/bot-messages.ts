import type { SupabaseClient } from '@supabase/supabase-js'

export type BotMessageDirection = 'incoming' | 'outgoing'
export type BotMessageResourceType = 'meal' | 'summary' | 'query' | 'weight'

export interface BotMessageInsert {
  userId: string
  messageId: string
  direction: BotMessageDirection
  resourceType?: BotMessageResourceType | null
  resourceId?: string | null
  metadata?: Record<string, unknown> | null
}

export interface BotMessageResource {
  direction: BotMessageDirection
  resourceType: BotMessageResourceType | null
  resourceId: string | null
  metadata: Record<string, unknown> | null
}

export async function saveBotMessage(
  supabase: SupabaseClient,
  data: BotMessageInsert,
): Promise<void> {
  const { error } = await supabase.from('bot_messages').insert({
    user_id: data.userId,
    message_id: data.messageId,
    direction: data.direction,
    resource_type: data.resourceType ?? null,
    resource_id: data.resourceId ?? null,
    metadata: data.metadata ?? null,
  })

  if (error) {
    console.error('[bot-messages] Failed to save:', error.message)
  }
}

export async function getMessageResource(
  supabase: SupabaseClient,
  messageId: string,
): Promise<BotMessageResource | null> {
  const { data, error } = await supabase
    .from('bot_messages')
    .select('direction, resource_type, resource_id, metadata')
    .eq('message_id', messageId)
    .limit(1)
    .single()

  if (error || !data) return null

  return {
    direction: data.direction as BotMessageDirection,
    resourceType: data.resource_type as BotMessageResourceType | null,
    resourceId: data.resource_id as string | null,
    metadata: data.metadata as Record<string, unknown> | null,
  }
}

export async function cleanupOldMessages(
  supabase: SupabaseClient,
  retentionDays: number = 30,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()

  const { error, count } = await supabase
    .from('bot_messages')
    .delete()
    .lt('created_at', cutoff)

  if (error) {
    console.error('[bot-messages] Cleanup failed:', error.message)
    return 0
  }

  return count ?? 0
}
