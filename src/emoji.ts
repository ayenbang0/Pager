/**
 * `:name:` shortcodes. Aliases map to the same character. Names are lowercase `[a-z0-9_+-]` and at least two characters long, so the
 * one-letter `x` cannot be a shortcode: `cross` and `x_mark` stand in for ❌.
 */
export const EMOJI: Record<string, string> = {
  cry: '😭',
  sob: '😭',
  skull: '💀',
  fire: '🔥',
  pray: '🙏',
  joy: '😂',
  lol: '😂',
  rofl: '🤣',
  heart: '❤️',
  thumbsup: '👍',
  '+1': '👍',
  thumbsdown: '👎',
  '-1': '👎',
  clap: '👏',
  eyes: '👀',
  '100': '💯',
  tada: '🎉',
  rocket: '🚀',
  sparkles: '✨',
  thinking: '🤔',
  shrug: '🤷',
  facepalm: '🤦',
  wave: '👋',
  ok: '👌',
  muscle: '💪',
  smile: '😄',
  grin: '😁',
  wink: '😉',
  sweat: '😅',
  blush: '😊',
  heart_eyes: '😍',
  sunglasses: '😎',
  nerd: '🤓',
  scream: '😱',
  angry: '😠',
  rage: '🤬',
  sleepy: '😴',
  party: '🥳',
  pleading: '🥺',
  cold: '🥶',
  hot: '🥵',
  vomit: '🤮',
  clown: '🤡',
  ghost: '👻',
  alien: '👽',
  robot: '🤖',
  poop: '💩',
  brain: '🧠',
  bug: '🐛',
  bulb: '💡',
  warning: '⚠️',
  check: '✅',
  cross: '❌',
  x_mark: '❌',
  question: '❓',
  bang: '❗',
  zzz: '💤',
  boom: '💥',
  star: '⭐',
  sun: '☀️',
  moon: '🌙',
  rain: '🌧️',
  snow: '❄️',
  zap: '⚡',
  rainbow: '🌈',
  coffee: '☕',
  pizza: '🍕',
  beer: '🍺',
  cake: '🍰',
  apple: '🍎',
  cat: '🐱',
  dog: '🐶',
  fox: '🦊',
  unicorn: '🦄',
  panda: '🐼',
  penguin: '🐧',
  snake: '🐍',
  crab: '🦀',
  whale: '🐳',
  octopus: '🐙',
  tree: '🌲',
  flower: '🌸',
  music: '🎵',
  game: '🎮',
  book: '📖',
  pencil: '✏️',
  lock: '🔒',
  key: '🔑',
  bell: '🔔',
  phone: '📱',
  laptop: '💻',
  keyboard: '⌨️',
  package: '📦',
  gift: '🎁',
  trophy: '🏆',
  medal: '🏅',
  flag: '🚩',
  hourglass: '⏳',
  clock: '🕐',
  mag: '🔍',
  link: '🔗',
  wrench: '🔧',
  hammer: '🔨',
  gear: '⚙️',
  shield: '🛡️',
  bomb: '💣',
  pin: '📌',
  memo: '📝',
  chart: '📈',
  money: '💰',
  gem: '💎',
  crown: '👑',
  handshake: '🤝',
  raised_hands: '🙌',
  fist: '✊',
  peace: '✌️',
  crossed_fingers: '🤞',
  salute: '🫡',
  melting: '🫠',
  skull_crossbones: '☠️',
  rip: '🪦',
  ship: '🚢',
  merge: '🔀',
}

const CODE = /:([a-z0-9_+-]{2,24}):/g
/** Fenced blocks (an unterminated fence runs to the end) and inline code spans are data, never expanded. */
const PROTECTED = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g

function expandPlain(text: string): string {
  let out = ''
  let last = 0
  CODE.lastIndex = 0
  for (let m = CODE.exec(text); m !== null; m = CODE.exec(text)) {
    const name = m[1] ?? ''
    if (!Object.hasOwn(EMOJI, name)) {
      // The closing colon may open the next code: `:nope:fire:` still expands `:fire:`.
      CODE.lastIndex = m.index + m[0].length - 1
      continue
    }
    out += text.slice(last, m.index) + EMOJI[name]
    last = m.index + m[0].length
  }
  return out + text.slice(last)
}

/** `:fire:` -> 🔥. Unknown names and code (`inline` or fenced) are left as typed. */
export function expandEmoji(text: string): string {
  if (!text.includes(':')) return text
  let out = ''
  let last = 0
  for (const span of text.matchAll(PROTECTED)) {
    out += expandPlain(text.slice(last, span.index)) + span[0]
    last = span.index + span[0].length
  }
  return out + expandPlain(text.slice(last))
}

const NAMES = Object.keys(EMOJI).sort()

/** Shortcode completions for what was typed after the colon: prefix matches first, then substring matches, alphabetical within each. */
export function emojiMatches(prefix: string, limit = 8): { name: string; char: string }[] {
  const typed = prefix.toLowerCase()
  const starts = NAMES.filter((n) => n.startsWith(typed))
  const inside = NAMES.filter((n) => !n.startsWith(typed) && n.includes(typed))
  return [...starts, ...inside].slice(0, limit).map((name) => ({ name, char: EMOJI[name] ?? '' }))
}
