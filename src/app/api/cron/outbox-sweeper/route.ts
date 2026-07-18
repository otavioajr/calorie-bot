export const maxDuration = 60

import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { isCronAuthorized } from '@/lib/auth/cron'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { parseOutboxConfig } from '@/lib/outbox/policy'
import {
  claimOutboxMessages,
  redactOutboxPayloads,
} from '@/lib/outbox/repository'
import { deliverClaimedOutboxMessage } from '@/lib/outbox/service'

const CLAIM_LIMIT = 5
const LEASE_SECONDS = 90
const REDACTION_LIMIT = 100

async function redact(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<{ redacted: number; redactionErrors: number }> {
  try {
    const result = await redactOutboxPayloads(supabase, REDACTION_LIMIT)
    if (!result.ok) {
      console.error('[outbox-sweeper] redaction failed:', result.error.message)
      return { redacted: 0, redactionErrors: 1 }
    }
    return { redacted: result.redactedCount, redactionErrors: 0 }
  } catch (error) {
    console.error('[outbox-sweeper] redaction failed:', error)
    return { redacted: 0, redactionErrors: 1 }
  }
}

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let config
  try {
    config = parseOutboxConfig(process.env, { source: 'sweeper' })
  } catch (error) {
    console.error('[outbox-sweeper] invalid rollout configuration:', error)
    return NextResponse.json(
      { error: 'Outbox rollout configuration is invalid' },
      { status: 503 },
    )
  }

  // This permits the code-first/off rollout before the additive migration is
  // installed: off mode performs no outbox RPC at all.
  if (config.mode === 'off' && !config.generation) {
    return NextResponse.json({
      mode: 'off',
      generation: null,
      claimed: 0,
      processed: 0,
      errors: 0,
      redacted: 0,
      redactionErrors: 0,
    })
  }

  const supabase = createServiceRoleClient()
  if (config.mode === 'off') {
    const redaction = await redact(supabase)
    return NextResponse.json({
      mode: 'off',
      generation: config.generation,
      claimed: 0,
      processed: 0,
      errors: 0,
      ...redaction,
    })
  }

  if (config.mode === 'shadow') {
    const redaction = await redact(supabase)
    return NextResponse.json({
      mode: 'shadow',
      generation: config.generation,
      claimed: 0,
      processed: 0,
      errors: 0,
      ...redaction,
    })
  }

  const generation = config.generation
  if (!generation) {
    return NextResponse.json(
      { error: 'Outbox generation is required' },
      { status: 503 },
    )
  }

  let claimed
  try {
    claimed = await claimOutboxMessages(
      supabase,
      `sweeper:${randomUUID()}`,
      generation,
      { limit: CLAIM_LIMIT, leaseSeconds: LEASE_SECONDS },
    )
  } catch (error) {
    console.error('[outbox-sweeper] claim failed:', error)
    return NextResponse.json({ error: 'Outbox claim failed' }, { status: 503 })
  }
  if (!claimed.ok) {
    console.error('[outbox-sweeper] claim failed:', claimed.error.message)
    return NextResponse.json({ error: 'Outbox claim failed' }, { status: 503 })
  }

  const outcomes = await Promise.allSettled(
    claimed.rows.map((row) => deliverClaimedOutboxMessage(supabase, row)),
  )
  const processed = outcomes.filter(
    (result) =>
      result.status === 'fulfilled' && result.value.attemptResultPersisted,
  ).length
  const errors = outcomes.length - processed
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      console.error('[outbox-sweeper] claimed delivery failed:', outcome.reason)
    }
  }

  const redaction = await redact(supabase)
  return NextResponse.json({
    mode: 'active',
    generation,
    claimed: claimed.rows.length,
    processed,
    errors,
    ...redaction,
  })
}
