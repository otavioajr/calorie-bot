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
  onRecompute: (
    foodName: string,
    grams: number,
    override?: LabelOverride,
  ) => Promise<Partial<IngredientRowState>>
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

export function IngredientRow({
  index,
  value,
  onChange,
  onRemove,
  onRecompute,
}: IngredientRowProps) {
  const [labelOpen, setLabelOpen] = useState(false)
  const [nameDraft, setNameDraft] = useState("")
  const [gramsDraft, setGramsDraft] = useState("")
  const [editingName, setEditingName] = useState(false)
  const [editingGrams, setEditingGrams] = useState(false)
  const [recomputing, setRecomputing] = useState(false)

  function updateName(foodName: string) {
    setNameDraft(foodName)

    if (value.source !== "taco") return

    onChange({
      ...value,
      foodName,
      source: "user_label",
      labelOverride: undefined,
      tacoId: undefined,
      tacoFoodBase: undefined,
      tacoFoodVariant: undefined,
      calories: 0,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
    })
  }

  function updateGrams(input: string) {
    setGramsDraft(input)

    const quantityGrams = Number(input)
    const emptyMacros = {
      calories: 0,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
    }

    onChange({
      ...value,
      ...(value.labelOverride && Number.isFinite(quantityGrams)
        ? macrosFromOverride(quantityGrams, value.labelOverride)
        : emptyMacros),
      quantityGrams,
    })
  }

  async function commitDraft() {
    const foodName = (editingName ? nameDraft : value.foodName).trim()
    const quantityGrams = Number(editingGrams ? gramsDraft : value.quantityGrams)

    if (!foodName || !Number.isFinite(quantityGrams)) {
      onChange({
        ...value,
        foodName,
        quantityGrams,
        source: "user_label",
        labelOverride: undefined,
        tacoId: undefined,
        tacoFoodBase: undefined,
        tacoFoodVariant: undefined,
        calories: 0,
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
      })
      setEditingName(false)
      setEditingGrams(false)
      return
    }

    setRecomputing(true)
    try {
      const partial = await onRecompute(foodName, quantityGrams, value.labelOverride)
      onChange({
        ...value,
        ...partial,
        foodName,
        quantityGrams,
      })
    } finally {
      setRecomputing(false)
      setEditingName(false)
      setEditingGrams(false)
    }
  }

  function handleCommitKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return

    event.currentTarget.blur()
  }

  async function applyLabel(labelOverride: LabelOverride) {
    const foodName = (editingName ? nameDraft : value.foodName).trim()
    const quantityGrams = Number(editingGrams ? gramsDraft : value.quantityGrams)
    const validGrams = Number.isFinite(quantityGrams) ? quantityGrams : value.quantityGrams

    setRecomputing(true)
    try {
      const partial = await onRecompute(foodName, validGrams, labelOverride)
      onChange({
        ...value,
        ...partial,
        foodName,
        quantityGrams: validGrams,
        source: "user_label",
        labelOverride,
        tacoId: undefined,
        tacoFoodBase: undefined,
        tacoFoodVariant: undefined,
      })
      setLabelOpen(false)
    } finally {
      setRecomputing(false)
      setEditingName(false)
      setEditingGrams(false)
    }
  }

  const isLabelPending = value.source === "user_label" && !value.labelOverride
  const displayedName = editingName ? nameDraft : value.foodName
  const displayedGrams = editingGrams ? gramsDraft : String(value.quantityGrams)

  return (
    <div className="grid gap-2 border-b py-3 last:border-b-0 md:grid-cols-[2rem_minmax(12rem,1fr)_7rem_5rem_6rem_auto] md:items-center">
      <div className="text-sm text-muted-foreground">{index + 1}</div>

      <Input
        value={displayedName}
        onFocus={() => {
          setNameDraft(value.foodName)
          setEditingName(true)
        }}
        onChange={(event) => updateName(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={handleCommitKeyDown}
        placeholder="Ingrediente"
        aria-label={`Ingrediente ${index + 1}`}
        disabled={recomputing}
      />

      <div className="relative">
        <Input
          type="number"
          min={0.01}
          step="0.01"
          value={displayedGrams}
          onFocus={() => {
            setGramsDraft(String(value.quantityGrams))
            setEditingGrams(true)
          }}
          onChange={(event) => updateGrams(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={handleCommitKeyDown}
          placeholder="g"
          aria-label={`Gramas do ingrediente ${index + 1}`}
          className="pr-7"
          disabled={recomputing}
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          g
        </span>
      </div>

      <div className="text-sm tabular-nums">
        {recomputing ? "..." : `${roundMacro(value.calories)} kcal`}
      </div>

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
