/** Narrows parsed JSON to a plain object; its fields stay `unknown` and need their own checks. */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}
