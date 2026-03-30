import { SupabaseClient } from '@supabase/supabase-js'

export const CONTEXT_TTLS: Record<ContextType, number> = {
  onboarding: 1440,
  awaiting_confirmation: 5,
  awaiting_clarification: 10,
  awaiting_correction: 10,
  awaiting_weight: 5,
  awaiting_label_portions: 5,
  settings_menu: 5,
  settings_change: 5,
  awaiting_reset_confirmation: 5,
  awaiting_history_selection: 5,
}

export type ContextType =
  | 'onboarding'
  | 'awaiting_confirmation'
  | 'awaiting_clarification'
  | 'awaiting_correction'
  | 'awaiting_weight'
  | 'awaiting_label_portions'
  | 'settings_menu'
  | 'settings_change'
  | 'awaiting_reset_confirmation'
  | 'awaiting_history_selection'

export interface ConversationContext {
  id: string
  userId: string
  contextType: ContextType
  contextData: Record<string, unknown>
  expiresAt: string // ISO timestamp
  createdAt: string
}

/**
 * Get the active (non-expired) context for a user.
 * Queries rows where user_id = userId AND expires_at > NOW(),
 * ordered by created_at DESC, limited to 1.
 */
export async function getActiveContext(
  supabase: SupabaseClient,
  userId: string
): Promise<ConversationContext | null> {
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('conversation_context')
    .select('id, user_id, context_type, context_data, expires_at, created_at')
    .eq('user_id', userId)
    .gt('expires_at', now)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error || !data) {
    return null
  }

  return {
    id: data.id as string,
    userId: data.user_id as string,
    contextType: data.context_type as ContextType,
    contextData: data.context_data as Record<string, unknown>,
    expiresAt: data.expires_at as string,
    createdAt: data.created_at as string,
  }
}

/**
 * Upsert context for a user: delete any existing context, then insert the new one.
 * This ensures at most one active context per user at all times.
 */
export async function upsertContext(
  supabase: SupabaseClient,
  userId: string,
  contextType: ContextType,
  contextData: Record<string, unknown>,
  expiresAt: Date
): Promise<void> {
  const { error: deleteError } = await supabase
    .from('conversation_context')
    .delete()
    .eq('user_id', userId)

  if (deleteError) {
    throw new Error(`Failed to delete existing context: ${deleteError.message}`)
  }

  const { error: insertError } = await supabase.from('conversation_context').insert({
    user_id: userId,
    context_type: contextType,
    context_data: contextData,
    expires_at: expiresAt.toISOString(),
  })

  if (insertError) {
    throw new Error(`Failed to insert new context: ${insertError.message}`)
  }
}

/**
 * Delete all context rows for a user.
 */
export async function deleteContext(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('conversation_context')
    .delete()
    .eq('user_id', userId)

  if (error) {
    throw new Error(`Failed to delete context: ${error.message}`)
  }
}
