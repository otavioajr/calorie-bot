import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Recipe } from "@/lib/recipes/types"

const push = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}))

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string
    children: React.ReactNode
  }) => <a href={href}>{children}</a>,
}))

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    children: React.ReactNode
  }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (value: string) => void
    children: React.ReactNode
  }) => (
    <select
      aria-label="Tipo de refeição"
      value={value}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <>{placeholder}</>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectItem: ({
    value,
    children,
  }: {
    value: string
    children: React.ReactNode
  }) => <option value={value}>{children}</option>,
}))

const recipe: Recipe = {
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
  notes: null,
  createdAt: "2026-04-25T10:00:00.000Z",
  updatedAt: "2026-04-25T10:00:00.000Z",
}

function expectedLocalDateTime(date = new Date()) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)

  return localDate.toISOString().slice(0, 16)
}

describe("RecipeList", () => {
  it("shows an empty state with a creation CTA", async () => {
    const { RecipeList } = await import("@/components/recipes/RecipeList")

    render(<RecipeList recipes={[]} />)

    expect(
      screen.getByText("Salve uma receita que você repete.")
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        "Pratos caseiros ficam mais fáceis de registrar quando rendimento, porção e macros já estão calculados."
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Criar primeira receita" })
    ).toHaveAttribute("href", "/recipes/new")
  })

  it("renders compact recipe cards linked to detail pages", async () => {
    const { RecipeList } = await import("@/components/recipes/RecipeList")

    render(<RecipeList recipes={[recipe]} />)

    expect(screen.getByRole("link", { name: /Panqueca de banana/ })).toHaveAttribute(
      "href",
      "/recipes/recipe-1"
    )
    expect(screen.getByText("100g/porção")).toBeInTheDocument()
    expect(screen.getByText("180 kcal/porção")).toBeInTheDocument()
    expect(screen.getByText("P 8.0g")).toBeInTheDocument()
    expect(screen.getByText("C 26.0g")).toBeInTheDocument()
    expect(screen.getByText("G 5.0g")).toBeInTheDocument()
  })
})

describe("LogRecipeModal", () => {
  beforeEach(() => {
    push.mockClear()
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("posts the selected servings, meal type, and local datetime before routing to history", async () => {
    const { LogRecipeModal } = await import("@/components/recipes/LogRecipeModal")
    const onClose = vi.fn()
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response)

    render(<LogRecipeModal recipeId="recipe-1" open onClose={onClose} />)

    fireEvent.change(screen.getByLabelText("Porções consumidas"), {
      target: { value: "1.5" },
    })
    fireEvent.change(screen.getByLabelText("Tipo de refeição"), {
      target: { value: "snack" },
    })
    fireEvent.change(screen.getByLabelText("Data e hora"), {
      target: { value: "2026-04-25T12:30" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Registrar" }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/recipes/recipe-1/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          servingsConsumed: 1.5,
          mealType: "snack",
          registeredAt: new Date("2026-04-25T12:30").toISOString(),
        }),
      })
    })
    expect(onClose).toHaveBeenCalledOnce()
    expect(push).toHaveBeenCalledWith("/history")
  })

  it("does not submit nonpositive servings", async () => {
    const { LogRecipeModal } = await import("@/components/recipes/LogRecipeModal")
    const fetchMock = vi.mocked(fetch)

    render(<LogRecipeModal recipeId="recipe-1" open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText("Porções consumidas"), {
      target: { value: "0" },
    })
    expect(screen.getByRole("button", { name: "Registrar" })).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Registrar" }))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does not submit servings above the API limit", async () => {
    const { LogRecipeModal } = await import("@/components/recipes/LogRecipeModal")
    const fetchMock = vi.mocked(fetch)

    render(<LogRecipeModal recipeId="recipe-1" open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText("Porções consumidas"), {
      target: { value: "1000" },
    })
    expect(screen.getByLabelText("Porções consumidas")).toHaveAttribute("max", "999.99")
    expect(screen.getByRole("button", { name: "Registrar" })).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Registrar" }))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refreshes the default datetime when opened after staying mounted", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-25T13:00:00.000Z"))

    const { LogRecipeModal } = await import("@/components/recipes/LogRecipeModal")
    const { rerender } = render(
      <LogRecipeModal recipeId="recipe-1" open={false} onClose={vi.fn()} />
    )

    vi.setSystemTime(new Date("2026-04-25T15:30:00.000Z"))
    rerender(<LogRecipeModal recipeId="recipe-1" open onClose={vi.fn()} />)

    expect(screen.getByLabelText("Data e hora")).toHaveValue(
      expectedLocalDateTime()
    )

    rerender(<LogRecipeModal recipeId="recipe-1" open={false} onClose={vi.fn()} />)
    vi.setSystemTime(new Date("2026-04-25T17:45:00.000Z"))
    rerender(<LogRecipeModal recipeId="recipe-1" open onClose={vi.fn()} />)

    expect(screen.getByLabelText("Data e hora")).toHaveValue(
      expectedLocalDateTime()
    )
  })

  it("restores transient form defaults when reopened after local edits and an error", async () => {
    const { LogRecipeModal } = await import("@/components/recipes/LogRecipeModal")
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "recipe_not_found" }),
    } as Response)

    const { rerender } = render(
      <LogRecipeModal recipeId="recipe-1" open onClose={vi.fn()} />
    )

    fireEvent.change(screen.getByLabelText("Tipo de refeição"), {
      target: { value: "dinner" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Registrar" }))

    expect(
      await screen.findByText("Não foi possível registrar a receita. Código: recipe_not_found")
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText("Porções consumidas"), {
      target: { value: "0" },
    })
    expect(screen.getByRole("button", { name: "Registrar" })).toBeDisabled()

    rerender(<LogRecipeModal recipeId="recipe-1" open={false} onClose={vi.fn()} />)
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-25T15:30:00.000Z"))
    rerender(<LogRecipeModal recipeId="recipe-1" open onClose={vi.fn()} />)

    expect(screen.getByLabelText("Porções consumidas")).toHaveValue(1)
    expect(screen.getByLabelText("Tipo de refeição")).toHaveValue("lunch")
    expect(screen.getByLabelText("Data e hora")).toHaveValue(
      expectedLocalDateTime()
    )
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Registrar" })).toBeEnabled()
  })

  it("shows a sanitized error when the request fails", async () => {
    const { LogRecipeModal } = await import("@/components/recipes/LogRecipeModal")
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        error: "recipe_not_found",
        details: "service role stack trace",
      }),
    } as Response)

    render(<LogRecipeModal recipeId="recipe-1" open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole("button", { name: "Registrar" }))

    expect(
      await screen.findByText("Não foi possível registrar a receita. Código: recipe_not_found")
    ).toBeInTheDocument()
    expect(screen.queryByText(/service role stack trace/i)).not.toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })
})
