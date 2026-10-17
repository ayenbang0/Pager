import { Box } from 'ink'
import type { ConvView, PendingView } from '../engine.js'
import { parseAgentTab, parseSharedTab } from '../agents/ids.js'
import type { SharedView } from '../agents/share.js'
import { ROOM_ID, type RoomView } from '../agents/orchestrator.js'
import type { AgentView } from '../agents/types.js'
import { TERM_ID } from '../terminal.js'
import { DOCS_ID } from '../docs/store.js'
import { SegLine } from './SegLine.js'
import { useBlink } from './Spinner.js'
import { SpinnerLine } from './SpinnerLine.js'
import { agentTint } from './look.js'
import { pillSeg } from './segs.js'
import { agentRowSpec, sharedRowSpec, buildRow, groupHeader, unreadBadge, type RowSpec } from './sidebarRows.js'
import { tabGroups } from './tabs.js'
import { useLook, useTheme } from './theme.js'

export const SIDEBAR_WIDTH = 26
/** Row width: the sidebar less its right border column. */
const ROW_WIDTH = SIDEBAR_WIDTH - 1

function Header({ title }: { title: string }) {
  const theme = useTheme()
  return (
    <Box width={ROW_WIDTH} height={1}>
      <SegLine segs={groupHeader(title, ROW_WIDTH, theme)} />
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
  convs: ConvView[]
  pending: PendingView[]
  room: RoomView
  shared: SharedView[]
  activeId: string | null
  terminalRunning: boolean
}

export function Sidebar({ convs, pending, room, shared, activeId, terminalRunning }: Props) {
  const theme = useTheme()
  const groups = tabGroups(
    convs,
    room.agents.map((a) => a.name),
    shared.map((s) => s.pk),
  )
  const byId = new Map(convs.map((c) => [c.id, c]))
  const byName = new Map(room.agents.map((a) => [a.name, a]))
  const chatRow = (id: string) => {
    const conv = byId.get(id)
    const active = activeId === id
    if (conv?.kind === 'dm') {
      const online = conv.online === true
      const spec: RowSpec = {
        glyph: online ? '●' : '○',
        glyphColor: online ? theme.online : theme.dim,
        label: conv.title,
        labelColor: online ? theme.text : theme.dim,
        badge: unreadBadge(conv.unread, theme),
      }
      return <Row key={id} spec={spec} active={active} />
    }
    if (conv) return <Row key={id} spec={{ glyph: '#', glyphColor: theme.accent2, label: conv.title, badge: unreadBadge(conv.unread, theme) }} active={active} />
    if (id === ROOM_ID) {
      return <Row key={id} spec={{ glyph: '⌁', glyphColor: theme.accent2, label: 'agents', badge: unreadBadge(room.unread, theme) }} active={active} />
    }
    const session = shared.find((s) => s.pk === parseSharedTab(id))
    if (session !== undefined) return <Row key={id} spec={sharedRowSpec(session, theme)} active={active} />
    const agent = byName.get(parseAgentTab(id) ?? '')
    return agent === undefined ? null : <AgentRow key={id} agent={agent} active={active} />
  }
  return (
    <Box
      width={SIDEBAR_WIDTH}
      flexDirection="column"
      borderStyle="bold"
      borderColor={theme.border}
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
    >
      <Header title="HOME" />
      <Row spec={{ glyph: '⌂', glyphColor: theme.accent, label: 'home' }} active={activeId === null} />
      <Header title="CHATS" />
      {groups.chats.map(chatRow)}
      {pending.map((p) => (
        <Row
          key={p.n}
          spec={{ glyph: '◌', glyphColor: theme.badge, label: `${p.label} (${p.type})`, labelColor: theme.badge, badge: [pillSeg(`#${p.n}`, theme.pill.warning)] }}
          active={false}
        />
      ))}
      <Header title="TOOLS" />
      <Row
        spec={{
          glyph: '▸',
          glyphColor: theme.accent,
          label: 'terminal',
          ...(terminalRunning ? { badge: [pillSeg('● run', theme.pill.success)] } : {}),
        }}
        active={activeId === TERM_ID}
      />
      <Row spec={{ glyph: '▤', glyphColor: theme.accent, label: 'docs' }} active={activeId === DOCS_ID} />
    </Box>
  )
}
