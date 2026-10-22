import { COMMANDS } from '../../app/commands.js'

export interface KeySection {
  title: string
  rows: readonly (readonly [keys: string, action: string])[]
  /** Set on an agent's own section: the help panel draws its heading in that agent's color. */
  agent?: string
}

/** Shown by the help panel (Ctrl+G). Keep in sync with Prompt.tsx and App.tsx. Rows read as plain language: keys, then what they do. */
export const KEY_SECTIONS: readonly KeySection[] = [
  {
    title: 'Move around',
    rows: [
      ['Alt+Up / Alt+Down', 'Previous / next tab, in the order the sidebar lists them'],
      ['Ctrl+O / Ctrl+N', 'Same, for terminals that do not send Alt+arrows'],
      ['Ctrl+H', 'Jump to the Home tab'],
      ['Ctrl+B', 'Show or hide the sidebar'],
      ['Ctrl+P', 'Command palette: every action, searchable'],
      ['Alt+S', 'Open Settings'],
      ['PgUp / PgDn / wheel', 'Scroll messages'],
      ['Ctrl+T / click "▸ N more lines"', 'Fold / expand long messages'],
      ['click a message', 'React with an emoji (needs the mouse)'],
      ['Ctrl+G', 'This help'],
    ],
  },
  {
    title: 'Write',
    rows: [
      ['Enter', 'Send the message, or run the command'],
      ['Esc', 'Clear what you typed (closes help and the palette)'],
      ['Ctrl+A / Ctrl+E', 'Jump to the start / end of the line (Home / End too)'],
      ['Ctrl+W / Ctrl+U / Ctrl+K', 'Delete the word before the cursor / everything before it / everything after it'],
      ['Alt+B / Alt+F', 'Jump a word left / right (Option or Ctrl + Left / Right too)'],
      ['Alt+Backspace', 'Delete the word before the cursor (Option+Delete on macOS)'],
      [':name: then Tab', 'Emoji: type :fi and Tab inserts the first match; a finished :fire: is sent as 🔥'],
      ['Right / End / Tab', 'Accept the grey suggestion; it learns from what you type'],
    ],
  },
  {
    title: 'Copy and paste',
    rows: [
      ['Drag with the mouse', 'Select text in a chat; letting go copies it'],
      ['Ctrl+C', 'Copy the selection'],
      ['Ctrl+V', "Paste from the clipboard (your terminal's own paste works too)"],
      ['Shift+drag', 'Select with the terminal itself instead (Option+drag in iTerm2)'],
    ],
  },
  {
    title: 'Chats and agents',
    rows: [
      ['@name', 'Mention an agent so it hears the message'],
      ['@a @b', 'Name several agents: each one hears it'],
      ['@all', 'Every agent hears it'],
      ['Ctrl+C', 'Stop the agent working in this tab'],
      ['@bot in a group', 'Call one of the group bots: it always answers (they also chime in when their job calls for it)'],
      ['Ctrl+C in a group', 'Stop the bots that are thinking there'],
      ['/group members', 'The group screen: people (p pings), bots (Enter model, e effort, j job, x remove) and call rooms (Enter joins)'],
      ['/call [room]', 'Voice call: a DM rings the other side; a group joins the room (main by default). /mute, /hangup. /call setup installs SoX for sound'],
      ['/ping <name>', 'Play a sound on their machine, even when their sounds are set to pings only'],
      ['/requests', 'Everything waiting for /accept: Enter accepts, d declines'],
    ],
  },
  {
    title: 'Agents',
    rows: [
      ['Settings > Agents', 'See which agents are installed and add one (Enter adds, r rechecks, x removes), pick models, colors, budgets and the verify command'],
      ['Alt+M', 'Model and effort of the agent in this tab (pick an agent first elsewhere)'],
      ['Alt+I', 'Invite a contact to work with your agents (the + invite chip in the Agents room does too)'],
      ['/agent invite <contact> [--view]', 'Same by command; --view lets them only watch; they accept with /accept'],
      ['Settings > Agents', 'Who is in your session, remove them, or leave one you joined'],
      ['Alt+Q', 'Jump to the agent that is waiting for your answer'],
      ['Ctrl+P · Agent <name>: usage', "Provider limits and context use (agent's own /usage)"],
      ['Ctrl+P · Agent <name>: compact', "Shrink an agent's context"],
      ['/agent chain a>b <task>', 'Run agents in turn; each reviews the previous work'],
      ['/agent runs | stop | merge | drop | undo | log', 'Manage runs, their branches and the turns you can take back'],
      ['/<command> in an agent tab', 'Run a command the agent advertises; pager commands win a clash (/agent <name> /<command>)'],
      ['/new /clear /resume', 'Agents keep their session: Ctrl+P · Agent <name>: reset session starts over'],
      ['/copy', 'Drag to select instead: letting go copies'],
    ],
  },
  {
    title: 'When an agent asks you',
    rows: [
      ['Up / Down', 'Move between the options'],
      ['Space', 'Pick the option, or tick it when several can be chosen'],
      ['Enter', 'Confirm this question; after the last one the answers are sent'],
      ['Tab / Shift+Tab', 'Next / previous question'],
      ['Other row', 'Type an answer of your own: every key types there, Backspace edits'],
      ['Esc', 'Cancel: the agent is told you did not answer'],
    ],
  },
  {
    title: 'Settings tab',
    rows: [
      ['Up / Down', 'Move between settings (PgUp / PgDn / Home / End jump)'],
      ['Left / Right', 'Change a switch or pick another choice'],
      ['Enter', 'Edit a text field, or run the highlighted action (twice when it asks to confirm)'],
      ['[ and ]', 'On a folder: move it up or down the sidebar'],
      ['Esc', 'Back to Home'],
    ],
  },
  {
    title: 'Terminal tab',
    rows: [
      ['Alt+Up / Alt+Down', 'Previous / next tab'],
      ['Alt+P', 'Command palette (Quit is there)'],
      ['Alt+K', 'Block mode: select a finished command (c output, y command, r rerun)'],
      ['Everything else', 'Goes to the shell, including Ctrl+C, Ctrl+D and Ctrl+P'],
    ],
  },
  {
    title: 'Docs tab (vim)',
    rows: [
      ['i a o / Esc', 'Insert, append, open line / back to normal'],
      ['h j k l w b e 0 $ gg G { }', 'Move (counts work: 3j, d2w)'],
      ['d c y + motion, dd cc yy', 'Delete, change, copy; p P paste; u Ctrl+R undo / redo'],
      ['v V + motion, Ctrl+A', 'Select; Ctrl+A selects everything; d y c > < Backspace Delete act on it'],
      [': / n N', ':w :q :qa :rename, :%s/a/b/g, search'],
      ['click / wheel', 'Place the cursor / scroll'],
      ['Ctrl+C / Ctrl+V / Ctrl+Z / Ctrl+Y', 'Copy selection or line / paste / undo / redo'],
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
    title: 'Leave',
    rows: [
      ['Ctrl+C twice', 'Clear the input first; again on an empty prompt to quit'],
      ['Ctrl+D', 'Quit (empty prompt)'],
      ['/quit  /exit', 'Quit pager'],
    ],
  },
]

/** Every slash command, generated from the command table so the list cannot drift. */
export const COMMAND_SECTION: KeySection = { title: 'All commands', rows: COMMANDS.map((c) => [c.usage, c.summary]) }
