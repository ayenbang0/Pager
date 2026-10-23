// In-browser stand-in for window.pager.d (the Electron preload's daemon client), so the renderer runs in plain
// Chromium with no Electron. Same shape as the real thing: state/onState/call/attach/write/resize/onData/onToast/
// block/onBlock (+ onResync/onStatus/restart/quit). Pure browser ES module; the only import is DEFAULT_SETTINGS.
//
// Model (see pager-desktop-contract.md): sessions -> tabs -> a binary tree of panes. Panes of kind 'block:<name>'
// have no PTY. Every other pane runs a small in-memory line-editing "shell" that prints realistic ANSI and keeps a
// bounded scrollback (256 KiB) that d.attach() replays. Output only reaches onData for panes that were attached
// (exactly like the daemon, which streams to attached clients only).
import { DEFAULT_SETTINGS } from './store.js'

const SCROLLBACK = 256 * 1024
const SETTINGS_KEY = 'pager.mock.settings'
const KINDS = new Set(['pager', 'shell', 'omp', 'claude', 'opencode', 'hermes', 'custom'])
const NON_MUTATING = new Set(['hello', 'state', 'settings.get', 'events.subscribe', 'pane.input', 'pane.resize', 'pane.attach', 'pane.detach', 'pane.capture'])

const enc = new TextEncoder()
const dec = new TextDecoder()
const clone = (v) => JSON.parse(JSON.stringify(v))
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g, '')
const R = '\x1b[0m'

// ------------------------------------------------------------------------------------------ fake file system

const D = (c) => ({ d: true, c })
const REPO = D({
  '.github': D({
    workflows: D({ 'ci.yml': 1180, 'release.yml': 2240 }),
    ISSUE_TEMPLATE: D({ 'bug_report.md': 640, 'feature_request.md': 512 }),
    'dependabot.yml': 310,
  }),
  desktop: D({
    assets: D({ 'icon.ico': 96310, 'pager-mark.svg': 1820 }),
    electron: D({
      blocks: D({ 'board.cjs': 14210, 'database.cjs': 22870, 'files.cjs': 31204, 'git.cjs': 28113, 'notebook.cjs': 9806, 'tasks-core.cjs': 7422 }),
      'daemon.cjs': 18440,
      'main.cjs': 12096,
      'preload.cjs': 3288,
    }),
    renderer: D({
      blocks: D({ 'files-util.js': 6012, 'giticons.js': 4410, 'index.js': 903 }),
      fonts: D({ 'Geist-Variable.woff2': 63800, 'GeistMono-Variable.woff2': 71240 }),
      ui: D({ 'dom.js': 5120, 'mock-daemon.js': 61440, 'store.js': 9344, 'tokens.css': 14880 }),
      'index.html': 4096,
      'pane.js': 21312,
      'renderer.js': 33100,
      'style.css': 18200,
    }),
    'package.json': 1604,
  }),
  dist: D({ app: D({ 'engine.js': 88210, 'state.js': 4420 }), 'cli.js': 40320 }),
  node_modules: D({ '.bin': D({}), ink: D({ 'package.json': 2200 }), react: D({ 'package.json': 1400 }), typescript: D({ 'package.json': 3100 }), xterm: D({ 'package.json': 2600 }) }),
  scripts: D({ 'build.mjs': 2310, 'dev.mjs': 1480, 'release.mjs': 3902 }),
  src: D({
    app: D({ 'engine.test.ts': 28110, 'engine.ts': 64230, 'state.ts': 5120 }),
    daemon: D({ 'daemon.ts': 19800, 'protocol.ts': 6210 }),
    term: D({ 'blocks.ts': 8800, 'osc.ts': 3300 }),
    ui: D({ 'App.tsx': 24100, 'Sidebar.tsx': 7200 }),
    'cli.tsx': 6480,
  }),
  tern: D({ reference: D({ 's104308.png': 184220, 's104341.png': 171004, 's104419.png': 190230 }) }),
  '.gitignore': 96,
  'CHANGELOG.md': 18420,
  LICENSE: 1068,
  'PLAN.md': 7810,
  'README.md': 5290,
  'package-lock.json': 214880,
  'package.json': 2410,
  'tsconfig.json': 612,
})
const HOME_TREE = D({
  Desktop: D({ Projects: D({ Products: D({ pager: REPO, tern: D({}) }), Scratch: D({ 'notes.txt': 1204 }) }), 'todo.txt': 188 }),
  Documents: D({ 'resume.pdf': 91820 }),
  Downloads: D({ 'installer.exe': 48201344 }),
  '.gitconfig': 214,
})
const REPO_SEGS = ['Desktop', 'Projects', 'Products', 'pager']
const WALK_SKIP = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'target'])
const IGNORED_TOP = new Set(['node_modules', 'dist'])

// Repo-relative status shared by `git status` and the files/git blocks.
const CHANGED = { 'CHANGELOG.md': 'M', 'package.json': 'M', 'package-lock.json': 'M', 'README.md': 'M', 'src/': 'M' }
const GIT_FILES = [
  { path: 'CHANGELOG.md', xy: '.M' },
  { path: 'README.md', xy: '.M' },
  { path: 'package-lock.json', xy: '.M' },
  { path: 'package.json', xy: '.M' },
  { path: 'src/app/engine.ts', xy: '.M' },
  { path: 'src/daemon/daemon.ts', xy: '.M' },
  { path: 'src/ui/App.tsx', xy: '.M' },
  { path: 'PLAN.md', xy: '??' },
]
const COMMIT_LINES = [
  'desktop: rebuild renderer shell on plain ES modules',
  'daemon: persist scrollback and layout across restarts',
  'files: compact folder chains in the sidebar tree',
  'git: summary endpoint for headers and prompt bars',
  'term: coalesce pane writes per animation frame',
  'blocks: board and tasks share one store',
  'themes: import the omp palette set',
  'settings: right-docked sheet with live preview',
  'cli: pager open <path> grants a files root',
  'chore: bump ink to 5.2',
]
const hashOf = (i) => (((i * 2654435761) >>> 0).toString(16).padStart(8, '0').repeat(5)).slice(0, 40)

function treeFiles(node, prefix, out) {
  for (const [name, v] of Object.entries(node.c)) {
    if (v.d) {
      if (!prefix && IGNORED_TOP.has(name)) continue
      if (WALK_SKIP.has(name)) continue
      treeFiles(v, prefix + name + '/', out)
    } else out.push(prefix + name)
  }
  return out
}

function findChild(dir, name) {
  if (!dir || !dir.d) return null
  if (name in dir.c) return name
  const low = name.toLowerCase()
  for (const k of Object.keys(dir.c)) if (k.toLowerCase() === low) return k
  return null
}

/** Resolve canonical segments under the home tree; null when it does not exist. */
function lookup(segs) {
  let node = HOME_TREE
  const canon = []
  for (const s of segs) {
    const k = findChild(node, s)
    if (k === null) return null
    node = node.c[k]
    canon.push(k)
  }
  return { node, segs: canon }
}

