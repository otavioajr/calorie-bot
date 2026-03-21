import { createServiceRoleClient } from '@/lib/db/supabase'
import {
  getActiveContext,
  upsertContext,
  deleteContext,
  CONTEXT_TTLS,
  type ContextType,
  type ConversationContext,
} from '@/lib/db/queries/context'

// Re-export for convenience so callers can import everything from state.ts
export { CONTEXT_TTLS, type ContextType, type ConversationContext }

/**
 * Returns the active (non-expired) conversation context for a user,
 * or null if none exists or all have expired.
 */
export async function getState(userId: string): Promise<ConversationContext | null> {
  const supabase = createServiceRoleClient()
  return getActiveContext(supabase, userId)
}

/**
 * Sets the conversation context for a user with an auto-calculated TTL.
 * Any existing context is replaced (delete + insert).
 *
 * expiresAt = now + CONTEXT_TTLS[type] minutes
 */
export async function setState(
  userId: string,
  type: ContextType,
  data: Record<string, unknown>
): Promise<void> {
  const supabase = createServiceRoleClient()
  const expiresAt = new Date(Date.now() + CONTEXT_TTLS[type] * 60 * 1000)
  return upsertContext(supabase, userId, type, data, expiresAt)
}

/**
 * Clears the active context for a user.
 */
export async function clearState(userId: string): Promise<void> {
  const supabase = createServiceRoleClient()
  return deleteContext(supabase, userId)
}
