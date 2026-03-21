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
              hasData ? "border-primary/30 bg-accent/50" : "border-border"
            )}
          >
            <CardContent className="p-4 flex flex-col items-center text-center gap-2">
              <span className="text-2xl">{config.icon}</span>
              <p className="text-xs font-medium text-muted-foreground leading-tight">
                {config.label}
              </p>
              {hasData ? (
                <p className="text-lg font-bold text-primary">
                  {calories.toLocaleString("pt-BR")}
                  <span className="text-xs font-normal text-muted-foreground ml-1">kcal</span>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground italic">não registrado</p>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
