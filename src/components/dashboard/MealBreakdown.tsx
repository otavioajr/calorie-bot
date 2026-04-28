"use client"

import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface MealData {
  mealType: string
  totalCalories: number
}

interface MealBreakdownProps {
  meals: MealData[]
}

const mealConfig = [
  { key: "cafe", label: "Café da manhã", icon: "☕", aliases: ["cafe", "café", "breakfast", "morning"] },
  { key: "almoco", label: "Almoço", icon: "🍽️", aliases: ["almoco", "almoço", "lunch"] },
  { key: "lanche", label: "Lanche", icon: "🍎", aliases: ["lanche", "snack"] },
  { key: "jantar", label: "Jantar", icon: "🌙", aliases: ["jantar", "dinner", "supper"] },
]

function normalizeMealType(mealType: string): string {
  const lower = mealType.toLowerCase()
  for (const config of mealConfig) {
    if (config.aliases.some((a) => lower.includes(a))) {
      return config.key
    }
  }
  return lower
}

export function MealBreakdown({ meals }: MealBreakdownProps) {
  const mealMap: Record<string, number> = {}
  for (const meal of meals) {
    const key = normalizeMealType(meal.mealType)
    mealMap[key] = (mealMap[key] ?? 0) + meal.totalCalories
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {mealConfig.map((config) => {
        const calories = mealMap[config.key]
        const hasData = calories !== undefined

        return (
          <Card
            key={config.key}
            className={cn(
              "border transition-colors",
              hasData
                ? "border-primary/25 bg-accent/60 shadow-sm"
                : "border-border bg-card/70"
            )}
          >
            <CardContent className="flex flex-col items-center gap-2 p-4 text-center">
              <span className="text-xl" aria-hidden="true">{config.icon}</span>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground leading-tight">
                {config.label}
              </p>
              {hasData ? (
                <p className="font-heading text-2xl font-semibold text-primary">
                  {calories.toLocaleString("pt-BR")}
                  <span className="ml-1 font-sans text-xs font-normal text-muted-foreground">kcal</span>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Aguardando registro</p>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
