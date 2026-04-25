"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { IngredientRow, type IngredientRowState } from "./IngredientRow"
import type { LabelOverride, RecipeWithIngredients } from "@/lib/recipes/types"

interface RecipeWizardProps {
  initial?: RecipeWithIngredients
}

interface ParseIngredientResult {
  foodName: string
  quantityGrams: number
  source: "taco" | "unknown"
  tacoId?: number
  tacoFoodBase?: string
  tacoFoodVariant?: string
  calories: number
  proteinG: number
  carbsG: number
  fatG: number
}

interface ParseIngredientsResponse {
  ingredients?: ParseIngredientResult[]
  error?: string
}

interface SaveRecipeResponse {
  id?: string
  error?: string
}

const NUMERIC_8_2_MAX = 999999.99
const NUMERIC_5_2_MAX = 999.99

function hasAtMostTwoDecimalPlaces(value: number): boolean {
  if (!Number.isFinite(value)) return false

  const cents = value * 100
  return Math.abs(Math.round(cents) - cents) < 1e-9
}

function isPositiveDecimal2(value: number, max: number): boolean {
  return value >= 0.01 && value <= max && hasAtMostTwoDecimalPlaces(value)
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

function mapInitialIngredients(initial?: RecipeWithIngredients): IngredientRowState[] {
  return (
    initial?.ingredients.map((ingredient) => ({
      foodName: ingredient.foodName,
      quantityGrams: ingredient.quantityGrams,
      source: ingredient.source,
      tacoId: ingredient.tacoId,
      tacoFoodBase: ingredient.tacoFoodBase,
      tacoFoodVariant: ingredient.tacoFoodVariant,
      labelOverride: ingredient.labelOverride,
      calories: ingredient.calories,
      proteinG: ingredient.proteinG,
      carbsG: ingredient.carbsG,
      fatG: ingredient.fatG,
    })) ?? []
  )
}

function ingredientFromParsed(parsed: ParseIngredientResult): IngredientRowState {
  return {
    foodName: parsed.foodName,
    quantityGrams: parsed.quantityGrams,
    source: parsed.source === "taco" ? "taco" : "user_label",
    tacoId: parsed.source === "taco" ? parsed.tacoId : undefined,
    tacoFoodBase: parsed.source === "taco" ? parsed.tacoFoodBase : undefined,
    tacoFoodVariant: parsed.source === "taco" ? parsed.tacoFoodVariant : undefined,
    calories: parsed.calories,
    proteinG: parsed.proteinG,
    carbsG: parsed.carbsG,
    fatG: parsed.fatG,
  }
}

function validateIngredients(ingredients: IngredientRowState[]): string | null {
  if (ingredients.length === 0) return "Adicione pelo menos um ingrediente."
  if (ingredients.length > 50) return "Use no máximo 50 ingredientes."

  for (const [index, ingredient] of ingredients.entries()) {
    const label = `Ingrediente ${index + 1}`

    if (!ingredient.foodName.trim()) return `${label}: informe o nome.`
    if (!isPositiveDecimal2(ingredient.quantityGrams, NUMERIC_8_2_MAX)) {
      return `${label}: informe gramas positivas com até 2 casas decimais.`
    }

    if (ingredient.source === "taco" && !ingredient.tacoId) {
      return `${label}: selecione um item TACO válido ou informe o rótulo.`
    }

    if (ingredient.source === "user_label" && !ingredient.labelOverride) {
      return `${label}: informe o rótulo nutricional.`
    }
  }

  return null
}

export function RecipeWizard({ initial }: RecipeWizardProps) {
  const router = useRouter()
  const [name, setName] = useState(initial?.name ?? "")
  const [ingredientText, setIngredientText] = useState("")
  const [ingredients, setIngredients] = useState<IngredientRowState[]>(
    mapInitialIngredients(initial),
  )
  const [totalWeight, setTotalWeight] = useState(
    initial ? String(initial.totalWeightGrams) : "",
  )
  const [servings, setServings] = useState(initial ? String(initial.servings) : "")
  const [notes, setNotes] = useState(initial?.notes ?? "")
  const [parseLoading, setParseLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const totalWeightValue = Number(totalWeight)
  const servingsValue = Number(servings)

  const preview = useMemo(() => {
    const totals = ingredients.reduce(
      (acc, ingredient) => ({
        calories: acc.calories + ingredient.calories,
        proteinG: acc.proteinG + ingredient.proteinG,
        carbsG: acc.carbsG + ingredient.carbsG,
        fatG: acc.fatG + ingredient.fatG,
      }),
      { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
    )

    if (servingsValue <= 0 || !Number.isFinite(servingsValue)) {
      return null
    }

    return {
      weightPerServing: totalWeightValue > 0 ? totalWeightValue / servingsValue : 0,
      calories: totals.calories / servingsValue,
      proteinG: totals.proteinG / servingsValue,
      carbsG: totals.carbsG / servingsValue,
      fatG: totals.fatG / servingsValue,
    }
  }, [ingredients, servingsValue, totalWeightValue])

  const validationError = useMemo(() => {
    if (!name.trim()) return "Informe o nome da receita."
    if (!isPositiveDecimal2(totalWeightValue, NUMERIC_8_2_MAX)) {
      return "Informe o peso final com até 2 casas decimais."
    }
    if (!isPositiveDecimal2(servingsValue, NUMERIC_5_2_MAX)) {
      return "Informe porções com até 2 casas decimais."
    }

    return validateIngredients(ingredients)
  }, [ingredients, name, servingsValue, totalWeightValue])

  async function handleParse() {
    setParseLoading(true)
    setError(null)

    try {
      const response = await fetch("/api/recipes/parse-ingredients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: ingredientText }),
      })
      const data = (await response.json()) as ParseIngredientsResponse

      if (!response.ok || !data.ingredients) {
        throw new Error(data.error ?? "parse_failed")
      }

      setIngredients(data.ingredients.map(ingredientFromParsed))
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "parse_failed")
    } finally {
      setParseLoading(false)
    }
  }

  function addManualIngredient() {
    setIngredients((current) => [
      ...current,
      {
        foodName: "",
        quantityGrams: 0,
        source: "user_label",
        calories: 0,
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
      },
    ])
  }

  async function recomputeIngredient(
    foodName: string,
    grams: number,
    override?: LabelOverride,
  ): Promise<Partial<IngredientRowState>> {
    if (override) {
      return {
        ...macrosFromOverride(grams, override),
        source: "user_label",
        labelOverride: override,
        tacoId: undefined,
        tacoFoodBase: undefined,
        tacoFoodVariant: undefined,
      }
    }

    if (!foodName.trim() || !Number.isFinite(grams) || grams <= 0) {
      return {
        source: "user_label",
        labelOverride: undefined,
        tacoId: undefined,
        tacoFoodBase: undefined,
        tacoFoodVariant: undefined,
        calories: 0,
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
      }
    }

    try {
      const response = await fetch("/api/recipes/parse-ingredients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `${grams}g ${foodName}` }),
      })
      const data = (await response.json()) as ParseIngredientsResponse
      const parsed = data.ingredients?.[0]

      if (!response.ok || !parsed || parsed.source !== "taco" || !parsed.tacoId) {
        return {
          source: "user_label",
          labelOverride: undefined,
          tacoId: undefined,
          tacoFoodBase: undefined,
          tacoFoodVariant: undefined,
          calories: 0,
          proteinG: 0,
          carbsG: 0,
          fatG: 0,
        }
      }

      return {
        source: "taco",
        tacoId: parsed.tacoId,
        tacoFoodBase: parsed.tacoFoodBase,
        tacoFoodVariant: parsed.tacoFoodVariant,
        labelOverride: undefined,
        calories: parsed.calories,
        proteinG: parsed.proteinG,
        carbsG: parsed.carbsG,
        fatG: parsed.fatG,
      }
    } catch {
      return {
        source: "user_label",
        labelOverride: undefined,
        tacoId: undefined,
        tacoFoodBase: undefined,
        tacoFoodVariant: undefined,
        calories: 0,
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
      }
    }
  }

  async function handleSave() {
    if (validationError) {
      setError(validationError)
      return
    }

    setSaving(true)
    setError(null)

    const payload = {
      name: name.trim(),
      totalWeightGrams: totalWeightValue,
      servings: servingsValue,
      notes: notes.trim() || undefined,
      ingredients: ingredients.map((ingredient, index) => {
        if (ingredient.source === "taco") {
          return {
            foodName: ingredient.foodName.trim(),
            quantityGrams: ingredient.quantityGrams,
            source: "taco" as const,
            tacoId: ingredient.tacoId,
            tacoFoodBase: ingredient.tacoFoodBase,
            tacoFoodVariant: ingredient.tacoFoodVariant,
            displayOrder: index,
          }
        }

        return {
          foodName: ingredient.foodName.trim(),
          quantityGrams: ingredient.quantityGrams,
          source: "user_label" as const,
          labelOverride: ingredient.labelOverride,
          displayOrder: index,
        }
      }),
    }

    try {
      const response = await fetch(initial ? `/api/recipes/${initial.id}` : "/api/recipes", {
        method: initial ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const data = (await response.json()) as SaveRecipeResponse

      if (!response.ok) {
        throw new Error(data.error ?? "save_failed")
      }

      const recipeId = initial?.id ?? data.id
      if (!recipeId) {
        throw new Error("save_failed")
      }

      router.push(`/recipes/${recipeId}`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "save_failed")
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Receita</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="recipe-name">Nome da receita</Label>
            <Input
              id="recipe-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Nome"
              maxLength={120}
            />
          </div>

          {!initial && (
            <div className="space-y-2">
              <Label htmlFor="recipe-ingredients-text">Ingredientes</Label>
              <textarea
                id="recipe-ingredients-text"
                value={ingredientText}
                onChange={(event) => setIngredientText(event.target.value)}
                placeholder="200g arroz, 100g feijão, 150g peito de frango"
                className="min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <Button
                type="button"
                onClick={handleParse}
                disabled={parseLoading || ingredientText.trim().length < 3}
              >
                {parseLoading ? "Analisando..." : "Analisar ingredientes"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ingredientes</CardTitle>
        </CardHeader>
        <CardContent>
          {ingredients.length > 0 && (
            <div>
              {ingredients.map((ingredient, index) => (
                <IngredientRow
                  key={index}
                  index={index}
                  value={ingredient}
                  onChange={(next) => {
                    setIngredients((current) =>
                      current.map((row, rowIndex) => (rowIndex === index ? next : row)),
                    )
                  }}
                  onRemove={() => {
                    setIngredients((current) =>
                      current.filter((_, rowIndex) => rowIndex !== index),
                    )
                  }}
                  onRecompute={recomputeIngredient}
                />
              ))}
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addManualIngredient}
            className="mt-3"
          >
            <Plus data-icon="inline-start" />
            ingrediente manual
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rendimento</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="recipe-total-weight">Peso final (g)</Label>
              <Input
                id="recipe-total-weight"
                type="number"
                min={0.01}
                max={NUMERIC_8_2_MAX}
                step="0.01"
                value={totalWeight}
                onChange={(event) => setTotalWeight(event.target.value)}
                placeholder="g"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recipe-servings">Porções</Label>
              <Input
                id="recipe-servings"
                type="number"
                min={0.01}
                max={NUMERIC_5_2_MAX}
                step="0.01"
                value={servings}
                onChange={(event) => setServings(event.target.value)}
                placeholder="1"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="recipe-notes">Notas</Label>
            <Input
              id="recipe-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Opcional"
              maxLength={1000}
            />
          </div>

          {preview && totalWeightValue > 0 && (
            <div className="grid gap-2 rounded-lg bg-muted p-3 text-sm sm:grid-cols-5">
              <div>
                <span className="text-muted-foreground">Peso/porção</span>
                <div className="font-medium tabular-nums">
                  {roundMacro(preview.weightPerServing)}g
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">kcal</span>
                <div className="font-medium tabular-nums">
                  {roundMacro(preview.calories)}
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Proteína</span>
                <div className="font-medium tabular-nums">
                  {roundMacro(preview.proteinG)}g
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Carboidratos</span>
                <div className="font-medium tabular-nums">
                  {roundMacro(preview.carbsG)}g
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Gorduras</span>
                <div className="font-medium tabular-nums">
                  {roundMacro(preview.fatG)}g
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {(error || validationError) && (
        <p className="text-sm text-destructive">{error ?? validationError}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={handleSave} disabled={saving || Boolean(validationError)}>
          {saving ? "Salvando..." : initial ? "Atualizar" : "Salvar receita"}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}
