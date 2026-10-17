import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useInput, useWindowSize } from 'ink'
import { agentTabId, parseAgentTab, parseSharedTab } from '../agents/ids.js'
import { ROOM_ID } from '../agents/orchestrator.js'
import type { AgentView } from '../agents/types.js'
import { TERM_ID } from '../terminal.js'
import { DOCS_ID } from '../docs/store.js'
import { copyText } from '../clipboard.js'
import { AgentHeader, HubHeader } from './AgentHeader.js'
import { AgentSetup } from './AgentSetup.js'
import { watchCtrlH } from './ctrlH.js'
import { DocsPanel, type DocsCtl } from './DocsPanel.js'
import type { Engine, Toast } from '../engine.js'
import { DENSITIES } from '../settings.js'
import { resolveTheme, THEMES } from '../themes.js'
import { agentTint, badgeGlyph, effectiveDensity, type Look } from './look.js'
import { chipFor, crumbsFor, type Place } from './chrome.js'
import { Header } from './Header.js'
import { SegLine } from './SegLine.js'
import { fitSegs, pillSeg } from './segs.js'
import { ThemePicker } from './ThemePicker.js'
import { BandTitle } from './kit.js'
import { TerminalHeader } from './TerminalHeader.js'
import { agentChip, chipWidth, filesChanged, questionBanner, questionFor, questionTarget, stateWord } from './agentChrome.js'
import { agentHelpSections } from './agentHelp.js'
import { CommandPalette, type PaletteItem } from './CommandPalette.js'
import { HelpPanel, type HelpCtl } from './HelpPanel.js'
import { BANNER_ROWS, HomeBanner } from './HomeBanner.js'
import { homeAgents, type HomeAgents } from './homeAgents.js'
import { emptyInput, setText, type InputBuffer } from './inputBuffer.js'
import { buildLines, plainLines, windowLines, type Line } from './layout.js'
import { ModelPicker } from './ModelPicker.js'
import type { Point } from './mouse.js'
import { menuItems, type AgentMenu } from './palette.js'
import { Prompt } from './Prompt.js'
import { pickerHeight } from './questionState.js'
import { QuestionPicker } from './QuestionPicker.js'
import { selectedText, withSelection, type Cell, type Sel } from './selection.js'
import { Sidebar, SIDEBAR_WIDTH } from './Sidebar.js'
import { tabGroups, tabOrder } from './tabs.js'
import { StatusBar } from './StatusBar.js'
import { frameRows } from './frame.js'
import { LookContext, ThemeContext } from './theme.js'
import { Toasts, TOAST_LIFETIME_MS, type ToastItem } from './Toasts.js'
import { useEngine } from './useEngine.js'
import { useMouse } from './useMouse.js'
import { useTerminalFocus } from './useTerminalFocus.js'

const MIN_COLUMNS = 60
const MIN_ROWS = 12
const SIDEBAR_MIN_COLUMNS = 80
const HISTORY_LIMIT = 500
/** The prompt box: one text row plus its border. The Docs panel takes these rows over. */
const PROMPT_ROWS = 3
/** Lines per wheel notch; trackpads send many notches, so this feels smooth rather than jumpy. */
const WHEEL_LINES = 3
// header + title + prompt box + status bar
const FIXED_ROWS = 1 + 1 + 3 + 1
/** Terminal row (1-based) where the message pane starts: below the header and the title row. */
const PANE_TOP_ROW = 3
/** Terminal row (1-based) of the title row, where an agent tab's model chip sits. */
const TITLE_ROW = 2
const MIN_PANE_ROWS = 3
/** A second Ctrl+C within this window quits. */
const QUIT_WINDOW_MS = 2000
const NOTIFY = process.env.PAGER_NO_NOTIFY !== '1'
/** OSC 9;4 taskbar progress: Windows Terminal and a few others; elsewhere it could print garbage. */
const TASKBAR_PROGRESS = process.env.WT_SESSION !== undefined || ['iTerm.app', 'ghostty', 'WezTerm'].includes(process.env.TERM_PROGRAM ?? '')

type Overlay = 'palette' | 'help' | 'agents' | 'model' | 'theme' | null

/** What the Home AGENTS card shows, from the live agents and the recorded stats. */
function homeData(engine: Engine, agents: readonly AgentView[]): HomeAgents {
  return homeAgents({
    agents,
    stats: engine.agentStats(),
    questions: engine.questions(),
    reviewsPending: engine.agentReviewsPending(),
    usages: engine.agentUsages(),
    unadded: engine.agentSetup().filter((r) => r.readiness.state === 'ready' && r.instances === 0).length,
    now: Date.now(),
  })
}

