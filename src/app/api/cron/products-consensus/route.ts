import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/db/supabase'
import { runConsensusPromotion } from '@/lib/products/consensus'

function isAuthorized(request: Request): boolean {
  return request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

async function handleProductsConsensus(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = createServiceRoleClient()
    const report = await runConsensusPromotion(supabase)
    return NextResponse.json({ status: 'ok', ...report })
  } catch (error) {
    console.error('[products-consensus] Error:', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

export async function GET(request: Request) {
  return handleProductsConsensus(request)
}

export async function POST(request: Request) {
  return handleProductsConsensus(request)
}
