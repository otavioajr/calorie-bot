import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RecipeWithIngredients } from "@/lib/recipes/types"

const back = vi.fn()
const push = vi.fn()
const refresh = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back, push, refresh }),
}))

vi.mock("@/components/recipes/RecipeWizard", () => ({
  RecipeWizard: ({
    onCancel,
    onSaved,
  }: {
    onCancel?: () => void
    onSaved?: (recipeId: string) => void
  }) => (
    <div>
      <p>Wizard mock</p>
      <button type="button" onClick={onCancel}>
        Cancelar wizard
      </button>
      <button type="button" onClick={() => onSaved?.("recipe-1")}>
        Salvar wizard
      </button>
    </div>
  ),
}))

vi.mock("@/components/recipes/LogRecipeModal", () => ({
  LogRecipeModal: () => null,
}))

const recipe: RecipeWithIngredients = {
  id: "recipe-1",
  userId: "user-1",
  name: "Panqueca de banana",
  totalWeightGrams: 300,
  servings: 3,
  weightPerServingGrams: 100,
  totalCalories: 540,
  totalProteinG: 24,
  totalCarbsG: 78,
  totalFatG: 15,
  perServingCalories: 180,
  perServingProteinG: 8,
  perServingCarbsG: 26,
  perServingFatG: 5,
  notes: "Sem açúcar",
  createdAt: "2026-04-25T10:00:00.000Z",
  updatedAt: "2026-04-25T10:00:00.000Z",
  ingredients: [
    {
      id: "ingredient-1",
      recipeId: "recipe-1",
      foodName: "Banana",
      quantityGrams: 100,
      source: "user_label",
      tacoId: null,
      tacoFoodBase: null,
      tacoFoodVariant: null,
      labelOverride: {
        kcalPer100g: 90,
        proteinPer100g: 1,
        carbsPer100g: 22,
        fatPer100g: 0.3,
      },
      displayOrder: 0,
      calories: 90,
      proteinG: 1,
      carbsG: 22,
      fatG: 0.3,
    },
  ],
}

describe("RecipeDetailClient", () => {
  beforeEach(() => {
    back.mockClear()
    push.mockClear()
    refresh.mockClear()
  })

  it("exits edit mode on cancel without navigating back", async () => {
    const { RecipeDetailClient } = await import("@/components/recipes/RecipeDetailClient")

    render(<RecipeDetailClient recipe={recipe} />)

    fireEvent.click(screen.getByRole("button", { name: "Editar" }))
    expect(screen.getByText("Wizard mock")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Cancelar wizard" }))

    expect(screen.getByRole("heading", { name: "Panqueca de banana" })).toBeInTheDocument()
    expect(screen.getByText("Sem açúcar")).toBeInTheDocument()
    expect(back).not.toHaveBeenCalled()
  })

  it("exits edit mode and refreshes server data after save", async () => {
    const { RecipeDetailClient } = await import("@/components/recipes/RecipeDetailClient")

    render(<RecipeDetailClient recipe={recipe} />)

    fireEvent.click(screen.getByRole("button", { name: "Editar" }))
    expect(screen.getByText("Wizard mock")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Salvar wizard" }))

    expect(screen.getByRole("heading", { name: "Panqueca de banana" })).toBeInTheDocument()
    expect(refresh).toHaveBeenCalledOnce()
    expect(push).not.toHaveBeenCalled()
  })
})
