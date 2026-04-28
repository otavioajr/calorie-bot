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

async function getWeeklyData(userId: string, days: number, timezone: string): Promise<DayChartData[]> {
  const supabase = createServiceRoleClient()
  const result: DayChartData[] = []

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    d.setHours(12, 0, 0, 0) // Use noon to avoid DST edge cases
    const calories = await getDailyCalories(supabase, userId, d, timezone)
    const label = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: timezone })
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

  const timezone = user.timezone ?? 'America/Sao_Paulo'

  const [todayCalories, todayMeals, recentMeals, weeklyData] = await Promise.all([
    getDailyCalories(supabase, userId, undefined, timezone).catch(() => 0),
    getDailyMeals(supabase, userId, undefined, timezone).catch(() => []),
    getRecentMeals(supabase, userId, 5).catch(() => []),
    getWeeklyData(userId, 30, timezone).catch(() => []),
  ])

  const target = user.dailyCalorieTarget ?? 2000
  const firstName = user.name?.split(" ")[0] ?? "Usuário"

  return (
    <div className="space-y-6">
      <div className="rounded-[2rem] border border-border bg-card/75 p-6 shadow-sm backdrop-blur sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-secondary">
          Painel do dia
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-heading text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
              Olá, {firstName}.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              O registro acontece no WhatsApp. Este painel é o retrovisor do seu dia:
              calorias, refeições recentes e tendências em um só lugar.
            </p>
          </div>
          <p className="text-sm capitalize text-muted-foreground">
            {new Date().toLocaleDateString("pt-BR", {
              timeZone: timezone,
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </p>
        </div>
      </div>

      <Card className="overflow-hidden bg-card/85">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-semibold">Progresso de hoje</CardTitle>
        </CardHeader>
        <CardContent>
          <CalorieProgress consumed={todayCalories} target={target} />
        </CardContent>
      </Card>

      <Card className="bg-card/85">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-semibold">Refeições de hoje</CardTitle>
        </CardHeader>
        <CardContent>
          <MealBreakdown meals={todayMeals} />
        </CardContent>
      </Card>

      <Card className="bg-card/85">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-semibold">Histórico de calorias</CardTitle>
        </CardHeader>
        <CardContent>
          <WeeklyChart data={weeklyData} target={target} />
        </CardContent>
      </Card>

      <Card className="bg-card/85">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-semibold">Últimas refeições</CardTitle>
        </CardHeader>
        <CardContent>
          <RecentMeals meals={recentMeals} />
        </CardContent>
      </Card>
    </div>
  )
}
