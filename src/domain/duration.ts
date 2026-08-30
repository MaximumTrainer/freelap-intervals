/** Sprint times are read to the millisecond and shown to the hundredth. */
export function formatSeconds(seconds: number, decimals = 2): string {
  return seconds.toFixed(decimals)
}
