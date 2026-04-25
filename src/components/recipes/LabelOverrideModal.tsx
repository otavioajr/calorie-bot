"use client"

import { useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { LabelOverride } from "@/lib/recipes/types"

interface LabelOverrideModalProps {
  open: boolean
  initial?: LabelOverride
  onClose: () => void
  onSave: (override: LabelOverride) => void
}

type FieldKey = keyof LabelOverride

const FIELD_LIMITS: Record<FieldKey, number> = {
  kcalPer100g: 900,
  proteinPer100g: 100,
  carbsPer100g: 100,
  fatPer100g: 100,
  fiberPer100g: 100,
  sodiumPer100g: 100000,
}

function toInputValue(value: number | undefined): string {
  return value === undefined ? "" : String(value)
}

function parseOptionalNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined
  return Number(value)
}

function isValidRequired(value: string, max: number): boolean {
  const parsed = Number(value)
  return value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 && parsed <= max
}

function isValidOptional(value: string, max: number): boolean {
  const parsed = parseOptionalNumber(value)
  return parsed === undefined || (Number.isFinite(parsed) && parsed >= 0 && parsed <= max)
}

export function LabelOverrideModal({
  open,
  initial,
  onClose,
  onSave,
}: LabelOverrideModalProps) {
  const [kcal, setKcal] = useState(toInputValue(initial?.kcalPer100g))
  const [protein, setProtein] = useState(toInputValue(initial?.proteinPer100g))
  const [carbs, setCarbs] = useState(toInputValue(initial?.carbsPer100g))
  const [fat, setFat] = useState(toInputValue(initial?.fatPer100g))
  const [fiber, setFiber] = useState(toInputValue(initial?.fiberPer100g))
  const [sodium, setSodium] = useState(toInputValue(initial?.sodiumPer100g))
  const [error, setError] = useState<string | null>(null)

  const canSave = useMemo(
    () =>
      isValidRequired(kcal, FIELD_LIMITS.kcalPer100g) &&
      isValidRequired(protein, FIELD_LIMITS.proteinPer100g) &&
      isValidRequired(carbs, FIELD_LIMITS.carbsPer100g) &&
      isValidRequired(fat, FIELD_LIMITS.fatPer100g) &&
      isValidOptional(fiber, FIELD_LIMITS.fiberPer100g) &&
      isValidOptional(sodium, FIELD_LIMITS.sodiumPer100g),
    [carbs, fat, fiber, kcal, protein, sodium],
  )

  function handleSave() {
    if (!canSave) {
      setError("Preencha os macros obrigatórios com valores válidos.")
      return
    }

    const override: LabelOverride = {
      kcalPer100g: Number(kcal),
      proteinPer100g: Number(protein),
      carbsPer100g: Number(carbs),
      fatPer100g: Number(fat),
    }

    const fiberValue = parseOptionalNumber(fiber)
    const sodiumValue = parseOptionalNumber(sodium)

    if (fiberValue !== undefined) override.fiberPer100g = fiberValue
    if (sodiumValue !== undefined) override.sodiumPer100g = sodiumValue

    onSave(override)
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Tabela nutricional por 100g</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="label-kcal">kcal *</Label>
            <Input
              id="label-kcal"
              type="number"
              min={0}
              max={FIELD_LIMITS.kcalPer100g}
              step="0.01"
              value={kcal}
              onChange={(event) => setKcal(event.target.value)}
              placeholder="0"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="label-protein">Proteína (g) *</Label>
            <Input
              id="label-protein"
              type="number"
              min={0}
              max={FIELD_LIMITS.proteinPer100g}
              step="0.01"
              value={protein}
              onChange={(event) => setProtein(event.target.value)}
              placeholder="0"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="label-carbs">Carboidratos (g) *</Label>
            <Input
              id="label-carbs"
              type="number"
              min={0}
              max={FIELD_LIMITS.carbsPer100g}
              step="0.01"
              value={carbs}
              onChange={(event) => setCarbs(event.target.value)}
              placeholder="0"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="label-fat">Gorduras (g) *</Label>
            <Input
              id="label-fat"
              type="number"
              min={0}
              max={FIELD_LIMITS.fatPer100g}
              step="0.01"
              value={fat}
              onChange={(event) => setFat(event.target.value)}
              placeholder="0"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="label-fiber">Fibra (g)</Label>
            <Input
              id="label-fiber"
              type="number"
              min={0}
              max={FIELD_LIMITS.fiberPer100g}
              step="0.01"
              value={fiber}
              onChange={(event) => setFiber(event.target.value)}
              placeholder="0"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="label-sodium">Sódio (mg)</Label>
            <Input
              id="label-sodium"
              type="number"
              min={0}
              max={FIELD_LIMITS.sodiumPer100g}
              step="0.01"
              value={sodium}
              onChange={(event) => setSodium(event.target.value)}
              placeholder="0"
            />
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" onClick={handleSave} disabled={!canSave}>
            Aplicar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
