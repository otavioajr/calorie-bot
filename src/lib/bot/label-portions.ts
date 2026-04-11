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

export function extractLabelPortionsFromCaption(caption?: string | null): number | null {
  if (!caption) return null

  const normalized = normalize(caption)
  const keywords = PORTION_KEYWORDS.join('|')
  const values = '(?:\\d+(?:[.,]\\d+)?|1\\/2|meio|meia|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)'
  const match = normalized.match(new RegExp(`\\b(${values})\\s+(${keywords})\\b`))

  if (!match) return null

  return parsePortionValue(match[1])
}
