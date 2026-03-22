import { SupabaseClient } from '@supabase/supabase-js'

export interface LLMUsageEntry {
  userId?: string
  provider: string
  model: string
  functionType: 'meal_analysis' | 'classify_intent' | 'vision' | 'chat' | 'audio_transcription'
  tokensInput?: number
  tokensOutput?: number
  costUsd?: number
  latencyMs: number
  success: boolean
}

export async function logLLMUsage(supabase: SupabaseClient, entry: LLMUsageEntry): Promise<void> {
  // Insert into llm_usage_log with snake_case conversion
  const row: Record<string, unknown> = {
    provider: entry.provider,
    model: entry.model,
    function_type: entry.functionType,
    latency_ms: entry.latencyMs,
    success: entry.success,
  }

  if (entry.userId !== undefined) {
    row.user_id = entry.userId
  }
  if (entry.tokensInput !== undefined) {
    row.tokens_input = entry.tokensInput
  }
  if (entry.tokensOutput !== undefined) {
    row.tokens_output = entry.tokensOutput
  }
  if (entry.costUsd !== undefined) {
    row.cost_usd = entry.costUsd
  }

  const { error } = await supabase.from('llm_usage_log').insert(row)

  if (error) {
    throw new Error(`Failed to log LLM usage: ${error.message}`)
  }
}
