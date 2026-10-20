/** Windows Terminal JSON fragment: the Pager profiles and colour scheme (`Fragments\Pager\pager.json`). */
export const SCHEME = 'Pager Glass'
export const FONT = 'Cascadia Mono'

export const ANSI = {
  black: '#000000',
  red: '#ff6b81',
  green: '#7fe3a1',
  yellow: '#ffd479',
  blue: '#6aa8ff',
  purple: '#c792ea',
  cyan: '#5fe0ff',
  white: '#cfd8e6',
  brightBlack: '#3a4658',
  brightRed: '#ff8fa1',
  brightGreen: '#a4f0bf',
  brightYellow: '#ffe4a3',
  brightBlue: '#92c0ff',
  brightPurple: '#dbb4f5',
  brightCyan: '#8aeaff',
  brightWhite: '#ffffff',
} as const

export const SURFACE = { background: '#000000', foreground: '#d7e3f4', cursorColor: '#7fe9ff', selectionBackground: '#2b4a6f' } as const

export interface Fragment {
  profiles: Record<string, unknown>[]
  schemes: Record<string, unknown>[]
}

export function buildFragment(o: { node: string; cli: string; opacity?: number }): Fragment {
  // Pitch black and opaque by default; the glass profile lets the blurred desktop through.
  const black: Record<string, unknown> = {
    name: 'Pager',
    commandline: `"${o.node}" "${o.cli}"`,
    icon: 'pager.ico',
    startingDirectory: '%USERPROFILE%',
    font: { face: FONT, size: 12, weight: 'normal' },
    opacity: 100,
    useAcrylic: false,
    colorScheme: SCHEME,
    padding: '10, 8',
    cursorShape: 'filledBox',
    antialiasingMode: 'cleartype',
    intenseTextStyle: 'bright',
    scrollbarState: 'hidden',
    closeOnExit: 'always',
  }
  const glass = { ...black, name: 'Pager Glass', opacity: o.opacity ?? 55, useAcrylic: true }
  return { profiles: [black, glass], schemes: [{ name: SCHEME, ...SURFACE, ...ANSI }] }
}
