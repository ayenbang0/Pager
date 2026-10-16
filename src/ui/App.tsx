import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useWindowSize } from 'ink'
import { AGENT_NAMES } from '../agents/adapters.js'
import { ROOM_ID } from '../agents/orchestrator.js'
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
import { useEngine } from './useEngine.js'

const MIN_COLUMNS = 60
const MIN_ROWS = 12
const SIDEBAR_MIN_COLUMNS = 80
const HISTORY_LIMIT = 500
// header + title + prompt box + status bar
const FIXED_ROWS = 1 + 1 + 3 + 1
const MIN_PANE_ROWS = 3
/** A second Ctrl+C within this window quits. */
const QUIT_WINDOW_MS = 2000

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

  const matches = overlay === null ? matchCommands(input.text) : []
  const paneRows = Math.max(MIN_PANE_ROWS, rows - FIXED_ROWS - matches.length)
  const mainWidth = columns - (sidebarShown ? SIDEBAR_WIDTH : 0)
  const activeConv = convs.find((c) => c.id === activeId)

  const lines: Line[] = activeId
    ? buildLines(engine.messages(activeId, HISTORY_LIMIT), mainWidth - 2, theme)
    : plainLines(engine.home(), mainWidth - 2)
  const { visible, maxOffset } = windowLines(lines, paneRows, offset)
  const showBanner = activeId === null && engine.welcome() && paneRows >= BANNER_ROWS

  const onScroll = useCallback(
    (dir: 1 | -1) => setOffset(Math.min(maxOffset, Math.max(0, offset + dir * Math.max(1, paneRows - 2)))),
    [maxOffset, offset, paneRows],
  )
  const onSwitch = (dir: 1 | -1): void => {
    const ids = [null, ...convs.map((c) => c.id), ROOM_ID]
    const at = Math.max(0, ids.indexOf(activeId))
    engine.activate(ids[(at + dir + ids.length) % ids.length] ?? null)
  }
  const onSubmit = (text: string): void => {
    setOffset(0)
    void engine.submit(text)
  }
  const onInterrupt = (): void => {
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
  const title = inRoom ? '⌁ agents' : activeConv ? (activeConv.kind === 'group' ? `#${activeConv.title}` : activeConv.title) : 'home'
  const placeholder = inRoom
    ? 'Ask @omp, @claude, @opencode or @hermes'
    : activeConv
      ? `Message ${title} or type / for commands`
      : 'Type / for commands'

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
    { label: 'Add a contact…', hint: '/add', run: () => setInput(setText('/add ')) },
    { label: 'New group…', hint: '/group new', run: () => setInput(setText('/group new ')) },
    ...(activeConv?.kind === 'group'
      ? [
          { label: 'Invite to this group…', hint: '/group invite', run: () => setInput(setText('/group invite ')) },
          { label: 'Leave this group…', hint: '/group leave', run: () => setInput(setText('/group leave')) },
        ]
      : []),
    { label: 'Change my name…', hint: '/name', run: () => setInput(setText('/name ')) },
    { label: settings.sidebar ? 'Hide sidebar' : 'Show sidebar', hint: 'Ctrl+B', run: () => engine.toggleSidebar() },
    { label: 'Keyboard shortcuts', hint: '?', run: () => setOverlay('help') },
    ...THEMES.map(
      (t): PaletteItem => ({
        label: `Theme: ${t.name}`,
        hint: t.name === theme.name ? 'current' : t.description,
        run: () => void engine.submit(`/theme ${t.name}`),
      }),
    ),
    { label: '⌁ Agents room', hint: agentsActive > 0 ? `${agentsActive} running` : '/open agents', run: () => engine.activate(ROOM_ID) },
    ...AGENT_NAMES.map(
      (n): PaletteItem => ({ label: `Ask ${n}…`, hint: `/agent ${n}`, run: () => setInput(setText(`/agent ${n} `)) }),
    ),
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

  let hint = 'Enter send · Alt+↑/↓ switch · Ctrl+P commands · ? help'
  if (offset > 0) hint = 'Scrolled · PgDn for newer'
  else if (input.text.startsWith('/')) hint = 'Tab complete · Enter run · Esc clear'
  else if (input.text !== '') hint = 'Enter send · Esc clear'
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
          <Text dimColor>Ctrl+P commands · ? help</Text>
        </Box>
        <Box flexGrow={1}>
          {sidebarShown ? <Sidebar convs={convs} pending={pending} room={room} activeId={activeId} /> : null}
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
                {showBanner ? (
                  <HomeBanner width={mainWidth - 2} height={paneRows} info={engine.home().slice(2)} />
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
            />
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
