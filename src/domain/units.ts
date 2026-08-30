const SECONDS_PER_HOUR = 3600
const METRES_PER_KM = 1000

/** Rounds half away from zero, correcting for binary-float representation of decimal literals. */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value
  const sign = value < 0 ? -1 : 1
  const shifted = Number(`${Math.abs(value)}e${decimals}`)
  return sign * Number(`${Math.round(shifted)}e-${decimals}`)
}

export function kmhToMps(kmh: number): number {
  return (kmh * METRES_PER_KM) / SECONDS_PER_HOUR
}

export function mpsToKmh(mps: number): number {
  return (mps * SECONDS_PER_HOUR) / METRES_PER_KM
}

export function speedFrom(distanceM: number, elapsedS: number): number {
  return elapsedS > 0 ? distanceM / elapsedS : 0
}
