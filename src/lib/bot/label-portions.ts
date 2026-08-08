const PORTION_KEYWORDS = [
  'dose',
  'doses',
  'porcao',
  'porcoes',
  'scoop',
  'scoops',
  'serving',
  'servings',
  'medida',
  'medidas',
  'capsula',
  'capsulas',
  'caps',
  'unidade',
  'unidades',
  'tablete',
  'tabletes',
  'pacote',
  'pacotes',
  'sache',
  'saches',
] as const

const WORD_TO_NUMBER: Record<string, number> = {
  meio: 0.5,
  meia: 0.5,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
}

const PORTION_VALUE =
  '(?:\\d+(?:[.,]\\d+)?|1\\/2|meio|meia|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)'

const CONSUMPTION_VERBS = '(?:tomei|comi|bebi|ingeri|tome|come|bebe)'

const DEMONSTRATIVES = '(?:desse|dessa|destes|destas|desses|dessas|dele|dela|deles|delas)'

function normalize(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function parsePortionValue(rawValue: string): number | null {
  if (rawValue in WORD_TO_NUMBER) {
    return WORD_TO_NUMBER[rawValue]
  }

  if (rawValue === '1/2') {
    return 0.5
  }

  const parsed = parseFloat(rawValue.replace(',', '.'))
  if (Number.isNaN(parsed) || parsed <= 0) {
    return null
  }

  return parsed
}

/**
 * Extrai quantidade de porções da legenda da foto de rótulo.
 * Aceita: "1 dose", "tomei um desse", "comi 2", "uma porção", etc.
 */
export function extractLabelPortionsFromCaption(caption?: string | null): number | null {
  if (!caption) return null

  const normalized = normalize(caption)
  const keywords = PORTION_KEYWORDS.join('|')

  const patterns = [
    // "1 dose", "uma porção", "2 scoops"
    new RegExp(`\\b(${PORTION_VALUE})\\s+(${keywords})\\b`),
    // "um desse", "2 dessas", "uma dela"
    new RegExp(`\\b(${PORTION_VALUE})\\s+${DEMONSTRATIVES}\\b`),
    // "tomei um", "comi 2", "bebi uma"
    new RegExp(`\\b${CONSUMPTION_VERBS}\\s+(${PORTION_VALUE})\\b`),
  ]

  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (match) {
      const value = parsePortionValue(match[1])
      if (value !== null) return value
    }
  }

  return null
}

export function extractLabelGramsFromCaption(caption?: string | null): number | null {
  if (!caption) return null

  const normalized = normalize(caption)
  const match = normalized.match(/(\d+(?:[.,]\d+)?)\s*g(?:rama)?s?\b/)

  if (!match) return null

  const parsed = parseFloat(match[1].replace(',', '.'))
  if (Number.isNaN(parsed) || parsed <= 0) return null

  return parsed
}
