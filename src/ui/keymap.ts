export interface KeySection {
  title: string
  rows: readonly (readonly [keys: string, action: string])[]
}

/** Shown by the help panel (Ctrl+G). Keep in sync with Prompt.tsx and App.tsx. */
export const KEY_SECTIONS: readonly KeySection[] = [
  {
    title: 'Chat',
    rows: [
      ['Enter', 'Send message / run command'],
      ['@name (agents room)', 'Ask a coding agent'],
      ['Ctrl+P', 'Command palette'],
      ['Alt+Up / Alt+Down', 'Previous / next conversation'],
      ['Ctrl+O / Ctrl+N', 'Previous / next conversation (any terminal)'],
      ['Ctrl+B', 'Toggle sidebar'],
      ['PgUp / PgDn / wheel', 'Scroll messages'],
      ['Ctrl+T / click "▸ N more lines"', 'Fold / expand long messages'],
      ['Ctrl+G', 'This help'],
      ['Terminal tab', 'Run shell commands; cd works; Ctrl+C stops one'],
    ],
  },
  {
    title: 'Commands',
    rows: [
      ['/', 'Open the command menu'],
      ['Tab', 'Complete the highlighted entry'],
      ['Up / Down', 'Pick an entry, or recall earlier input'],
      ['Right / End / Tab', 'Accept the dim suggestion; it learns from what you type'],
    ],
  },
  {
    title: 'Docs tab (vim)',
    rows: [
      ['i a o / Esc', 'Insert, append, open line / back to normal'],
      ['h j k l w b e 0 $ gg G { }', 'Move (counts work: 3j, d2w)'],
      ['d c y + motion, dd cc yy', 'Delete, change, copy; p P paste; u Ctrl+R undo / redo'],
      ['v V + motion', 'Select; d y c > < act on it'],
      [': / n N', ':w :q :qa :rename, :%s/a/b/g, search'],
      ['click / wheel', 'Place the cursor / scroll'],
      ['Ctrl+C / Ctrl+V / Ctrl+Z / Ctrl+Y', 'Copy selection or line / paste / undo / redo'],
    ],
  },
  {
    title: 'Editing',
    rows: [
      ['Ctrl+A / Ctrl+E', 'Line start / end'],
      ['Alt+B / Alt+F', 'Word left / right (Option or Ctrl + Left / Right too)'],
      ['Alt+Backspace', 'Delete word back (Option+Delete on macOS)'],
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
