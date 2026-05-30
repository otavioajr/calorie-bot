// ---------------------------------------------------------------------------
// In-memory Supabase fake (test-only)
//
// A minimal, faithful stand-in for the supabase-js client that backs the meal
// consolidation seam. It actually STORES meals/meal_items so the REAL queries in
// `src/lib/db/queries/meals.ts` (createMeal, addMealItems, recalculateMealTotal,
// getMealWithItems, findMealByTypeForDay) can be exercised end-to-end.
//
// Only the chains those 5 functions use are implemented:
//   meals:      insert().select().single() | update().eq() | select().eq()..order().limit() (thenable)
//   meal_items: insert() (thenable) | select().eq() (thenable)
// ---------------------------------------------------------------------------

// Index signatures let applyFilters() treat rows generically (Record<string, unknown>)
// while keeping the explicit columns documented.
interface MealRow {
  [key: string]: unknown
  id: string
  user_id: string
  meal_type: string
  total_calories: number
  registered_at: string
  original_message: string
  llm_response: unknown
}

interface ItemRow {
  [key: string]: unknown
  id: string
  meal_id: string
  food_name: string
  quantity_grams: number
  quantity_display: string | null
  calories: number
  protein_g: number
  carbs_g: number
  fat_g: number
  source: string
  confidence: string
  taco_id: number | null
  product_id: string | null
}

export function createInMemorySupabase() {
  const meals: MealRow[] = []
  const items: ItemRow[] = []
  let seq = 0
  const id = (p: string) => `${p}-${++seq}`

  function applyFilters<T extends Record<string, unknown>>(
    rows: T[],
    filters: Array<[string, string, unknown]>,
  ): T[] {
    return rows.filter((row) =>
      filters.every(([op, col, val]) => {
        const v = row[col] as unknown
        if (op === 'eq') return v === val
        if (op === 'gte') return String(v) >= String(val)
        if (op === 'lte') return String(v) <= String(val)
        return true
      }),
    )
  }

  function mealsTable() {
    const filters: Array<[string, string, unknown]> = []
    let insertPayload: Record<string, unknown> | null = null
    let updatePayload: Record<string, unknown> | null = null
    const api: Record<string, unknown> = {}
    api.insert = (payload: Record<string, unknown>) => {
      insertPayload = payload
      return api
    }
    api.update = (payload: Record<string, unknown>) => {
      updatePayload = payload
      return api
    }
    api.select = () => api
    api.eq = (c: string, v: unknown) => {
      filters.push(['eq', c, v])
      return api
    }
    api.gte = (c: string, v: unknown) => {
      filters.push(['gte', c, v])
      return api
    }
    api.lte = (c: string, v: unknown) => {
      filters.push(['lte', c, v])
      return api
    }
    api.order = () => api
    api.limit = () => api
    api.single = async () => {
      if (insertPayload) {
        const row: MealRow = {
          id: id('meal'),
          user_id: insertPayload.user_id as string,
          meal_type: insertPayload.meal_type as string,
          total_calories: insertPayload.total_calories as number,
          registered_at: (insertPayload.registered_at as string) ?? new Date().toISOString(),
          original_message: (insertPayload.original_message as string) ?? '',
          llm_response: insertPayload.llm_response ?? {},
        }
        meals.push(row)
        return { data: { id: row.id }, error: null }
      }
      const found = applyFilters(meals, filters)[0]
      return found
        ? { data: found, error: null }
        : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
    }
    api.then = (resolve: (v: unknown) => unknown) => {
      if (updatePayload) {
        for (const m of applyFilters(meals, filters)) Object.assign(m, updatePayload)
        return Promise.resolve({ data: null, error: null }).then(resolve)
      }
      return Promise.resolve({ data: applyFilters(meals, filters), error: null }).then(resolve)
    }
    return api
  }

  function itemsTable() {
    const filters: Array<[string, string, unknown]> = []
    let insertPayload: Array<Record<string, unknown>> | null = null
    const api: Record<string, unknown> = {}
    api.insert = (payload: Array<Record<string, unknown>>) => {
      insertPayload = payload
      return api
    }
    api.select = () => api
    api.eq = (c: string, v: unknown) => {
      filters.push(['eq', c, v])
      return api
    }
    api.then = (resolve: (v: unknown) => unknown) => {
      if (insertPayload) {
        for (const p of insertPayload) {
          items.push({
            id: id('item'),
            meal_id: p.meal_id as string,
            food_name: p.food_name as string,
            quantity_grams: p.quantity_grams as number,
            quantity_display: (p.quantity_display as string) ?? null,
            calories: p.calories as number,
            protein_g: p.protein_g as number,
            carbs_g: p.carbs_g as number,
            fat_g: p.fat_g as number,
            source: p.source as string,
            confidence: (p.confidence as string) ?? 'high',
            taco_id: (p.taco_id as number) ?? null,
            product_id: (p.product_id as string) ?? null,
          })
        }
        return Promise.resolve({ data: null, error: null }).then(resolve)
      }
      return Promise.resolve({ data: applyFilters(items, filters), error: null }).then(resolve)
    }
    return api
  }

  return {
    from(table: string) {
      if (table === 'meals') return mealsTable()
      if (table === 'meal_items') return itemsTable()
      throw new Error(`Unexpected table ${table}`)
    },
  }
}
