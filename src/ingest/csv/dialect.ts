export type Delimiter = ',' | ';' | '\t'
export type DecimalMark = '.' | ','

export interface CsvDialect {
  readonly delimiter: Delimiter
  readonly decimal: DecimalMark
}

const CANDIDATE_DELIMITERS: readonly Delimiter[] = [';', '\t', ',']
const DEFAULT_DIALECT: CsvDialect = { delimiter: ',', decimal: '.' }
const DECIMAL_COMMA = /^-?\d{1,3}(?:\.\d{3})*,\d+$/

/**
 * MyFreelap lets the athlete choose their CSV separator, so the export is sniffed
 * rather than assumed: the winning delimiter is the one that yields more than one
 * column with a consistent width across rows.
 */
export function detectDialect(text: string): CsvDialect {
  const delimiter = CANDIDATE_DELIMITERS.find((candidate) => splitsCleanly(text, candidate)) ?? DEFAULT_DIALECT.delimiter
  return { delimiter, decimal: detectDecimalMark(text, delimiter) }
}

function splitsCleanly(text: string, delimiter: Delimiter): boolean {
  const rows = parseDelimited(text, delimiter)
  const [header, ...body] = rows
  if (!header || header.length < 2) return false
  return body.every((row) => row.length === header.length)
}

function detectDecimalMark(text: string, delimiter: Delimiter): DecimalMark {
  if (delimiter === ',') return '.'

  const cells = parseDelimited(text, delimiter).slice(1).flat()
  return cells.some((cell) => DECIMAL_COMMA.test(cell)) ? ',' : '.'
}

/** A minimal RFC 4180 reader: quoted fields may contain the delimiter, escaped quotes and newlines. */
export function parseDelimited(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  const endField = (): void => {
    row.push(quoted ? field : field.trim())
    field = ''
    quoted = false
  }
  const endRow = (): void => {
    endField()
    if (row.some((cell) => cell !== '')) rows.push(row)
    row = []
  }

  const source = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')

  for (let position = 0; position < source.length; position += 1) {
    const character = source[position]

    if (character === '"' && field.trim() === '') {
      quoted = true
      field = readQuoted(source, position, (next) => (position = next))
      continue
    }
    if (character === delimiter) endField()
    else if (character === '\n') endRow()
    else field += character
  }

  if (field !== '' || row.length > 0) endRow()
  return rows
}

function readQuoted(source: string, openQuote: number, seekTo: (position: number) => void): string {
  let value = ''
  let position = openQuote + 1

  while (position < source.length) {
    if (source[position] === '"') {
      if (source[position + 1] === '"') {
        value += '"'
        position += 2
        continue
      }
      break
    }
    value += source[position]
    position += 1
  }

  seekTo(position)
  return value
}
