import { describe, expect, it } from 'vitest'

import { applyFreelapBlock, extractFreelapBlock, renderFreelapBlock } from '~/domain/description-block'
import { intervalNameFor, isFreelapInterval } from '~/domain/interval-naming'

import { aRep, aSession } from '../../support/builders'

describe('intervalNameFor', () => {
  it('names an interval deterministically from the rep number, distance and time', () => {
    const session = aSession()

    expect(intervalNameFor(session, aRep({ index: 3, totalS: 7.21, distanceM: 60 }))).toBe('FL #3 · 60m · 7.21s')
  })

  it('falls back to the session distance when the rep carries none', () => {
    const session = aSession({ distanceM: 30 })

    expect(intervalNameFor(session, aRep({ index: 1, totalS: 3.4, distanceM: null }))).toBe('FL #1 · 30m · 3.40s')
  })

  it('drops the distance segment when nothing knows it', () => {
    const session = aSession({ distanceM: null })

    expect(intervalNameFor(session, aRep({ index: 1, totalS: 3.4, distanceM: null }))).toBe('FL #1 · 3.40s')
  })

  it('recognises the intervals it owns and leaves other intervals alone', () => {
    expect(isFreelapInterval('FL #1 · 30m · 3.42s')).toBe(true)
    expect(isFreelapInterval('Warmup')).toBe(false)
    expect(isFreelapInterval('FL warmup')).toBe(false)
  })
})

describe('renderFreelapBlock', () => {
  const session = aSession({
    exerciseName: 'Flying 30m',
    distanceM: 30,
    reps: [
      aRep({
        index: 1,
        totalS: 3.42,
        splits: [
          { atM: 10, elapsedS: 1.21 },
          { atM: 30, elapsedS: 3.42 },
        ],
        maxSpeedMps: 9.278,
      }),
      aRep({
        index: 2,
        totalS: 3.38,
        splits: [
          { atM: 10, elapsedS: 1.19 },
          { atM: 30, elapsedS: 3.38 },
        ],
        maxSpeedMps: 9.389,
      }),
    ],
  })

  it('wraps the table in markers so re-syncs can replace exactly what we own', () => {
    const block = renderFreelapBlock(session)

    expect(block.startsWith('<!-- freelap:start -->')).toBe(true)
    expect(block.trimEnd().endsWith('<!-- freelap:end -->')).toBe(true)
  })

  it('summarises the session above the table', () => {
    expect(renderFreelapBlock(session)).toContain('2 reps · best 3.38s · avg 3.40s · 30m')
  })

  it('tabulates each rep with its intermediate splits and max speed', () => {
    const block = renderFreelapBlock(session)

    expect(block).toContain('| Rep | Time (s) | 10m (s) | Max (km/h) |')
    expect(block).toContain('| 1 | 3.42 | 1.21 | 33.4 |')
    expect(block).toContain('| 2 | 3.38 | 1.19 | 33.8 |')
  })

  it('omits the max speed column when the export never carried one', () => {
    const block = renderFreelapBlock(aSession({ reps: [aRep({ index: 1, totalS: 3.42 })] }))

    expect(block).not.toContain('Max (km/h)')
    expect(block).toContain('| 1 | 3.42 |')
  })
})

describe('applyFreelapBlock', () => {
  const block = '<!-- freelap:start -->\nnew\n<!-- freelap:end -->'

  it('appends the block to a description that has none', () => {
    expect(applyFreelapBlock('Morning track session.', block)).toBe(`Morning track session.\n\n${block}`)
  })

  it('is the whole description when there was none at all', () => {
    expect(applyFreelapBlock(null, block)).toBe(block)
  })

  it('replaces an earlier block without disturbing the athlete text around it', () => {
    const existing = `Before.\n\n<!-- freelap:start -->\nold\n<!-- freelap:end -->\n\nAfter.`

    expect(applyFreelapBlock(existing, block)).toBe(`Before.\n\n${block}\n\nAfter.`)
  })

  it('is idempotent', () => {
    const once = applyFreelapBlock('Notes.', block)

    expect(applyFreelapBlock(once, block)).toBe(once)
  })
})

describe('extractFreelapBlock', () => {
  it('returns the block we own, ignoring the athlete text', () => {
    const description = 'Before.\n\n<!-- freelap:start -->\nmine\n<!-- freelap:end -->\n\nAfter.'

    expect(extractFreelapBlock(description)).toBe('<!-- freelap:start -->\nmine\n<!-- freelap:end -->')
  })

  it('returns null when the description carries no block', () => {
    expect(extractFreelapBlock('Just a run.')).toBeNull()
    expect(extractFreelapBlock(null)).toBeNull()
  })
})
