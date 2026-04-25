import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import {
  IngredientRow,
  type IngredientRowState,
} from "@/components/recipes/IngredientRow"
import type { LabelOverride } from "@/lib/recipes/types"

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })

  return { promise, resolve }
}

const initialRow: IngredientRowState = {
  clientId: "ingredient-1",
  foodName: "Arroz",
  quantityGrams: 100,
  source: "taco",
  tacoId: 10,
  tacoFoodBase: "Arroz",
  tacoFoodVariant: "cozido",
  calories: 128,
  proteinG: 2.5,
  carbsG: 28.1,
  fatG: 0.2,
}

describe("IngredientRow", () => {
  it("ignores stale recompute completions after a newer label override", async () => {
    const oldRecompute = deferred<Partial<IngredientRowState>>()
    const labelRecompute = deferred<Partial<IngredientRowState>>()
    const onRecompute = vi
      .fn()
      .mockReturnValueOnce(oldRecompute.promise)
      .mockReturnValueOnce(labelRecompute.promise)
    const changes: IngredientRowState[] = []

    function Harness() {
      const [row, setRow] = useState(initialRow)

      return (
        <IngredientRow
          index={0}
          value={row}
          onChange={(next) => {
            changes.push(next)
            setRow(next)
          }}
          onRemove={vi.fn()}
          onRecompute={onRecompute}
        />
      )
    }

    render(<Harness />)

    fireEvent.click(screen.getByRole("button", { name: "Editar rótulo" }))

    fireEvent.focus(screen.getByLabelText("Ingrediente 1"))
    fireEvent.change(screen.getByLabelText("Ingrediente 1"), {
      target: { value: "Aveia" },
    })
    fireEvent.blur(screen.getByLabelText("Ingrediente 1"))

    await waitFor(() => expect(onRecompute).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByLabelText(/kcal/i), { target: { value: "200" } })
    fireEvent.change(screen.getByLabelText(/proteína/i), { target: { value: "8" } })
    fireEvent.change(screen.getByLabelText(/carboidratos/i), { target: { value: "20" } })
    fireEvent.change(screen.getByLabelText(/gorduras/i), { target: { value: "5" } })
    fireEvent.click(screen.getByRole("button", { name: "Aplicar" }))

    await waitFor(() => expect(onRecompute).toHaveBeenCalledTimes(2))

    const labelOverride: LabelOverride = {
      kcalPer100g: 200,
      proteinPer100g: 8,
      carbsPer100g: 20,
      fatPer100g: 5,
    }

    await act(async () => {
      labelRecompute.resolve({
        source: "user_label",
        labelOverride,
        calories: 200,
        proteinG: 8,
        carbsG: 20,
        fatG: 5,
      })
    })

    await waitFor(() => {
      expect(changes.at(-1)).toMatchObject({
        source: "user_label",
        labelOverride,
        tacoId: undefined,
      })
    })

    await act(async () => {
      oldRecompute.resolve({
        source: "taco",
        labelOverride: undefined,
        tacoId: 11,
        tacoFoodBase: "Aveia",
        tacoFoodVariant: "crua",
        calories: 389,
        proteinG: 16.9,
        carbsG: 66.3,
        fatG: 6.9,
      })
    })

    expect(changes.at(-1)).toMatchObject({
      source: "user_label",
      labelOverride,
      tacoId: undefined,
      calories: 200,
    })
  })
})
