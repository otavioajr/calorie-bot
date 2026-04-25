"use client"

import { useState } from "react"
import { Minus, Tag, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { LabelOverrideModal } from "./LabelOverrideModal"
import type { LabelOverride } from "@/lib/recipes/types"

export interface IngredientRowState {
  foodName: string
  quantityGrams: number
  source: "taco" | "user_label"
  tacoId?: number
  tacoFoodBase?: string
  tacoFoodVariant?: string
  labelOverride?: LabelOverride
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}

interface IngredientRowProps {
  index: number
  value: IngredientRowState
  onChange: (next: IngredientRowState) => void
  onRemove: () => void
}

function roundMacro(value: number): number {
  return Math.round(value * 10) / 10
}

function macrosFromOverride(grams: number, override: LabelOverride) {
  const factor = grams / 100

  return {
    calories: roundMacro(override.kcalPer100g * factor),
    proteinG: roundMacro(override.proteinPer100g * factor),
    carbsG: roundMacro(override.carbsPer100g * factor),
    fatG: roundMacro(override.fatPer100g * factor),
  }
}

function scaleMacros(row: IngredientRowState, nextGrams: number) {
  if (!Number.isFinite(nextGrams) || nextGrams <= 0 || row.quantityGrams <= 0) {
    return {
      calories: 0,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
    }
  }

  const ratio = nextGrams / row.quantityGrams

  return {
    calories: roundMacro(row.calories * ratio),
    proteinG: roundMacro(row.proteinG * ratio),
    carbsG: roundMacro(row.carbsG * ratio),
    fatG: roundMacro(row.fatG * ratio),
  }
}

export function IngredientRow({
  index,
  value,
  onChange,
  onRemove,
}: IngredientRowProps) {
  const [labelOpen, setLabelOpen] = useState(false)

  function updateName(foodName: string) {
    onChange({ ...value, foodName })
  }

  function updateGrams(input: string) {
    const quantityGrams = Number(input)
    const nextMacros = value.labelOverride
      ? macrosFromOverride(quantityGrams, value.labelOverride)
      : scaleMacros(value, quantityGrams)

    onChange({
      ...value,
      ...nextMacros,
      quantityGrams,
    })
  }

  function applyLabel(labelOverride: LabelOverride) {
    onChange({
      ...value,
      ...macrosFromOverride(value.quantityGrams, labelOverride),
      source: "user_label",
      labelOverride,
      tacoId: undefined,
      tacoFoodBase: undefined,
      tacoFoodVariant: undefined,
    })
    setLabelOpen(false)
  }

  const isLabelPending = value.source === "user_label" && !value.labelOverride

  return (
    <div className="grid gap-2 border-b py-3 last:border-b-0 md:grid-cols-[2rem_minmax(12rem,1fr)_7rem_5rem_6rem_auto] md:items-center">
      <div className="text-sm text-muted-foreground">{index + 1}</div>

      <Input
        value={value.foodName}
        onChange={(event) => updateName(event.target.value)}
        placeholder="Ingrediente"
        aria-label={`Ingrediente ${index + 1}`}
      />

      <div className="relative">
        <Input
          type="number"
          min={0.01}
          step="0.01"
          value={Number.isFinite(value.quantityGrams) ? String(value.quantityGrams) : ""}
          onChange={(event) => updateGrams(event.target.value)}
          placeholder="g"
          aria-label={`Gramas do ingrediente ${index + 1}`}
          className="pr-7"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          g
        </span>
      </div>

      <div className="text-sm tabular-nums">{roundMacro(value.calories)} kcal</div>

      <div
        className={cn(
          "w-fit rounded-lg px-2 py-1 text-xs font-medium",
          value.source === "taco"
            ? "bg-primary/10 text-primary"
            : isLabelPending
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground",
        )}
      >
        {value.source === "taco" ? "TACO" : isLabelPending ? "rótulo pendente" : "rótulo"}
      </div>

      <div className="flex items-center gap-1 md:justify-end">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={() => setLabelOpen(true)}
          aria-label="Editar rótulo"
          title="Editar rótulo"
        >
          <Tag />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label="Remover ingrediente"
          title="Remover ingrediente"
        >
          <Trash2 />
        </Button>
      </div>

      {value.source === "user_label" && !value.labelOverride && (
        <div className="flex items-center gap-1 text-xs text-destructive md:col-start-2 md:col-end-7">
          <Minus className="size-3" />
          Informe a tabela nutricional antes de salvar.
        </div>
      )}

      {labelOpen && (
        <LabelOverrideModal
          open={labelOpen}
          initial={value.labelOverride}
          onClose={() => setLabelOpen(false)}
          onSave={applyLabel}
        />
      )}
    </div>
  )
}
