import type { SupabaseClient } from '@supabase/supabase-js'

interface ProductConsensusRow {
  id: string
  name: string
  name_normalized: string | null
  brand: string | null
  brand_normalized: string | null
  barcode?: string | null
  serving_size_g?: number | null
  serving_display?: string | null
  calories_per_100g: number
  protein_per_100g: number
  carbs_per_100g: number
  fat_per_100g: number
  fiber_per_100g?: number | null
  sodium_per_100g?: number | null
  created_by: string | null
}

interface ConsensusCandidate {
  sample: ProductConsensusRow
  contributorIds: string[]
  caloriesPer100g: number
  proteinPer100g: number
  carbsPer100g: number
  fatPer100g: number
}

export interface ConsensusReport {
  promoted: number
  clusters: number
}

const PRODUCT_CONSENSUS_COLUMNS = [
  'id',
  'name',
  'name_normalized',
  'brand',
  'brand_normalized',
  'barcode',
  'serving_size_g',
  'serving_display',
  'calories_per_100g',
  'protein_per_100g',
  'carbs_per_100g',
  'fat_per_100g',
  'fiber_per_100g',
  'sodium_per_100g',
  'created_by',
].join(',')

const MIN_CONTRIBUTORS = 3
const KCAL_MAX_DEVIATION = 0.15
const MACRO_MAX_DEVIATION = 0.2

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  if (sorted.length % 2 === 1) return sorted[middle]

  return (sorted[middle - 1] + sorted[middle]) / 2
}

function isWithinDeviation(values: number[], medianValue: number, maxDeviation: number): boolean {
  if (medianValue === 0) return values.every((value) => value === 0)

  return values.every((value) => Math.abs(value - medianValue) / Math.abs(medianValue) <= maxDeviation)
}

function evaluateCluster(rows: ProductConsensusRow[]): ConsensusCandidate | null {
  const rowsByContributor = new Map<string, ProductConsensusRow>()

  for (const row of rows) {
    if (!row.brand_normalized || !row.name_normalized || !row.created_by) continue
    if (!rowsByContributor.has(row.created_by)) {
      rowsByContributor.set(row.created_by, row)
    }
  }

  const deduplicatedRows = [...rowsByContributor.values()]
  if (deduplicatedRows.length < MIN_CONTRIBUTORS) return null

  const calories = deduplicatedRows.map((row) => row.calories_per_100g)
  const protein = deduplicatedRows.map((row) => row.protein_per_100g)
  const carbs = deduplicatedRows.map((row) => row.carbs_per_100g)
  const fat = deduplicatedRows.map((row) => row.fat_per_100g)

  const caloriesMedian = median(calories)
  const proteinMedian = median(protein)
  const carbsMedian = median(carbs)
  const fatMedian = median(fat)

  if (!isWithinDeviation(calories, caloriesMedian, KCAL_MAX_DEVIATION)) return null
  if (!isWithinDeviation(protein, proteinMedian, MACRO_MAX_DEVIATION)) return null
  if (!isWithinDeviation(carbs, carbsMedian, MACRO_MAX_DEVIATION)) return null
  if (!isWithinDeviation(fat, fatMedian, MACRO_MAX_DEVIATION)) return null

  return {
    sample: deduplicatedRows[0],
    contributorIds: [...rowsByContributor.keys()],
    caloriesPer100g: caloriesMedian,
    proteinPer100g: proteinMedian,
    carbsPer100g: carbsMedian,
    fatPer100g: fatMedian,
  }
}

export async function runConsensusPromotion(
  supabase: SupabaseClient,
): Promise<ConsensusReport> {
  const { data, error } = await supabase
    .from('products')
    .select(PRODUCT_CONSENSUS_COLUMNS)
    .eq('status', 'privado')
    .not('brand_normalized', 'is', null)
    .not('name_normalized', 'is', null)

  if (error) {
    throw new Error(`runConsensusPromotion failed to list products: ${error.message ?? 'unknown error'}`)
  }

  const clustersByKey = new Map<string, ProductConsensusRow[]>()

  for (const row of (data ?? []) as unknown as ProductConsensusRow[]) {
    if (!row.brand_normalized || !row.name_normalized || !row.created_by) continue

    const key = `${row.brand_normalized}:${row.name_normalized}`
    const cluster = clustersByKey.get(key) ?? []
    cluster.push(row)
    clustersByKey.set(key, cluster)
  }

  let promoted = 0

  for (const cluster of clustersByKey.values()) {
    const candidate = evaluateCluster(cluster)
    if (!candidate) continue

    const { sample } = candidate
    const { data: existingApproved, error: existingError } = await supabase
      .from('products')
      .select('id')
      .eq('status', 'aprovado')
      .eq('brand_normalized', sample.brand_normalized)
      .eq('name_normalized', sample.name_normalized)
      .limit(1)
      .maybeSingle()

    if (existingError) {
      throw new Error(`runConsensusPromotion failed to check approved product: ${existingError.message ?? 'unknown error'}`)
    }

    if (existingApproved) continue

    const { error: insertError } = await supabase.from('products').insert({
      name: sample.name,
      name_normalized: sample.name_normalized,
      brand: sample.brand,
      brand_normalized: sample.brand_normalized,
      barcode: null,
      serving_size_g: null,
      serving_display: null,
      calories_per_100g: candidate.caloriesPer100g,
      protein_per_100g: candidate.proteinPer100g,
      carbs_per_100g: candidate.carbsPer100g,
      fat_per_100g: candidate.fatPer100g,
      fiber_per_100g: null,
      sodium_per_100g: null,
      source: 'consenso_usuarios',
      source_ref: null,
      status: 'aprovado',
      created_by: null,
      contributor_ids: candidate.contributorIds,
      promoted_at: new Date().toISOString(),
    })

    if (insertError) {
      throw new Error(`runConsensusPromotion failed to insert product: ${insertError.message ?? 'unknown error'}`)
    }

    promoted += 1
  }

  return {
    promoted,
    clusters: clustersByKey.size,
  }
}
