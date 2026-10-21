import { EventEmitter } from 'node:events'
import { openInApp } from '../../platform/appBrowser.js'
import { scrub } from './html.js'
import { readPage } from './read.js'
import { searchWeb, type WebResult } from './search.js'
import type { WebOptions } from './read.js'

/** The id of the web search tab. */
export const WEB_ID = 'web'

const MAX_ENTRIES = 50
const MAX_LINES = 400
const CHANGE_THROTTLE_MS = 80

export interface WebEntry {
  n: number
  ts: number
  command: string
  state: 'running' | 'done' | 'failed'
  lines: string[]
  results?: WebResult[]
}

export const WEB_OFF = 'Web search is off (Settings > AI chat and Web)'

const HELP = ['search <text> (or just type it)  find pages', 'open <n>                        open result n in the browser pane', 'read <n>                        show result n as text', 'clear                           empty this tab']

/** Numbered result blocks: `1. Title`, the address, then the snippet. */
export function formatResults(results: readonly WebResult[]): string[] {
  return results.flatMap((r, i) => [`${i + 1}. ${r.title}`, `   ${r.url}`, ...(r.snippet === '' ? [] : [`   ${r.snippet}`])])
}

/**
 * The web tab's engine: a tiny command language (search / open / read) over DuckDuckGo. Everything fetched is untrusted text:
 * it is scrubbed of control characters and only ever shown, never run.
 */
export class WebTool extends EventEmitter {
  private entries: WebEntry[] = []
  private results: WebResult[] = []
  private counter = 0
  private pending = 0
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly opts: WebOptions = {}) {
    super()
  }

  get busy(): boolean {
    return this.pending > 0
  }

  list(): readonly WebEntry[] {
    return this.entries
  }

  clear(): void {
    this.entries = []
    this.results = []
    this.emit('change')
  }

  /** The last search's results, for the agents' tools and `open` / `read`. */
  lastResults(): readonly WebResult[] {
    return this.results
  }

  async run(line: string): Promise<void> {
    const command = line.trim()
    if (command === '') return
    if (/^clear$/i.test(command)) return this.clear()
    const entry = this.begin(command)
    if (process.env.PAGER_NO_WEB === '1') return this.fail(entry, WEB_OFF)
    this.pending++
    try {
      const m = /^(search|open|read|help)\b\s*(.*)$/i.exec(command)
      const verb = (m?.[1] ?? 'search').toLowerCase()
      const arg = m === null ? command : (m[2] ?? '').trim()
      if (verb === 'help') return this.done(entry, HELP)
      if (verb === 'search') return await this.search(entry, arg)
      const n = Number(arg)
      const hit = Number.isInteger(n) ? this.results[n - 1] : undefined
      if (hit === undefined) return this.fail(entry, `No result ${arg}`)
      if (verb === 'open') return (await openInApp(hit.url)) ? this.done(entry, [`Opened ${hit.url} in the browser pane`]) : this.fail(entry, `The browser pane is part of the Pager desktop window; here it is: ${hit.url}`)
      const page = await readPage(hit.url, this.opts)
      this.done(entry, [...(page.title === '' ? [] : [page.title, '']), ...page.text.split('\n').map(scrub)])
    } catch (err) {
      this.fail(entry, err instanceof Error ? err.message : String(err))
    } finally {
      this.pending--
      this.emit('change')
    }
  }

  private async search(entry: WebEntry, query: string): Promise<void> {
    if (query === '') return this.fail(entry, 'Type what to search for')
    const results = await searchWeb(query, this.opts)
    this.results = results
    entry.results = results
    this.done(entry, results.length === 0 ? ['No results'] : formatResults(results))
  }

  private begin(command: string): WebEntry {
    const entry: WebEntry = { n: ++this.counter, ts: Date.now(), command: scrub(command), state: 'running', lines: [] }
    this.entries = [...this.entries, entry].slice(-MAX_ENTRIES)
    this.change()
    return entry
  }

  private done(entry: WebEntry, lines: readonly string[]): void {
    entry.lines = lines.slice(0, MAX_LINES)
    entry.state = 'done'
    this.flush()
  }

  private fail(entry: WebEntry, message: string): void {
    entry.lines = [scrub(message)]
    entry.state = 'failed'
    this.flush()
  }

  private flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.emit('change')
  }

  private change(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.emit('change')
    }, CHANGE_THROTTLE_MS)
  }

  close(): void {
    clearTimeout(this.timer)
  }
}
