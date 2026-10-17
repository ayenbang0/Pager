import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useWindowSize } from 'ink'
import { AGENT_NAMES } from '../agents/adapters.js'
import { ROOM_ID } from '../agents/orchestrator.js'
import { TERM_ID } from '../terminal.js'
import { DOCS_ID } from '../docs/store.js'
import { DocsPanel, type DocsCtl } from './DocsPanel.js'
import type { Engine, Toast } from '../engine.js'
import { DEFAULT_THEME, findTheme, THEMES } from '../themes.js'
import { CommandPalette, type PaletteItem } from './CommandPalette.js'
import { HelpPanel } from './HelpPanel.js'
import { BANNER_ROWS, HomeBanner } from './HomeBanner.js'
import { emptyInput, setText, type InputBuffer } from './inputBuffer.js'
import { buildLines, plainLines, windowLines, type Line } from './layout.js'
import { matchCommands } from './palette.js'
import { Prompt } from './Prompt.js'
import { Sidebar, SIDEBAR_WIDTH } from './Sidebar.js'
import { StatusBar } from './StatusBar.js'
import { ThemeContext } from './theme.js'
import { Toasts, TOAST_LIFETIME_MS, type ToastItem } from './Toasts.js'
import { notifySequence } from './focus.js'
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
const MIN_PANE_ROWS = 3
/** A second Ctrl+C within this window quits. */
const QUIT_WINDOW_MS = 2000
const NOTIFY = process.env.PAGER_NO_NOTIFY !== '1'
/** OSC 9;4 taskbar progress: Windows Terminal and a few others; elsewhere it could print garbage. */
const TASKBAR_PROGRESS = process.env.WT_SESSION !== undefined || ['iTerm.app', 'ghostty', 'WezTerm'].includes(process.env.TERM_PROGRAM ?? '')

type Overlay = 'palette' | 'help' | null

interface Props {
  engine: Engine
  onExit(): void
}

