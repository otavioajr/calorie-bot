import Link from "next/link"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { RecipeList } from "@/components/recipes/RecipeList"
import { createServiceRoleClient } from "@/lib/db/supabase"
import { getRecipesByUser } from "@/lib/db/queries/recipes"

export default async function RecipesPage() {
  const cookieStore = await cookies()
  const userId = cookieStore.get("caloriebot-user-id")?.value

  if (!userId) {
    redirect("/")
  }

  const supabase = createServiceRoleClient()
  const recipes = await getRecipesByUser(supabase, userId)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-secondary">
            Pratos recorrentes
          </p>
          <h1 className="mt-3 font-heading text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Minhas receitas
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
            Cadastre receitas caseiras uma vez e registre porções depois com calorias e macros mais consistentes.
          </p>
        </div>
        <Button render={<Link href="/recipes/new" />}>
          <Plus data-icon="inline-start" />
          Nova receita
        </Button>
      </div>

      <RecipeList recipes={recipes} />
    </div>
  )
}
