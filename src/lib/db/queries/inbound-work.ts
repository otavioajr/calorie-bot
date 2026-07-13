import type { SupabaseClient } from '@supabase/supabase-js'
import { fromDB } from '@/lib/db/utils'

export const INBOUND_WORK_PROVIDER = 'whatsapp_cloud'
export const DEFAULT_LEASE_SECONDS = 90
export const MAX_INBOUND_ATTEMPTS = 5

export type InboundWorkStatus =
  | 'accepted'
  | 'processing'
  | 'committed'
  | 'failed_retryable'
  | 'failed_terminal'

export type InboundPayload = {
  type: 'text' | 'audio' | 'image' | 'unsupported'
  from: string
  messageId: string
  phoneNumberId?: string
  text?: string
  audioId?: string
  imageId?: string
  caption?: string
  quotedMessageId?: string
  rawType?: string
}

export type EnqueueInboundWorkInput = {
  provider: string
  businessAccountId: string
  providerMessageId: string
  userPhone: string
  eventAt: string | null
  payload: InboundPayload
}

export type EnqueueInboundWorkResult =
  | { ok: true; workId: string; status: InboundWorkStatus; wasInserted: boolean }
  | { ok: false }

export type ClaimInboundWorkResult = {
  claimed: boolean
  status: InboundWorkStatus | null
  attempt: number | null
}

export type CompleteInboundWorkResult = {
  completed: boolean
  status: InboundWorkStatus | null
}

export type StaleInboundWorkRow = {
  workId: string
  status: InboundWorkStatus
  attempt: number
}

type EnqueueRpcRow = {
  workId: string
  status: InboundWorkStatus
  wasInserted: boolean
}

type ClaimRpcRow = {
  claimed: boolean
  status: InboundWorkStatus | null
  attempt: number | null
}

type CompleteRpcRow = {
  completed: boolean
  status: InboundWorkStatus | null
}

type StaleRpcRow = {
  workId: string
  status: InboundWorkStatus
  attempt: number
}

export function isInboundWorkEnabled(): boolean {
  return process.env.INBOUND_WORK_ENABLED === 'true'
}

function firstRpcRow(data: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(data)) {
    const row = data[0]
    if (row && typeof row === 'object') return row as Record<string, unknown>
    return undefined
  }
  if (data && typeof data === 'object') return data as Record<string, unknown>
  return undefined
}

export async function enqueueInboundWork(
  supabase: SupabaseClient,
  input: EnqueueInboundWorkInput,
): Promise<EnqueueInboundWorkResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('enqueue_inbound_work', {
    p_provider: input.provider,
    p_business_account_id: input.businessAccountId,
    p_provider_message_id: input.providerMessageId,
    p_user_phone: input.userPhone,
    p_event_at: input.eventAt,
    p_payload_json: input.payload,
  })

  if (error) {
    console.error('[inbound-work] enqueue_inbound_work failed:', error.message)
    return { ok: false }
  }

  const raw = firstRpcRow(data)
  if (!raw) {
    console.error('[inbound-work] enqueue_inbound_work returned no row')
    return { ok: false }
  }

  const row = fromDB<EnqueueRpcRow>(raw)
  if (!row.workId) {
    console.error('[inbound-work] enqueue_inbound_work returned no row')
    return { ok: false }
  }

  return {
    ok: true,
    workId: row.workId,
    status: row.status,
    wasInserted: row.wasInserted,
  }
}

export async function claimInboundWork(
  supabase: SupabaseClient,
  workId: string,
  owner: string,
  leaseSeconds: number = DEFAULT_LEASE_SECONDS,
): Promise<ClaimInboundWorkResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('claim_inbound_work', {
    p_work_id: workId,
    p_owner: owner,
    p_lease_seconds: leaseSeconds,
  })

  if (error) {
    console.error('[inbound-work] claim_inbound_work failed:', error.message)
    return { claimed: false, status: null, attempt: null }
  }

  const raw = firstRpcRow(data)
  if (!raw) {
    return { claimed: false, status: null, attempt: null }
  }

  const row = fromDB<ClaimRpcRow>(raw)
  return {
    claimed: row.claimed ?? false,
    status: row.status ?? null,
    attempt: row.attempt ?? null,
  }
}

export async function completeInboundWork(
  supabase: SupabaseClient,
  workId: string,
  owner: string,
  status: 'committed' | 'failed_retryable' | 'failed_terminal',
  errorCode?: string | null,
  errorMessage?: string | null,
): Promise<CompleteInboundWorkResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('complete_inbound_work', {
    p_work_id: workId,
    p_owner: owner,
    p_status: status,
    p_error_code: errorCode ?? null,
    p_error_message: errorMessage ?? null,
  })

  if (error) {
    console.error('[inbound-work] complete_inbound_work failed:', error.message)
    return { completed: false, status: null }
  }

  const raw = firstRpcRow(data)
  if (!raw) {
    return { completed: false, status: null }
  }

  const row = fromDB<CompleteRpcRow>(raw)
  return {
    completed: row.completed ?? false,
    status: row.status ?? null,
  }
}

export async function listStaleInboundWork(
  supabase: SupabaseClient,
  limit: number = 5,
): Promise<StaleInboundWorkRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('list_stale_inbound_work', {
    p_limit: limit,
  })

  if (error) {
    console.error('[inbound-work] list_stale_inbound_work failed:', error.message)
    return []
  }

  if (!Array.isArray(data)) return []

  return data.map((row) => fromDB<StaleRpcRow>(row as Record<string, unknown>))
}

export function isTerminalInboundStatus(status: InboundWorkStatus): boolean {
  return status === 'committed' || status === 'failed_terminal'
}

export function shouldSkipInboundProcessing(status: InboundWorkStatus): boolean {
  return status === 'committed' || status === 'failed_terminal'
}

export function failureStatusForAttempt(attempt: number | null): 'failed_retryable' | 'failed_terminal' {
  if (attempt !== null && attempt >= MAX_INBOUND_ATTEMPTS) {
    return 'failed_terminal'
  }
  return 'failed_retryable'
}

export type HasNewerInboundWorkInput = {
  workId: string
  userPhone: string | null
  receivedAt: string
  createdAt: string
}

/**
 * True if another inbound_work for the same phone is strictly newer
 * by (received_at, created_at) lexicographic order.
 */
export async function hasNewerInboundWork(
  supabase: SupabaseClient,
  input: HasNewerInboundWorkInput,
): Promise<boolean> {
  if (!input.userPhone) return false

  const receivedAt = input.receivedAt
  const createdAt = input.createdAt

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('inbound_work')
    .select('id')
    .eq('user_phone', input.userPhone)
    .neq('id', input.workId)
    .or(
      `received_at.gt."${receivedAt}",and(received_at.eq."${receivedAt}",created_at.gt."${createdAt}")`,
    )
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[inbound-work] hasNewerInboundWork failed:', error.message)
    // Fail closed for reply: treat as superseded so we do not send a late WhatsApp
    return true
  }

  return data != null
}
