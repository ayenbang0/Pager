/** Lower is better; undefined = no match. Prefix < word-start < substring < subsequence. */
function score(label: string, query: string): number | undefined {
  const hay = label.toLowerCase()
  if (hay.startsWith(query)) return 0
  const at = hay.indexOf(query)
  if (at !== -1) return /[\s#/:·-]/.test(hay[at - 1] ?? '') ? 1 : 2
  let from = 0
  for (const ch of query) {
    from = hay.indexOf(ch, from) + 1
    if (from === 0) return undefined
  }
  return 3
}

/** Filters and ranks by label, keeping original order among equal scores. Empty query keeps everything. */
export function fuzzyFilter<T extends { label: string }>(items: readonly T[], rawQuery: string): T[] {
  const query = rawQuery.trim().toLowerCase()
  if (query === '') return [...items]
  const scored: { item: T; rank: number; index: number }[] = []
  items.forEach((item, index) => {
    const rank = score(item.label, query)
    if (rank !== undefined) scored.push({ item, rank, index })
  })
  return scored.sort((a, b) => a.rank - b.rank || a.index - b.index).map((s) => s.item)
}
