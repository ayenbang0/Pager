// Chats block: windowed list math. Rows have unknown, changing heights: each key has an estimate until it is measured.
// Pure (no DOM) so the thread's anchoring and range logic is tested under node.

export class FlowLayout {
  /** estimate(item) -> px for a row that was never measured. */
  constructor(estimate = () => 56) {
    this.estimate = estimate
    this.items = []
    this.heights = new Map()
    this.tops = new Float64Array(1)
    this.total = 0
    this.dirty = true
  }

  setItems(items) {
    this.items = items
    this.dirty = true
  }

  /** Records a measured height; returns true when it changed (callers re-layout and may correct scroll). */
  setHeight(key, h) {
    const v = Math.max(0, Math.round(h * 100) / 100)
    if (this.heights.get(key) === v) return false
    this.heights.set(key, v)
    this.dirty = true
    return true
  }

  forget(keys) {
    for (const k of keys) this.heights.delete(k)
    this.dirty = true
  }

  heightOf(i) {
    const it = this.items[i]
    return this.heights.get(it.key) ?? this.estimate(it)
  }

  layout() {
    if (!this.dirty) return
    const n = this.items.length
    if (this.tops.length < n + 1) this.tops = new Float64Array(Math.max(n + 1, this.tops.length * 2))
    let y = 0
    for (let i = 0; i < n; i++) {
      this.tops[i] = y
      y += this.heightOf(i)
    }
    this.tops[n] = y
    this.total = y
    this.dirty = false
  }

  topOf(i) {
    this.layout()
    return this.tops[Math.min(i, this.items.length)]
  }

  indexOfKey(key) {
    return this.items.findIndex((it) => it.key === key)
  }

  /** Index of the row containing offset y (clamped). */
  indexAt(y) {
    this.layout()
    const n = this.items.length
    if (!n) return 0
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.tops[mid] <= y) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** Rows to render for a viewport: [start, end) with `over` px of slack on both sides. */
  range(scrollTop, viewH, over = 480) {
    this.layout()
    const n = this.items.length
    if (!n) return { start: 0, end: 0 }
    const start = this.indexAt(Math.max(0, scrollTop - over))
    let end = this.indexAt(scrollTop + viewH + over) + 1
    if (end > n) end = n
    return { start, end }
  }
}

/** True when the viewport is within `threshold` px of the end of the content. */
export const nearBottom = (scrollTop, viewH, total, threshold = 56) => total - (scrollTop + viewH) <= threshold

/**
 * Scroll anchoring: given the key and screen offset (row top minus scrollTop) of the row we want to keep still, returns the
 * scrollTop that keeps it there after layout changed (older messages prepended, rows re-measured above the viewport).
 */
export function anchorScrollTop(layout, key, offsetInView) {
  const i = layout.indexOfKey(key)
  if (i < 0) return null
  return Math.max(0, layout.topOf(i) - offsetInView)
}

/** A cheap first guess at a row's height before it is measured. */
export function estimateRow(item, width = 520) {
  switch (item.type) {
    case 'day':
      return 44
    case 'unread':
      return 36
    case 'system':
      return 40
    default: {
      const m = item.msg
      const chars = Math.max(1, (m.text || '').length)
      const per = Math.max(24, Math.floor((width * 0.62) / 7.4))
      const lines = (m.text || '').split('\n').reduce((a, l) => a + Math.max(1, Math.ceil(l.length / per)), 0)
      let h = 14 + lines * 21 + (item.showName ? 18 : 0) + (m.reactions?.length ? 28 : 0) + (m.replyTo ? 46 : 0)
      for (const a of m.attachments || []) h += a.mime?.startsWith('image/') ? 190 : 56
      return Math.round(h + (item.pos === 'last' || item.pos === 'single' ? 10 : 3) + (chars > 2000 ? 40 : 0))
    }
  }
}
