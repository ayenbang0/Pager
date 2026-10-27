// The sidebar's Changes tab: the focused terminal's repository as conflicted / staged / changes / untracked groups
// with stage, unstage, discard and take-ours/theirs buttons, the branch status and a one-line commit box.
// Embedded by the shell through mountChanges().
import { h } from '../ui/dom.js'
import { icon } from './giticons.js'
import { announce, errorText, GROUPS, groupStatus, onAnnounce, plural, splitPath, STATUS_NAME, statusClass, subscribe, trackText } from './gitmodel.js'

const GROUP_TITLE = { conflicted: 'Conflicted', staged: 'Staged', unstaged: 'Changes', untracked: 'Untracked' }

/**
 * @param {HTMLElement} el container (the sidebar body)
 * @param {{ rpc:(m:string,a?:object)=>Promise<any>, onEvent?:Function, cwd?:string|(()=>string), toast?:Function,
 *   openBlock?:(name:string,args?:object)=>void, openPath?:(p:string)=>void }} ctx
 * @returns {{ dispose():void, setCwd(cwd:string):Promise<void>, refresh():Promise<void>, focus():void, resize():void }}
 */
export function mountChanges(el, ctx) {
  const toast = (level, text) => (ctx.toast ? ctx.toast(level, text) : console.log(`[git] ${level}: ${text}`))
  let cwd = typeof ctx.cwd === 'function' ? ctx.cwd() : ctx.cwd || ''
  let root = null // resolved work tree, null when `cwd` is not in a repository
  let status = null
  let error = ''
  let disposed = false
  let loading = true
  let token = 0
  const collapsed = { conflicted: false, staged: false, unstaged: false, untracked: false }
  const box = { summary: '', busy: false, writing: false }
  let discardArmed = null // 'path' of the row waiting for a second click

  const self = {} // identifies this view on the announce bus
  const root$ = h('div', { class: 'gt gt-ch' })
  el.replaceChildren(root$)
  const head = h('div', { class: 'gt-ch-head' })
  const lists = h('div', { class: 'gt-ch-lists' })
  const foot = h('div', { class: 'gt-ch-foot' })
  root$.append(head, lists, foot)

  const summary = h('input', {
    class: 'gt-input',
    type: 'text',
    placeholder: 'Summary',
    spellcheck: false,
    onInput: () => ((box.summary = summary.value), renderFoot()),
    onKeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
        e.preventDefault()
        commit()
      }
    },
  })
  const writeBtn = h('button', { class: 'gt-ibtn', title: 'Write the message for the staged changes', onClick: write }, icon('sparkle'))
  const commitBtn = h('button', { class: 'gt-btn accent', onClick: commit })
  foot.append(h('div', { class: 'gt-ch-sum' }, summary, writeBtn), commitBtn)

  const call = (method, args = {}) => ctx.rpc(method, { cwd: root ?? cwd, ...args })

  async function resolve() {
    if (!cwd) {
      root = null
      return
    }
    const r = await ctx.rpc('open', { cwd })
    if (!r.ok) {
      root = null
      error = r.error || 'not a git repository'
      return
    }
    root = r.root
    error = ''
  }

  let watchedRoot = null
  async function rewatch() {
    if (watchedRoot === root) return
    const old = watchedRoot
    watchedRoot = root
    if (old) ctx.rpc('unwatch', { cwd: old }).catch(() => {})
    if (root) ctx.rpc('watch', { cwd: root }).catch(() => {})
  }

  async function load() {
    const mine = ++token
    try {
      if (!root || root !== watchedRoot) await resolve()
      if (root) {
        const st = await call('status')
        if (mine !== token) return
        status = st
      } else status = null
    } catch (e) {
      if (mine !== token) return
      status = null
      root = null
      error = errorText(e)
    }
    loading = false
    await rewatch()
    if (!disposed && mine === token) render()
  }

  const refreshSoon = (() => {
    let t = 0
    return () => {
      clearTimeout(t)
      t = setTimeout(() => !disposed && load(), 60)
    }
  })()

  async function act(fn, ok) {
    try {
      await fn()
      if (ok) toast('info', ok)
    } catch (e) {
      toast('error', errorText(e))
    }
    announce(root, self)
    await load()
  }

  function open(path, staged) {
    if (ctx.openBlock) ctx.openBlock('git', { cwd: root, path, staged })
  }

  /** Staged entries are unstaged first; a staged-new file (or a staged rename's target) is untracked afterwards. */
  async function discardEntry(f, staged) {
    if (!staged) return call('discard', f.untracked ? { untracked: [f.path] } : { paths: [f.path] })
    await call('unstage', { paths: [f.path] })
    if (f.status === 'A' || f.status === 'R') {
      await call('discard', { untracked: [f.path] })
      if (f.orig) await call('discard', { paths: [f.orig] })
    } else {
      await call('discard', { paths: [f.path] })
    }
  }

  function discardBtn(f, staged) {
    const armed = discardArmed === f.path
    return h(
      'button',
      {
        class: 'gt-ibtn' + (armed ? ' armed' : ''),
        type: 'button',
        title: armed ? 'Click again to discard' : f.untracked ? 'Delete this untracked file' : 'Discard changes',
        onClick: (e) => {
          e.stopPropagation()
          if (!armed) {
            discardArmed = f.path
            render()
            setTimeout(() => discardArmed === f.path && ((discardArmed = null), !disposed && render()), 2500)
            return
          }
          discardArmed = null
          act(() => discardEntry(f, staged), 'Discarded the change')
        },
      },
      armed ? h('span', { class: 'gt-armed' }, 'Discard?') : icon('trash'),
    )
  }

  function fileRow(f, group) {
    const { dir, name } = splitPath(f.path)
    const actions = h('span', { class: 'gt-row-actions' })
    if (f.conflict) {
      actions.append(
        h('button', { class: 'gt-ibtn', type: 'button', title: 'Keep your version (ours) and stage it', onClick: (e) => (e.stopPropagation(), act(() => call('resolve', { path: f.path, side: 'ours' }), 'Took ours')) }, icon('check')),
        h('button', { class: 'gt-ibtn', type: 'button', title: 'Keep their version (theirs) and stage it', onClick: (e) => (e.stopPropagation(), act(() => call('resolve', { path: f.path, side: 'theirs' }), 'Took theirs')) }, icon('copy')),
      )
    } else if (group === 'staged') {
      actions.append(
        h('button', { class: 'gt-ibtn', type: 'button', title: 'Unstage', onClick: (e) => (e.stopPropagation(), act(() => call('unstage', { paths: [f.path] }))) }, icon('minus')),
        discardBtn(f, true),
      )
    } else {
      actions.append(
        h('button', { class: 'gt-ibtn', type: 'button', title: 'Stage', onClick: (e) => (e.stopPropagation(), act(() => call('stage', { paths: [f.path] }))) }, icon('plus')),
        discardBtn(f, false),
      )
    }
    return h(
      'div',
      { class: 'gt-frow', title: `${STATUS_NAME[f.status] ?? ''}${f.orig ? ` from ${f.orig}` : ''}\n${f.path}`, onClick: () => open(f.path, group === 'staged'), onDblclick: () => ctx.openPath?.(`${root.replace(/[\\/]+$/, '')}/${f.path}`) },
      h('span', { class: `gt-st ${statusClass(f.status)}` }, f.status),
      h('span', { class: 'gt-fname' }, dir ? h('span', { class: 'dim' }, dir) : null, h('b', {}, name)),
      actions,
    )
  }

  const BULK = { staged: 'Unstage all', unstaged: 'Stage all', untracked: 'Stage all', conflicted: null }

  function section(group, items) {
    const open$ = !collapsed[group]
    return h(
      'section',
      { class: 'gt-sec' },
      h(
        'div',
        { class: 'gt-sec-head', role: 'button', tabIndex: -1, title: group === 'conflicted' ? 'Resolve each file, then stage it' : 'Collapse or expand', onClick: () => ((collapsed[group] = !collapsed[group]), render()) },
        h('span', { class: 'gt-chev' + (open$ ? ' open' : '') }, icon('chevR')),
        h('span', { class: 'gt-sec-title' }, GROUP_TITLE[group]),
        h('span', { class: 'gt-count' + (group === 'conflicted' ? ' bad' : '') }, items.length),
        h('span', { class: 'gt-grow' }),
        BULK[group] && items.length ? h('button', { class: 'gt-link', type: 'button', onClick: (e) => (e.stopPropagation(), bulkRun(group, items)) }, BULK[group]) : null,
      ),
      open$ ? h('div', { class: 'gt-sec-body' }, items.map((f) => fileRow(f, group))) : null,
    )
  }

  function bulkRun(group, items) {
    const paths = items.map((f) => f.path)
    if (!paths.length) return
    if (group === 'staged') act(() => call('unstage', { paths }), `Unstaged ${plural(paths.length, 'file')}`)
    else act(() => call('stage', { paths }), `Staged ${plural(paths.length, 'file')}`)
  }

  function render() {
    head.replaceChildren()
    lists.replaceChildren()
    if (loading && !status) {
      head.append(h('div', { class: 'gt-ch-note' }, 'Loading\u2026'))
      renderFoot()
      return
    }
    if (!root || !status) {
      head.append(
        h(
          'div',
          { class: 'gt-ch-empty' },
          icon('branch'),
          h('div', { class: 'gt-ch-empty-title' }, cwd ? 'Not a Git repository' : 'No folder'),
          h('div', { class: 'gt-ch-note' }, cwd ? 'Changes appear here when the focused terminal is inside a repository.' : 'Focus a terminal to follow its folder.'),
          cwd ? h('button', { class: 'gt-btn sm', type: 'button', onClick: () => ctx.rpc('init', { cwd }).then(() => (toast('info', 'Initialized an empty repository'), load()), (e) => toast('error', errorText(e))) }, 'Initialize repository') : null,
        ),
      )
      renderFoot()
      return
    }
    const b = status.branch
    const track = trackText(b)
    head.append(
      h(
        'div',
        { class: 'gt-ch-branch', title: b.upstream ? `${b.head ?? 'detached'} \u2192 ${b.upstream}` : (b.head ?? 'detached HEAD') },
        icon('branch'),
        h('b', {}, b.head ?? (b.oid ? `detached ${b.oid.slice(0, 7)}` : 'no commits yet')),
        track ? h('span', { class: 'gt-track' }, track) : null,
        h('span', { class: 'gt-grow' }),
        h('button', { class: 'gt-ibtn', type: 'button', title: 'Refresh', onClick: () => load() }, icon('fetch')),
      ),
    )
    const g = groupStatus(status.files)
    if (!g.conflicted.length && !g.staged.length && !g.unstaged.length && !g.untracked.length) {
      lists.append(h('div', { class: 'gt-ch-empty small' }, icon('check'), h('div', { class: 'gt-ch-note' }, 'Working tree clean')))
    } else {
      for (const group of GROUPS) if (g[group].length) lists.append(section(group, g[group]))
    }
    if (status.truncated) lists.append(h('div', { class: 'gt-ch-note pad' }, 'The list is cut off: too many changed files.'))
    renderFoot()
  }

  function renderFoot() {
    const staged = status ? groupStatus(status.files).staged.length : 0
    foot.hidden = !root || !status
    if (foot.hidden) return
    const msg = box.summary.trim()
    commitBtn.disabled = box.busy || !staged || !msg
    commitBtn.textContent = box.busy ? 'Committing\u2026' : staged ? `Commit ${plural(staged, 'file')}` : 'Nothing staged'
    writeBtn.disabled = box.writing || !staged
    writeBtn.classList.toggle('busy', box.writing)
    summary.disabled = box.busy
  }

  async function write() {
    if (box.writing) return
    box.writing = true
    renderFoot()
    try {
      const m = await call('generateMessage')
      summary.value = box.summary = m.summary
      if (m.note) toast('info', m.note)
    } catch (e) {
      toast('error', errorText(e))
    }
    box.writing = false
    renderFoot()
  }

  async function commit() {
    if (commitBtn.disabled) return
    box.busy = true
    renderFoot()
    try {
      await call('commitCreate', { summary: box.summary })
      summary.value = box.summary = ''
      toast('info', 'Committed')
    } catch (e) {
      toast('error', errorText(e))
    }
    box.busy = false
    announce(root, self)
    await load()
  }

  const offEvent = subscribe(ctx, (event, p) => {
    if (event === 'changed' && p && root && p.root === root) refreshSoon()
  })
  const offAnnounce = onAnnounce((r, src) => {
    if (src !== self && r === root) refreshSoon()
  })

  render()
  load()

  return {
    async setCwd(next) {
      if (next === cwd) return
      cwd = next || ''
      loading = !status
      await resolve().catch((e) => ((root = null), (error = errorText(e))))
      await load()
    },
    refresh: () => load(),
    focus: () => summary.focus(),
    resize() {},
    dispose() {
      disposed = true
      offEvent()
      offAnnounce()
      if (watchedRoot) ctx.rpc('unwatch', { cwd: watchedRoot }).catch(() => {})
      root$.remove()
    },
  }
}
