/**
 * Smoke test local do fluxo replace_item (correção de alimento).
 *
 * Reproduz o bug da carbonara sem WhatsApp e sem tocar na VPS:
 * cria um item "Espaguete ao alho e óleo" 237 kcal, pede a troca
 * por carbonara via handleEditForMeal, e falha se as kcal virarem 0.
 *
 * Pré-requisitos:
 *   Docker (OrbStack ou Colima) + `supabase start`
 *   .env.test.local preenchido (supabase status)
 *   LLM_API_KEY real no ambiente (o valor test-llm-key do .env.test.local
 *   NÃO funciona no OpenRouter)
 *
 * Uso:
 *   LLM_API_KEY=sk-or-... npx tsx --tsconfig tsconfig.json scripts/smoke-rename-correction.ts
 *
 * Depois: supabase stop
 *          (e colima stop, se estiver usando Colima)
 */

import { existsSync, readFileSync } from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// Env loading — MUST run before importing app modules that read process.env
// ---------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal'])
const LLM_KEYS = new Set([
  'LLM_PROVIDER',
  'LLM_API_KEY',
  'LLM_MODEL_MEAL',
  'LLM_MODEL_CLASSIFY',
  'LLM_MODEL_VISION',
  'LLM_FALLBACK_PROVIDER',
])