export function App({ engine, onExit }: Props) {
  useEngine(engine)
  const { columns, rows } = useWindowSize()
  const [input, setInput] = useState<InputBuffer>(emptyInput)
  const [offset, setOffset] = useState(0)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [quitArmed, setQuitArmed] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [foldsOn, setFoldsOn] = useState(true)
  const [docPick, setDocPick] = useState<string | null>(null)
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
    engine.on('toast', onToast)
    engine.on('quit', onExit)
    return () => {
      engine.off('toast', onToast)
      engine.off('quit', onExit)
      for (const t of timers) clearTimeout(t)
      clearTimeout(quitTimer.current)
    }
  }, [engine, onExit])

  const activeId = engine.active()
  useEffect(() => setOffset(0), [activeId])

  const settings = engine.settings()
  const theme = findTheme(settings.theme) ?? DEFAULT_THEME
  const sidebarShown = settings.sidebar && columns >= SIDEBAR_MIN_COLUMNS
  const convs = engine.convs()
  const pending = engine.pending()
  const unread = convs.reduce((sum, c) => sum + c.unread, 0)
  const room = engine.agentRoom()
  const agentsActive = room.runs.filter((r) => r.state === 'running' || r.state === 'queued').length

  // The window title carries the unread count so it shows in the taskbar/tab.
  useEffect(() => {
    process.stdout.write(`\x1b]0;${unread > 0 ? `(${unread}) ` : ''}pager\x07`)
    return () => void process.stdout.write('\x1b]0;\x07')
  }, [unread])

  // Unfocused attention: ring (and raise a desktop notification where the terminal supports one) when a message arrives, a long
  // terminal command ends or the agents finish; show indeterminate taskbar progress while agents run.
  const focused = useTerminalFocus()
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const ring = useCallback((title: string, body: string): void => {
    if (NOTIFY && !focusedRef.current) process.stdout.write(`\x07${notifySequence(process.env, title, body)}`)
  }, [])
  useEffect(() => {
    engine.on('notify', ring)
    return () => void engine.off('notify', ring)
  }, [engine, ring])
  const prevActive = useRef(agentsActive)
  useEffect(() => {
    if (agentsActive === 0 && prevActive.current > 0) ring('pager', 'Agents finished')
    prevActive.current = agentsActive
  }, [agentsActive, ring])
  useEffect(() => {
    if (!NOTIFY || !TASKBAR_PROGRESS) return
    process.stdout.write(`\x1b]9;4;${agentsActive > 0 ? '3;0' : '0;0'}\x07`)
    return () => void process.stdout.write('\x1b]9;4;0;0\x07')
  }, [agentsActive])

  const inDocs = activeId === DOCS_ID
  const inEditor = inDocs && engine.openedDoc() !== null
  const docsCtl = useRef<DocsCtl | null>(null)
  const matches = overlay === null && !inEditor ? matchCommands(input.text) : []
  const paneRows = Math.max(MIN_PANE_ROWS, rows - FIXED_ROWS - matches.length)
  const mainWidth = columns - (sidebarShown ? SIDEBAR_WIDTH : 0)
  const activeConv = convs.find((c) => c.id === activeId)

  const lines: Line[] = activeId
    ? buildLines(engine.messages(activeId, HISTORY_LIMIT), mainWidth - 2, theme, new Date(), { enabled: foldsOn, expanded })
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
  useMouse({
    onWheel: (dir) => {
      if (overlay !== null) return
      if (inDocs) docsCtl.current?.wheel(dir)
      else setOffset((o) => Math.min(maxOffset, Math.max(0, o + dir * WHEEL_LINES)))
    },
    onClick: ({ x, y }) => {
      if (overlay !== null || x <= (sidebarShown ? SIDEBAR_WIDTH : 0)) return
      if (inDocs) return docsCtl.current?.click(x, y)
      // The pane's lines are bottom-aligned and start below the header and title rows.
      const key = visible[y - (PANE_TOP_ROW + paneRows - visible.length)]?.fold
      if (key !== undefined) setExpanded((prev) => new Set(prev).add(key))
    },
  })
  const onSwitch = (dir: 1 | -1): void => {
    const ids = [
      null,
      ...convs.filter((c) => c.kind === 'dm').map((c) => c.id),
      ...convs.filter((c) => c.kind === 'group').map((c) => c.id),
      TERM_ID,
      DOCS_ID,
      ROOM_ID,
    ]
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
  const title = inDocs
    ? `▤ docs${openDocName ? ` · ${openDocName}` : ''}`
    : inTerm
      ? `▸ terminal · ${term.cwd}`
      : inRoom
        ? '⌁ agents'
        : activeConv
          ? activeConv.kind === 'group'
            ? `#${activeConv.title}`
            : activeConv.title
          : 'home'
  const placeholder = inTerm
    ? term.running
      ? 'Type to send input to the running command · Ctrl+C stops it'
      : 'Run a command (cd works) · // for a leading slash · Ctrl+C stops'
    : inRoom
      ? 'Ask @omp, @claude, @opencode or @hermes (@omp>claude chains)'
      : activeConv
        ? `Message ${title} or type / for commands`
        : 'Type / for commands'

  // The editor has no prompt; leave it first so a palette action that fills the prompt is not typed into a hidden buffer.
  const fillPrompt = (text: string): void => {
    if (inEditor) engine.openDoc(null)
    setInput(setText(text))
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
    ...AGENT_NAMES.map(
      (n): PaletteItem => ({ label: `Ask ${n}…`, hint: `/agent ${n}`, run: () => fillPrompt(`/agent ${n} `) }),
    ),
    { label: 'Chain agents…', hint: '/agent chain', run: () => fillPrompt('/agent chain omp>claude ') },
    { label: 'Check agents', hint: '/agent check', run: () => void engine.submit('/agent check') },
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
    { label: 'Quit', hint: '/quit', run: onExit },
  ]

  let hint = 'Enter send · Alt+↑/↓ switch · Ctrl+P commands · Ctrl+G help'
  if (inTerm) hint = term.running ? 'Enter send input · Ctrl+C stop command' : 'Enter run · Alt+↑/↓ switch · Ctrl+P commands · Ctrl+G help'
  if (offset > 0) hint = 'Scrolled · PgDn for newer'
  else if (input.text.startsWith('/')) hint = 'Tab complete · Enter run · Esc clear'
  else if (input.text !== '') hint = 'Enter send · Esc clear'
  if (inEditor) hint = 'Esc normal · :q list · Ctrl+C copy · Ctrl+Z undo · Ctrl+G help'
  else if (inDocs && input.text === '') hint = 'PgUp/PgDn pick · Enter open · /doc new <name> · Ctrl+G help'
  if (quitArmed) hint = 'Press Ctrl+C again to quit'

  const closeOverlay = (): void => setOverlay(null)

  return (
    <ThemeContext.Provider value={theme}>
      <Box width={columns} height={rows} flexDirection="column">
        <Box paddingX={1} justifyContent="space-between">
          <Text>
            <Text bold color={theme.accent}>
              pager
            </Text>{' '}
            · {engine.me.name}
          </Text>
          <Text dimColor>Ctrl+P commands · Ctrl+G help</Text>
        </Box>
        <Box flexGrow={1}>
          {sidebarShown ? <Sidebar convs={convs} pending={pending} room={room} activeId={activeId} terminalRunning={term.running} /> : null}
          <Box flexDirection="column" flexGrow={1}>
            {overlay === 'palette' ? (
              <CommandPalette items={paletteItems} height={paneRows + 1} onClose={closeOverlay} />
            ) : overlay === 'help' ? (
              <HelpPanel height={paneRows + 1} onClose={closeOverlay} />
            ) : (
              <>
                <Box paddingX={1}>
                  <Text bold>{title}</Text>
                  {offset > 0 ? <Text dimColor> · scrolled (PgDn)</Text> : null}
                </Box>
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
                  <HomeBanner width={mainWidth - 2} height={paneRows} stats={engine.stats()} info={engine.home().slice(2)} />
                ) : (
                  <Box height={paneRows} flexDirection="column" justifyContent="flex-end" overflow="hidden" paddingX={1}>
                    {visible.map((line) => (
                      <Text key={line.key} wrap="truncate-end">
                        {line.segs.map((s, i) => (
                          <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim} italic={s.italic}>
                            {s.text}
                          </Text>
                        ))}
                      </Text>
                    ))}
                  </Box>
                )}
              </>
            )}
            {inEditor ? null : (
              <Prompt
                value={input}
                onEdit={setInput}
                placeholder={placeholder}
                matches={matches}
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
          update={engine.updateAvailable()}
          hint={hint}
        />
        <Toasts toasts={toasts} />
      </Box>
    </ThemeContext.Provider>
  )
}
