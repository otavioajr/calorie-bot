"use client"

import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"

interface CalorieProgressProps {
  consumed: number
  target: number
}

export function CalorieProgress({ consumed, target }: CalorieProgressProps) {
  const percentage = target > 0 ? Math.min(Math.round((consumed / target) * 100), 150) : 0
  const displayPercentage = target > 0 ? Math.round((consumed / target) * 100) : 0

  const colorClass =
    displayPercentage > 100
      ? "text-destructive"
      : displayPercentage >= 80
        ? "text-secondary"
        : "text-primary"

  const progressColorClass =
    displayPercentage > 100
      ? "[&>div]:bg-destructive"
      : displayPercentage >= 80
        ? "[&>div]:bg-secondary"
        : "[&>div]:bg-primary"

  const remaining = target - consumed
  const isOver = remaining < 0

  return (
    <div className="space-y-4">
      {/* Big number display */}
      <div className="flex items-end justify-between">
        <div>
          <p className="text-sm text-muted-foreground mb-1">Calorias consumidas</p>
          <div className="flex items-baseline gap-2">
            <span className={cn("text-4xl font-bold", colorClass)}>
              {consumed.toLocaleString("pt-BR")}
            </span>
            <span className="text-muted-foreground text-sm">/ {target.toLocaleString("pt-BR")} kcal</span>
          </div>
        </div>
        <div className="text-right">
          <p className="text-sm text-muted-foreground mb-1">
            {isOver ? "Excedido" : "Restante"}
          </p>
          <span className={cn("text-2xl font-semibold", isOver ? "text-destructive" : "text-foreground")}>
            {Math.abs(remaining).toLocaleString("pt-BR")} kcal
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <Progress
        value={percentage}
        className={cn("h-4 rounded-full", progressColorClass)}
      />

      {/* Percentage label */}
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>0 kcal</span>
        <span className={cn("font-medium text-sm", colorClass)}>
          {displayPercentage}%
        </span>
        <span>{target.toLocaleString("pt-BR")} kcal</span>
      </div>

      {/* Status message */}
      <p className={cn("text-sm text-center font-medium", colorClass)}>
        {displayPercentage > 100
          ? "⚠️ Meta diária excedida!"
          : displayPercentage >= 80
            ? "⚡ Quase atingindo a meta"
            : displayPercentage >= 50
              ? "👍 No caminho certo"
              : "🌱 Começando o dia"}
      </p>
    </div>
  )
}
