// Board block: the pane's TODO.md as a kanban (Board) or a checklist (List). The file is the only store; every
// edit goes through the main-process handler (electron/blocks/board.cjs), which rewrites just the lines it means to
// change and tells us when the file changes on disk.
import { h, fromHTML } from '../ui/dom.js'

// The block's stylesheet loads itself, so any host that imports the module gets the styling.
const CSS = new URL('./board.css', import.meta.url).href
if (!document.querySelector(`link[href="${CSS}"]`)) document.head.append(h('link', { rel: 'stylesheet', href: CSS }))

const svg = (body) => `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const ICONS = {
  board: svg('<rect x="2" y="2.5" width="3.4" height="11" rx="1"/><rect x="6.3" y="2.5" width="3.4" height="7" rx="1"/><rect x="10.6" y="2.5" width="3.4" height="9" rx="1"/>'),
  list: svg('<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><path d="M2.4 4h.1M2.4 8h.1M2.4 12h.1"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  tick: svg('<path d="M3.6 8.4l2.7 2.7 6-6.3"/>'),
  cal: svg('<rect x="2.5" y="3.5" width="11" height="10" rx="1.8"/><path d="M2.5 6.8h11M5.5 2v3M10.5 2v3"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  trash: svg('<path d="M3 4.5h10M6.2 4.5V3h3.6v1.5M4.5 4.5l.6 8.2c0 .5.4.8.8.8h4.2c.4 0 .8-.3.8-.8l.6-8.2M6.6 7v4M9.4 7v4"/>'),
  sub: svg('<path d="M3.5 3v6.5c0 1 .8 1.8 1.8 1.8H12M9.5 8.8l2.7 2.5-2.7 2.5"/>'),
  file: svg('<path d="M4 2h5l3 3v8.5c0 .3-.2.5-.5.5h-7.5c-.3 0-.5-.2-.5-.5v-11c0-.3.2-.5.5-.5z"/><path d="M9 2v3h3"/>'),
  archive: svg('<rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3 6v6.5c0 .3.2.5.5.5h9c.3 0 .5-.2.5-.5V6M6.5 9h3"/>'),
}
const ico = (k) => fromHTML(ICONS[k])

const LABEL_COLORS = ['#8e5cf7', '#e5487f', '#e8752d', '#2fae74', '#159c9c', '#6b7280']
const labelColor = (name) => {
  let n = 0
  for (let i = 0; i < name.length; i++) n = (n * 31 + name.charCodeAt(i)) >>> 0
  return LABEL_COLORS[n % LABEL_COLORS.length]
}

const pad = (n) => String(n).padStart(2, '0')
const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const prettyDue = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return `${MONTHS[m - 1]} ${d}${y !== new Date().getFullYear() ? ` ${y}` : ''}`
}

/** An event from ctx.onEvent in either call shape: (name, payload) or ({ event, payload }). */
const eventOf = (a, b) => (typeof a === 'string' ? { name: a, data: b } : { name: a && (a.event || a.name), data: a && (a.payload !== undefined ? a.payload : a.data) })

function mount(el, ctx) {
  const args = ctx.args || {}
  const state = {
    data: null, // snapshot from the main process
    view: (() => {
      try {
        return localStorage.getItem('pager.board.view') === 'list' ? 'list' : 'board'
      } catch {
        return 'board'
      }
    })(),
    inspector: null, // line number of the card being edited
    adding: null, // lane id with the quick-add open
    addText: '',
    showArchived: false,
    error: null,
    drag: null,
  }
  let boardId = null
  let disposed = false

  const root = h('div', { class: 'bd' })
  el.append(root)
  const bar = h('div', { class: 'bd-bar' })
  const body = h('div', { class: 'bd-body' })
  const side = h('aside', { class: 'bd-side', hidden: true })
  root.append(bar, h('div', { class: 'bd-stage' }, body, side))

  // ------------------------------------------------------------ data
  const fail = (e) => {
    const msg = String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
    ctx.toast && ctx.toast('error', msg)
    return reload()
  }

  async function call(method, a) {
    try {
      const data = await ctx.rpc(method, { board: boardId, ...a })
      if (!disposed) apply(data)
      return data
    } catch (e) {
      return fail(e)
    }
  }

  async function reload() {
    if (!boardId || disposed) return
    try {
      apply(await ctx.rpc('load', { board: boardId }))
    } catch (e) {
      state.error = String((e && e.message) || e)
      render()
    }
  }

  function apply(data) {
    state.data = data
    state.error = null
    if (data.name) ctx.setTitle && ctx.setTitle(data.name)
    render()
  }

  async function init() {
    try {
      const data = await ctx.rpc('open', { cwd: ctx.cwd, file: args.file })
      boardId = data.board
      apply(data)
    } catch (e) {
      state.error = String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
      render()
    }
  }

  /** The file changed on disk: redraw, and close the card editor if its line now holds a different card. */
  async function externalChange() {
    const before = state.inspector === null ? null : cardByLine(state.inspector)
    await reload()
    if (before) {
      const after = cardByLine(state.inspector)
      if (!after || after.card.title !== before.card.title) closeInspector()
    }
  }

  const offEvent = ctx.onEvent
    ? ctx.onEvent((a, b) => {
        const { name, data } = eventOf(a, b)
        if (name === 'changed' && (!data || data.board === boardId)) externalChange()
      })
    : null

  // ------------------------------------------------------------ helpers
  const lanes = () => (state.data && state.data.lanes) || []
  const findCard = (id) => {
    for (const l of lanes()) for (const c of l.cards) if (c.id === id) return { card: c, lane: l }
    return null
  }
  const cardByLine = (line) => {
    for (const l of lanes()) for (const c of l.cards) if (Number(c.id.split(':')[0]) === line) return { card: c, lane: l }
    return null
  }

  // ------------------------------------------------------------ chrome
  function renderBar() {
    const d = state.data
    bar.replaceChildren()
    if (!d || !d.exists) return
    const seg = h(
      'div',
      { class: 'seg', role: 'tablist' },
      ...['board', 'list'].map((v) =>
        h(
          'button',
          {
            class: 'seg-b' + (state.view === v ? ' on' : ''),
            role: 'tab',
            'aria-selected': state.view === v,
            title: v === 'board' ? 'Board' : 'List',
            onClick: () => {
              state.view = v
              try {
                localStorage.setItem('pager.board.view', v)
              } catch {
                /* private mode */
              }
              render()
            },
          },
          ico(v),
          h('span', null, v === 'board' ? 'Board' : 'List'),
        ),
      ),
    )
    const archived = d.lanes.filter((l) => l.archived).reduce((n, l) => n + l.cards.length, 0)
    bar.append(...[
      h('div', { class: 'bd-file', title: d.path }, ico('file'), h('span', { class: 'bd-name' }, d.name)),
      h('div', { class: 'bd-count mono' }, `${d.counts.open} open · ${d.counts.done} done`),
      d.kanban ? h('span', { class: 'bd-tag', title: 'Obsidian Kanban file' }, 'kanban') : null,
      h('div', { class: 'bd-gap' }),
      archived
        ? h(
            'button',
            { class: 'bd-ghost' + (state.showArchived ? ' on' : ''), title: 'Show archived lanes', onClick: () => ((state.showArchived = !state.showArchived), render()) },
            ico('archive'),
            h('span', null, `${archived} archived`),
          )
        : null,
      seg,
    ].filter(Boolean))
  }

  // ------------------------------------------------------------ cards
  function checkBtn(card, laneDone) {
    return h(
      'button',
      {
        class: 'bd-check' + (card.done ? ' on' : ''),
        title: card.done ? 'Mark as not done' : 'Mark as done',
        'aria-pressed': card.done,
        onPointerdown: (e) => e.stopPropagation(),
        onClick: (e) => {
          e.stopPropagation()
          state.inspector = null
          call('toggle', { card: card.id })
        },
      },
      ico('tick'),
    )
  }

  function chips(card, { withSub = true } = {}) {
    const out = []
    for (const l of card.labels) out.push(h('span', { class: 'bd-chip', style: { '--c': labelColor(l) } }, l))
    if (card.due) {
      const t = todayStr()
      const late = !card.done && card.due < t
      out.push(h('span', { class: 'bd-chip due mono' + (late ? ' late' : card.due === t && !card.done ? ' today' : '') }, ico('cal'), prettyDue(card.due)))
    }
    if (withSub && card.subtasks.length) {
      const done = card.subtasks.filter((s) => s.done).length
      out.push(
        h(
          'span',
          { class: 'bd-chip sub mono' + (done === card.subtasks.length ? ' full' : ''), title: `${done} of ${card.subtasks.length} subtasks done` },
          ico('sub'),
          `${done}/${card.subtasks.length}`,
        ),
      )
    }
    return out
  }

  function cardEl(card, lane) {
    const el = h(
      'div',
      {
        class: 'bd-card' + (card.done ? ' done' : '') + (state.inspector === Number(card.id.split(':')[0]) ? ' sel' : ''),
        dataset: { card: card.id },
        tabIndex: 0,
        onKeydown: (e) => {
          if (e.key === 'Enter') openInspector(card.id)
          else if (e.key === ' ') {
            e.preventDefault()
            call('toggle', { card: card.id })
          }
        },
      },
      checkBtn(card, lane.done),
      h('div', { class: 'bd-main' }, h('div', { class: 'bd-title', title: card.title }, card.title || '(empty)'), chips(card).length ? h('div', { class: 'bd-meta' }, chips(card)) : null),
    )
    if (!lane.archived) el.addEventListener('pointerdown', (e) => dragStart(e, el, card, lane))
    else el.addEventListener('click', () => openInspector(card.id))
    return el
  }

  function quickAdd(lane) {
    const input = h('input', {
      class: 'bd-input',
      placeholder: 'Card text, #label, 📅 2025-01-31',
      value: state.addText,
      onInput: (e) => (state.addText = e.target.value),
      onKeydown: async (e) => {
        if (e.key === 'Escape') {
          state.adding = null
          state.addText = ''
          render()
        } else if (e.key === 'Enter' && input.value.trim()) {
          const text = input.value
          state.addText = ''
          input.value = ''
          await call('add', { lane: lane.id, text })
          // stay open for the next card
          const again = body.querySelector(`[data-lane="${CSS.escape(lane.id)}"] .bd-input`)
          if (again) again.focus()
        }
      },
      onBlur: () => {
        if (!input.value.trim()) {
          state.adding = null
          state.addText = ''
          setTimeout(() => !disposed && render(), 0)
        }
      },
    })
    queueMicrotask(() => input.focus())
    return h('div', { class: 'bd-add-row' }, input)
  }

  // ------------------------------------------------------------ board view
  function laneEl(lane) {
    const head = h(
      'div',
      { class: 'bd-lane-head' },
      h('span', { class: 'bd-lane-title', title: lane.implicit ? 'Cards above the first heading' : 'Double-click to rename', onDblclick: () => !lane.implicit && !lane.archived && renameLane(lane, head) }, lane.title),
      h('span', { class: 'bd-lane-count mono' }, String(lane.cards.length)),
      lane.done ? h('span', { class: 'bd-lane-ok', title: 'Done lane: cards moved here are checked' }, ico('tick')) : null,
      h('span', { class: 'bd-gap' }),
      !lane.cards.length && !lane.implicit && !lane.archived
        ? h('button', { class: 'bd-icon', title: 'Delete empty lane', onClick: () => call('removeLane', { lane: lane.id }) }, ico('trash'))
        : null,
    )
    const list = h('div', { class: 'bd-cards' }, lane.cards.map((c) => cardEl(c, lane)))
    const foot = lane.archived
      ? null
      : state.adding === lane.id
        ? quickAdd(lane)
        : h(
            'button',
            {
              class: 'bd-add',
              onClick: () => {
                state.adding = lane.id
                state.addText = ''
                render()
              },
            },
            ico('plus'),
            h('span', null, 'Add card'),
          )
    return h('section', { class: 'bd-lane' + (lane.done ? ' done' : '') + (lane.archived ? ' archived' : ''), dataset: { lane: lane.id } }, head, list, foot)
  }

  function renameLane(lane, head) {
    const title = head.querySelector('.bd-lane-title')
    const input = h('input', {
      class: 'bd-input bd-rename',
      value: lane.title,
      onKeydown: (e) => {
        if (e.key === 'Enter') input.blur()
        else if (e.key === 'Escape') {
          input.value = lane.title
          input.blur()
        }
      },
      onBlur: () => {
        const v = input.value.trim()
        if (v && v !== lane.title) call('renameLane', { lane: lane.id, title: v })
        else render()
      },
    })
    title.replaceWith(input)
    input.focus()
    input.select()
  }

  function addLaneEl() {
    const wrap = h('div', { class: 'bd-lane ghost' })
    const btn = h(
      'button',
      {
        class: 'bd-add lane',
        onClick: () => {
          const input = h('input', {
            class: 'bd-input',
            placeholder: 'Lane name',
            onKeydown: (e) => {
              if (e.key === 'Enter' && input.value.trim()) call('addLane', { title: input.value })
              else if (e.key === 'Escape') render()
            },
            onBlur: () => setTimeout(() => !disposed && render(), 0),
          })
          btn.replaceWith(input)
          input.focus()
        },
      },
      ico('plus'),
      h('span', null, 'Add lane'),
    )
    wrap.append(btn)
    return wrap
  }

  function renderBoard() {
    const visible = lanes().filter((l) => state.showArchived || !l.archived)
    if (!visible.length) {
      body.append(emptyState('No lanes yet', 'Add a lane; each `## Heading` in the file is one.', h('button', { class: 'bd-primary', onClick: () => addLaneEl().querySelector('button').click() }, 'Add lane'), addLaneEl()))
      return
    }
    body.append(h('div', { class: 'bd-lanes' }, visible.map(laneEl), addLaneEl()))
  }

  // ------------------------------------------------------------ list view
  function renderList() {
    const visible = lanes().filter((l) => state.showArchived || !l.archived)
    const wrap = h('div', { class: 'bd-list' })
    for (const lane of visible) {
      wrap.append(
        h('div', { class: 'bd-list-head' }, h('span', null, lane.title), h('span', { class: 'bd-lane-count mono' }, String(lane.cards.length)), lane.done ? h('span', { class: 'bd-lane-ok' }, ico('tick')) : null),
      )
      for (const c of lane.cards) {
        wrap.append(
          h(
            'div',
            { class: 'bd-row' + (c.done ? ' done' : '') + (state.inspector === Number(c.id.split(':')[0]) ? ' sel' : ''), tabIndex: 0, onClick: () => openInspector(c.id), onKeydown: (e) => e.key === 'Enter' && openInspector(c.id) },
            checkBtn(c, lane.done),
            h('span', { class: 'bd-row-title' }, c.title || '(empty)'),
            h('span', { class: 'bd-meta' }, chips(c)),
          ),
        )
      }
      if (!lane.archived) {
        wrap.append(
          state.adding === lane.id
            ? quickAdd(lane)
            : h('button', { class: 'bd-add row', onClick: () => ((state.adding = lane.id), (state.addText = ''), render()) }, ico('plus'), h('span', null, 'Add card')),
        )
      }
    }
    body.append(h('div', { class: 'bd-list-wrap' }, wrap))
  }

  function emptyState(title, sub, ...actions) {
    return h('div', { class: 'bd-empty' }, ico('board'), h('div', { class: 'bd-empty-t' }, title), h('div', { class: 'bd-empty-s' }, sub), h('div', { class: 'bd-empty-a' }, actions))
  }

  // ------------------------------------------------------------ inspector
  function openInspector(id) {
    const f = findCard(id)
    if (!f) return
    state.inspector = Number(id.split(':')[0])
    render()
  }

  function closeInspector() {
    state.inspector = null
    render()
  }

  function renderInspector() {
    const f = state.inspector === null ? null : cardByLine(state.inspector)
    if (!f) {
      state.inspector = null
      side.hidden = true
      side.replaceChildren()
      return
    }
    const { card, lane } = f
    const keep = side.contains(document.activeElement) ? document.activeElement : null
    if (keep && side.dataset.line === String(state.inspector)) {
      // the user is typing here: update only what is not being edited
      refreshSubtasks(card)
      return
    }
    side.hidden = false
    side.dataset.line = String(state.inspector)
    const title = h('textarea', {
      class: 'bd-field title',
      rows: 2,
      value: card.title,
      onKeydown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          title.blur()
        }
      },
      onChange: () => cur() && call('update', { card: cur().card.id, title: title.value }),
    })
    const labels = h('input', {
      class: 'bd-field',
      placeholder: 'labels, separated by spaces',
      value: card.labels.join(' '),
      onChange: () => cur() && call('update', { card: cur().card.id, labels: labels.value.split(/[\s,]+/).filter(Boolean) }),
    })
    const due = h('input', {
      class: 'bd-field mono',
      type: 'date',
      value: card.due || '',
      onChange: () => cur() && call('update', { card: cur().card.id, due: due.value || null }),
    })
    const subs = h('div', { class: 'bd-subs' })
    const subInput = h('input', {
      class: 'bd-field',
      placeholder: 'Add a subtask',
      onKeydown: async (e) => {
        if (e.key === 'Enter' && subInput.value.trim() && cur()) {
          const text = subInput.value
          subInput.value = ''
          await call('addSub', { card: cur().card.id, text })
          subInput.focus()
        }
      },
    })
    const cur = () => cardByLine(state.inspector)
    side.replaceChildren(...[
      h(
        'div',
        { class: 'bd-side-head' },
        h('span', { class: 'bd-side-lane' }, lane.title),
        h('span', { class: 'bd-gap' }),
        h('button', { class: 'bd-icon', title: 'Delete card', onClick: async () => cur() && ((await call('remove', { card: cur().card.id })), closeInspector()) }, ico('trash')),
        h('button', { class: 'bd-icon', title: 'Close', onClick: closeInspector }, ico('close')),
      ),
      h('label', { class: 'bd-lab' }, 'Card', title),
      h('label', { class: 'bd-lab' }, 'Labels', labels),
      h('label', { class: 'bd-lab' }, 'Due', due),
      h('div', { class: 'bd-lab' }, 'Subtasks', subs, subInput),
      card.notes.length ? h('div', { class: 'bd-lab' }, 'Notes', h('div', { class: 'bd-notes' }, card.notes.join('\n'))) : null,
    ].filter(Boolean))
    side.subs = subs
    refreshSubtasks(card)
  }

  function refreshSubtasks(card) {
    const subs = side.subs
    if (!subs) return
    subs.replaceChildren(
      ...card.subtasks.map((s) =>
        h(
          'div',
          { class: 'bd-sub' + (s.done ? ' done' : '') },
          h('button', { class: 'bd-check sm' + (s.done ? ' on' : ''), onClick: () => call('toggleSub', { sub: s.id }) }, ico('tick')),
          h('span', null, s.text),
          h('button', { class: 'bd-icon sm', title: 'Remove subtask', onClick: () => call('removeSub', { sub: s.id }) }, ico('close')),
        ),
      ),
    )
  }

  // ------------------------------------------------------------ drag
  function dragStart(e, cardNode, card, lane) {
    if (e.button !== 0 || e.target.closest('.bd-check, button, input, textarea')) return
    const startX = e.clientX
    const startY = e.clientY
    const rect = cardNode.getBoundingClientRect()
    let started = false
    let ghost = null
    let drop = null // { laneEl, index }
    const marker = h('div', { class: 'bd-drop' })

    const move = (ev) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return
        started = true
        state.drag = true
        ghost = cardNode.cloneNode(true)
        ghost.classList.add('lifted')
        ghost.style.width = rect.width + 'px'
        document.body.append(ghost)
        cardNode.classList.add('ghosted')
        root.classList.add('dragging')
      }
      ghost.style.transform = `translate(${ev.clientX - (startX - rect.left)}px, ${ev.clientY - (startY - rect.top)}px) rotate(1.5deg)`
      // edge scroll
      const lanesEl = body.querySelector('.bd-lanes')
      if (lanesEl) {
        const r = lanesEl.getBoundingClientRect()
        if (ev.clientX < r.left + 48) lanesEl.scrollLeft -= 14
        else if (ev.clientX > r.right - 48) lanesEl.scrollLeft += 14
      }
      const under = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => n.classList && n.classList.contains('bd-lane') && n.dataset.lane)
      marker.remove()
      drop = null
      if (!under) return
      const listEl = under.querySelector('.bd-cards')
      const kids = [...listEl.querySelectorAll('.bd-card')].filter((n) => n !== cardNode)
      let index = kids.length
      for (let i = 0; i < kids.length; i++) {
        const r = kids[i].getBoundingClientRect()
        if (ev.clientY < r.top + r.height / 2) {
          index = i
          break
        }
      }
      if (index < kids.length) listEl.insertBefore(marker, kids[index])
      else listEl.append(marker)
      const ar = listEl.getBoundingClientRect()
      if (ev.clientY < ar.top + 28) listEl.scrollTop -= 10
      else if (ev.clientY > ar.bottom - 28) listEl.scrollTop += 10
      drop = { lane: under.dataset.lane, index }
    }

    const finish = async (ev, cancelled) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      if (!started) {
        if (!cancelled) openInspector(card.id)
        return
      }
      marker.remove()
      ghost.remove()
      cardNode.classList.remove('ghosted')
      root.classList.remove('dragging')
      state.drag = null
      if (cancelled || !drop) return
      // optimistic: show the card where it will be, then let the file's answer replace it
      const target = lanes().find((l) => l.id === drop.lane)
      if (target) {
        const from = lane.cards.indexOf(card)
        lane.cards.splice(from, 1)
        target.cards.splice(Math.min(drop.index, target.cards.length), 0, card)
        render()
      }
      state.inspector = null
      await call('move', { card: card.id, lane: drop.lane, index: drop.index })
    }
    const up = (ev) => finish(ev, false)
    const cancel = (ev) => finish(ev, true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  // ------------------------------------------------------------ render
  function render() {
    if (disposed || state.drag) return
    const scroll = body.querySelector('.bd-lanes')
    const sx = scroll ? scroll.scrollLeft : 0
    const sy = [...body.querySelectorAll('.bd-cards')].map((n) => n.scrollTop)
    const listScroll = body.querySelector('.bd-list-wrap')
    const ly = listScroll ? listScroll.scrollTop : 0
    renderBar()
    body.replaceChildren()
    const d = state.data
    if (state.error && !d) {
      body.append(emptyState('Board unavailable', state.error))
    } else if (!d) {
      body.append(h('div', { class: 'bd-loading' }, 'Looking for TODO.md…'))
    } else if (!d.exists) {
      body.append(
        emptyState(
          'No TODO.md here',
          d.path,
          h(
            'button',
            { class: 'bd-primary', onClick: async () => { try { apply(await ctx.rpc('create', { board: boardId })) } catch (e) { fail(e) } } },
            'Create TODO.md',
          ),
        ),
      )
    } else if (state.view === 'list') renderList()
    else renderBoard()
    renderInspector()
    const nl = body.querySelector('.bd-lanes')
    if (nl) nl.scrollLeft = sx
    body.querySelectorAll('.bd-cards').forEach((n, i) => (n.scrollTop = sy[i] || 0))
    const nw = body.querySelector('.bd-list-wrap')
    if (nw) nw.scrollTop = ly
  }

  const onKey = (e) => {
    if (e.key === 'Escape' && state.inspector !== null && !e.target.closest('input, textarea')) closeInspector()
  }
  root.addEventListener('keydown', onKey)

  render()
  init()

  return {
    dispose() {
      disposed = true
      if (typeof offEvent === 'function') offEvent()
      if (boardId) ctx.rpc('close', { board: boardId }).catch(() => {})
      root.remove()
    },
    focus() {
      const c = body.querySelector('.bd-card, .bd-row')
      if (c) c.focus()
    },
  }
}

export default { id: 'board', title: 'Board', icon: ICONS.board, hotkey: 'Alt+Mod+K', mount }
