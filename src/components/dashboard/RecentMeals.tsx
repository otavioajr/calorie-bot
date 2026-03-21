"use client"

interface RecentMeal {
  id: string
  mealType: string
  totalCalories: number
  registeredAt: string
}

interface RecentMealsProps {
  meals: RecentMeal[]
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

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  })
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

export function RecentMeals({ meals }: RecentMealsProps) {
  if (meals.length === 0) {
    return (
      <div className="py-8 text-center text-muted-foreground text-sm">
        Nenhuma refeição registrada recentemente.
      </div>
    )
  }

  return (
    <ul className="divide-y divide-border">
      {meals.map((meal) => (
        <li key={meal.id} className="flex items-center justify-between py-3 gap-3">
          <div className="flex items-center gap-3">
            <span className="text-2xl w-8 text-center">{getMealIcon(meal.mealType)}</span>
            <div>
              <p className="text-sm font-medium text-foreground">
                {formatMealType(meal.mealType)}
              </p>
              <p className="text-xs text-muted-foreground">{formatTime(meal.registeredAt)}</p>
            </div>
          </div>
          <span className="text-sm font-semibold text-primary whitespace-nowrap">
            {meal.totalCalories.toLocaleString("pt-BR")} kcal
          </span>
        </li>
      ))}
    </ul>
  )
}