interface Props {
  engine: Engine
  onExit(): void
}

export function App({ engine, onExit }: Props) {
  useEngine(engine)
  const { columns, rows } = useWindowSize()
  const frame = frameRows(rows)
  const [input, setInput] = useState<InputBuffer>(emptyInput)
  const [offset, setOffset] = useState(0)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [modelAgent, setModelAgent] = useState<string | null>(null)
  /** The theme highlighted in the picker, drawn live before it is kept; null outside the picker. */
  const [previewTheme, setPreviewTheme] = useState<string | null>(null)
  const [quitArmed, setQuitArmed] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [foldsOn, setFoldsOn] = useState(true)
  const [docPick, setDocPick] = useState<string | null>(null)
  const [sel, setSel] = useState<Sel | null>(null)
  /** The left-button gesture in progress: where it started and, once the pointer moved, where it is now. */
  const gesture = useRef<{ anchor: Cell; head: Cell | null } | null>(null)
  const helpCtl = useRef<HelpCtl | null>(null)
  const nextToastId = useRef(0)
  const quitTimer = useRef<NodeJS.Timeout | undefined>(undefined)

  useEffect(() => {
    const timers = new Set<NodeJS.Timeout>()
    const onToast = (toast: Toast): void => {
      const id = nextToastId.current++
      setToasts((prev) => [...prev, { ...toast, id, born: Date.now() }])
      const timer = setTimeout(() => {
        timers.delete(timer)
        setToasts((prev) => prev.filter((t) => t.id !== id))
      }, TOAST_LIFETIME_MS[toast.kind])
      timers.add(timer)
    }
    const onOverlay = (kind: string, name?: string): void => {
      if (kind === 'agents') setOverlay('agents')
      else if (kind === 'theme') {
        setPreviewTheme(engine.settings().theme)
        setOverlay('theme')
      }
      else if (kind === 'model') {
        setModelAgent(name ?? null)
        setOverlay('model')
      }
    }
    engine.on('toast', onToast)
    engine.on('overlay', onOverlay)
    engine.on('quit', onExit)
    return () => {
      engine.off('overlay', onOverlay)
      engine.off('toast', onToast)
      engine.off('quit', onExit)
      for (const t of timers) clearTimeout(t)
      clearTimeout(quitTimer.current)
    }
  }, [engine, onExit])

  const activeId = engine.active()
  useEffect(() => setOffset(0), [activeId])

  const settings = engine.settings()
  const theme = resolveTheme(overlay === 'theme' && previewTheme !== null ? previewTheme : settings.theme, settings.accent === '' ? undefined : settings.accent)
  const sidebarShown = settings.sidebar && columns >= SIDEBAR_MIN_COLUMNS
  const convs = engine.convs()
  const pending = engine.pending()
  const unread = convs.reduce((sum, c) => sum + c.unread, 0)
  const room = engine.agentRoom()
  const agentsActive = room.runs.filter((r) => r.state === 'running' || r.state === 'queued').length
  const agentTab = parseAgentTab(activeId)
  const agentView = room.agents.find((a) => a.name === agentTab)
  const shared = engine.sharedSessions()
  const sharedPk = parseSharedTab(activeId)
  const sharedRoom = sharedPk === undefined ? undefined : engine.sharedRoom(sharedPk)
  const review = engine.agentReview()
  const inTermTab = activeId === TERM_ID
  // Short panes fall back to compact rows, and the terminal tab is always compact: its rows are commands and output, not speakers.
  const look: Look = {
    density: inTermTab ? 'compact' : effectiveDensity(settings.density, frame),
    badge: badgeGlyph(settings.badge, engine.me.name),
    agentColors: Object.fromEntries(room.agents.flatMap((a) => (a.color === undefined ? [] : [[a.name, a.color] as const]))),
    me: engine.me.name,
  }

  // The window title carries the unread count so it shows in the taskbar/tab.
  useEffect(() => {
    process.stdout.write(`\x1b]0;${unread > 0 ? `(${unread}) ` : ''}pager\x07`)
    return () => void process.stdout.write('\x1b]0;\x07')
  }, [unread])

  // Alerts (desktop notification + chime) come from the engine, which shows them whether or not this window is active. The window's
  // focus only tells it when messages count as read. Indeterminate taskbar progress shows while agents run.
  const focused = useTerminalFocus()
  useEffect(() => engine.setFocused(focused), [engine, focused])
  useEffect(() => {
    if (!NOTIFY || !TASKBAR_PROGRESS) return
    process.stdout.write(`\x1b]9;4;${agentsActive > 0 ? '3;0' : '0;0'}\x07`)
    return () => void process.stdout.write('\x1b]9;4;0;0\x07')
  }, [agentsActive])

  const inDocs = activeId === DOCS_ID
  const inEditor = inDocs && engine.openedDoc() !== null
  // Ctrl+H goes to the Home tab. Legacy terminals deliver it as the backspace byte, so it is read from raw input (not while an overlay
  // or the document editor owns the keyboard).
  const homeOk = useRef(false)
  homeOk.current = overlay === null && !inEditor
  useEffect(() => watchCtrlH(() => homeOk.current && engine.activate(null)), [engine])
  const docsCtl = useRef<DocsCtl | null>(null)
  // Emoji shortcodes expand in chats and agent tabs only; the terminal and the Docs list take text as typed.
  const emojiOk = activeId !== null && activeId !== TERM_ID && !inDocs
  const agentMenu: AgentMenu | undefined = agentView === undefined ? undefined : { agent: agentView.name, commands: engine.agentCommands(agentView.name) }
  // An agent's question takes the prompt's place in its own tab and in the hub; in any other tab a banner points to it.
  const questions = engine.questions()
  // In a shared session the host's agents ask; only a guest with control answers.
  const shownQuestion = sharedRoom === undefined ? questionFor(questions, agentTab, activeId === ROOM_ID) : sharedRoom.access === 'control' ? sharedRoom.questions[0] : undefined
  const questionLine = questionBanner(questions, sharedRoom === undefined ? shownQuestion : undefined)
  const pickerH = shownQuestion === undefined ? 0 : pickerHeight(shownQuestion, Math.max(8, Math.floor(frame / 2)))
  const menu = overlay === null && !inEditor && shownQuestion === undefined ? menuItems(input.text, input.cursor, emojiOk, engine.agentNames(), agentMenu) : []
  const bannerRow = !inEditor && questionLine !== undefined ? 1 : 0
  const paneRows = Math.max(MIN_PANE_ROWS, frame - (FIXED_ROWS - PROMPT_ROWS) - (shownQuestion === undefined || inEditor ? PROMPT_ROWS : pickerH) - bannerRow - menu.length)
  const mainWidth = columns - (sidebarShown ? SIDEBAR_WIDTH : 0)
  const activeConv = convs.find((c) => c.id === activeId)

  const lines: Line[] = activeId
    ? buildLines(engine.messages(activeId, HISTORY_LIMIT), mainWidth - 2, theme, new Date(), { enabled: foldsOn, expanded }, look)
    : plainLines(engine.home(), mainWidth - 2)
  const { visible, maxOffset } = windowLines(lines, paneRows, offset)
  // New content while scrolled up must not move what the user is reading.
  const seen = useRef({ id: activeId, len: lines.length })
  useEffect(() => {
    const grew = lines.length - seen.current.len
    if (seen.current.id === activeId && offset > 0 && grew > 0) setOffset((o) => o + grew)
    seen.current = { id: activeId, len: lines.length }
  }, [lines.length, activeId, offset])
  const showBanner = activeId === null && engine.welcome() && paneRows >= BANNER_ROWS

  // The list reorders as people edit, so the selection follows the document, not its row.
  const docList = engine.docList()
  const docSel = Math.max(0, docList.findIndex((d) => d.id === docPick))
  const moveDocSel = (delta: number): void => setDocPick(docList[Math.min(docList.length - 1, Math.max(0, docSel + delta))]?.id ?? null)
  const onScroll = useCallback(
    (dir: 1 | -1) => {
      if (inDocs) return moveDocSel(-dir)
      setOffset(Math.min(maxOffset, Math.max(0, offset + dir * Math.max(1, paneRows - 2))))
    },
    [maxOffset, offset, paneRows, inDocs],
  )
  const sidebarCols = sidebarShown ? SIDEBAR_WIDTH : 0
  // A terminal cell as a cell of the message lines. They are bottom-aligned, start below the header and title rows, and the pane
  // pads one column. `clamp` pins a drag that left the lines to the nearest edge row; a press outside them is null.
  const cellAt = ({ x, y }: Point, clamp: boolean): Cell | null => {
    const row = y - (PANE_TOP_ROW + paneRows - visible.length)
    if (visible.length === 0 || (!clamp && (row < 0 || row >= visible.length))) return null
    return { row: Math.min(visible.length - 1, Math.max(0, row)), col: Math.max(0, x - sidebarCols - 2) }
  }
  const copySelection = (s: Sel): void => {
    const text = selectedText(visible, s)
    if (text === '') return setSel(null)
    copyText(text)
    const n = [...text].length
    engine.emit('toast', { kind: 'info', text: `copied ${n} character${n === 1 ? '' : 's'}` } satisfies Toast)
  }
  // Any key but the copy chord drops the highlight (Ctrl+C is handled by onInterrupt).
  useInput(
    (input, key) => {
      if (key.eventType !== 'release' && !(key.ctrl && input === 'c')) setSel(null)
    },
    { isActive: sel !== null },
  )
  // Rows shift when messages arrive or the view scrolls or resizes, so a highlight would land on the wrong text.
  useEffect(() => setSel(null), [activeId, lines.length, offset, paneRows, mainWidth, overlay])
  useMouse({
    onWheel: (dir) => {
      gesture.current = null
      setSel(null)
      if (overlay === 'help') return helpCtl.current?.wheel(dir)
      if (overlay !== null) return
      if (inDocs) docsCtl.current?.wheel(dir)
      else setOffset((o) => Math.min(maxOffset, Math.max(0, o + dir * WHEEL_LINES)))
    },
    onPress: (at) => {
      gesture.current = null
      setSel(null)
      if (overlay === null && agentView !== undefined && at.y === TITLE_ROW && at.x >= columns - chipWidth(agentChip(agentView), engine.agentReview()) - 1) return openModel(agentView.name)
      if (overlay !== null || at.x <= sidebarCols) return
      if (inDocs) return docsCtl.current?.click(at.x, at.y)
      const anchor = showBanner ? null : cellAt(at, false)
      if (anchor !== null) gesture.current = { anchor, head: null }
    },
    onDrag: (at) => {
      const g = gesture.current
      const head = g === null ? null : cellAt(at, true)
      if (g === null || head === null) return
      g.head = head
      setSel({ anchor: g.anchor, head })
    },
    onRelease: () => {
      const g = gesture.current
      gesture.current = null
      if (g === null) return
      if (g.head !== null) return copySelection({ anchor: g.anchor, head: g.head })
      // Pressed and released on one cell: a click, which expands a fold marker.
      const key = visible[g.anchor.row]?.fold
      if (key !== undefined) setExpanded((prev) => new Set(prev).add(key))
    },
  })
  const openModel = (name?: string): void => {
    const names = room.agents.map((a) => a.name)
    if (names.length === 0) return void engine.emit('toast', { kind: 'warn', text: 'No agents are ready: /agent setup' } satisfies Toast)
    setModelAgent(name ?? (agentTab !== undefined && names.includes(agentTab) ? agentTab : names.length === 1 ? (names[0] ?? null) : null))
    setOverlay('model')
  }
  const jumpToQuestion = (): void => {
    const target = questionTarget(questions, shownQuestion)
    if (target === undefined) return void engine.emit('toast', { kind: 'info', text: 'No agent is waiting for an answer' } satisfies Toast)
    engine.activate(agentTabId(target.agent))
  }
  // Alt chords only: nothing printable is a shortcut while a text field may have focus.
  useInput(
    (input, key) => {
      if (key.eventType === 'release') return
      if (key.ctrl && input === 'h') return void engine.activate(null)
      if (!key.meta) return
      if (input === 'm') openModel()
      else if (input === 'q') jumpToQuestion()
    },
    { isActive: overlay === null && !inEditor },
  )
  const onSwitch = (dir: 1 | -1): void => {
    const ids = tabOrder(
      tabGroups(
        convs,
        room.agents.map((a) => a.name),
        shared.map((s) => s.pk),
      ),
    )
    const at = Math.max(0, ids.indexOf(activeId))
    engine.activate(ids[(at + dir + ids.length) % ids.length] ?? null)
  }
  const onSubmit = (text: string): void => {
    if (inDocs && text.trim() === '') {
      const doc = docList[docSel]
      if (doc) engine.openDoc(doc.id)
      return
    }
    setOffset(0)
    void engine.submit(text)
  }
  const onInterrupt = (): void => {
    if (sel !== null) {
      copySelection(sel)
      setSel(null)
      return
    }
    if (engine.interrupt()) return
    if (input.text !== '') return setInput(emptyInput)
    if (quitArmed) return onExit()
    setQuitArmed(true)
    clearTimeout(quitTimer.current)
    quitTimer.current = setTimeout(() => setQuitArmed(false), QUIT_WINDOW_MS)
  }

  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    return <Text>Terminal too small (need {MIN_COLUMNS}x{MIN_ROWS})</Text>
  }

  const inRoom = activeId === ROOM_ID
  const inTerm = activeId === TERM_ID
  const term = engine.terminal()
  const openDocName = inDocs ? engine.docs.info(engine.openedDoc() ?? '')?.name : undefined
  const title = activeConv ? (activeConv.kind === 'group' ? `#${activeConv.title}` : activeConv.title) : 'home'
  const place: Place = inDocs
    ? { kind: 'docs', title: openDocName ?? '' }
    : inTerm
      ? { kind: 'terminal', title: '' }
      : inRoom
        ? { kind: 'hub', title: '' }
        : sharedRoom !== undefined
          ? { kind: 'shared', title: sharedRoom.host }
          : agentView !== undefined
          ? { kind: 'agent', title: agentView.name }
          : activeConv?.kind === 'group'
            ? { kind: 'group', title: activeConv.title }
            : activeConv
              ? { kind: 'dm', title: activeConv.title }
              : { kind: 'home', title: '' }
  const tint = agentView === undefined ? undefined : (agentView.color ?? agentTint(theme, look, agentView.name))
  // The title row under the header: what this tab is, plus the one fact worth a glance (presence, scroll state). The terminal has its own header.
  const sharedHere = sharedRoom?.guests.filter((g) => g.online).map((g) => g.name) ?? []
  const sharedNote =
    sharedRoom === undefined ? undefined : [sharedRoom.access, sharedRoom.connected ? undefined : 'host offline', sharedHere.length === 0 ? undefined : `with ${sharedHere.join(', ')}`].filter(Boolean).join(' · ')
  const tabTitle = sharedRoom !== undefined ? `◈ ${sharedRoom.host}'s agents` : inDocs ? `▤ docs${openDocName ? ` · ${openDocName}` : ''}` : activeConv?.kind === 'dm' ? `${activeConv.online ? '●' : '○'} ${activeConv.title}` : activeConv ? `# ${activeConv.title}` : '⌂ home'
  const tabNote = sharedNote !== undefined ? sharedNote : offset > 0 ? 'scrolled · PgDn for newer' : activeConv?.kind === 'dm' ? (activeConv.online ? 'online' : 'offline') : undefined
  const placeholder = inTerm
    ? term.running
      ? 'Type to send input to the running command · Ctrl+C stops it'
      : 'Run a command (cd works) · // for a leading slash · Ctrl+C stops'
    : sharedRoom !== undefined
      ? sharedRoom.access === 'view'
        ? 'View only: the host invited you to watch'
        : `Ask ${sharedRoom.agents.slice(0, 3).map((a) => `@${a.name}`).join(', ') || '@agent'} or @all in ${sharedRoom.host}'s session`
      : inRoom
      ? room.agents.length === 0
        ? 'No agents are ready: /agent setup'
        : `Ask ${room.agents.slice(0, 3).map((a) => `@${a.name}`).join(', ')} or @all (@a>b chains)`
      : agentView !== undefined
        ? `message ${agentView.name} (@mention others, /command)`
        : activeConv
          ? `Message ${title} or type / for commands`
          : 'Type / for commands'

  // The editor has no prompt; leave it first so a palette action that fills the prompt is not typed into a hidden buffer.
  const fillPrompt = (text: string): void => {
    if (inEditor) engine.openDoc(null)
    setInput(setText(text))
  }
  const openThemePicker = (): void => {
    setPreviewTheme(settings.theme)
    setOverlay('theme')
  }
  const paletteItems: PaletteItem[] = [
    { label: '⌂ Home', run: () => engine.activate(null) },
    ...convs.map(
      (c): PaletteItem => ({
        label: c.kind === 'group' ? `# ${c.title}` : c.title,
        hint: [c.kind === 'group' ? 'group' : c.online ? 'online' : 'offline', c.unread > 0 ? `${c.unread} unread` : '']
          .filter(Boolean)
          .join(' · '),
        run: () => engine.activate(c.id),
      }),
    ),
    ...pending.flatMap((p): PaletteItem[] => [
      { label: `Accept ${p.label}`, hint: p.type, run: () => void engine.submit(`/accept ${p.n}`) },
      { label: `Decline ${p.label}`, hint: p.type, run: () => void engine.submit(`/decline ${p.n}`) },
    ]),
    { label: 'Show my contact code', hint: '/code', run: () => void engine.submit('/code') },
    { label: 'Add a contact…', hint: '/add', run: () => fillPrompt('/add ') },
    { label: 'New group…', hint: '/group new', run: () => fillPrompt('/group new ') },
    ...(activeConv?.kind === 'group'
      ? [
          { label: 'Invite to this group…', hint: '/group invite', run: () => fillPrompt('/group invite ') },
          { label: 'Leave this group…', hint: '/group leave', run: () => fillPrompt('/group leave') },
        ]
      : []),
    { label: 'Change my name…', hint: '/name', run: () => fillPrompt('/name ') },
    { label: settings.sidebar ? 'Hide sidebar' : 'Show sidebar', hint: 'Ctrl+B', run: () => engine.toggleSidebar() },
    { label: 'Keyboard shortcuts', hint: 'Ctrl+G', run: () => setOverlay('help') },
    { label: foldsOn ? 'Show long messages in full' : 'Fold long messages', hint: 'Ctrl+T', run: () => setFoldsOn((v) => !v) },
    { label: 'Theme picker…', hint: '/theme', run: openThemePicker },
    { label: 'Accent color…', hint: '/accent', run: () => fillPrompt('/accent ') },
    { label: 'Badge beside my name…', hint: '/badge', run: () => fillPrompt('/badge ') },
    ...DENSITIES.map(
      (d): PaletteItem => ({ label: `Density: ${d}`, hint: d === settings.density ? 'current' : '/density', run: () => void engine.submit(`/density ${d}`) }),
    ),
    ...THEMES.map(
      (t): PaletteItem => ({
        label: `Theme: ${t.name}`,
        hint: t.name === theme.name ? 'current' : t.description,
        run: () => void engine.submit(`/theme ${t.name}`),
      }),
    ),
    { label: '▸ Terminal', hint: engine.terminal().running ? 'running' : '/open terminal', run: () => engine.activate(TERM_ID) },
    { label: '▤ Docs', hint: '/open docs', run: () => engine.openDoc(null) },
    ...engine.docList().map((d): PaletteItem => ({ label: `Doc: ${d.name}`, hint: d.where, run: () => engine.openDoc(d.id) })),
    { label: 'New document…', hint: '/doc new', run: () => fillPrompt('/doc new ') },
    { label: '⌁ Agents room', hint: agentsActive > 0 ? `${agentsActive} running` : '/open agents', run: () => engine.activate(ROOM_ID) },
    ...engine.agentNames().map(
      (n): PaletteItem => ({ label: `Ask ${n}…`, hint: `/agent ${n}`, run: () => fillPrompt(`/agent ${n} `) }),
    ),
    ...(room.agents.length >= 2
      ? [{ label: 'Chain agents…', hint: '/agent chain', run: () => fillPrompt(`/agent chain ${room.agents[0]?.name}>${room.agents[1]?.name} `) }]
      : []),
    { label: 'Check agents', hint: '/agent check', run: () => void engine.submit('/agent check') },
    { label: 'Agents: setup', hint: '/agent setup', run: () => setOverlay('agents') },
    { label: `Agents: turn review ${review ? 'off' : 'on'}`, hint: `/agent review ${review ? 'off' : 'on'}`, run: () => void engine.submit(`/agent review ${review ? 'off' : 'on'}`) },
    { label: 'Agents: usage', hint: '/agent usage', run: () => void engine.submit('/agent usage') },
    { label: 'Agent: model…', hint: 'Alt+M', run: () => openModel() },
    { label: 'Agent: effort…', hint: 'Alt+M', run: () => openModel() },
    { label: 'Agents: set the goal…', hint: '/agent goal', run: () => fillPrompt('/agent goal ') },
    { label: 'Agents: show shared memory', hint: '/agent memory', run: () => void engine.submit('/agent memory') },
    { label: 'Agents: add a note to memory…', hint: '/agent memory add', run: () => fillPrompt('/agent memory add ') },
    ...room.agents.flatMap((a): PaletteItem[] => {
      const commands = engine.agentCommands(a.name)
      return [
        { label: `· ${a.name}`, hint: `${a.cli} · ${stateWord(a.state)}`, run: () => engine.activate(agentTabId(a.name)) },
        { label: `Model & effort: ${a.name}`, hint: [a.model ?? 'default', a.effort ?? 'default'].join(' · '), run: () => openModel(a.name) },
        { label: `Usage: ${a.name}`, hint: `/agent usage ${a.name}`, run: () => void engine.submit(`/agent usage ${a.name}`) },
        ...(commands.some((c) => c.name === 'compact')
          ? [{ label: `Compact: ${a.name}`, hint: `/agent compact ${a.name}`, run: () => void engine.submit(`/agent compact ${a.name}`) }]
          : []),
        ...commands.map(
          (c): PaletteItem => ({
            label: `${a.name}: /${c.name} — ${c.description}`,
            run: () => (c.hint === undefined || c.hint === '' ? void engine.submit(`/agent ${a.name} /${c.name}`) : fillPrompt(`/agent ${a.name} /${c.name} `)),
          }),
        ),
      ]
    }),
    ...(agentsActive > 0 ? [{ label: 'Stop all agents', hint: '/agent stop', run: () => void engine.submit('/agent stop') }] : []),
    ...room.runs
      .filter((r) => r.mergeable)
      .map(
        (r): PaletteItem => ({
          label: `Merge ${r.id} (${r.files} file${r.files === 1 ? '' : 's'})`,
          hint: '/agent merge',
          run: () => void engine.submit(`/agent merge ${r.id}`),
        }),
      ),
    { label: 'Quit', hint: '/quit · /exit', run: onExit },
  ]

  let hint = 'Enter send · Alt+↑/↓ switch · Ctrl+P commands · Ctrl+G help'
  if (inTerm) hint = term.running ? 'Enter send input · Ctrl+C stop command' : 'Enter run · Alt+↑/↓ switch · Ctrl+P commands · Ctrl+G help'
  if (offset > 0) hint = 'Scrolled · PgDn for newer'
  else if (input.text.startsWith('/')) hint = 'Tab complete · Enter run · Esc clear'
  else if (menu.length > 0) hint = 'Tab insert emoji · Enter send as typed · Esc clear'
  else if (input.text !== '') hint = 'Enter send · Esc clear'
  if (sel !== null) hint = 'Selected · Ctrl+C copies again · any key clears'
  if (inEditor) hint = 'Esc normal · :q list · Ctrl+C copy · Ctrl+Z undo · Ctrl+G help'
  else if (inDocs && input.text === '') hint = 'PgUp/PgDn pick · Enter open · /doc new <name> · Ctrl+G help'
  if (agentView !== undefined && !inEditor && input.text === '' && offset === 0 && sel === null) hint = 'Enter send · @name others · Alt+M model · Ctrl+C stop · Ctrl+G help'
  if (shownQuestion !== undefined && !inEditor) hint = 'Up/Down move · Space pick · Enter confirm · Tab field · Esc cancel'
  if (quitArmed) hint = 'Press Ctrl+C again to quit'

  const closeOverlay = (): void => setOverlay(null)
  

  return (
    <ThemeContext.Provider value={theme}>
      <LookContext.Provider value={look}>
      <Box width={columns} height={frame} flexDirection="column">
        <Header
          width={columns}
          crumbs={crumbsFor(place)}
          connected={engine.listening()}
          unread={unread}
          agentsRunning={agentsActive}
          name={engine.me.name}
          badge={look.badge}
        />
        <Box flexGrow={1}>
          {sidebarShown ? <Sidebar convs={convs} pending={pending} room={room} shared={shared} activeId={activeId} terminalRunning={term.running} /> : null}
          <Box flexDirection="column" flexGrow={1}>
            {overlay === 'palette' ? (
              <CommandPalette items={paletteItems} height={paneRows + 1} onClose={closeOverlay} />
            ) : overlay === 'help' ? (
              <HelpPanel
                width={mainWidth - 2}
                height={paneRows + 1}
                ctl={helpCtl}
                agents={agentHelpSections({ agents: room.agents, commandsOf: (n) => engine.agentCommands(n), usageOf: (n) => engine.agentUsages().find((u) => u.agent === n), now: Date.now() })}
                onClose={closeOverlay}
              />
            ) : overlay === 'agents' ? (
              <AgentSetup engine={engine} height={paneRows + 1} onClose={closeOverlay} />
            ) : overlay === 'theme' ? (
              <ThemePicker
                width={mainWidth}
                height={paneRows + 1}
                current={settings.theme}
                onPreview={setPreviewTheme}
                onPick={(name) => {
                  setOverlay(null)
                  setPreviewTheme(null)
                  void engine.submit(`/theme ${name}`)
                }}
                onCancel={() => {
                  setOverlay(null)
                  setPreviewTheme(null)
                }}
              />
            ) : overlay === 'model' ? (
              <ModelPicker engine={engine} agent={modelAgent} height={paneRows + 1} onClose={closeOverlay} />
            ) : (
              <>
                {agentView !== undefined ? (
                  <AgentHeader view={agentView} files={filesChanged(room.runs, agentView.name)} review={engine.agentReview()} />
                ) : inRoom ? (
                  <HubHeader agents={room.agents} goal={engine.agentGoal()} />
                ) : inTerm ? (
                  <TerminalHeader term={term} width={mainWidth} />
                ) : (
                  <BandTitle title={tabTitle} width={mainWidth} right={tabNote} />
                )}
                {inDocs ? (
                  <DocsPanel
                    engine={engine}
                    width={mainWidth}
                    height={inEditor ? paneRows + PROMPT_ROWS : paneRows}
                    left={(sidebarShown ? SIDEBAR_WIDTH : 0) + 1}
                    top={PANE_TOP_ROW}
                    active={overlay === null}
                    ctl={docsCtl}
                    selected={docSel}
                    onMove={moveDocSel}
                    onPalette={() => setOverlay('palette')}
                    onSidebar={() => engine.toggleSidebar()}
                    onSwitch={onSwitch}
                    onHelp={() => setOverlay('help')}
                    onQuit={onExit}
                  />
                ) : showBanner ? (
                  <HomeBanner width={mainWidth - 2} height={paneRows} stats={engine.stats()} agents={homeData(engine, room.agents)} info={engine.home().slice(2)} />
                ) : (
                  <Box height={paneRows} flexDirection="column" justifyContent="flex-end" overflow="hidden" paddingX={1}>
                    {visible.map((line, row) => (
                      <SegLine key={line.key} segs={withSelection(line.segs, row, sel)} />
                    ))}
                  </Box>
                )}
              </>
            )}
            {inEditor || questionLine === undefined ? null : (
              <SegLine segs={fitSegs([{ text: ' ' }, pillSeg('?', theme.pill.warning), { text: ` ${questionLine}`, color: theme.warning, bold: true }], mainWidth)} />
            )}
            {inEditor ? null : shownQuestion !== undefined ? (
              <QuestionPicker
                key={shownQuestion.id}
                view={shownQuestion}
                active={overlay === null}
                height={pickerH}
                onAnswer={(answers) => engine.answerQuestion(shownQuestion.id, answers)}
                onSwitch={onSwitch}
                onPalette={() => setOverlay('palette')}
                onSidebar={() => engine.toggleSidebar()}
                onHelp={() => setOverlay('help')}
              />
            ) : (
              <Prompt
                value={input}
                onEdit={setInput}
                placeholder={placeholder}
                menu={menu}
                active={overlay === null}
                onSubmit={onSubmit}
                onScroll={onScroll}
                onSwitch={onSwitch}
                onInterrupt={onInterrupt}
                onPalette={() => setOverlay('palette')}
                onSidebar={() => engine.toggleSidebar()}
                onHelp={() => setOverlay('help')}
                onQuit={onExit}
                history={engine.history()}
                suggest={(t) => engine.suggest(t)}
                onToggleFolds={() => setFoldsOn((v) => !v)}
                width={mainWidth}
                chip={chipFor(place, input.text.startsWith('/'), tint)}
                hint={hint}
              />
            )}
          </Box>
        </Box>
        <StatusBar
          columns={columns}
          listening={engine.listening()}
          online={engine.onlineCount()}
          unread={unread}
          pending={pending.length}
          agentsRunning={agentsActive}
          agentsReady={room.agents.length}
          review={review}
          update={engine.updateAvailable()}
          mode={place.kind === 'dm' ? 'chat' : place.kind}
          quitArmed={quitArmed}
        />
        <Toasts toasts={toasts} />
      </Box>
      </LookContext.Provider>
    </ThemeContext.Provider>
  )
}
