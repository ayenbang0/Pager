import { DAEMON_VERBS, parseDaemonArgs, type DaemonArgs } from '../daemon/args.js'
import { parseShowArgs, type ShowArgs } from '../surface/emit.js'

export type DesktopAction = 'install' | 'uninstall' | 'launch' | 'status'

export interface DesktopArgs {
  action: DesktopAction
  /** install: the own-window host executable to prefer when it can start. */
  exe?: string
  cwd?: string
  words?: string[]
  /** The translucent profile; the default window is opaque black. */
  glass?: boolean
}

export interface ParsedArgs {
  /** `run` starts the UI; `exec` hands a command to the running pager (or starts one with it). */
  command: 'run' | 'exec' | 'desktop' | 'daemon' | 'show' | 'update' | 'docs' | 'studio' | 'lock' | 'unlock' | 'help' | 'version'
  lan: boolean
  lanTarget?: string
  noAgents: boolean
  cwd?: string
  words?: string[]
  desktop?: DesktopArgs
  daemon?: DaemonArgs
  show?: ShowArgs
}

const TARGET = /^[^\s:]+:\d{1,5}$/
const DESKTOP_ACTIONS: readonly string[] = ['install', 'uninstall', 'launch', 'status']

export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = { command: 'run', lan: false, noAgents: false }
  if (argv[0] === 'update' || argv[0] === 'docs' || argv[0] === 'studio' || argv[0] === 'lock' || argv[0] === 'unlock') {
    return argv.length === 1 ? { ...out, command: argv[0] } : { error: `pager ${argv[0]} takes no arguments` }
  }
  if (argv[0] === 'run') return parseExec(argv.slice(1), out)
  if (argv[0] === 'desktop') return parseDesktop(argv.slice(1), out)
  if (argv[0] === 'show') {
    const show = parseShowArgs(argv.slice(1))
    return 'error' in show ? show : { ...out, command: 'show', show }
  }
  if (argv[0] !== undefined && DAEMON_VERBS.includes(argv[0])) {
    const daemon = parseDaemonArgs(argv[0], argv.slice(1))
    return 'error' in daemon ? daemon : { ...out, command: 'daemon', daemon }
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-h' || a === '--help') return { ...out, command: 'help' }
    if (a === '-v' || a === '--version') return { ...out, command: 'version' }
    else if (a === '--no-agents') out.noAgents = true
    else if (a === '--cwd') {
      const v = argv[++i]
      if (v === undefined) return { error: '--cwd needs a folder' }
      out.cwd = v
    } else if (a === '--lan') {
      out.lan = true
      const next = argv[i + 1]
      if (next !== undefined && TARGET.test(next)) {
        out.lanTarget = next
        i++
      }
    } else return { error: `unknown argument: ${a}` }
  }
  return out
}

/** `[--cwd DIR] [--] <word...>`: everything after the first non-option word, or after `--`, is the command. */
function parseWords(argv: string[], allow: (flag: string) => boolean): { cwd?: string; words: string[]; flags: string[] } | { error: string } {
  const flags: string[] = []
  let cwd: string | undefined
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') {
      i++
      break
    }
    if (a === '--cwd') {
      const v = argv[++i]
      if (v === undefined) return { error: '--cwd needs a folder' }
      cwd = v
    } else if (a.startsWith('-') && allow(a)) flags.push(a)
    else if (a.startsWith('-')) return { error: `unknown argument: ${a}` }
    else break
  }
  return { ...(cwd === undefined ? {} : { cwd }), words: argv.slice(i), flags }
}

function parseExec(argv: string[], out: ParsedArgs): ParsedArgs | { error: string } {
  const p = parseWords(argv, () => false)
  if ('error' in p) return p
  if (p.words.length === 0 && p.cwd === undefined) return { error: 'pager run needs a command or --cwd' }
  return { ...out, command: 'exec', ...(p.cwd === undefined ? {} : { cwd: p.cwd }), ...(p.words.length === 0 ? {} : { words: p.words }) }
}

function parseDesktop(argv: string[], out: ParsedArgs): ParsedArgs | { error: string } {
  const action = argv[0]
  if (action === undefined || !DESKTOP_ACTIONS.includes(action)) return { error: 'pager desktop needs one of: install, uninstall, launch, status' }
  const act = action as DesktopAction
  const rest = argv.slice(1)
  const desktop: DesktopArgs = { action: act }
  if (act === 'launch') {
    const p = parseWords(rest, (f) => f === '--glass')
    if ('error' in p) return p.error.startsWith('unknown argument: ') ? { error: `pager desktop launch does not take ${p.error.slice('unknown argument: '.length)}` } : p
    if (p.cwd !== undefined) desktop.cwd = p.cwd
    if (p.words.length > 0) desktop.words = p.words
    if (p.flags.includes('--glass')) desktop.glass = true
  } else if (act === 'install') {
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!
      if (a !== '--exe') return { error: `pager desktop install does not take ${a}` }
      const v = rest[++i]
      if (v === undefined) return { error: '--exe needs a path' }
      desktop.exe = v
    }
  } else if (rest.length > 0) return { error: `pager desktop ${act} does not take ${rest[0]}` }
  return { ...out, command: 'desktop', desktop }
}
