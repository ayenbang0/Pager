// The daemon-facing commands: `pager daemon|split|capture|events|open|ls|send`.

export type DaemonArgs =
  | { verb: 'daemon'; action: 'start' | 'stop' | 'status' | 'serve' }
  | { verb: 'split'; pane?: string; dir: 'row' | 'col'; kind?: string; cwd?: string; words: string[] }
  | { verb: 'capture'; pane?: string; lines?: number; ansi: boolean; json: boolean }
  | { verb: 'events'; filter: string[] }
  | { verb: 'open'; pane?: string; split?: 'row' | 'col'; tab: boolean; targets: string[] }
  | { verb: 'ls'; json: boolean }
  | { verb: 'send'; pane?: string; enter: boolean; text: string }

export const DAEMON_VERBS: readonly string[] = ['daemon', 'split', 'capture', 'events', 'open', 'ls', 'send']

const DIRS: Record<string, 'row' | 'col'> = { right: 'row', row: 'row', down: 'col', col: 'col' }

interface Flags {
  values: Record<string, string>
  switches: Set<string>
  rest: string[]
}

/** `--name VALUE` for names in `valued`, bare `--name` for `switches`; the first other word, or `--`, starts `rest`. */
function flags(argv: string[], valued: readonly string[], switches: readonly string[]): Flags | { error: string } {
  const out: Flags = { values: {}, switches: new Set(), rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') {
      out.rest = argv.slice(i + 1)
      return out
    }
    if (valued.includes(a)) {
      const v = argv[++i]
      if (v === undefined) return { error: `${a} needs a value` }
      out.values[a] = v
    } else if (switches.includes(a)) out.switches.add(a)
    else if (a.startsWith('-')) return { error: `unknown argument: ${a}` }
    else {
      out.rest = argv.slice(i)
      return out
    }
  }
  return out
}

export function parseDaemonArgs(verb: string, argv: string[]): DaemonArgs | { error: string } {
  switch (verb) {
    case 'daemon': {
      const action = argv[0] ?? 'serve'
      if (action !== 'start' && action !== 'stop' && action !== 'status' && action !== 'serve') return { error: 'pager daemon needs one of: start, stop, status' }
      return argv.length > 1 ? { error: `pager daemon ${action} takes no arguments` } : { verb, action }
    }
    case 'split': {
      const dir = DIRS[argv[0] ?? '']
      if (dir === undefined) return { error: 'pager split needs a direction: right or down' }
      const f = flags(argv.slice(1), ['--pane', '--kind', '--cwd'], [])
      if ('error' in f) return f
      const kind = f.values['--kind']
      return { verb, dir, words: f.rest, ...(f.values['--pane'] === undefined ? {} : { pane: f.values['--pane'] }), ...(kind === undefined ? {} : { kind }), ...(f.values['--cwd'] === undefined ? {} : { cwd: f.values['--cwd'] }) }
    }
    case 'capture': {
      const f = flags(argv, ['--pane', '--lines'], ['--ansi', '--json'])
      if ('error' in f) return f
      if (f.rest.length > 0) return { error: `pager capture does not take ${f.rest[0]}` }
      const lines = f.values['--lines'] === undefined ? undefined : Number(f.values['--lines'])
      if (lines !== undefined && !(Number.isInteger(lines) && lines > 0)) return { error: '--lines needs a positive number' }
      return { verb, ansi: f.switches.has('--ansi'), json: f.switches.has('--json'), ...(f.values['--pane'] === undefined ? {} : { pane: f.values['--pane'] }), ...(lines === undefined ? {} : { lines }) }
    }
    case 'events': {
      const f = flags(argv, ['--filter'], [])
      if ('error' in f) return f
      if (f.rest.length > 0) return { error: `pager events does not take ${f.rest[0]}` }
      return { verb, filter: (f.values['--filter'] ?? '').split(',').filter((s) => s !== '') }
    }
    case 'open': {
      const f = flags(argv, ['--pane', '--split'], ['--tab'])
      if ('error' in f) return f
      if (f.rest.length === 0) return { error: 'pager open needs a file, a folder or an http(s) address' }
      const split = f.values['--split'] === undefined ? undefined : DIRS[f.values['--split']]
      if (f.values['--split'] !== undefined && split === undefined) return { error: '--split needs right or down' }
      return { verb, tab: f.switches.has('--tab'), targets: f.rest, ...(f.values['--pane'] === undefined ? {} : { pane: f.values['--pane'] }), ...(split === undefined ? {} : { split }) }
    }
    case 'ls': {
      const f = flags(argv, [], ['--json'])
      if ('error' in f) return f
      return f.rest.length > 0 ? { error: `pager ls does not take ${f.rest[0]}` } : { verb, json: f.switches.has('--json') }
    }
    case 'send': {
      const f = flags(argv, ['--pane'], ['--no-enter'])
      if ('error' in f) return f
      if (f.rest.length === 0) return { error: 'pager send needs the text to type' }
      return { verb, enter: !f.switches.has('--no-enter'), text: f.rest.join(' '), ...(f.values['--pane'] === undefined ? {} : { pane: f.values['--pane'] }) }
    }
    default:
      return { error: `unknown command: ${verb}` }
  }
}