function fileText(name) {
  const lower = name.toLowerCase()
  if (lower === 'package.json') return '{\n  "name": "pager",\n  "version": "0.94.0",\n  "type": "module",\n  "bin": { "pager": "dist/cli.js" },\n  "scripts": { "build": "node scripts/build.mjs", "dev": "node scripts/dev.mjs" }\n}\n'
  if (lower === 'tsconfig.json') return '{\n  "compilerOptions": { "target": "ES2023", "module": "NodeNext", "strict": true, "outDir": "dist" },\n  "include": ["src"]\n}\n'
  if (lower === 'readme.md') return '# pager\n\nA terminal workspace with a daemon underneath.\n\n- panes that survive closing the window\n- blocks: files, git, database, notebook\n'
  if (lower === 'changelog.md') return '# Changelog\n\n## 0.94.0\n\n- Rebuilt the desktop renderer.\n- Files sidebar with git status.\n'
  if (lower === 'license') return 'MIT License\n\nCopyright (c) pager contributors\n'
  if (lower === 'plan.md') return '# Plan\n\n1. Renderer shell\n2. Blocks\n3. Daemon\n'
  const ext = lower.slice(lower.lastIndexOf('.') + 1)
  if (['js', 'cjs', 'mjs', 'ts', 'tsx'].includes(ext)) return `// ${name}\n// (mock file contents)\nexport {}\n`
  if (ext === 'css') return `/* ${name} */\n:root { color-scheme: dark; }\n`
  if (ext === 'html') return '<!doctype html>\n<title>pager</title>\n'
  return `${name}\n(mock file contents)\n`
}

// ------------------------------------------------------------------------------------------ module entry

