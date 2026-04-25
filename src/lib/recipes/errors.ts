export class TacoNotFoundError extends Error {
  constructor(readonly tacoId: number) {
    super('TACO row not found')
    this.name = 'TacoNotFoundError'
  }
}

export function isDuplicateRecipeNameError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const message = error.message.toLowerCase()
  return message.includes('duplicate') || message.includes('unique constraint')
}

export function isRecipeNotFoundOrNotOwnedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const message = error.message.toLowerCase()
  return message.includes('not found') || message.includes('not owned')
}
