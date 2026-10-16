export interface KeySection {
  title: string
  rows: readonly (readonly [keys: string, action: string])[]
}

/** Shown by the help panel (`?`). Keep in sync with Prompt.tsx and App.tsx. */
export const KEY_SECTIONS: readonly KeySection[] = [
  {
    title: 'Chat',
    rows: [
      ['Enter', 'Send message / run command'],
      ['Ctrl+P', 'Command palette'],
      ['Alt+Up / Alt+Down', 'Previous / next conversation'],
      ['Ctrl+B', 'Toggle sidebar'],
      ['PgUp / PgDn', 'Scroll messages'],
      ['?', 'This help (on an empty prompt)'],
    ],
  },
  {
    title: 'Commands',
    rows: [
      ['/', 'Open the command menu'],
      ['Tab', 'Complete the highlighted entry'],
      ['Up / Down', 'Pick an entry, or recall earlier input'],
    ],
  },
  {
    title: 'Editing',
    rows: [
      ['Ctrl+A / Ctrl+E', 'Line start / end'],
      ['Alt+B / Alt+F', 'Word left / right (Ctrl+Left / Right too)'],
      ['Ctrl+W / Ctrl+U / Ctrl+K', 'Delete word back / to start / to end'],
      ['Esc', 'Clear the input, or close this panel'],
    ],
  },
  {
    title: 'Exit',
    rows: [
      ['Ctrl+C', 'Clear input; again on empty input to quit'],
      ['Ctrl+D', 'Quit (empty input)'],
    ],
  },
]