export function createMockDaemon(opts = {}) {
  const HOME = opts.home ?? 'C:\\Users\\welov'
  const HOME_FWD = HOME.replace(/\\/g, '/')
  const DEFAULT_CWD = opts.cwd ?? '~/Desktop/Projects/Products/pager'
  const WELCOME = opts.welcomeToast !== false

  // ---- path helpers (cwd strings are '~/a/b'; paths outside the fake home are kept verbatim)
  function parsePath(input, base) {
    let p = String(input ?? '').trim().replace(/\\/g, '/')
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
    const low = p.toLowerCase()
    let segs
    if (p === '~' || p.startsWith('~/')) {
      segs = []
      p = p.slice(1)
    } else if (low === HOME_FWD.toLowerCase() || low.startsWith(HOME_FWD.toLowerCase() + '/')) {
      segs = []
      p = p.slice(HOME_FWD.length)
    } else if (/^[a-z]:/i.test(p) || p.startsWith('/')) return null
    else segs = base.slice()
    for (const part of p.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') segs.pop()
      else segs.push(part)
    }
    return segs
  }
  const tildeOf = (segs) => '~' + segs.map((s) => '/' + s).join('')
  const winOf = (segs) => HOME + segs.map((s) => '\\' + s).join('')
  const baseName = (p) => (p === '~' ? '~' : p.split(/[\\/]/).filter(Boolean).pop() || p)
  function normCwd(cwd) {
    if (!cwd) return DEFAULT_CWD
    const segs = parsePath(cwd, [])
    if (!segs) return String(cwd)
    const hit = lookup(segs)
    return tildeOf(hit ? hit.segs : segs)
  }
  const paneSegs = (pane) => parsePath(pane.cwd, [])
  const inRepo = (segs) => segs && REPO_SEGS.every((s, i) => segs[i] === s)
  const repoRel = (segs) => segs.slice(REPO_SEGS.length)

  // ---- state
  const settingsStore = 'storage' in opts ? opts.storage : (() => { try { return globalThis.localStorage } catch { return null } })()
  function loadSettings() {
    try {
      const raw = settingsStore && settingsStore.getItem(SETTINGS_KEY)
      const v = raw ? JSON.parse(raw) : {}
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    } catch {
      return {}
    }
  }
  const state = { sessions: [], panes: [], activeSession: '', clients: 1, settings: loadSettings() }
  const counters = { s: 0, t: 0, p: 0 }
  const newId = (k) => k + ++counters[k]
  const shells = new Map() // paneId -> shell
  const autoTitle = new Set() // tab ids whose title follows the focused pane
  const stateSubs = new Set()
  const dataSubs = new Set()
  const toastSubs = new Set()
  const blockSubs = new Map() // name -> Set<fn>
  const resyncSubs = new Set()
  const statusSubs = new Set()

  const paneById = (id) => state.panes.find((p) => p.id === id) || null
  const needPane = (id) => {
    const p = paneById(id)
    if (!p) throw new Error('pane not found: ' + id)
    return p
  }
  const leavesOf = (n) => (n.type === 'pane' ? [n.paneId] : [...leavesOf(n.a), ...leavesOf(n.b)])
  const firstLeaf = (n) => (n.type === 'pane' ? n.paneId : firstLeaf(n.a))
  function tabOfPane(paneId) {
    for (const session of state.sessions) for (const tab of session.tabs) if (leavesOf(tab.root).includes(paneId)) return { session, tab }
    return null
  }
  function tabById(tabId) {
    for (const session of state.sessions) for (const tab of session.tabs) if (tab.id === tabId) return { session, tab }
    return null
  }
  const needTab = (id) => {
    const hit = tabById(id)
    if (!hit) throw new Error('tab not found: ' + id)
    return hit
  }
  const needSession = (id) => {
    const s = state.sessions.find((x) => x.id === id)
    if (!s) throw new Error('session not found: ' + id)
    return s
  }
  const activeSession = () => state.sessions.find((s) => s.id === state.activeSession) || state.sessions[0]
  const activeTab = () => {
    const s = activeSession()
    return s.tabs.find((t) => t.id === s.activeTab) || s.tabs[0]
  }

  function syncTitle(tab) {
    if (!autoTitle.has(tab.id)) return
    const p = paneById(tab.focus)
    if (p) tab.title = p.title
  }

  function emitState() {
    queueMicrotask(() => {
      if (!stateSubs.size) return
      const snap = clone(state)
      for (const fn of [...stateSubs]) {
        try { fn(snap) } catch (e) { console.error('[mock-daemon] onState subscriber failed', e) }
      }
    })
  }

  // ------------------------------------------------------------------------------------ scrollback + IO

  function ringWrite(sh, bytes) {
    const n = bytes.length
    if (!sh.ring) sh.ring = new Uint8Array(SCROLLBACK)
    const ring = sh.ring
    if (n >= SCROLLBACK) {
      ring.set(bytes.subarray(n - SCROLLBACK))
      sh.head = 0
      sh.len = SCROLLBACK
    } else {
      const first = Math.min(n, SCROLLBACK - sh.head)
      ring.set(bytes.subarray(0, first), sh.head)
      if (first < n) ring.set(bytes.subarray(first), 0)
      sh.head = (sh.head + n) % SCROLLBACK
      sh.len = Math.min(SCROLLBACK, sh.len + n)
    }
  }
  function snapshot(sh) {
    if (!sh.ring || !sh.len) return new Uint8Array(0)
    const out = new Uint8Array(sh.len)
    const start = (sh.head - sh.len + SCROLLBACK) % SCROLLBACK
    const first = Math.min(sh.len, SCROLLBACK - start)
    out.set(sh.ring.subarray(start, start + first), 0)
    if (first < sh.len) out.set(sh.ring.subarray(0, sh.len - first), first)
    if (sh.len === SCROLLBACK) {
      // history was dropped: start at a line boundary so the replay never opens inside an escape sequence
      const lim = Math.min(out.length, 8192)
      for (let i = 0; i < lim; i++) if (out[i] === 10) return out.subarray(i + 1)
    }
    return out
  }

  /** The single output path: scrollback buffer + onData for attached panes. */
  function emit(sh, str) {
    const bytes = typeof str === 'string' ? enc.encode(str) : str
    if (!bytes.length) return
    ringWrite(sh, bytes)
    sh.seq += bytes.length
    if (sh.attached && dataSubs.size) {
      for (const fn of [...dataSubs]) {
        try { fn(sh.pane.id, bytes) } catch (e) { console.error('[mock-daemon] onData subscriber failed', e) }
      }
    }
  }
  const print = (sh, text) => emit(sh, text.replace(/\r?\n/g, '\r\n'))

  // ------------------------------------------------------------------------------------ fake shell

  const usesMarks = (sh) => sh.pane.kind === 'shell'
  function promptText(sh) {
    const k = sh.pane.kind
    if (k === 'pager') return '\x1b[1;36m›' + R + ' '
    if (k === 'omp') return '\x1b[1;35m❯' + R + ' '
    const segs = paneSegs(sh.pane)
    return 'PS ' + (segs ? winOf(segs) : sh.pane.cwd) + '> '
  }
  function prompt(sh) {
    const m = usesMarks(sh)
    emit(sh, (m ? '\x1b]133;A\x07' : '') + promptText(sh) + (m ? '\x1b]133;B\x07' : ''))
  }
  function boxed(lines, color) {
    const w = Math.max(...lines.map((l) => stripAnsi(l).length)) + 2
    const out = [color + '╭' + '─'.repeat(w) + '╮' + R]
    for (const l of lines) out.push(color + '│' + R + ' ' + l + ' '.repeat(w - 1 - stripAnsi(l).length) + color + '│' + R)
    out.push(color + '╰' + '─'.repeat(w) + '╯' + R)
    return out.join('\r\n') + '\r\n'
  }
  function banner(sh) {
    const pane = sh.pane
    const accent = '\x1b[38;2;75;139;255m'
    const dim = '\x1b[2m'
    if (pane.kind === 'pager') {
      const theme = state.settings.theme ?? DEFAULT_SETTINGS.theme
      emit(sh, '\r\n' + boxed([
        accent + '\x1b[1m◆ pager' + R + dim + '   0.94.0' + R,
        dim + 'A terminal workspace with a daemon underneath.' + R,
      ], accent) + '\r\n')
      const rows = [['New chat', 'Ctrl+N'], ['Open files', 'Ctrl+O'], ['Git changes', 'Ctrl+G'], ['Command palette', 'Ctrl+K'], ['Settings', 'Ctrl+,']]
      for (const [a, b] of rows) emit(sh, '  ' + accent + '›' + R + ' ' + a.padEnd(18) + dim + b + R + '\r\n')
      emit(sh, '\r\n  ' + dim + 'theme ' + theme + ' · mock daemon (browser)' + R + '\r\n  ' + dim + 'type "help" for the commands this mock understands' + R + '\r\n\r\n')
    } else if (pane.kind === 'omp') {
      emit(sh, '\r\n' + boxed([
        '\x1b[1;35m ◗ omp' + R + dim + '   oh-my-pi · mock' + R,
        dim + 'cwd ' + pane.cwd + R,
      ], '\x1b[35m') + '\r\n\x1b[1mWhat are we cooking?' + R + '\r\n\r\n')
    } else if (pane.kind === 'claude' || pane.kind === 'opencode' || pane.kind === 'hermes') {
      const col = { claude: '\x1b[38;5;208m', opencode: '\x1b[38;5;75m', hermes: '\x1b[38;5;141m' }[pane.kind]
      emit(sh, col + '● ' + pane.kind + R + dim + ' (mock session)' + R + '\r\n\r\n')
    } else if (pane.kind === 'custom') {
      emit(sh, dim + 'custom command: ' + (pane.command || '(none)') + R + '\r\n\r\n')
    } else {
      emit(sh, 'Windows PowerShell (mock)\r\nCopyright (C) Pager contributors. Type "help" for the commands available here.\r\n\r\n')
    }
  }

  function spawnShell(pane) {
    const sh = { pane, ring: null, head: 0, len: 0, seq: 0, attached: false, line: '', hist: [], busy: false, job: null, esc: '', lastCR: false, exited: false }
    shells.set(pane.id, sh)
    banner(sh)
    prompt(sh)
    return sh
  }

  function tokenize(line) {
    const out = []
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g
    let m
    while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3])
    return out
  }

  function finishCommand(sh, code = 0) {
    if (usesMarks(sh)) emit(sh, '\x1b]133;D;' + code + '\x07')
    prompt(sh)
  }

  /** Paced output: step() returns the next chunk string, or null when done. setTimeout(0) between chunks. */
  function startJob(sh, step) {
    const job = { cancelled: false }
    sh.busy = true
    sh.job = job
    const tick = () => {
      if (job.cancelled || sh.exited) return
      const chunk = step()
      if (chunk === null) {
        sh.busy = false
        sh.job = null
        finishCommand(sh, 0)
        return
      }
      emit(sh, chunk)
      setTimeout(tick, 0)
    }
    setTimeout(tick, 0)
  }

  const typeColor = (name, isDir) => {
    if (isDir) return '\x1b[1;34m'
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    if (name.startsWith('.')) return '\x1b[2m'
    if (['json', 'yml', 'yaml'].includes(ext)) return '\x1b[33m'
    if (['js', 'cjs', 'mjs', 'ts', 'tsx', 'css', 'html'].includes(ext)) return '\x1b[36m'
    if (['png', 'svg', 'ico', 'woff2'].includes(ext)) return '\x1b[35m'
    if (ext === 'exe') return '\x1b[1;32m'
    return ''
  }

  const commands = {
    help(sh) {
      print(sh, [
        '\x1b[1mmock shell commands\x1b[0m',
        '  help            this list',
        '  echo <text>     print text',
        '  ls | dir [-la]  list the fake repo (dirs in blue)',
        '  cd <dir>        change directory (.., name, ~, absolute)',
        '  pwd             print the working directory',
        '  cat <file>      print a fake file',
        '  clear | cls     clear the screen (also Ctrl+L)',
        '  git status      coloured status',
        '  git log --oneline',
        '  color           16 colours, 256 ramp, truecolour gradient',
        '  seq <N>         print 1..N fast (perf test)',
        '  bigflood        5 MiB of output in 64 KiB chunks',
        '  exit            end this pane (state: exited)',
        '',
      ].join('\n'))
    },
    echo(sh, args) {
      print(sh, args.join(' ') + '\n')
    },
    ls(sh, args) {
      const flags = args.filter((a) => a.startsWith('-')).join('')
      const target = args.find((a) => !a.startsWith('-'))
      const base = paneSegs(sh.pane)
      const segs = base && (target ? parsePath(target, base) : base)
      const hit = segs && lookup(segs)
      if (!hit) {
        print(sh, '\x1b[31mls: cannot access \'' + (target || sh.pane.cwd) + '\': No such file or directory' + R + '\n')
        return
      }
      if (!hit.node.d) {
        print(sh, typeColor(target, false) + target + R + '\n')
        return
      }
      const showAll = /a/.test(flags)
      const rows = Object.entries(hit.node.c)
        .filter(([n]) => showAll || !n.startsWith('.'))
        .map(([name, v]) => ({ name, dir: !!v.d, size: v.d ? 0 : v }))
        .sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1))
      if (!rows.length) return
      if (/l/.test(flags)) {
        for (const r of rows) print(sh, (r.dir ? 'drwxr-xr-x' : '-rw-r--r--') + '  ' + String(r.size).padStart(9) + '  Oct 20 14:02  ' + typeColor(r.name, r.dir) + r.name + R + '\n')
        return
      }
      const w = Math.max(...rows.map((r) => r.name.length)) + 2
      const per = Math.max(1, Math.floor((sh.pane.cols || 80) / w))
      let line = ''
      rows.forEach((r, i) => {
        line += typeColor(r.name, r.dir) + r.name + R + ' '.repeat(w - r.name.length)
        if ((i + 1) % per === 0 || i === rows.length - 1) {
          print(sh, line.replace(/\s+$/, '') + '\n')
          line = ''
        }
      })
    },
    cd(sh, args) {
      const arg = args[0]
      const base = paneSegs(sh.pane)
      const segs = !arg || arg === '~' ? [] : base && parsePath(arg, base)
      const hit = segs && lookup(segs)
      if (!hit) {
        print(sh, '\x1b[31mcd: Cannot find path \'' + (arg || '~') + '\' because it does not exist.' + R + '\n')
        return
      }
      if (!hit.node.d) {
        print(sh, '\x1b[31mcd: \'' + arg + '\' is not a directory.' + R + '\n')
        return
      }
      sh.pane.cwd = tildeOf(hit.segs)
      if (sh.pane.kind === 'shell') sh.pane.title = baseName(sh.pane.cwd)
      const loc = tabOfPane(sh.pane.id)
      if (loc) syncTitle(loc.tab)
      emitState()
    },
    pwd(sh) {
      const segs = paneSegs(sh.pane)
      print(sh, (segs ? winOf(segs) : sh.pane.cwd) + '\n')
    },
    cat(sh, args) {
      const base = paneSegs(sh.pane)
      const hit = args[0] && base && lookup(parsePath(args[0], base))
      if (!hit || hit.node.d) {
        print(sh, '\x1b[31mcat: ' + (args[0] || '(missing operand)') + ': No such file\x1b[0m\n')
        return
      }
      print(sh, fileText(hit.segs[hit.segs.length - 1]))
    },
    clear(sh) {
      emit(sh, '\x1b[2J\x1b[3J\x1b[H')
    },
    git(sh, args) {
      const segs = paneSegs(sh.pane)
      if (!inRepo(segs)) {
        print(sh, '\x1b[31mfatal: not a git repository (or any of the parent directories): .git' + R + '\n')
        return
      }
      const sub = args[0]
      if (sub === 'status') {
        const lines = [
          'On branch \x1b[1mmain' + R,
          "Your branch is ahead of 'origin/main' by 5 commits.",
          '  (use "git push" to publish your local commits)',
          '',
          'Changes not staged for commit:',
          '  (use "git add <file>..." to update what will be committed)',
          '  (use "git restore <file>..." to discard changes in working directory)',
        ]
        for (const f of GIT_FILES) if (f.xy !== '??') lines.push('\t\x1b[31mmodified:   ' + f.path + R)
        lines.push('', 'Untracked files:', '  (use "git add <file>..." to include in what will be committed)')
        for (const f of GIT_FILES) if (f.xy === '??') lines.push('\t\x1b[31m' + f.path + R)
        lines.push('', 'no changes added to commit (use "git add" and/or "git commit -a")', '')
        print(sh, lines.join('\n'))
      } else if (sub === 'log') {
        const oneline = args.includes('--oneline')
        const out = []
        COMMIT_LINES.forEach((msg, i) => {
          const h = hashOf(i + 1)
          const deco = i === 0 ? ' \x1b[33m(\x1b[1;36mHEAD -> \x1b[1;32mmain' + R + '\x1b[33m)' + R : i === 5 ? ' \x1b[33m(\x1b[1;31morigin/main' + R + '\x1b[33m)' + R : ''
          if (oneline) out.push('\x1b[33m' + h.slice(0, 7) + R + deco + ' ' + msg)
          else out.push('\x1b[33mcommit ' + h + R + deco, 'Author: welov <welov@example.com>', 'Date:   ' + new Date(Date.now() - i * 5 * 3600e3).toDateString(), '', '    ' + msg, '')
        })
        print(sh, out.join('\n') + '\n')
      } else if (sub === 'branch') {
        print(sh, '* \x1b[32mmain' + R + '\n')
      } else if (!sub) {
        print(sh, 'usage: git <status|log|branch>\n')
      } else {
        print(sh, '\x1b[31mgit: \'' + sub + '\' is not implemented in the mock' + R + '\n')
      }
    },
    color(sh) {
      const out = ['\x1b[1m16 colours' + R]
      for (const base of [40, 100]) {
        let row = ''
        for (let i = 0; i < 8; i++) row += '\x1b[' + (base + i) + 'm   ' + R
        out.push(row)
      }
      out.push('', '\x1b[1m256-colour ramp' + R)
      for (let r = 0; r < 6; r++) {
        let row = ''
        for (let i = 16 + r * 36; i < 16 + (r + 1) * 36; i++) row += '\x1b[48;5;' + i + 'm ' + R
        out.push(row)
      }
      let gray = ''
      for (let i = 232; i < 256; i++) gray += '\x1b[48;5;' + i + 'm  ' + R
      out.push(gray, '', '\x1b[1mtruecolour gradient' + R)
      let tc = ''
      for (let i = 0; i < 72; i++) {
        const t = i / 71
        tc += '\x1b[48;2;' + Math.round(255 * (1 - t)) + ';' + Math.round(255 * Math.sin(t * Math.PI)) + ';' + Math.round(255 * t) + 'm ' + R
      }
      out.push(tc, '')
      print(sh, out.join('\n'))
    },
    seq(sh, args) {
      const n = Math.floor(Number(args[0]))
      if (!Number.isFinite(n) || n < 1) {
        print(sh, '\x1b[31musage: seq <N>' + R + '\n')
        return
      }
      const total = Math.min(n, 5_000_000)
      let i = 1
      startJob(sh, () => {
        if (i > total) return null
        const end = Math.min(total, i + 4095)
        const parts = []
        for (; i <= end; i++) parts.push(i)
        return parts.join('\r\n') + '\r\n'
      })
      return true
    },
    bigflood(sh) {
      // 80 chunks x 1024 fixed-width lines x 64 bytes = exactly 5 MiB, never cutting an escape sequence
      const CHUNK_LINES = 1024
      const CHUNKS = 80
      const filler = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
      let n = 0
      let sent = 0
      startJob(sh, () => {
        if (sent === CHUNKS) {
          emit(sh, '\x1b[1;32mbigflood: done, ' + CHUNKS * CHUNK_LINES * 64 + ' bytes' + R + '\r\n')
          return null
        }
        const lines = new Array(CHUNK_LINES)
        for (let i = 0; i < CHUNK_LINES; i++, n++) {
          const head = '\x1b[3' + (1 + (n % 6)) + 'mflood ' + String(n).padStart(7, '0') + R + ' '
          lines[i] = head + filler.slice(n % 7, n % 7 + 62 - head.length) + '\r\n'
        }
        sent++
        return lines.join('')
      })
      return true
    },
    exit(sh) {
      exitShell(sh, 0)
      return true
    },
  }
  commands.dir = commands.ls
  commands.cls = commands.clear

  function exitShell(sh, code) {
    if (sh.job) sh.job.cancelled = true
    sh.busy = false
    sh.exited = true
    emit(sh, '\x1b[2m[process exited with code ' + code + ']' + R + '\r\n')
    sh.pane.state = 'exited'
    sh.pane.exitCode = code
    delete sh.pane.pid
    emitState()
  }

  function runLine(sh, line) {
    const toks = tokenize(line)
    const name = (toks[0] || '').toLowerCase()
    const fn = Object.prototype.hasOwnProperty.call(commands, name) ? commands[name] : null
    if (usesMarks(sh)) emit(sh, '\x1b]133;C\x07')
    if (!fn) {
      print(sh, '\x1b[31m' + toks[0] + ': command not found' + R + '\n')
      finishCommand(sh, 127)
      return
    }
    const async = fn(sh, toks.slice(1))
    if (async === true) return // a job or exit owns the rest
    finishCommand(sh, 0)
  }

  const escDone = (s) => {
    if (s.length > 64) return true
    if (s.length === 2) return s[1] !== '[' && s[1] !== 'O' && s[1] !== ']'
    if (s[1] === '[') return s.charCodeAt(s.length - 1) >= 0x40 && s.charCodeAt(s.length - 1) <= 0x7e
    if (s[1] === 'O') return s.length === 3
    return s.endsWith('\x07') || s.endsWith('\x1b\\')
  }

  function input(sh, data) {
    if (sh.exited) return
    for (const ch of data) {
      if (sh.esc) {
        sh.esc += ch
        if (escDone(sh.esc)) sh.esc = ''
        continue
      }
      if (ch === '\x1b') {
        sh.esc = ch
        continue
      }
      if (ch === '\x03') {
        if (sh.job) sh.job.cancelled = true
        const wasBusy = sh.busy
        sh.busy = false
        sh.job = null
        sh.line = ''
        emit(sh, '^C\r\n')
        if (wasBusy) finishCommand(sh, 130)
        else prompt(sh)
        continue
      }
      if (sh.busy) continue
      if (ch === '\r' || (ch === '\n' && !sh.lastCR)) {
        sh.lastCR = ch === '\r'
        emit(sh, '\r\n')
        const line = sh.line.trim()
        sh.line = ''
        if (!line) {
          prompt(sh)
          continue
        }
        sh.hist.push(line)
        runLine(sh, line)
        if (sh.exited) return
        continue
      }
      sh.lastCR = false
      if (ch === '\n') continue
      if (ch === '\x7f' || ch === '\b') {
        if (sh.line.length) {
          sh.line = Array.from(sh.line).slice(0, -1).join('')
          emit(sh, '\b \b')
        }
      } else if (ch === '\x0c') {
        emit(sh, '\x1b[2J\x1b[3J\x1b[H')
        prompt(sh)
        if (sh.line) emit(sh, sh.line)
      } else if (ch === '\x15') {
        if (sh.line) emit(sh, '\b \b'.repeat(Array.from(sh.line).length))
        sh.line = ''
      } else if (ch >= ' ') {
        sh.line += ch
        emit(sh, ch)
      }
    }
  }

  // ------------------------------------------------------------------------------------ layout model

  function paneTitle(kind, cwd, command) {
    if (kind.startsWith('block:')) return kind.slice(6)
    if (kind === 'shell') return baseName(cwd)
    if (kind === 'custom') return (command ? String(command).trim().split(/\s+/)[0] : '') || 'custom'
    return kind
  }

  function makePane({ kind = 'shell', cwd, command } = {}) {
    if (typeof kind !== 'string' || !(KINDS.has(kind) || (kind.startsWith('block:') && kind.length > 6))) throw new Error('unknown pane kind: ' + kind)
    const block = kind.startsWith('block:')
    const pane = { id: newId('p'), kind, title: '', cwd: normCwd(cwd), cols: 80, rows: 24, state: 'running' }
    if (command !== undefined && command !== null && command !== '') pane.command = typeof command === 'string' ? command : JSON.stringify(command)
    pane.title = paneTitle(kind, pane.cwd, pane.command)
    if (!block) pane.pid = 4000 + counters.p * 37
    state.panes.push(pane)
    if (!block) spawnShell(pane)
    return pane
  }

  function killPane(paneId) {
    const sh = shells.get(paneId)
    if (sh && sh.job) sh.job.cancelled = true
    shells.delete(paneId)
    const i = state.panes.findIndex((p) => p.id === paneId)
    if (i >= 0) state.panes.splice(i, 1)
  }

  function addTab(session, spec, { activate = true } = {}) {
    const pane = makePane(spec)
    const tab = { id: newId('t'), title: pane.title, root: { type: 'pane', paneId: pane.id }, focus: pane.id }
    session.tabs.push(tab)
    autoTitle.add(tab.id)
    if (activate) {
      session.activeTab = tab.id
      state.activeSession = session.id
    }
    return { tab, pane }
  }

  function addSession(name, spec) {
    const session = { id: newId('s'), name: name || 'Session ' + (counters.s + 1), tabs: [], activeTab: '' }
    state.sessions.push(session)
    const { tab, pane } = addTab(session, spec)
    return { session, tab, pane }
  }

  function removeSession(session) {
    const i = state.sessions.indexOf(session)
    state.sessions.splice(i, 1)
    if (state.activeSession === session.id && state.sessions.length) state.activeSession = state.sessions[Math.min(i, state.sessions.length - 1)].id
  }

  function closeTab(session, tab, killPanes = true) {
    const i = session.tabs.indexOf(tab)
    if (killPanes) for (const id of leavesOf(tab.root)) killPane(id)
    session.tabs.splice(i, 1)
    autoTitle.delete(tab.id)
    if (!session.tabs.length) {
      if (state.sessions.length > 1) removeSession(session)
      else addTab(session, { kind: 'shell' })
      return
    }
    if (session.activeTab === tab.id) session.activeTab = session.tabs[Math.min(i, session.tabs.length - 1)].id
  }

  /** Remove a leaf, collapsing its parent split; returns the new subtree (null when it was the only leaf). */
  function removeLeaf(n, id) {
    if (n.type === 'pane') return n.paneId === id ? null : n
    const a = removeLeaf(n.a, id)
    const b = removeLeaf(n.b, id)
    if (a === null) return b
    if (b === null) return a
    return { ...n, a, b }
  }
  function siblingOf(n, id) {
    if (n.type === 'pane') return null
    if (n.a.type === 'pane' && n.a.paneId === id) return n.b
    if (n.b.type === 'pane' && n.b.paneId === id) return n.a
    return siblingOf(n.a, id) || siblingOf(n.b, id)
  }
  function replaceLeaf(n, id, make) {
    if (n.type === 'pane') return n.paneId === id ? make(n) : n
    return { ...n, a: replaceLeaf(n.a, id, make), b: replaceLeaf(n.b, id, make) }
  }
  function directSplit(n, id) {
    if (n.type === 'pane') return null
    if ((n.a.type === 'pane' && n.a.paneId === id) || (n.b.type === 'pane' && n.b.paneId === id)) return n
    return directSplit(n.a, id) || directSplit(n.b, id)
  }

  function detachPane(paneId) {
    const loc = tabOfPane(paneId)
    if (!loc) return null
    const { session, tab } = loc
    const sib = siblingOf(tab.root, paneId)
    const root = removeLeaf(tab.root, paneId)
    if (root === null) return { session, tab, emptied: true }
    tab.root = root
    if (tab.focus === paneId) tab.focus = firstLeaf(sib || root)
    syncTitle(tab)
    return { session, tab, emptied: false }
  }

  // ------------------------------------------------------------------------------------ requests

  function writeTo(paneId, data) {
    const sh = shells.get(paneId)
    if (!sh) return
    input(sh, typeof data === 'string' ? data : dec.decode(data))
  }

  const toB64 = (bytes) => {
    let s = ''
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return btoa(s)
  }

  function doAttach(paneId) {
    const pane = needPane(paneId)
    const sh = shells.get(paneId)
    if (!sh) return { replay: new Uint8Array(0), cols: pane.cols, rows: pane.rows, seq: 0 }
    sh.attached = true
    return { replay: snapshot(sh).slice(), cols: pane.cols, rows: pane.rows, seq: sh.seq }
  }

  const handlers = {
    hello: () => ({ version: 1, server: 'mock-daemon' }),
    state: () => clone(state),
    'settings.get': () => clone(state.settings),
    'settings.set'({ patch } = {}) {
      if (patch && typeof patch === 'object') for (const k of Object.keys(patch)) state.settings[k] = patch[k]
      try { if (settingsStore) settingsStore.setItem(SETTINGS_KEY, JSON.stringify(state.settings)) } catch { /* storage full or blocked */ }
      return clone(state.settings)
    },
    'events.subscribe': () => ({ ok: true }),
    'daemon.restart': () => ({ ok: true }),
    'daemon.stop': () => ({ ok: true }),

    'session.new'({ name, kind, cwd, command } = {}) {
      const { session, tab, pane } = addSession(name, { kind: kind || 'shell', cwd, command })
      return { sessionId: session.id, tabId: tab.id, paneId: pane.id }
    },
    'session.activate'({ sessionId }) {
      state.activeSession = needSession(sessionId).id
      return { ok: true }
    },
    'session.close'({ sessionId } = {}) {
      const session = needSession(sessionId || state.activeSession)
      for (const tab of session.tabs) {
        for (const id of leavesOf(tab.root)) killPane(id)
        autoTitle.delete(tab.id)
      }
      removeSession(session)
      if (!state.sessions.length) {
        const { session: s } = addSession('Default', { kind: 'shell' })
        state.activeSession = s.id
      }
      return { ok: true }
    },
    'session.rename'({ sessionId, name }) {
      needSession(sessionId || state.activeSession).name = String(name ?? '')
      return { ok: true }
    },

    'tab.new'({ sessionId, kind, cwd, command, title } = {}) {
      const session = needSession(sessionId || state.activeSession)
      const k = kind || 'shell'
      let from = cwd
      if (!from && !String(k).startsWith('block:')) {
        const cur = session.tabs.find((t) => t.id === session.activeTab)
        const fp = cur && paneById(cur.focus)
        if (fp && !fp.kind.startsWith('block:')) from = fp.cwd
      }
      const { tab, pane } = addTab(session, { kind: k, cwd: from, command })
      if (title) {
        tab.title = String(title)
        autoTitle.delete(tab.id)
      }
      return { tabId: tab.id, paneId: pane.id }
    },
    'tab.close'({ tabId } = {}) {
      const { session, tab } = needTab(tabId || activeTab().id)
      closeTab(session, tab)
      return { ok: true }
    },
    'tab.rename'({ tabId, title }) {
      const { tab } = needTab(tabId || activeTab().id)
      tab.title = String(title ?? '')
      autoTitle.delete(tab.id)
      return { ok: true }
    },
    'tab.activate'({ tabId }) {
      const { session, tab } = needTab(tabId)
      session.activeTab = tab.id
      state.activeSession = session.id
      return { ok: true }
    },

    'pane.split'({ paneId, dir, kind, cwd, command, before, ratio } = {}) {
      const src = needPane(paneId)
      if (dir !== 'row' && dir !== 'col') throw new Error('dir must be row or col')
      const { tab } = tabOfPane(paneId)
      const k = kind || 'shell'
      const from = cwd || (src.kind.startsWith('block:') || k.startsWith('block:') ? undefined : src.cwd)
      const pane = makePane({ kind: k, cwd: from, command })
      const r = clamp(typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : 0.5, 0.1, 0.9)
      const leaf = { type: 'pane', paneId: pane.id }
      tab.root = replaceLeaf(tab.root, paneId, (old) => (before ? { type: 'split', dir, ratio: r, a: leaf, b: old } : { type: 'split', dir, ratio: r, a: old, b: leaf }))
      tab.focus = pane.id
      syncTitle(tab)
      return { paneId: pane.id }
    },
    'pane.close'({ paneId }) {
      needPane(paneId)
      const loc = detachPane(paneId)
      killPane(paneId)
      if (loc && loc.emptied) closeTab(loc.session, loc.tab, false)
      return { ok: true }
    },
    'pane.focus'({ paneId }) {
      needPane(paneId)
      const { session, tab } = tabOfPane(paneId)
      tab.focus = paneId
      session.activeTab = tab.id
      state.activeSession = session.id
      syncTitle(tab)
      return { ok: true }
    },
    'pane.ratio'({ paneId, ratio, path } = {}) {
      needPane(paneId)
      const { tab } = tabOfPane(paneId)
      let node
      if (typeof path === 'string') {
        node = tab.root
        for (const c of path) {
          if (node.type !== 'split') break
          node = c === 'b' ? node.b : node.a
        }
      } else node = directSplit(tab.root, paneId)
      if (!node || node.type !== 'split') throw new Error('no split at that position')
      node.ratio = clamp(Number(ratio), 0.1, 0.9)
      return { ok: true, ratio: node.ratio }
    },
    'pane.move'({ paneId, toTab }) {
      needPane(paneId)
      const dest = needTab(toTab)
      const src = tabOfPane(paneId)
      if (src.tab === dest.tab) return { ok: true }
      const loc = detachPane(paneId)
      if (loc.emptied) closeTab(loc.session, loc.tab, false)
      dest.tab.root = { type: 'split', dir: 'row', ratio: 0.5, a: dest.tab.root, b: { type: 'pane', paneId } }
      dest.tab.focus = paneId
      dest.session.activeTab = dest.tab.id
      state.activeSession = dest.session.id
      syncTitle(dest.tab)
      return { ok: true }
    },
    'pane.input'({ paneId, data }) {
      needPane(paneId)
      writeTo(paneId, data)
      return { ok: true }
    },
    'pane.resize'({ paneId, cols, rows }) {
      const p = needPane(paneId)
      if (cols > 0) p.cols = cols | 0
      if (rows > 0) p.rows = rows | 0
      return { ok: true }
    },
    'pane.attach'({ paneId }) {
      const r = doAttach(paneId)
      return { replay: toB64(r.replay), cols: r.cols, rows: r.rows, seq: r.seq }
    },
    'pane.detach'({ paneId }) {
      const sh = shells.get(paneId)
      if (sh) sh.attached = false
      return { ok: true }
    },
    'pane.capture'({ paneId, lines, plain } = {}) {
      needPane(paneId)
      const sh = shells.get(paneId)
      let text = sh ? dec.decode(snapshot(sh)) : ''
      if (plain) text = stripAnsi(text).replace(/\r/g, '')
      if (lines > 0) text = text.split('\n').slice(-lines).join('\n')
      return { text }
    },
    'pane.run'({ paneId, cwd, command, kind, dir } = {}) {
      if (!command) throw new Error('command required')
      const target = paneId ? needPane(paneId) : paneById(activeTab().focus)
      const res = handlers['pane.split']({ paneId: target.id, dir: dir === 'col' ? 'col' : 'row', kind: kind || 'shell', cwd })
      writeTo(res.paneId, String(command) + '\r')
      return res
    },
  }

  // ------------------------------------------------------------------------------------ blocks

  function fuzzy(q, text) {
    const ql = q.toLowerCase()
    const tl = text.toLowerCase()
    const base = text.lastIndexOf('/') + 1
    const idx = []
    let from = 0
    let score = 0
    let prev = -2
    for (const c of ql) {
      const i = tl.indexOf(c, from)
      if (i < 0) return null
      idx.push(i)
      score += i === prev + 1 ? 6 : 1
      if (i === 0 || '/._- '.includes(tl[i - 1])) score += 4
      if (i >= base) score += 2
      prev = i
      from = i + 1
    }
    return { score: score - text.length * 0.01, idx }
  }

  const resolveBlockPath = (p, root) => {
    const rootSegs = root ? parsePath(root, []) : []
    return parsePath(p, rootSegs || [])
  }

  const filesBlock = {
    grant({ path: p } = {}) {
      const segs = parsePath(p || '~', [])
      const hit = segs && lookup(segs)
      if (!hit) return { path: String(p ?? ''), root: String(p ?? ''), dir: true, kind: 'dir', home: HOME }
      const root = hit.node.d ? hit.segs : hit.segs.slice(0, -1)
      return { path: winOf(hit.segs), root: winOf(root), dir: !!hit.node.d, kind: hit.node.d ? 'dir' : 'text', home: HOME }
    },
    list({ dir, root, compact } = {}) {
      const segs = resolveBlockPath(dir ?? root ?? '~', root)
      const hit = segs && lookup(segs)
      if (!hit || !hit.node.d) return { entries: [], error: 'ENOENT' }
      const entries = Object.entries(hit.node.c)
        .map(([name, v]) => ({ name, dir: !!v.d }))
        .sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1))
      if (compact && entries.length <= 400) {
        for (const e of entries) {
          if (!e.dir || WALK_SKIP.has(e.name)) continue
          let cur = hit.node.c[e.name]
          const names = [e.name]
          for (let depth = 0; depth < 8; depth++) {
            const kids = Object.entries(cur.c)
            if (kids.length !== 1 || !kids[0][1].d || kids[0][0] === '.git') break
            names.push(kids[0][0])
            cur = kids[0][1]
          }
          if (names.length > 1) {
            e.label = names.join(' / ')
            e.target = names.join('/')
          }
        }
      }
      return { entries }
    },
    status({ root } = {}) {
      const segs = resolveBlockPath(root ?? '~', null)
      if (!inRepo(segs) || !lookup(segs)) return { repo: false }
      const rel = repoRel(segs)
      const prefix = rel.length ? rel.join('/') + '/' : ''
      const files = {}
      for (const [k, v] of Object.entries(CHANGED)) if (k.startsWith(prefix)) files[k.slice(prefix.length)] = v
      return {
        repo: true,
        root: winOf(REPO_SEGS),
        branch: 'main',
        ahead: 5,
        behind: 0,
        changed: 25,
        untracked: 1,
        staged: 0,
        files,
        ignored: rel.length ? [] : ['node_modules/', 'dist/'],
      }
    },
    find({ root, query, limit = 50 } = {}) {
      const segs = resolveBlockPath(root ?? '~', null)
      const hit = segs && lookup(segs)
      const q = String(query || '').trim()
      let results = []
      let total = 0
      if (hit && hit.node.d) {
        const all = treeFiles(hit.node, '', [])
        if (!q) {
          total = all.length
          results = all.slice(0, limit).map((p) => ({ path: p, idx: [], score: 0 }))
        } else {
          const scored = []
          for (const p of all) {
            const m = fuzzy(q, p)
            if (m) scored.push({ path: p, idx: m.idx, score: m.score })
          }
          scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
          total = scored.length
          results = scored.slice(0, limit)
        }
      }
      // The real handler answers { total, results }; the array view is kept for callers that expect a bare list.
      const arr = results.slice()
      arr.results = results
      arr.total = total
      return arr
    },
    info({ path: p, root } = {}) {
      const segs = resolveBlockPath(p ?? root ?? '~', root)
      const hit = segs && lookup(segs)
      if (!hit) throw new Error('ENOENT: no such file or directory')
      const dir = !!hit.node.d
      return { path: winOf(hit.segs), dir, size: dir ? 0 : hit.node, mtimeMs: Date.now() - 86400e3, kind: dir ? 'dir' : 'text' }
    },
    read({ path: p, root } = {}) {
      const segs = resolveBlockPath(p ?? '', root)
      const hit = segs && lookup(segs)
      if (!hit) throw new Error('ENOENT: no such file or directory')
      if (hit.node.d) return { kind: 'dir', path: winOf(hit.segs) }
      const name = hit.segs[hit.segs.length - 1]
      const text = fileText(name)
      return { path: winOf(hit.segs), name, size: hit.node, mtimeMs: Date.now() - 86400e3, kind: 'text', text, content: text, eol: 'lf', encoding: 'utf8', bom: false }
    },
    gutter: () => ({ repo: true, tracked: true, marks: [], count: 0 }),
    complete: () => ({ entries: [] }),
    watch: () => ({ ok: true }),
    watchTree: () => ({ ok: true }),
    unwatch: () => ({ ok: true }),
    write: () => ({ ok: true, mtimeMs: Date.now(), size: 0 }),
  }

  const inRepoCwd = (cwd) => {
    const segs = parsePath(cwd || '', [])
    return inRepo(segs) && lookup(segs) ? true : false
  }
  const gitSummary = () => ({ root: winOf(REPO_SEGS), branch: 'main', ahead: 5, behind: 0, changed: 25, staged: 0, untracked: 1, upstream: 'origin/main' })
  const gitBlock = {
    open({ cwd } = {}) {
      if (!inRepoCwd(cwd)) return { ok: false, error: 'not a git repository', cwd }
      return { ok: true, root: winOf(REPO_SEGS), gitDir: winOf(REPO_SEGS) + '\\.git', name: 'pager', branch: 'main', detached: false, empty: false, head: hashOf(1), upstream: 'origin/main', ahead: 5, behind: 0 }
    },
    summary({ cwd } = {}) {
      return inRepoCwd(cwd) ? gitSummary() : null
    },
    status({ cwd } = {}) {
      if (!inRepoCwd(cwd)) throw new Error('not a git repository')
      const files = GIT_FILES.map((f) => {
        const untracked = f.xy === '??'
        return {
          path: f.path,
          xy: f.xy,
          index: '.',
          worktree: untracked ? '?' : 'M',
          kind: untracked ? 'untracked' : 'changed',
          staged: false,
        }
      })
      return {
        root: winOf(REPO_SEGS),
        branch: { head: 'main', oid: hashOf(1), upstream: 'origin/main', ahead: 5, behind: 0 },
        files,
        changed: 25,
        staged: 0,
        untracked: 1,
        modified: 24,
        conflicted: 0,
        truncated: false,
      }
    },
    refs({ cwd } = {}) {
      if (!inRepoCwd(cwd)) throw new Error('not a git repository')
      return {
        branches: [{ name: 'main', hash: hashOf(1), upstream: 'origin/main', ahead: 5, behind: 0, gone: false, current: true, date: Math.floor(Date.now() / 1000) }],
        remotes: [{ name: 'origin/main', hash: hashOf(6), date: Math.floor(Date.now() / 1000) - 86400 }],
        tags: [],
        stashes: [],
        remoteNames: ['origin'],
      }
    },
    log({ cwd, limit } = {}) {
      if (!inRepoCwd(cwd)) throw new Error('not a git repository')
      const now = Math.floor(Date.now() / 1000)
      const commits = COMMIT_LINES.slice(0, limit > 0 ? limit : COMMIT_LINES.length).map((subject, i) => ({
        hash: hashOf(i + 1),
        parents: i + 1 < COMMIT_LINES.length ? [hashOf(i + 2)] : [],
        author: 'welov',
        email: 'welov@example.com',
        time: now - i * 5 * 3600,
        refs: i === 0 ? 'HEAD -> main' : i === 5 ? 'origin/main' : '',
        subject,
      }))
      return { commits, hasMore: false }
    },
    diff: () => ({ text: '', truncated: false }),
  }
  const BLOCKS = { files: filesBlock, git: gitBlock }

  // ------------------------------------------------------------------------------------ public object

  function pushToast(level, text) {
    for (const fn of [...toastSubs]) {
      try { fn({ level, text }) } catch (e) { console.error('[mock-daemon] onToast subscriber failed', e) }
    }
  }
  let welcomeDue = false
  let welcomeDone = false
  let welcomeTimer = null
  function deliverWelcome() {
    if (welcomeDone || !welcomeDue || !toastSubs.size) return
    welcomeDone = true
    pushToast('info', 'Mock daemon: running in the browser')
  }

  const sub = (set, fn) => {
    set.add(fn)
    return () => set.delete(fn)
  }

  const d = {
    mock: true,
    state: () => Promise.resolve(clone(state)),
    onState(fn) {
      stateSubs.add(fn)
      if (WELCOME && !welcomeTimer && !welcomeDone) {
        welcomeTimer = setTimeout(() => {
          welcomeDue = true
          deliverWelcome()
        }, 1500)
      }
      return () => stateSubs.delete(fn)
    },
    async call(type, args) {
      const h = Object.prototype.hasOwnProperty.call(handlers, type) ? handlers[type] : null
      if (!h) throw new Error('unknown request')
      const result = await h(args || {})
      if (!NON_MUTATING.has(type)) emitState()
      return result
    },
    async attach(paneId) {
      return doAttach(paneId)
    },
    write(paneId, data) {
      writeTo(paneId, data)
    },
    resize(paneId, cols, rows) {
      const p = paneById(paneId)
      if (!p) return
      if (cols > 0) p.cols = cols | 0
      if (rows > 0) p.rows = rows | 0
    },
    onData: (fn) => sub(dataSubs, fn),
    onToast(fn) {
      toastSubs.add(fn)
      if (welcomeDue && !welcomeDone) setTimeout(deliverWelcome, 0)
      return () => toastSubs.delete(fn)
    },
    onResync: (fn) => sub(resyncSubs, fn),
    onStatus: (fn) => sub(statusSubs, fn),
    async block(name, method, args) {
      const handler = BLOCKS[name]
      const fn = handler && Object.prototype.hasOwnProperty.call(handler, method) ? handler[method] : null
      if (!fn) return {}
      return fn(args || {})
    },
    onBlock(name, fn) {
      let set = blockSubs.get(name)
      if (!set) blockSubs.set(name, (set = new Set()))
      return sub(set, fn)
    },
    async restart() {
      pushToast('info', 'Mock daemon: restart is a no-op in the browser')
    },
    async quit() {
      pushToast('info', 'Mock daemon: quit is a no-op in the browser')
    },
  }

  // ---- initial state: one session, one pager tab
  {
    const session = { id: newId('s'), name: 'Default', tabs: [], activeTab: '' }
    state.sessions.push(session)
    addTab(session, { kind: 'pager', cwd: DEFAULT_CWD })
    state.activeSession = session.id
  }

  return d
}
