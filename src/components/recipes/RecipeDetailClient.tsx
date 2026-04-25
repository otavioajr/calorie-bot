"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Edit3, Trash2, Utensils } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { LogRecipeModal } from "@/components/recipes/LogRecipeModal"
import { RecipeWizard } from "@/components/recipes/RecipeWizard"
import type { IngredientSource, RecipeWithIngredients } from "@/lib/recipes/types"

interface RecipeDetailClientProps {
  recipe: RecipeWithIngredients
}

function formatNumber(value: number, digits = 1) {
  return value.toLocaleString("pt-BR", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })
}

function formatWeight(value: number) {
  return `${formatNumber(value, value % 1 === 0 ? 0 : 1)}g`
}

function sourceLabel(source: IngredientSource) {
  return source === "taco" ? "TACO" : "Rótulo"
}

function MacroBlock({
  title,
  calories,
  protein,
  carbs,
  fat,
}: {
  title: string
  calories: number
  protein: number
  carbs: number
  fat: number
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted-foreground">kcal</div>
            <div className="font-medium tabular-nums">{formatNumber(calories)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Proteína</div>
            <div className="font-medium tabular-nums">{formatNumber(protein)}g</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Carboidratos</div>
            <div className="font-medium tabular-nums">{formatNumber(carbs)}g</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Gorduras</div>
            <div className="font-medium tabular-nums">{formatNumber(fat)}g</div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function RecipeDetailClient({ recipe }: RecipeDetailClientProps) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  async function handleDelete() {
    setDeleting(true)
    setDeleteError(null)

    try {
      const response = await fetch(`/api/recipes/${recipe.id}`, { method: "DELETE" })

      if (!response.ok) {
        throw new Error("delete_failed")
      }

      router.push("/recipes")
      router.refresh()
    } catch {
      setDeleteError("Não foi possível excluir a receita. Tente novamente.")
      setDeleting(false)
    }
  }

  if (editing) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Editar receita</h1>
          <p className="mt-1 text-sm text-muted-foreground">{recipe.name}</p>
        </div>

        <RecipeWizard initial={recipe} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{recipe.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatWeight(recipe.totalWeightGrams)} no total · {formatNumber(recipe.servings, 2)}{" "}
            porções · {formatWeight(recipe.weightPerServingGrams)}/porção
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => setLogOpen(true)}>
            <Utensils data-icon="inline-start" />
            Registrar
          </Button>
          <Button type="button" variant="outline" onClick={() => setEditing(true)}>
            <Edit3 data-icon="inline-start" />
            Editar
          </Button>
          <AlertDialog>
            <AlertDialogTrigger render={<Button type="button" variant="destructive" />}>
              <Trash2 data-icon="inline-start" />
              Excluir
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Excluir receita?</AlertDialogTitle>
                <AlertDialogDescription>
                  A receita será removida da sua lista. Refeições já registradas com ela serão
                  preservadas no histórico.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {deleteError && (
                <p role="alert" className="text-sm text-destructive">
                  {deleteError}
                </p>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  type="button"
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? "Excluindo..." : "Excluir"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="py-4">
            <div className="text-xs text-muted-foreground">Peso total</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {formatWeight(recipe.totalWeightGrams)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="text-xs text-muted-foreground">Porções</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {formatNumber(recipe.servings, 2)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="text-xs text-muted-foreground">Peso/porção</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {formatWeight(recipe.weightPerServingGrams)}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <MacroBlock
          title="Macros totais"
          calories={recipe.totalCalories}
          protein={recipe.totalProteinG}
          carbs={recipe.totalCarbsG}
          fat={recipe.totalFatG}
        />
        <MacroBlock
          title="Macros por porção"
          calories={recipe.perServingCalories}
          protein={recipe.perServingProteinG}
          carbs={recipe.perServingCarbsG}
          fat={recipe.perServingFatG}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ingredientes</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ingrediente</TableHead>
                <TableHead>Fonte</TableHead>
                <TableHead className="text-right">Qtd.</TableHead>
                <TableHead className="text-right">kcal</TableHead>
                <TableHead className="text-right">P</TableHead>
                <TableHead className="text-right">C</TableHead>
                <TableHead className="text-right">G</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recipe.ingredients.map((ingredient) => (
                <TableRow key={ingredient.id}>
                  <TableCell>
                    <div className="font-medium">{ingredient.foodName}</div>
                    {ingredient.tacoFoodVariant && (
                      <div className="text-xs text-muted-foreground">
                        {ingredient.tacoFoodVariant}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium">
                      {sourceLabel(ingredient.source)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatWeight(ingredient.quantityGrams)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(ingredient.calories)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(ingredient.proteinG)}g
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(ingredient.carbsG)}g
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(ingredient.fatG)}g
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {recipe.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Notas</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{recipe.notes}</p>
          </CardContent>
        </Card>
      )}

      <LogRecipeModal
        recipeId={recipe.id}
        open={logOpen}
        onClose={() => setLogOpen(false)}
      />
    </div>
  )
}
