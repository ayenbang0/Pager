import fs from 'node:fs'

export interface AiEntry {
  n: number
  ts: number
  /** `you` or a backend id. */
  author: string
  kind: 'user' | 'reply' | 'system'
  text: string
}

const RESTORE = 500
const COMPACT_AT = 1000

/** `ai-chat.jsonl`: the AI tab's history, kept on this machine. A streamed reply is added unpersisted and written once when it settles. */
export class Transcript {
  private list: AiEntry[] = []
  private counter = 0
  private lines = 0

  constructor(private readonly file: string) {
    this.restore()
  }

  entries(): readonly AiEntry[] {
    return this.list
  }

  add(author: string, kind: AiEntry['kind'], text: string, persist = true): AiEntry {
    const entry: AiEntry = { n: ++this.counter, ts: Date.now(), author, kind, text }
    this.list.push(entry)
    if (this.list.length > RESTORE * 2) this.list.splice(0, this.list.length - RESTORE * 2)
    if (persist) this.persist(entry)
    return entry
  }

  persist(entry: AiEntry): void {
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`)
      this.lines++
      if (this.lines > COMPACT_AT) this.compact()
    } catch {
      // A read-only data dir must not break the tab; the history just won't survive a restart.
    }
  }

  clear(): void {
    this.list = []
    this.lines = 0
    try {
      fs.rmSync(this.file, { force: true })
    } catch {
      // nothing to wipe
    }
  }

  private compact(): void {
    const keep = this.list.filter((e) => e.text !== '').slice(-RESTORE)
    try {
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join('\n') + '\n')
      fs.renameSync(tmp, this.file)
      this.lines = keep.length
    } catch {
      // leave the long file as it is
    }
  }

  /** The last 500 entries; corrupt lines are skipped. */
  private restore(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    const entries: AiEntry[] = []
    const all = raw.split('\n').filter(Boolean)
    this.lines = all.length
    for (const line of all) {
      try {
        const e = JSON.parse(line) as Partial<AiEntry>
        if (typeof e.n === 'number' && typeof e.ts === 'number' && typeof e.author === 'string' && typeof e.text === 'string' && (e.kind === 'user' || e.kind === 'reply' || e.kind === 'system')) {
          entries.push({ n: e.n, ts: e.ts, author: e.author, kind: e.kind, text: e.text })
        }
      } catch {
        // skip
      }
    }
    this.list = entries.slice(-RESTORE)
    this.counter = this.list.reduce((m, e) => Math.max(m, e.n), 0)
  }
}
