import { describe, expect, it } from 'vitest'

import { mapColumns } from '~/ingest/csv/column-mapping'

const englishHeaders = [
  'Date',
  'Time',
  'Athlete',
  'Exercise',
  'Distance (m)',
  'Run',
  'Total time (s)',
  '10m (s)',
  '30m (s)',
  'Average speed (km/h)',
  'Max speed (km/h)',
]

describe('mapColumns', () => {
  it('binds the standard English export headers', () => {
    const map = mapColumns(englishHeaders)

    expect(map.columnOf('date')).toBe(0)
    expect(map.columnOf('timeOfDay')).toBe(1)
    expect(map.columnOf('athlete')).toBe(2)
    expect(map.columnOf('exercise')).toBe(3)
    expect(map.columnOf('distanceM')).toBe(4)
    expect(map.columnOf('repIndex')).toBe(5)
    expect(map.columnOf('totalS')).toBe(6)
    expect(map.columnOf('avgSpeed')).toBe(9)
    expect(map.columnOf('maxSpeed')).toBe(10)
  })

  it('binds intermediate split columns with the distance they were taken at', () => {
    expect(mapColumns(englishHeaders).splitColumns).toEqual([
      { atM: 10, column: 7 },
      { atM: 30, column: 8 },
    ])
  })

  it('binds French export headers', () => {
    const map = mapColumns(['Date', 'Heure', 'Athlète', 'Exercice', 'Course', 'Temps total (s)', 'Vitesse max (km/h)'])

    expect(map.columnOf('timeOfDay')).toBe(1)
    expect(map.columnOf('athlete')).toBe(2)
    expect(map.columnOf('exercise')).toBe(3)
    expect(map.columnOf('repIndex')).toBe(4)
    expect(map.columnOf('totalS')).toBe(5)
    expect(map.columnOf('maxSpeed')).toBe(6)
  })

  it('reads the speed unit from the header', () => {
    expect(mapColumns(['Total time (s)', 'Speed (m/s)']).speedUnitOf('avgSpeed')).toBe('mps')
    expect(mapColumns(['Total time (s)', 'Speed (mph)']).speedUnitOf('avgSpeed')).toBe('mph')
    expect(mapColumns(englishHeaders).speedUnitOf('maxSpeed')).toBe('kmh')
  })

  it('reports headers it could not place so the user can map them by hand', () => {
    expect(mapColumns(['Total time (s)', 'Wind (m/s)', 'Notes']).unmapped).toEqual([
      { column: 1, header: 'Wind (m/s)' },
      { column: 2, header: 'Notes' },
    ])
  })

  it('honours a remembered mapping over the guessed one', () => {
    const map = mapColumns(['Total time (s)', 'Wind (m/s)', 'Notes'], { Notes: 'exercise' })

    expect(map.columnOf('exercise')).toBe(2)
    expect(map.unmapped).toEqual([{ column: 1, header: 'Wind (m/s)' }])
  })

  it('refuses a file with no recognisable rep time', () => {
    expect(() => mapColumns(['Date', 'Athlete'])).toThrow(/total time/i)
  })
})
