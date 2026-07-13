export const maxDuration = 60

import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'
import { isCronAuthorized } from '@/lib/auth/cron'
import { processInboundWork } from '@/lib/bot/inbound-processor'
import { createServiceRoleClient } from '@/lib/db/supabase'
import {
  listStaleInboundWork,
  type InboundPayload,
} from '@/lib/db/queries/inbound-work'

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceRoleClient()
  const leaseOwner = randomUUID()
  const staleRows = await listStaleInboundWork(supabase, 5)

  let processed = 0
  let skipped = 0
  let errors = 0

  for (const row of staleRows) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('inbound_work')
        .select('payload_json')
        .eq('id', row.workId)
        .single()

      if (error || !data?.payload_json) {
        errors += 1
        continue
      }

      const outcome = await processInboundWork(
        supabase,
        {
          workId: row.workId,
          payload: data.payload_json as InboundPayload,
          status: row.status,
        },
        leaseOwner,
      )

      if (outcome === 'skipped') {
        skipped += 1
      } else {
        processed += 1
      }
    } catch {
      errors += 1
    }
  }

  return NextResponse.json({
    processed,
    skipped,
    errors,
    candidates: staleRows.length,
  })
}
