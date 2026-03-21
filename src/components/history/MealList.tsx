"use client"

import { useState } from "react"
import { MealDetail } from "./MealDetail"
import { cn } from "@/lib/utils"

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

interface MealListProps {
  initialMeals: HistoryMeal[]
  selectedDate: string
}

const mealIcons: Record<string, string> = {
  cafe: "☕",
  café: "☕",
  breakfast: "☕",
  almoco: "🍽️",
  almoço: "🍽️",
  lunch: "🍽️",
  lanche: "🍎",
  snack: "🍎",
  jantar: "🌙",
  dinner: "🌙",
}

function getMealIcon(mealType: string): string {
  const key = mealType.toLowerCase()
  for (const [k, icon] of Object.entries(mealIcons)) {
    if (key.includes(k)) return icon
  }
  return "🥘"
}

function formatMealType(mealType: string): string {
  const map: Record<string, string> = {
    cafe: "Café da manhã",
    café: "Café da manhã",
    breakfast: "Café da manhã",
    almoco: "Almoço",
    almoço: "Almoço",
    lunch: "Almoço",
    lanche: "Lanche",
    snack: "Lanche",
    jantar: "Jantar",
    dinner: "Jantar",
  }
  const key = mealType.toLowerCase()
  for (const [k, label] of Object.entries(map)) {
    if (key.includes(k)) return label
  }
  return mealType
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function MealList({ initialMeals }: MealListProps) {
  const [meals, setMeals] = useState<HistoryMeal[]>(initialMeals)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  function handleDelete(mealId: string) {
    setMeals((prev) => prev.filter((m) => m.id !== mealId))
    setExpandedId(null)
  }

  if (meals.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground text-sm">
        Nenhuma refeição registrada nesta data.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {meals.map((meal) => {
        const isExpanded = expandedId === meal.id
        return (
          <div
            key={meal.id}
            className={cn(
              "border rounded-xl overflow-hidden transition-colors",
              isExpanded ? "border-primary/40 bg-accent/20" : "border-border"
            )}
          >
            {/* Header row */}
            <button
              onClick={() => setExpandedId(isExpanded ? null : meal.id)}
              className="w-full flex items-center justify-between p-4 text-left hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className="text-2xl">{getMealIcon(meal.mealType)}</span>
                <div>
                  <p className="font-medium text-sm text-foreground">
                    {formatMealType(meal.mealType)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatTime(meal.registeredAt)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-semibold text-primary text-sm">
                  {meal.totalCalories.toLocaleString("pt-BR")} kcal
                </span>
                <svg
                  className={cn(
                    "w-4 h-4 text-muted-foreground transition-transform",
                    isExpanded && "rotate-180"
                  )}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </button>

            {/* Expanded detail */}
            {isExpanded && (
              <div className="px-4 pb-4 border-t border-border/50">
                <MealDetail meal={meal} onDelete={handleDelete} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
