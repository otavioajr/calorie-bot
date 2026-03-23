import { MealAnalysis } from './schemas/meal-analysis'
import { ImageAnalysis } from './schemas/image-analysis'
import { CalorieMode } from './schemas/common'
import { TacoFood } from './prompts/taco'

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
  analyzeMeal(message: string, mode: CalorieMode, context?: TacoFood[]): Promise<MealAnalysis>
  analyzeImage(imageBase64: string, caption: string | undefined, mode: CalorieMode, context?: TacoFood[]): Promise<ImageAnalysis>
  classifyIntent(message: string): Promise<IntentType>
  chat(message: string, systemPrompt: string): Promise<string>
}
