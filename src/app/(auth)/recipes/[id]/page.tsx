import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { RecipeDetailClient } from "@/components/recipes/RecipeDetailClient"
import { createServiceRoleClient } from "@/lib/db/supabase"
import { getRecipeWithIngredients } from "@/lib/db/queries/recipes"

interface RecipeDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function RecipeDetailPage({ params }: RecipeDetailPageProps) {
  const cookieStore = await cookies()
  const userId = cookieStore.get("caloriebot-user-id")?.value

  if (!userId) {
    redirect("/")
  }

  const { id } = await params
  const supabase = createServiceRoleClient()
  let recipe

  try {
    recipe = await getRecipeWithIngredients(supabase, id, userId)
  } catch (error) {
    console.error("[recipes/[id]] failed to load recipe", { id, userId, error })
    redirect("/recipes")
  }

  return <RecipeDetailClient recipe={recipe} />
}
