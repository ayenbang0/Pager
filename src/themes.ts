/** Semantic color tokens. Values are Ink color strings (names or #rrggbb). */
export interface Theme {
  name: string
  description: string
  /** Prompt arrow, titles, overlay headings. */
  accent: string
  /** Box borders and rules. */
  border: string
  success: string
  warning: string
  error: string
  info: string
  online: string
  /** Unread counts and the pending section. */
  badge: string
  /** Your own name in message lists. */
  mine: string
  /** Other authors, picked by a hash of their key. At least one entry. */
  authors: readonly string[]
}

export const THEMES: readonly Theme[] = [
  {
    // Palette from oh-my-pi's "titanium" theme (its default dark theme).
    name: 'omp',
    description: 'oh-my-pi titanium: electric blue on steel',
    accent: '#00b4ff',
    border: '#3b424d',
    success: '#00ff88',
    warning: '#ffb347',
    error: '#ff4757',
    info: '#00b4ff',
    online: '#00ff88',
    badge: '#ffb347',
    mine: '#00b4ff',
    authors: ['#d4c090', '#00ff88', '#d06fed', '#13d1cd', '#ffb347', '#6ec9ff'],
  },
  {
    name: 'terminal',
    description: 'Your terminal ANSI palette',
    accent: 'cyan',
    border: 'gray',
    success: 'green',
    warning: 'yellow',
    error: 'red',
    info: 'cyan',
    online: 'green',
    badge: 'yellow',
    mine: 'cyan',
    authors: ['magenta', 'yellow', 'green', 'blue', 'red', 'cyan'],
  },
  {
    name: 'mono',
    description: 'Grayscale, no hue',
    accent: 'white',
    border: 'gray',
    success: 'white',
    warning: 'white',
    error: 'white',
    info: 'white',
    online: 'white',
    badge: 'white',
    mine: 'white',
    authors: ['white', 'gray'],
  },
  {
    name: 'ocean',
    description: 'Cool blues and teals',
    accent: '#4fc3f7',
    border: '#546e7a',
    success: '#4db6ac',
    warning: '#ffb74d',
    error: '#ef5350',
    info: '#81d4fa',
    online: '#4db6ac',
    badge: '#ffb74d',
    mine: '#4fc3f7',
    authors: ['#81d4fa', '#4db6ac', '#9fa8da', '#b39ddb', '#80cbc4', '#90caf9'],
  },
  {
    name: 'amber',
    description: 'Warm gold on dark',
    accent: '#ffbf00',
    border: '#8d6e63',
    success: '#8bc34a',
    warning: '#ff9800',
    error: '#e53935',
    info: '#ffd54f',
    online: '#8bc34a',
    badge: '#ff9800',
    mine: '#ffbf00',
    authors: ['#ffd54f', '#ffb74d', '#bcaaa4', '#dce775', '#ff8a65', '#e6ee9c'],
  },
  {
    name: 'light',
    description: 'For light terminal backgrounds',
    accent: 'blue',
    border: '#9e9e9e',
    success: '#2e7d32',
    warning: '#b26a00',
    error: '#c62828',
    info: '#0277bd',
    online: '#2e7d32',
    badge: '#b26a00',
    mine: 'blue',
    authors: ['#6a1b9a', '#ad1457', '#2e7d32', '#1565c0', '#c62828', '#00695c'],
  },
]

export const DEFAULT_THEME: Theme = THEMES[0]!

/** Exact, case-insensitive match. Unknown names resolve to undefined. */
export function findTheme(name: string): Theme | undefined {
  const wanted = name.trim().toLowerCase()
  return THEMES.find((t) => t.name === wanted)
}
