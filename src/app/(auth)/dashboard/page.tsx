import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { createServiceRoleClient } from "@/lib/db/supabase"
import { getUserWithSettings } from "@/lib/db/queries/users"
import { getDailyCalories, getDailyMeals, getRecentMeals } from "@/lib/db/queries/meals"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { CalorieProgress } from "@/components/dashboard/CalorieProgress"
import { MealBreakdown } from "@/components/dashboard/MealBreakdown"
import { WeeklyChart } from "@/components/dashboard/WeeklyChart"
import { RecentMeals } from "@/components/dashboard/RecentMeals"

interface DayChartData {
  date: string
  calories: number
  label: string
}

async function getWeeklyData(userId: string, days: number): Promise<DayChartData[]> {
  const supabase = createServiceRoleClient()
  const result: DayChartData[] = []

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const calories = await getDailyCalories(supabase, userId, d)
    const label = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
    result.push({ date: d.toISOString(), calories, label })
  }

  return result
}

export default async function DashboardPage() {
  const cookieStore = await cookies()
  const userId = cookieStore.get("caloriebot-user-id")?.value

  if (!userId) {
    redirect("/")
  }

  const supabase = createServiceRoleClient()

  let userData
  try {
    userData = await getUserWithSettings(supabase, userId)
  } catch {
    redirect("/")
  }

  const { user } = userData

  const [todayCalories, todayMeals, recentMeals, weeklyData] = await Promise.all([
    getDailyCalories(supabase, userId).catch(() => 0),
    getDailyMeals(supabase, userId).catch(() => []),
    getRecentMeals(supabase, userId, 5).catch(() => []),
    getWeeklyData(userId, 30).catch(() => []),
  ])

  const target = user.dailyCalorieTarget ?? 2000
  const firstName = user.name?.split(" ")[0] ?? "Usuário"

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          Olá, {firstName}! 👋
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          {new Date().toLocaleDateString("pt-BR", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </p>
      </div>

      {/* Calorie Progress */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Progresso de hoje</CardTitle>
        </CardHeader>
        <CardContent>
          <CalorieProgress consumed={todayCalories} target={target} />
        </CardContent>
      </Card>

      {/* Meal Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Refeições de hoje</CardTitle>
        </CardHeader>
        <CardContent>
          <MealBreakdown meals={todayMeals} />
        </CardContent>
      </Card>

      {/* Weekly Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Histórico de calorias</CardTitle>
        </CardHeader>
        <CardContent>
          <WeeklyChart data={weeklyData} target={target} />
        </CardContent>
      </Card>

      {/* Recent Meals */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Últimas refeições</CardTitle>
        </CardHeader>
        <CardContent>
          <RecentMeals meals={recentMeals} />
        </CardContent>
      </Card>
    </div>
  )
}
