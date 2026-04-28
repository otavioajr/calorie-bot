import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { createServiceRoleClient } from "@/lib/db/supabase"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { MealList } from "@/components/history/MealList"

interface MealItem {
  id?: string
  foodName: string
  quantityGrams: number
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}

interface HistoryMeal {
  id: string
  mealType: string
  totalCalories: number
  registeredAt: string
  items: MealItem[]
}

async function getMealsForDate(userId: string, date: Date): Promise<HistoryMeal[]> {
  const supabase = createServiceRoleClient()

  const startOfDay = new Date(date)
  startOfDay.setUTCHours(0, 0, 0, 0)

  const endOfDay = new Date(date)
  endOfDay.setUTCHours(23, 59, 59, 999)

  const { data, error } = await supabase
    .from("meals")
    .select(`
      id,
      meal_type,
      total_calories,
      registered_at,
      meal_items (
        food_name,
        quantity_grams,
        calories,
        protein_g,
        carbs_g,
        fat_g
      )
    `)
    .eq("user_id", userId)
    .gte("registered_at", startOfDay.toISOString())
    .lte("registered_at", endOfDay.toISOString())
    .order("registered_at", { ascending: false })

  if (error || !data) return []

  return (data as Array<Record<string, unknown>>).map((row) => {
    const rawItems = (row.meal_items as Array<Record<string, unknown>>) ?? []
    return {
      id: row.id as string,
      mealType: row.meal_type as string,
      totalCalories: row.total_calories as number,
      registeredAt: row.registered_at as string,
      items: rawItems.map((item) => ({
        foodName: item.food_name as string,
        quantityGrams: item.quantity_grams as number,
        calories: item.calories as number,
        proteinG: item.protein_g as number,
        carbsG: item.carbs_g as number,
        fatG: item.fat_g as number,
      })),
    }
  })
}

interface HistoryPageProps {
  searchParams: Promise<{ date?: string }>
}

export default async function HistoryPage({ searchParams }: HistoryPageProps) {
  const cookieStore = await cookies()
  const userId = cookieStore.get("caloriebot-user-id")?.value

  if (!userId) {
    redirect("/")
  }

  const params = await searchParams
  const dateStr = params.date ?? new Date().toISOString().split("T")[0]
  const selectedDate = new Date(dateStr + "T12:00:00Z")
  const meals = await getMealsForDate(userId, selectedDate)

  const displayDate = selectedDate.toLocaleDateString("pt-BR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  })

  return (
    <div className="space-y-6">
      <div className="rounded-[2rem] border border-border bg-card/75 p-6 shadow-sm backdrop-blur sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-secondary">
          Linha do tempo
        </p>
        <h1 className="mt-4 font-heading text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Histórico
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
          Revise os registros que chegaram pelo WhatsApp e confira os detalhes de cada refeição.
        </p>
      </div>

      {/* Date selector */}
      <Card className="bg-card/85">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-semibold">Selecionar data</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="GET" action="/history" className="flex gap-3 items-end">
            <div className="flex-1">
              <input
                type="date"
                name="date"
                defaultValue={dateStr}
                max={new Date().toISOString().split("T")[0]}
                className="flex h-10 w-full rounded-lg border border-input bg-background/70 px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <button
              type="submit"
              className="inline-flex h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Ver
            </button>
          </form>
        </CardContent>
      </Card>

      {/* Meal list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base capitalize">{displayDate}</CardTitle>
        </CardHeader>
        <CardContent>
          <MealList initialMeals={meals} selectedDate={dateStr} />
        </CardContent>
      </Card>
    </div>
  )
}
