import { Box } from 'ink'
import type { ConvView, PendingView } from '../../app/engine.js'
import { parseAgentTab, parseSharedTab } from '../../agents/ids.js'
import type { SharedView } from '../../agents/share/share.js'
import { ROOM_ID, type RoomView } from '../../agents/orchestrator.js'
import type { AgentView } from '../../agents/types.js'
import { AI_ID } from '../../ai/chat.js'
import { SETTINGS_ID } from '../../app/settingsView.js'
import { isTermTab, TERM_ID } from '../../tools/terminal/sessions.js'
import { DOCS_ID } from '../../docs/store.js'
import { SegLine } from '../kit/SegLine.js'
import { useBlink } from '../kit/Spinner.js'
import { SpinnerLine } from '../kit/SpinnerLine.js'
import { agentTint } from '../theme/look.js'
import { fitSegs, pillSeg } from '../kit/segs.js'
import { agentRowSpec, buildRow, chatRowSpec, groupHeader, sharedRowSpec, unreadBadge, type RowSpec } from './sidebarRows.js'
import type { SidebarEntry } from './tabs.js'
import { useLook, useTheme } from '../theme/theme.js'

export const SIDEBAR_WIDTH = 26
/** Row width: the sidebar less one column of air before the main area. The sidebar is flat: no box, no rule; spacing and the raised active row set it apart. */
const ROW_WIDTH = SIDEBAR_WIDTH - 1

function Header({ title, fold, count }: { title: string; fold?: 'open' | 'closed'; count?: number }) {
  const theme = useTheme()
  return (
    <Box width={ROW_WIDTH} height={1}>
      <SegLine segs={groupHeader(title, ROW_WIDTH, theme, fold, count)} />
    </Box>
  )
}

function Row({ spec, active }: { spec: RowSpec; active: boolean }) {
  const theme = useTheme()
  return (
    <Box width={ROW_WIDTH} height={1}>
      <SpinnerLine segs={buildRow(spec, active, ROW_WIDTH, theme)} />
    </Box>
  )
}

function AgentRow({ agent, active }: { agent: AgentView; active: boolean }) {
  const theme = useTheme()
  const look = useLook()
  const blink = useBlink()
  const tint = agent.color ?? agentTint(theme, look, agent.name)
  return <Row spec={agentRowSpec(agent, tint, theme, blink)} active={active} />
}

interface Props {
  entries: readonly SidebarEntry[]
  /** First entry shown. */
  scroll: number
  /** Rows available. */
  rows: number
  convs: ConvView[]
  pending: PendingView[]
  room: RoomView
  shared: SharedView[]
  activeId: string | null
  terminalRunning: boolean
  aiBusy: boolean
}

/** The first conversation's invitation: shown under the entries while there are no chats, if there are the rows. */
const EMPTY_HINT = ['no chats yet', '/add <code> to start'] as const

export function Sidebar({ entries, scroll, rows, convs, pending, room, shared, activeId, terminalRunning, aiBusy }: Props) {
  const theme = useTheme()
  const now = Date.now()
  const byId = new Map(convs.map((c) => [c.id, c]))
  const byName = new Map(room.agents.map((a) => [a.name, a]))
  const tabRow = (id: string | null) => {
    const active = activeId === id
    if (id === null) return <Row key="home" spec={{ glyph: '⌂', glyphColor: theme.accent, label: 'home' }} active={active} />
    const conv = byId.get(id)
    if (conv !== undefined) return <Row key={id} spec={chatRowSpec(conv, now, theme)} active={active} />
    if (id === ROOM_ID) return <Row key={id} spec={{ glyph: '⌁', glyphColor: theme.accent2, label: 'agents', badge: unreadBadge(room.unread, theme) }} active={active} />
    if (id === AI_ID) return <Row key={id} spec={{ glyph: '✦', glyphColor: theme.accent2, spinner: aiBusy, label: 'ai' }} active={active} />
    if (isTermTab(id)) {
      return <Row key={id} spec={{ glyph: '▸', glyphColor: theme.accent, label: id === TERM_ID ? 'terminal' : `terminal ${id.slice(9)}`, ...(terminalRunning ? { badge: [{ text: '● run', color: theme.success, bold: true }] } : {}) }} active={active} />
    }
    if (id === DOCS_ID) return <Row key={id} spec={{ glyph: '▤', glyphColor: theme.accent, label: 'docs' }} active={active} />
    if (id === SETTINGS_ID) return <Row key={id} spec={{ glyph: '⚙', glyphColor: theme.accent, label: 'settings' }} active={active} />
    const session = shared.find((s) => s.pk === parseSharedTab(id))
    if (session !== undefined) return <Row key={id} spec={sharedRowSpec(session, theme)} active={active} />
    const agent = byName.get(parseAgentTab(id) ?? '')
    return agent === undefined ? null : <AgentRow key={id} agent={agent} active={active} />
  }
  const pendingBy = new Map(pending.map((p) => [p.n, p]))
  const shown = entries.slice(scroll, scroll + rows)
  const hint = convs.length === 0 && scroll + shown.length >= entries.length && shown.length + EMPTY_HINT.length + 1 <= rows
  return (
    <Box width={SIDEBAR_WIDTH} flexDirection="column" overflow="hidden">
      {shown.map((e, i) => {
        const key = `${scroll + i}`
        if (e.kind === 'static') return <Header key={key} title={e.title} />
        if (e.kind === 'header') return <Header key={key} title={e.title} fold={e.open ? 'open' : 'closed'} count={e.count} />
        if (e.kind === 'tab') return tabRow(e.id)
        const p = pendingBy.get(e.n)
        return p === undefined ? null : (
          <Row key={key} spec={{ glyph: '◌', glyphColor: theme.badge, label: `${p.label} (${p.type})`, labelColor: theme.badge, badge: [pillSeg(`#${p.n}`, theme.pill.warning)] }} active={false} />
        )
      })}
      {hint ? (
        <Box flexDirection="column" marginTop={1}>
          {EMPTY_HINT.map((text) => (
            <Box key={text} width={ROW_WIDTH} height={1}>
              <SegLine segs={fitSegs([{ text: `  ${text}`, color: theme.dim }], ROW_WIDTH)} />
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}
