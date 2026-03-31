/**
 * Synonyms map: normalized input phrases → TACO-compatible names.
 * Applied AFTER lowercasing and accent removal.
 * Longest matches first to avoid partial replacements.
 */
const SYNONYMS: [string, string][] = [
  ['semi desnatado', 'semidesnatado'],
  ['semi-desnatado', 'semidesnatado'],
  ['leite semidesnatado', 'leite, de vaca, semidesnatado'],
  ['leite integral', 'leite, de vaca, integral'],
  ['leite desnatado', 'leite, de vaca, desnatado'],
  ['peito de frango', 'frango, peito'],
  ['frango grelhado', 'frango, peito, sem pele, grelhado'],
  ['batata frita', 'batata, frita'],
  ['queijo minas', 'queijo, minas'],
  ['ovo cozido', 'ovo, de galinha, inteiro, cozido'],
  ['ovo frito', 'ovo, de galinha, inteiro, frito'],
  ['pao frances', 'pao, trigo, frances'],
  ['pao de forma', 'pao, de forma, tradicional'],
  ['arroz branco', 'arroz, tipo 1, cozido'],
  ['arroz integral', 'arroz, integral, cozido'],
  ['feijao preto', 'feijao, preto, cozido'],
  ['feijao carioca', 'feijao, carioca, cozido'],
]

export function normalizeFoodNameForTaco(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
}

export function applySynonyms(name: string): string {
  let result = name
  for (const [from, to] of SYNONYMS) {
    if (result.includes(from)) {
      result = result.replace(from, to)
      break
    }
  }
  return result
}

export function tokenMatchScore(inputTokens: string[], targetTokens: string[]): number {
  if (inputTokens.length === 0) return 0
  const targetSet = new Set(targetTokens)
  const matched = inputTokens.filter(t => targetSet.has(t)).length
  return matched / inputTokens.length
}
