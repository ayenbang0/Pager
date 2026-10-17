import type { ChildProcess } from 'node:child_process'
import type { AcpConfigOption } from './acp.js'
import type { InboxKind } from './protocol.js'
import type { AgentState, AgentView } from './types.js'

/** What one finished turn hands to whoever waits for it (a chain step, a peer waiting for an answer). */
export interface Outcome {
  runId: string
  text: string
  ok: boolean
  files: string[]
}

/** One message waiting for an agent. */
export interface Inbox {
  from: string
  kind: InboxKind
  text: string
  /** Other agents the same message went to. */
  also?: string[]
  /** Agents that delegated down to this message, for cycle and depth checks. */
  chain: string[]
  /** A branch to merge into the agent's worktree before it starts (a chain step continues from the previous agent's work). */
  mergeBranch?: string
  /** Called once when the turn that handled this message ends (also on failure and when it was dropped). */
  done?: (outcome: Outcome) => void
}

export interface ContextUse {
  used: number
  size: number
}

/** What the running turn may do through the tool set. */
export interface TurnCtx {
  runId: string
  kind: 'normal' | 'review'
  /** Documents the user named in this turn's messages; the only ones an agent may read or edit. */
  shownDocs: { name: string; text: string }[]
  docEdits: number
  notes: number
  touched: string[]
  refused: string[]
}

/** One agent teammate: its persistent worktree, inbox and what it is doing now. */
export class Worker {
  state: AgentState = 'idle'
  /** Set while a turn runs. */
  turn: TurnCtx | undefined
  task = ''
  purpose = ''
  /** Files changed on the agent's branch by its latest turn. */
  files: string[] = []
  readonly inbox: Inbox[] = []
  draining = false
  /** Set by stop: the running turn is killed and the queue dropped. */
  stopped = false
  child: ChildProcess | undefined
  context: ContextUse | undefined
  usage: { text: string; at: number } | undefined
  /** The agent's own model and thinking-level lists, learned from its ACP session. */
  options: AcpConfigOption[] = []
  turnKind: 'normal' | 'review' = 'normal'
  /** True while the worker occupies one of the concurrent-turn slots. */
  holdsSlot = false
  /** Last review round this agent's chain is in (reset by a user message). */
  reviewRound = 0

  constructor(
    readonly name: string,
    readonly cli: string,
    readonly branch: string,
    readonly dir: string,
  ) {}

  contextPct(): number | undefined {
    return this.context === undefined ? undefined : Math.min(1, this.context.used / this.context.size)
  }

  view(unread: number, model: string | undefined, effort: string | undefined, asking: boolean): AgentView {
    return {
      name: this.name,
      cli: this.cli,
      state: asking ? 'asking' : this.state,
      task: this.task,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      unread,
      ...(this.contextPct() === undefined ? {} : { contextPct: this.contextPct() }),
    }
  }
}
