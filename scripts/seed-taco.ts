import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const supabase = createClient(supabaseUrl, supabaseServiceKey)

interface TacoEntry {
  number: number
  name: string
  category: string
  energy_kcal: number
  protein_per_100g: number
  lipids_per_100g: number
  carbs_per_100g: number
  fiber_per_100g: number
}

async function seed() {
  const jsonPath = path.resolve(__dirname, '../docs/taco_foods_extracted.json')
  const rawData = fs.readFileSync(jsonPath, 'utf-8')
  const foods: TacoEntry[] = JSON.parse(rawData)

  console.log(`Seeding ${foods.length} TACO foods...`)

  // Clear existing data
  const { error: deleteError } = await supabase.from('taco_foods').delete().neq('id', 0)
  if (deleteError) {
    console.error('Error clearing taco_foods:', deleteError.message)
    return
  }

  // Insert in batches of 50
  const batchSize = 50
  let inserted = 0

  for (let i = 0; i < foods.length; i += batchSize) {
    const batch = foods.slice(i, i + batchSize).map(f => ({
      id: f.number,
      food_name: f.name,
      category: f.category,
      calories_per_100g: f.energy_kcal,
      protein_per_100g: f.protein_per_100g,
      carbs_per_100g: f.carbs_per_100g,
      fat_per_100g: f.lipids_per_100g,
      fiber_per_100g: f.fiber_per_100g,
      sodium_per_100g: 0,
    }))

    const { error } = await supabase.from('taco_foods').upsert(batch, { onConflict: 'id' })
    if (error) {
      console.error(`Error inserting batch at ${i}:`, error.message)
    } else {
      inserted += batch.length
    }
  }

  console.log(`Done! Inserted ${inserted} of ${foods.length} foods.`)
}

seed().catch(console.error)
