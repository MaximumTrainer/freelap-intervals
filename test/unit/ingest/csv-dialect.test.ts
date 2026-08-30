import { describe, expect, it } from 'vitest'

import { detectDialect, parseDelimited } from '~/ingest/csv/dialect'

describe('detectDialect', () => {
  it('detects the European default of semicolons with decimal commas', () => {
    const csv = 'Run;Total time (s)\n1;3,42\n2;3,38'

    expect(detectDialect(csv)).toEqual({ delimiter: ';', decimal: ',' })
  })

  it('detects comma-separated exports with decimal points', () => {
    const csv = 'Run,Total time (s)\n1,3.42\n2,3.38'

    expect(detectDialect(csv)).toEqual({ delimiter: ',', decimal: '.' })
  })

  it('detects tab-separated exports', () => {
    const csv = 'Run\tTotal time (s)\n1\t3.42'

    expect(detectDialect(csv)).toEqual({ delimiter: '\t', decimal: '.' })
  })

  it('prefers the delimiter that yields a consistent column count', () => {
    const csv = 'Athlete;Exercise\nWood, Dan;Flying 30m\nSmith, Jo;Flying 30m'

    expect(detectDialect(csv).delimiter).toBe(';')
  })

  it('falls back to a comma when a single column gives nothing to compare', () => {
    expect(detectDialect('Total time (s)\n3.42')).toEqual({ delimiter: ',', decimal: '.' })
  })
})

describe('parseDelimited', () => {
  it('splits rows and trims the byte-order mark and trailing blank lines', () => {
    const csv = '﻿a;b\r\n1;2\r\n\r\n'

    expect(parseDelimited(csv, ';')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('honours quoted fields containing the delimiter, quotes and newlines', () => {
    const csv = 'name;note\n"Wood; Dan";"said ""go""\nagain"'

    expect(parseDelimited(csv, ';')).toEqual([
      ['name', 'note'],
      ['Wood; Dan', 'said "go"\nagain'],
    ])
  })

  it('trims surrounding whitespace from unquoted fields', () => {
    expect(parseDelimited('a ; b\n 1 ; 2 ', ';')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})
