export type CanonicalField =
  | 'date'
  | 'timeOfDay'
  | 'athlete'
  | 'exercise'
  | 'distanceM'
  | 'repIndex'
  | 'totalS'
  | 'avgSpeed'
  | 'maxSpeed'

export type SpeedUnit = 'kmh' | 'mps' | 'mph'

export interface SplitColumn {
  readonly atM: number
  readonly column: number
}

export interface UnmappedColumn {
  readonly column: number
  readonly header: string
}

export interface ColumnMap {
  columnOf(field: CanonicalField): number | null
  speedUnitOf(field: 'avgSpeed' | 'maxSpeed'): SpeedUnit
  readonly splitColumns: readonly SplitColumn[]
  readonly unmapped: readonly UnmappedColumn[]
}

/** Evaluated in order, so specific headers claim a column before general ones. */
const FIELD_PATTERNS: ReadonlyArray<readonly [CanonicalField, RegExp]> = [
  ['totalS', /^(total\s*time|temps\s*total|tiempo\s*total|gesamtzeit|result|r[ée]sultat|time\s*\(s\)|temps\s*\(s\))/i],
  ['maxSpeed', /^(?=.*\b(speed|vitesse|velocidad|geschwindigkeit))(?=.*\b(max|maximum|peak|pointe))/i],
  ['avgSpeed', /\b(speed|vitesse|velocidad|geschwindigkeit)/i],
  ['distanceM', /^(distance|dist\b|strecke)/i],
  ['repIndex', /^(run|rep\b|repetition|r[ée]p[ée]tition|course|essai|attempt|trial|#|no\.?\b|number)/i],
  ['athlete', /^(athlete|athl[èe]te|participant|runner|coureur|name|nom|sportler)/i],
  ['exercise', /^(exercise|exercice|workout|drill|test|session|s[ée]ance|[ée]preuve)/i],
  ['date', /^(date|day|jour|fecha|datum)/i],
  ['timeOfDay', /^(time\s*of\s*day|start\s*time|clock|heure|hora|uhrzeit|time)/i],
]

const SPLIT_HEADER = /^(?:split\s*|interm[ée]diaire\s*|@\s*)?(\d+(?:[.,]\d+)?)\s*m\b/i
const SPEED_UNITS: ReadonlyArray<readonly [SpeedUnit, RegExp]> = [
  ['mps', /\bm\s*\/\s*s\b|\bmps\b/i],
  ['mph', /\bmph\b|\bmi\s*\/\s*h\b/i],
  ['kmh', /\bkm\s*\/\s*h\b|\bkph\b/i],
]

export type MappingOverrides = Readonly<Record<string, CanonicalField>>

/**
 * Guesses which export column holds which canonical field. MyFreelap exports only the
 * columns currently on screen, in the athlete's language, so nothing may be assumed
 * about position — and a remembered mapping always wins over the guess.
 */
export function mapColumns(headers: readonly string[], overrides: MappingOverrides = {}): ColumnMap {
  const bound = new Map<CanonicalField, number>()
  const splitColumns: SplitColumn[] = []
  const claimed = new Set<number>()

  headers.forEach((header, column) => {
    const override = overrides[header.trim()]
    if (!override) return
    bound.set(override, column)
    claimed.add(column)
  })

  headers.forEach((header, column) => {
    if (claimed.has(column)) return

    const split = SPLIT_HEADER.exec(header.trim())
    if (split?.[1]) {
      splitColumns.push({ atM: Number(split[1].replace(',', '.')), column })
      claimed.add(column)
      return
    }

    const match = FIELD_PATTERNS.find(([field, pattern]) => !bound.has(field) && pattern.test(header.trim()))
    if (!match) return
    bound.set(match[0], column)
    claimed.add(column)
  })

  if (!bound.has('totalS')) {
    throw new Error(`No total time column found in: ${headers.join(', ')}`)
  }

  return {
    columnOf: (field) => bound.get(field) ?? null,
    speedUnitOf: (field) => speedUnitOf(headers[bound.get(field) ?? -1]),
    splitColumns: splitColumns.sort((left, right) => left.atM - right.atM),
    unmapped: headers
      .map((header, column) => ({ column, header }))
      .filter(({ column }) => !claimed.has(column)),
  }
}

function speedUnitOf(header: string | undefined): SpeedUnit {
  const match = SPEED_UNITS.find(([, pattern]) => pattern.test(header ?? ''))
  return match?.[0] ?? 'kmh'
}
