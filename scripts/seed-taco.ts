// scripts/seed-taco.ts
// Run with: npx tsx scripts/seed-taco.ts
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env.

import { createClient } from '@supabase/supabase-js'

const TACO_FOODS = [
  {
    food_name: 'Arroz branco cozido',
    category: 'Cereais',
    calories_per_100g: 128.3,
    protein_per_100g: 2.5,
    carbs_per_100g: 28.1,
    fat_per_100g: 0.2,
    fiber_per_100g: 1.6,
    sodium_per_100g: 1.0,
  },
  {
    food_name: 'Feijão carioca cozido',
    category: 'Leguminosas',
    calories_per_100g: 76.4,
    protein_per_100g: 4.8,
    carbs_per_100g: 13.6,
    fat_per_100g: 0.5,
    fiber_per_100g: 8.5,
    sodium_per_100g: 2.0,
  },
  {
    food_name: 'Frango peito grelhado',
    category: 'Carnes',
    calories_per_100g: 159.0,
    protein_per_100g: 32.0,
    carbs_per_100g: 0.0,
    fat_per_100g: 2.5,
    fiber_per_100g: 0.0,
    sodium_per_100g: 51.0,
  },
  {
    food_name: 'Ovo de galinha cozido',
    category: 'Ovos',
    calories_per_100g: 146.0,
    protein_per_100g: 13.3,
    carbs_per_100g: 0.6,
    fat_per_100g: 9.5,
    fiber_per_100g: 0.0,
    sodium_per_100g: 146.0,
  },
  {
    food_name: 'Banana prata',
    category: 'Frutas',
    calories_per_100g: 98.0,
    protein_per_100g: 1.3,
    carbs_per_100g: 26.0,
    fat_per_100g: 0.1,
    fiber_per_100g: 2.0,
    sodium_per_100g: 0.0,
  },
  {
    food_name: 'Pão francês',
    category: 'Cereais',
    calories_per_100g: 300.0,
    protein_per_100g: 8.0,
    carbs_per_100g: 58.6,
    fat_per_100g: 3.1,
    fiber_per_100g: 2.3,
    sodium_per_100g: 648.0,
  },
  {
    food_name: 'Leite integral',
    category: 'Laticínios',
    calories_per_100g: 61.0,
    protein_per_100g: 3.2,
    carbs_per_100g: 4.5,
    fat_per_100g: 3.3,
    fiber_per_100g: 0.0,
    sodium_per_100g: 61.0,
  },
  {
    food_name: 'Batata inglesa cozida',
    category: 'Tubérculos',
    calories_per_100g: 52.0,
    protein_per_100g: 1.2,
    carbs_per_100g: 11.9,
    fat_per_100g: 0.0,
    fiber_per_100g: 1.3,
    sodium_per_100g: 2.0,
  },
  {
    food_name: 'Alface crespa',
    category: 'Verduras',
    calories_per_100g: 11.0,
    protein_per_100g: 1.3,
    carbs_per_100g: 1.7,
    fat_per_100g: 0.2,
    fiber_per_100g: 1.8,
    sodium_per_100g: 2.0,
  },
  {
    food_name: 'Tomate',
    category: 'Verduras',
    calories_per_100g: 15.0,
    protein_per_100g: 1.1,
    carbs_per_100g: 3.1,
    fat_per_100g: 0.2,
    fiber_per_100g: 1.2,
    sodium_per_100g: 2.0,
  },
  {
    food_name: 'Carne bovina patinho',
    category: 'Carnes',
    calories_per_100g: 219.0,
    protein_per_100g: 35.9,
    carbs_per_100g: 0.0,
    fat_per_100g: 7.3,
    fiber_per_100g: 0.0,
    sodium_per_100g: 45.0,
  },
  {
    food_name: 'Macarrão cozido',
    category: 'Cereais',
    calories_per_100g: 102.0,
    protein_per_100g: 3.4,
    carbs_per_100g: 19.9,
    fat_per_100g: 0.5,
    fiber_per_100g: 1.5,
    sodium_per_100g: 1.0,
  },
  {
    food_name: 'Queijo mussarela',
    category: 'Laticínios',
    calories_per_100g: 330.0,
    protein_per_100g: 22.6,
    carbs_per_100g: 3.0,
    fat_per_100g: 25.2,
    fiber_per_100g: 0.0,
    sodium_per_100g: 579.0,
  },
  {
    food_name: 'Café com açúcar',
    category: 'Bebidas',
    calories_per_100g: 40.0,
    protein_per_100g: 0.6,
    carbs_per_100g: 9.6,
    fat_per_100g: 0.0,
    fiber_per_100g: 0.0,
    sodium_per_100g: 2.0,
  },
  {
    food_name: 'Suco de laranja',
    category: 'Bebidas',
    calories_per_100g: 47.0,
    protein_per_100g: 0.6,
    carbs_per_100g: 11.1,
    fat_per_100g: 0.1,
    fiber_per_100g: 0.0,
    sodium_per_100g: 1.0,
  },
  {
    food_name: 'Mandioca cozida',
    category: 'Tubérculos',
    calories_per_100g: 125.0,
    protein_per_100g: 0.6,
    carbs_per_100g: 30.1,
    fat_per_100g: 0.3,
    fiber_per_100g: 1.6,
    sodium_per_100g: 1.0,
  },
  {
    food_name: 'Abacate',
    category: 'Frutas',
    calories_per_100g: 96.0,
    protein_per_100g: 1.2,
    carbs_per_100g: 6.0,
    fat_per_100g: 8.4,
    fiber_per_100g: 6.3,
    sodium_per_100g: 0.0,
  },
  {
    food_name: 'Presunto',
    category: 'Carnes',
    calories_per_100g: 108.0,
    protein_per_100g: 14.5,
    carbs_per_100g: 1.8,
    fat_per_100g: 4.6,
    fiber_per_100g: 0.0,
    sodium_per_100g: 1224.0,
  },
  {
    food_name: 'Coxinha de frango',
    category: 'Preparações',
    calories_per_100g: 229.0,
    protein_per_100g: 10.0,
    carbs_per_100g: 19.6,
    fat_per_100g: 12.5,
    fiber_per_100g: 0.0,
    sodium_per_100g: 368.0,
  },
  {
    food_name: 'Açaí',
    category: 'Frutas',
    calories_per_100g: 58.0,
    protein_per_100g: 0.8,
    carbs_per_100g: 6.2,
    fat_per_100g: 3.9,
    fiber_per_100g: 2.6,
    sodium_per_100g: 0.0,
  },
]

async function seedTaco() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    console.error(
      'Missing env vars: NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY',
    )
    process.exit(1)
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  console.log(`Seeding ${TACO_FOODS.length} TACO foods...`)

  const { error } = await supabase.from('taco_foods').insert(TACO_FOODS)

  if (error) {
    // If rows already exist (e.g. duplicate food_name), log but don't crash
    if (error.code === '23505') {
      console.warn(
        'Some rows already exist (duplicate key). Run with a clean table or add a unique constraint on food_name to use upsert.',
      )
    } else {
      console.error('Seed error:', error)
      process.exit(1)
    }
  } else {
    console.log('Done! All TACO foods inserted successfully.')
  }
}

seedTaco()
