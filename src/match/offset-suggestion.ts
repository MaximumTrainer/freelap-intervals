export interface RepWindow {
  readonly startS: number
  readonly endS: number
}

export interface OffsetSuggestionInput {
  readonly streamTimes: readonly number[]
  readonly speeds: readonly number[]
  readonly repWindows: readonly RepWindow[]
  readonly searchRangeS: number
}

export interface OffsetSuggestion {
  readonly offsetS: number
  readonly score: number
}

/** Peak must exceed the next-best non-adjacent peak by this factor to be trustworthy. */
const CONFIDENCE_RATIO = 1.5
const ADJACENCY_S = 5

/**
 * Cross-correlates planned rep windows against a speed stream to suggest a clock offset.
 *
 * Builds a boxcar signal (1 during each rep, 0 elsewhere), normalises the speed trace, then
 * slides the boxcar across the speed at 1 s steps within ±searchRangeS. The lag with the
 * highest dot-product wins, provided it clears the confidence gate.
 */
export function suggestOffset(input: OffsetSuggestionInput): OffsetSuggestion | null {
  const normalised = normaliseStream(input)
  if (!normalised) return null

  const scores = correlate(normalised, input.repWindows, input.searchRangeS)
  const best = pickBest(scores)
  if (!best) return null

  return passesConfidenceGate(scores, best) ? best : null
}

function normaliseStream(input: OffsetSuggestionInput): readonly number[] | null {
  const { streamTimes, speeds, repWindows } = input
  if (streamTimes.length === 0 || repWindows.length < 2) return null

  const maxSpeed = Math.max(...speeds)
  if (maxSpeed <= 0) return null

  const minSpeed = Math.min(...speeds)
  if (maxSpeed === minSpeed) return null

  return speeds.map((s) => (s - minSpeed) / (maxSpeed - minSpeed))
}

function correlate(
  normalised: readonly number[],
  repWindows: readonly RepWindow[],
  searchRangeS: number,
): Array<{ lag: number; score: number }> {
  const scores: Array<{ lag: number; score: number }> = []

  for (let lag = -searchRangeS; lag <= searchRangeS; lag += 1) {
    scores.push({ lag, score: scoreAtLag(normalised, repWindows, lag) })
  }

  return scores
}

function scoreAtLag(normalised: readonly number[], repWindows: readonly RepWindow[], lag: number): number {
  let score = 0

  for (const window of repWindows) {
    const windowStart = window.startS + lag
    const windowEnd = window.endS + lag

    for (let i = 0; i < normalised.length; i++) {
      if (i >= windowStart && i <= windowEnd) {
        score += normalised[i]!
      }
    }
  }

  return score
}

function pickBest(scores: ReadonlyArray<{ lag: number; score: number }>): OffsetSuggestion | null {
  let best: OffsetSuggestion | null = null

  for (const entry of scores) {
    if (!best || entry.score > best.score) {
      best = { offsetS: entry.lag, score: entry.score }
    }
  }

  return best && best.score > 0 ? best : null
}

function passesConfidenceGate(
  scores: ReadonlyArray<{ lag: number; score: number }>,
  best: OffsetSuggestion,
): boolean {
  const nextBest = scores
    .filter((s) => Math.abs(s.lag - best.offsetS) > ADJACENCY_S)
    .reduce((max, s) => (s.score > max ? s.score : max), 0)

  return nextBest <= 0 || best.score >= nextBest * CONFIDENCE_RATIO
}
