import { describe, expect, it } from 'vitest'

import { FREELAP_CUSTOM_FIELDS, customFieldValuesFor } from '~/write/custom-fields'

import { aSession } from '../../support/builders'

describe('custom field codes', () => {
  it('uses codes that match the intervals.icu format: uppercase start, alphanumeric only', () => {
    const codePattern = /^[A-Z][A-Za-z0-9]+$/

    for (const field of FREELAP_CUSTOM_FIELDS) {
      expect(field.code, `code "${field.code}" must match ${codePattern}`).toMatch(codePattern)
    }
  })

  it('maps session summary fields to the custom field codes', () => {
    const session = aSession({ distanceM: 30 })

    const values = customFieldValuesFor(session)

    expect(values).toEqual({
      FlSessionId: session.sourceId,
      FlRepCount: session.summary.count,
      FlBestS: session.summary.bestS,
      FlAvgS: session.summary.avgS,
      FlDistanceM: 30,
    })
  })

  it('omits distance when the session has none', () => {
    const session = aSession({ distanceM: null })

    expect(customFieldValuesFor(session)).not.toHaveProperty('FlDistanceM')
  })
})
