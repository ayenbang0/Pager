// Inline SVG icons of the git block: 16px viewBox, stroke 1.45, round caps and joins, currentColor.
import { fromHTML } from '../ui/dom.js'

const P = {
  branch: '<circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-1.9 3-5.4 3.6"/>',
  tag: '<path d="M2.5 2.5h5.2l6 6a1.2 1.2 0 0 1 0 1.7l-3.5 3.5a1.2 1.2 0 0 1-1.7 0l-6-6z"/><circle cx="5.4" cy="5.4" r=".8"/>',
  commit: '<circle cx="8" cy="8" r="2.6"/><path d="M1.5 8h3.9M10.6 8h3.9"/>',
  globe: '<circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c1.8 1.7 2.7 3.6 2.7 5.8S9.8 12.1 8 13.8M8 2.2C6.2 3.9 5.3 5.8 5.3 8s.9 4.1 2.7 5.8"/>',
  fetch: '<path d="M13 8a5 5 0 0 1-8.6 3.5M3 8a5 5 0 0 1 8.6-3.5M12.6 2.4v2.7H9.9M3.4 13.6v-2.7h2.7"/>',
  pull: '<path d="M8 2.5v8M5 7.7l3 3 3-3M3 13.5h10"/>',
  push: '<path d="M8 10.5v-8M5 5.3l3-3 3 3M3 13.5h10"/>',
  undo: '<path d="M3.5 6.3h5.7a3.3 3.3 0 0 1 0 6.6H6.2M6.2 3.6 3.5 6.3l2.7 2.7"/>',
  redo: '<path d="M12.5 6.3H6.8a3.3 3.3 0 0 0 0 6.6h3M9.8 3.6l2.7 2.7-2.7 2.7"/>',
  stash: '<path d="M2.5 5.5h11V13h-11zM3.6 3h8.8l1.1 2.5h-11zM6.5 8.4h3"/>',
  more: '<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>',
  search: '<circle cx="7" cy="7" r="4.3"/><path d="m10.2 10.2 3.3 3.3"/>',
  check: '<path d="m3.5 8.5 3.2 3 5.8-7"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  trash: '<path d="M2.8 4.5h10.4M6.4 4.5V3h3.2v1.5M4.4 4.5l.6 8.5h6l.6-8.5"/>',
  chevR: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  chevD: '<path d="m3.5 6 4.5 4.5L12.5 6"/>',
  sparkle: '<path d="M7 2.5l1.2 3.3 3.3 1.2-3.3 1.2L7 11.5 5.8 8.2 2.5 7l3.3-1.2zM12.2 10.2v3.2M10.6 11.8h3.2"/>',
  file: '<path d="M4 2h5l3.5 3.5V14H4zM9 2v3.6h3.5"/>',
  changes: '<path d="M5.5 2.5v6M2.5 5.5h6M8.5 12.5h5"/><path d="m3 13 8-9.5"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>',
  folder: '<path d="M2.5 4.5a1.3 1.3 0 0 1 1.3-1.3h2.6l1.4 1.6h4.4a1.3 1.3 0 0 1 1.3 1.3v5.6a1.3 1.3 0 0 1-1.3 1.3H3.8a1.3 1.3 0 0 1-1.3-1.3z"/>',
  spinner: '<path d="M8 2.2a5.8 5.8 0 1 0 5.8 5.8" class="gt-spin"/>',
}

/** An <svg class="ico"> element. */
export function icon(name, cls = '') {
  const el = fromHTML(`<svg class="ico ${cls}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`)
  return el
}

/** The same icon as markup, for the block registry's `icon` field. */
export const iconSvg = (name) => `<svg class="ico" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`
