"use client"

import Link from "next/link"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Recipe } from "@/lib/recipes/types"

interface RecipeListProps {
  recipes: Recipe[]
}

function formatInteger(value: number) {
  return Math.round(value).toLocaleString("pt-BR")
}

function formatMacro(value: number) {
  return value.toFixed(1)
}

export function RecipeList({ recipes }: RecipeListProps) {
  if (recipes.length === 0) {
    return (
      <Card className="border-dashed bg-card/85">
        <CardContent className="px-6 py-10 text-center">
          <p className="font-heading text-2xl font-semibold text-foreground">
            Salve uma receita que você repete.
          </p>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
            Pratos caseiros ficam mais fáceis de registrar quando rendimento, porção e macros já estão calculados.
          </p>
          <Button className="mt-5" render={<Link href="/recipes/new" />}>
            <Plus data-icon="inline-start" />
            Criar primeira receita
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid gap-3">
      {recipes.map((recipe) => (
        <Link
          key={recipe.id}
          href={`/recipes/${recipe.id}`}
          className="block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Card
            size="sm"
            className="transition-colors hover:bg-muted/40"
          >
            <CardHeader className="pb-0">
              <CardTitle className="line-clamp-2">{recipe.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                <span>{formatInteger(recipe.weightPerServingGrams)}g/porção</span>
                <span>{formatInteger(recipe.perServingCalories)} kcal/porção</span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                <span>P {formatMacro(recipe.perServingProteinG)}g</span>
                <span>C {formatMacro(recipe.perServingCarbsG)}g</span>
                <span>G {formatMacro(recipe.perServingFatG)}g</span>
              </div>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  )
}
