import type { AcpToolCall } from './acp.js'

type Part = { type: 'text'; text: string } | { type: 'tool'; id: string; title: string; kind: string; status: string }

const ICON: Record<string, string> = { completed: '✓', failed: '✗' }

/**
 * The room message an ACP run streams into: message chunks and tool calls in arrival order.
 * `onUpdate` receives the rendered body at most once per `intervalMs` (first update immediately).
 */
export class LiveMessage {
  private readonly parts: Part[] = []
  private timer: NodeJS.Timeout | undefined
  private dirty = false

  constructor(
    private readonly onUpdate: (body: string) => void,
    private readonly intervalMs = 80,
  ) {}

  get started(): boolean {
    return this.parts.length > 0
  }

  text(chunk: string): void {
    const last = this.parts.at(-1)
    if (last?.type === 'text') last.text += chunk
    else this.parts.push({ type: 'text', text: chunk })
    this.touch()
  }

  tool(call: AcpToolCall): void {
    const known = this.parts.find((p) => p.type === 'tool' && p.id === call.id)
    if (known?.type === 'tool') {
      known.title = call.title
      known.kind = call.kind
      known.status = call.status
    } else this.parts.push({ type: 'tool', id: call.id, title: call.title, kind: call.kind, status: call.status })
    this.touch()
  }

  /** Everything shown so far: text as streamed, tool calls as `⚙ title` / `✓ title` / `✗ title`. */
  body(): string {
    return this.parts
      .map((p) => (p.type === 'text' ? p.text.trim() : `${Object.hasOwn(ICON, p.status) ? ICON[p.status] : '⚙'} ${p.title}`))
      .filter((s) => s !== '')
      .join('\n')
  }

  /** The agent's words only (no tool lines). */
  message(): string {
    return this.parts
      .flatMap((p) => (p.type === 'text' ? [p.text.trim()] : []))
      .filter((s) => s !== '')
      .join('\n')
  }

  /** `used 7 tools (read 3, edit 2, execute 2)`, or '' when no tool ran. */
  summary(): string {
    const counts = new Map<string, number>()
    for (const p of this.parts) if (p.type === 'tool') counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1)
    if (counts.size === 0) return ''
    const total = [...counts.values()].reduce((a, b) => a + b, 0)
    const by = [...counts].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${kind} ${n}`)
    return `used ${total} tool${total === 1 ? '' : 's'} (${by.join(', ')})`
  }

  /** Stops the update timer; no update fires afterwards. */
  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.dirty = false
  }

  private touch(): void {
    this.dirty = true
    if (this.timer === undefined) this.tick()
  }

  private tick(): void {
    this.timer = undefined
    if (!this.dirty) return
    this.dirty = false
    this.onUpdate(this.body())
    this.timer = setTimeout(() => this.tick(), this.intervalMs)
  }
}
