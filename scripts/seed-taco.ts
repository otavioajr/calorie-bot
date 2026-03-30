import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const supabase = createClient(supabaseUrl, supabaseServiceKey)

interface TacoEntry {
  number: number
  name: string
  food_base: string
  food_variant: string
  energy_kcal: number | null
  protein_per_100g: number | null
  lipids_per_100g: number | null
  carbs_per_100g: number | null
  fiber_per_100g: number | null
  sodium_per_100g: number | null
}

// Default food for each base — the most commonly consumed variant in Brazil
const DEFAULTS: Record<string, string> = {
  'Arroz': 'tipo 1, cozido',
  'Feijão': 'carioca, cozido',
  'Banana': 'prata, crua',
  'Ovo': 'de galinha, inteiro, cozido/10minutos',
  'Pão': 'trigo, francês',
  'Leite': 'de vaca, integral',
  'Café': 'infusão 10%',
  'Frango': 'peito, sem pele, grelhado',
  'Carne': 'bovina, patinho, sem gordura, grelhado',
  'Queijo': 'mozarela',
  'Chocolate': 'ao leite',
  'Batata': 'inglesa, cozida',
  'Iogurte': 'natural',
  'Macarrão': 'trigo, cru',
  'Bolo': 'pronto, chocolate',
  'Laranja': 'pêra, crua',
  'Mandioca': 'cozida',
  'Lingüiça': 'porco, grelhada',
  'Porco': 'lombo, assado',
  'Óleo': 'de soja',
  'Tomate': 'com semente, cru',
  'Alface': 'crespa, crua',
  'Biscoito': 'salgado, cream cracker',
  'Margarina': 'com óleo hidrogenado, com sal (65% de lipídeos)',
  'Refrigerante': 'tipo cola',
  'Goiaba': 'vermelha, com casca, crua',
  'Manga': 'Tommy Atkins, crua',
  'Farinha': 'de trigo',
}

function isDefault(food: TacoEntry): boolean {
  const defaultVariant = DEFAULTS[food.food_base]
  if (!defaultVariant) return false
  return food.food_variant.toLowerCase() === defaultVariant.toLowerCase()
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
  let defaultCount = 0

  for (let i = 0; i < foods.length; i += batchSize) {
    const batch = foods.slice(i, i + batchSize).map(f => {
      const def = isDefault(f)
      if (def) defaultCount++
      return {
        id: f.number,
        food_name: f.name,
        food_base: f.food_base,
        food_variant: f.food_variant,
        is_default: def,
        category: null,
        calories_per_100g: f.energy_kcal,
        protein_per_100g: f.protein_per_100g,
        carbs_per_100g: f.carbs_per_100g,
        fat_per_100g: f.lipids_per_100g,
        fiber_per_100g: f.fiber_per_100g,
        sodium_per_100g: f.sodium_per_100g,
      }
    })

    const { error } = await supabase.from('taco_foods').upsert(batch, { onConflict: 'id' })
    if (error) {
      console.error(`Error inserting batch at ${i}:`, error.message)
    } else {
      inserted += batch.length
    }
  }

  console.log(`Done! Inserted ${inserted} of ${foods.length} foods (${defaultCount} defaults).`)
}

seed().catch(console.error)