function loadEnvFile(filename: string, opts?: { only?: Set<string>; override?: boolean }): void {
  const filePath = path.resolve(process.cwd(), filename)
  if (!existsSync(filePath)) return

  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (opts?.only && !opts.only.has(key)) continue
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (opts?.override || process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

function assertLocalSupabaseUrl(url: string | undefined): void {
  if (!url?.trim()) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL ausente. Copie .env.test.example → .env.test.local após `supabase start`.',
    )
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`NEXT_PUBLIC_SUPABASE_URL inválida: ${url}`)
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Recusando host não-local "${parsed.hostname}". Este script só roda contra Supabase local.`,
    )
  }
}

// 1) Banco local a partir do .env.test.local
loadEnvFile('.env.test.local')
loadEnvFile('.env.test')

// 2) LLM real: shell env ganha; senão tenta .env.local (só chaves LLM)
loadEnvFile('.env.local', { only: LLM_KEYS, override: false })

assertLocalSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)

const llmKey = process.env.LLM_API_KEY?.trim() ?? ''
if (!llmKey || llmKey === 'test-llm-key' || llmKey.startsWith('test-')) {
  console.error(`
[smoke] LLM_API_KEY ausente ou é chave de teste.

  O .env.test.local usa test-llm-key (OpenRouter rejeita).
  Passe uma chave real só nesta execução:

    LLM_API_KEY=sk-or-... npx tsx --tsconfig tsconfig.json scripts/smoke-rename-correction.ts
`)
  process.exit(1)
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
  console.error('[smoke] SUPABASE_SERVICE_ROLE_KEY ausente no .env.test.local')
  process.exit(1)
}

// users.phone is varchar(20); keep unique but short
const PHONE = `55${String(Date.now()).slice(-11)}`
const CORRECTION = 'Não é espaguete alho e oleo, é carbonara'

function fmtItem(item: {
  foodName: string
  quantityGrams: number
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}): string {
  return `${item.foodName} ${item.quantityGrams}g — ${item.calories} kcal (P${item.proteinG}/C${item.carbsG}/G${item.fatG})`
}

async function main(): Promise<void> {
  // Dynamic imports stay inside main() — tsx+tsconfig emits CJS, which
  // rejects top-level await.
  const { ensureServiceRoleGrants } = await import('../tests/integration/helpers/ensure-grants')
  const { createServiceRoleClient } = await import('../src/lib/db/supabase')
  const { createUser } = await import('../src/lib/db/queries/users')
  const { createMeal, getMealWithItems } = await import('../src/lib/db/queries/meals')
  const { handleEditForMeal } = await import('../src/lib/bot/flows/edit')

  // Local Supabase migrations don't grant service_role full table access
  // (same fix the integration suite applies once per process).
  console.log('[smoke] Aplicando grants service_role…')
  ensureServiceRoleGrants()

  const supabase = createServiceRoleClient()
  let userId: string | null = null

  console.log('[smoke] Supabase:', process.env.NEXT_PUBLIC_SUPABASE_URL)
  console.log('[smoke] LLM provider:', process.env.LLM_PROVIDER ?? 'openrouter')
  console.log('[smoke] phone fixture:', PHONE)
  console.log('[smoke] Criando fixture…')

  try {
    const user = await createUser(supabase, PHONE)
    userId = user.id

    const mealId = await createMeal(supabase, {
      userId,
      mealType: 'breakfast',
      totalCalories: 399,
      originalMessage: 'comi espaguete ao alho e oleo 150g e asa de frango 80g',
      llmResponse: { smoke: true },
      items: [
        {
          foodName: 'Espaguete ao alho e óleo',
          quantityGrams: 150,
          calories: 237,
          proteinG: 8,
          carbsG: 38,
          fatG: 6,
          source: 'taco',
          quantityDisplay: '150g',
        },
        {
          foodName: 'Meio da asa de frango assada',
          quantityGrams: 80,
          calories: 162,
          proteinG: 18,
          carbsG: 0,
          fatG: 10,
          source: 'taco',
          quantityDisplay: '80g',
        },
      ],
    })

    const before = await getMealWithItems(supabase, mealId)
    if (!before) throw new Error('Meal sumiu após createMeal')

    console.log('\nANTES')
    for (const item of before.items) console.log('  •', fmtItem(item))
    console.log('  total:', before.totalCalories, 'kcal')

    console.log(`\n[smoke] Chamando handleEditForMeal("${CORRECTION}")…`)
    const result = await handleEditForMeal(supabase, userId, CORRECTION, mealId, {
      timezone: 'America/Sao_Paulo',
      dailyCalorieTarget: 2168,
    })

    console.log('\nRESPOSTA DO BOT')
    console.log(result.response)
    console.log('\noutcome:', result.outcome)

    const after = await getMealWithItems(supabase, mealId)
    if (!after) throw new Error('Meal sumiu após a correção')

    console.log('\nDEPOIS')
    for (const item of after.items) console.log('  •', fmtItem(item))
    console.log('  total:', after.totalCalories, 'kcal')

    const pasta = after.items.find((i) =>
      i.foodName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes('carbonara'),
    )
    const chicken = after.items.find((i) =>
      i.foodName.toLowerCase().includes('asa') || i.foodName.toLowerCase().includes('frango'),
    )

    const failures: string[] = []

    if (result.outcome !== 'applied') {
      failures.push(`outcome esperado "applied", veio "${result.outcome}"`)
    }
    if (!pasta) {
      failures.push('nenhum item com "carbonara" no nome após a correção')
    } else {
      if (pasta.calories <= 0) {
        failures.push(`carbonara ficou com ${pasta.calories} kcal (bug original)`)
      }
      if (pasta.calories === 237) {
        failures.push('carbonara manteve 237 kcal do alho e óleo — macros provavelmente não recalcularam')
      }
    }
    if (chicken && chicken.calories !== 162) {
      failures.push(`asa de frango mudou de 162 para ${chicken.calories} kcal (não deveria)`)
    }

    if (failures.length > 0) {
      console.error('\n❌ FALHOU')
      for (const f of failures) console.error('  -', f)
      process.exitCode = 1
      return
    }

    console.log('\n✅ OK — troca precificou a carbonara sem zerar kcal')
  } finally {
    if (userId) {
      const { error } = await supabase.from('users').delete().eq('id', userId)
      if (error) {
        console.warn('[smoke] cleanup falhou:', error.message)
      } else {
        console.log('[smoke] fixture removida (user cascade)')
      }
    }
  }
}

main().catch((err) => {
  console.error('\n❌ Erro no smoke:', err)
  process.exit(1)
})
