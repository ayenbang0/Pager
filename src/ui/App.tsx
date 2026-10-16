import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useWindowSize } from 'ink'
import type { Engine, Toast } from '../engine.js'
import { emptyInput, type InputBuffer } from './inputBuffer.js'
import { buildLines, plainLines, windowLines, type Line } from './layout.js'
import { matchCommands } from './palette.js'
import { Prompt } from './Prompt.js'
import { Sidebar, SIDEBAR_WIDTH } from './Sidebar.js'
import { Toasts, TOAST_LIFETIME_MS, type ToastItem } from './Toasts.js'
import { useEngine } from './useEngine.js'

const MIN_COLUMNS = 60
const MIN_ROWS = 12
const SIDEBAR_MIN_COLUMNS = 80
const HISTORY_LIMIT = 500
// header + title + prompt box + hint
const FIXED_ROWS = 1 + 1 + 3 + 1
const MIN_PANE_ROWS = 3

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
  const nextToastId = useRef(0)

  useEffect(() => {
    const timers = new Set<NodeJS.Timeout>()
    const onToast = (toast: Toast): void => {
      const id = nextToastId.current++
      setToasts((prev) => [...prev, { ...toast, id }])
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
    }
  }, [engine, onExit])

  const activeId = engine.active()
  useEffect(() => setOffset(0), [activeId])

  const sidebarShown = columns >= SIDEBAR_MIN_COLUMNS
  const convs = engine.convs()
  const pending = engine.pending()
  const matches = matchCommands(input.text)
  const paneRows = Math.max(MIN_PANE_ROWS, rows - FIXED_ROWS - matches.length)
  const mainWidth = columns - (sidebarShown ? SIDEBAR_WIDTH : 0)
  const activeConv = convs.find((c) => c.id === activeId)

  const lines: Line[] = activeId
    ? buildLines(engine.messages(activeId, HISTORY_LIMIT), mainWidth - 2)
    : plainLines(engine.home(), mainWidth - 2)
  const { visible, maxOffset } = windowLines(lines, paneRows, offset)

  const onScroll = useCallback(
    (dir: 1 | -1) => setOffset(Math.min(maxOffset, Math.max(0, offset + dir * Math.max(1, paneRows - 2)))),
    [maxOffset, offset, paneRows],
  )
  const onSwitch = (dir: 1 | -1): void => {
    const ids = [null, ...convs.map((c) => c.id)]
    const at = Math.max(0, ids.indexOf(activeId))
    engine.activate(ids[(at + dir + ids.length) % ids.length] ?? null)
  }
  const onSubmit = (text: string): void => {
    setOffset(0)
    void engine.submit(text)
  }

  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    return <Text>Terminal too small (need {MIN_COLUMNS}x{MIN_ROWS})</Text>
  }

  const title = activeConv ? (activeConv.kind === 'group' ? `#${activeConv.title}` : activeConv.title) : 'home'
  const placeholder = activeConv ? `Message ${title} or type / for commands` : 'Type / for commands'

  return (
    <Box width={columns} height={rows} flexDirection="column">
      <Box paddingX={1} justifyContent="space-between">
        <Text>
          <Text bold>pager</Text> · {engine.me.name} · {engine.onlineCount()} online
          {engine.listening() ? '' : <Text dimColor> · connecting…</Text>}
        </Text>
        <Text dimColor>/help</Text>
      </Box>
      <Box flexGrow={1}>
        {sidebarShown ? <Sidebar convs={convs} pending={pending} activeId={activeId} /> : null}
        <Box flexDirection="column" flexGrow={1}>
          <Box paddingX={1}>
            <Text bold>{title}</Text>
            {offset > 0 ? <Text dimColor> · scrolled (PgDn)</Text> : null}
          </Box>
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
          <Prompt
            value={input}
            onEdit={setInput}
            placeholder={placeholder}
            matches={matches}
            onSubmit={onSubmit}
            onScroll={onScroll}
            onSwitch={onSwitch}
            onQuit={onExit}
          />
        </Box>
      </Box>
      <Box paddingX={1}>
        <Text dimColor>Enter send · Tab complete · Ctrl+N/P switch · PgUp/PgDn scroll · /help</Text>
      </Box>
      <Toasts toasts={toasts} />
    </Box>
  )
}
