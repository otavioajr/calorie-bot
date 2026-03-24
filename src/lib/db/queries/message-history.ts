import type { SupabaseClient } from '@supabase/supabase-js'

export const MAX_HISTORY_MESSAGES = 10

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Get the most recent messages for a user, ordered chronologically (oldest first).
 * Queries descending to get the newest N, then reverses for chronological order.
 */
export async function getRecentMessages(
  supabase: SupabaseClient,
  userId: string,
): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from('message_history')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY_MESSAGES)

  if (error || !data) {
    return []
  }

  return (data as ChatMessage[]).reverse()
}

/**
 * Save a message to history. After inserting, prune to keep only the
 * most recent MAX_HISTORY_MESSAGES rows per user.
 */
export async function saveMessage(
  supabase: SupabaseClient,
  userId: string,
  role: 'user' | 'assistant',
  content: string,
): Promise<void> {
  await supabase.from('message_history').insert({
    user_id: userId,
    role,
    content,
  })

  // Prune: keep only the most recent MAX_HISTORY_MESSAGES
  const { data: keepRows } = await supabase
    .from('message_history')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY_MESSAGES)

  if (keepRows && keepRows.length === MAX_HISTORY_MESSAGES) {
    const keepIds = keepRows.map((r) => r.id)
    await supabase
      .from('message_history')
      .delete()
      .eq('user_id', userId)
      .not('id', 'in', `(${keepIds.join(',')})`)
  }
}

/**
 * Clear all message history for a user (used on data reset).
 */
export async function clearHistory(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  await supabase
    .from('message_history')
    .delete()
    .eq('user_id', userId)
}
