import { MealAnalysis } from './schemas/meal-analysis'
import { ImageAnalysis } from './schemas/image-analysis'
import { DecomposedItem } from './schemas/decomposition'

export type IntentType =
  | 'meal_log'
  | 'summary'
  | 'edit'
  | 'query'
  | 'weight'
  | 'help'
  | 'settings'
  | 'out_of_scope'

export interface LLMProvider {
  analyzeMeal(message: string, history?: { role: string; content: string }[]): Promise<MealAnalysis[]>
  analyzeImage(imageBase64: string, caption: string | undefined): Promise<ImageAnalysis>
  decomposeMeal(foodName: string, grams: number): Promise<DecomposedItem[]>
  classifyIntent(message: string): Promise<IntentType>
  chat(message: string, systemPrompt: string, jsonMode?: boolean): Promise<string>
}
