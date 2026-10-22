// The bot studio: three static strings like the docs, on the docs' stylesheet. No build step, nothing to find at run time.

export const STUDIO_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pager bot studio</title><link rel="stylesheet" href="../app.css"><link rel="stylesheet" href="../studio.css"></head>
<body>
<aside id="side">
  <div id="brand"><img id="logo" src="../logo.png" alt=""><span>pager</span><small>studio</small></div>
  <nav id="nav"><a href="../">&larr; Docs and stats</a></nav>
  <div id="bots"></div>
  <button id="new" class="btn">+ New bot</button>
</aside>
<main id="main"></main>
<script src="../studio.js"></script>
</body></html>`

export const STUDIO_CSS = `
#bots a{display:block;padding:7px 10px;margin:2px 0;color:var(--muted);text-decoration:none;border-radius:6px;border:1px solid transparent;cursor:pointer}
#bots a:hover{color:var(--text)}
#bots a.on{color:var(--accent);background:var(--panel);border-color:var(--ring)}
#bots a small{display:block;color:var(--muted);font-size:11px}
#bots a.off{opacity:.55}
.btn{padding:7px 12px;color:var(--text);background:var(--panel);border:1px solid var(--ring);border-radius:8px;font:inherit;cursor:pointer}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn.primary{color:#000;background:var(--accent);border-color:var(--accent)}
.btn.primary:hover{color:#000;background:var(--purple);border-color:var(--purple)}
.btn.danger:hover{color:var(--red);border-color:var(--red)}
.btn:disabled{opacity:.5;cursor:default}
.form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 18px;padding:18px}
.form .wide{grid-column:1/-1}
label.f{display:block}
label.f>span{display:block;margin-bottom:4px;color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
label.f>small{display:block;margin-top:4px;color:var(--muted);font-size:11.5px}
input[type=text],input[type=number],select,textarea{width:100%;padding:7px 10px;color:var(--text);background:rgba(0,0,0,.5);border:1px solid var(--ring);border-radius:8px;font:inherit;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
textarea{min-height:92px;resize:vertical}
select option{background:#000}
.chk{display:flex;align-items:center;gap:8px;color:var(--text)}
.chk input{accent-color:var(--accent)}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0 0}
.note{margin:12px 0 0;min-height:1.5em}
.out{margin-top:10px;padding:12px 16px;white-space:pre-wrap}
.out b{color:var(--cyan)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.msg{display:flex;gap:10px;margin-top:10px}
.pad{padding:6px 10px}
.lbl{padding-top:7px}
.chk-col{display:grid;gap:10px;align-content:start}
.msg input{flex:1}
@media(max-width:900px){.form,.cols{grid-template-columns:1fr}}
`

export const STUDIO_JS = String.raw`
'use strict'
const $ = (id) => document.getElementById(id)
const h = (tag, props, ...kids) => {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn)
    else if (v === true) e.setAttribute(k, '')
    else if (v !== false && v != null) e.setAttribute(k, v)
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)))
  return e
}
const api = (path, body) => fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json', 'x-pager': 'studio' }, body: JSON.stringify(body) })
  .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || 'Failed (' + r.status + ')'); return j }))

let state
let sel = null // {conv, name} of an existing bot, or {create: true}
let draft = null
let flash = '' // shown once after a save re-renders the form

const blank = () => ({ create: true, conv: state.groups[0] ? state.groups[0].id : '', name: '', backend: state.backends[0] || '', instructions: '', ...state.defaults })
const field = (label, input, hint) => h('label', { class: 'f' }, h('span', {}, label), input, hint && h('small', {}, hint))
const text = (key, props) => h('input', { type: 'text', value: draft[key] ?? '', autocomplete: 'off', spellcheck: 'false', ...props, on: { input: (e) => { draft[key] = e.target.value } } })
const num = (key, lo, hi) => h('input', { type: 'number', min: lo, max: hi, step: 1, value: draft[key], on: { input: (e) => { draft[key] = e.target.value === '' ? NaN : Number(e.target.value) } } })
const area = (key, rows) => h('textarea', { rows, spellcheck: 'false', on: { input: (e) => { draft[key] = e.target.value } } }, draft[key])
const check = (key, label) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: draft[key], on: { change: (e) => { draft[key] = e.target.checked } } }), label)
const choose = (key, options, disabled) => h('select', { disabled, on: { change: (e) => { draft[key] = e.target.value } } }, options.map(([v, l]) => h('option', { value: v, selected: draft[key] === v }, l)))

const payload = (extra) => {
  const kw = typeof draft.keywords === 'string' ? draft.keywords : draft.keywords.join(',')
  return { ...draft, keywords: kw.split(/[\s,]+/).filter(Boolean), ...extra }
}

function sidebar() {
  const box = $('bots')
  box.replaceChildren(...(state.bots.length ? state.bots.map((b) => h('a', { class: (sel && !sel.create && sel.conv === b.conv && sel.name === b.name ? 'on ' : '') + (b.enabled ? '' : 'off'), on: { click: () => select(b) } }, b.name, h('small', {}, b.where + ' - ' + b.backend + (b.busy ? ' - thinking' : '') + (b.enabled ? '' : ' - paused')))) : [h('div', { class: 'dim pad' }, 'No bots yet.')]))
}

function select(b) {
  sel = b ? { conv: b.conv, name: b.name } : { create: true }
  draft = b ? { ...b, keywords: b.keywords.join(', ') } : blank()
  if (!b) draft.keywords = ''
  sidebar()
  render()
}

function render() {
  const main = $('main')
  if (!state.groups.length && sel && sel.create) {
    main.replaceChildren(h('h1', {}, 'Bot studio'), h('p', { class: 'lead' }, 'Bots live in group chats. Create a group in pager first (/group new), then come back.'))
    return
  }
  if (!draft) {
    main.replaceChildren(h('h1', {}, 'Bot studio'), h('p', { class: 'lead' }, 'Shape a bot in detail: how it talks, when it speaks, what it may touch. Pick a bot on the left, or make a new one.'))
    return
  }
  const create = !!draft.create
  const note = h('p', { class: 'note dim' })
  const out = h('div')
  if (flash) { note.className = 'note ok'; note.textContent = flash; flash = '' }
  const say = (msg, cls) => { note.className = 'note ' + (cls || 'dim'); note.textContent = msg }
  const testMsg = h('input', { type: 'text', value: '@' + (draft.name || 'bot') + ' what can you do?', spellcheck: 'false' })
  const busy = (btn, fn) => async () => { btn.disabled = true; try { await fn() } catch (e) { say(e.message, 'bad') } finally { btn.disabled = false } }
  const save = h('button', { class: 'btn primary' }, create ? 'Create bot' : 'Save changes')
  save.addEventListener('click', busy(save, async () => {
    await api('../api/studio/save', payload({ create }))
    flash = create ? draft.name + ' joined the group.' : 'Saved. It applies from the bot\'s next turn.'
    const keep = { conv: draft.conv, name: draft.name }
    state = await api('../api/studio')
    sel = keep
    draft = { ...state.bots.find((b) => b.conv === keep.conv && b.name === keep.name) }
    draft.keywords = draft.keywords.join(', ')
    sidebar(); render()
  }))
  const prev = h('button', { class: 'btn' }, 'Preview prompt')
  prev.addEventListener('click', busy(prev, async () => {
    const r = await api('../api/studio/preview', payload({ message: testMsg.value }))
    out.replaceChildren(h('div', { class: 'cols' }, h('div', {}, h('h2', {}, 'Standing orders'), h('div', { class: 'card' }, h('pre', {}, r.system))), h('div', {}, h('h2', {}, 'Conversation'), h('div', { class: 'card' }, h('pre', {}, r.chat)))))
    say('This is exactly what the model is sent, in a pretend group with you and a friend.')
  }))
  const test = h('button', { class: 'btn' }, 'Try it')
  test.addEventListener('click', busy(test, async () => {
    say('Asking ' + draft.backend + '...')
    const r = await api('../api/studio/test', payload({ message: testMsg.value }))
    out.replaceChildren(h('div', { class: 'card out' }, r.reply === undefined ? h('span', { class: 'dim' }, 'The bot would stay silent here.') : [h('b', {}, draft.name + ': '), r.reply]))
    say('Nothing was posted anywhere. CLI backends run with their tools in a scratch folder.')
  }))
  const del = h('button', { class: 'btn danger' }, 'Remove bot')
  del.addEventListener('click', busy(del, async () => {
    if (!confirm('Remove ' + draft.name + ' and its sandbox folder?')) return
    await api('../api/studio/remove', { conv: draft.conv, name: draft.name })
    state = await api('../api/studio'); sel = null; draft = null; sidebar(); render()
  }))
  const groups = state.groups.map((g) => [g.id, g.title])
  const backends = state.backends.map((b) => [b, b])
  main.replaceChildren(
    h('h1', {}, create ? 'New bot' : draft.name),
    h('p', { class: 'lead' }, create ? 'It joins the group you pick and runs on this computer.' : 'In ' + draft.where + '. Changes apply from its next turn.'),
    h('div', { class: 'card form' },
      field('Group', choose('conv', groups, !create)),
      field('Name', text('name', { disabled: !create, placeholder: 'grumpy' }), 'What @name calls. 2-24 lowercase letters, digits, - or _.'),
      field('Backend', choose('backend', backends), 'Who answers: a ready agent, ollama or openai.'),
      field('Model', text('model', { placeholder: 'backend default' }), 'Optional. Changing the backend resets it.'),
      field('Effort', text('effort', { placeholder: 'backend default' }), 'Optional: low, medium, high or what the backend takes.'),
      field('Mode', choose('mode', [['auto', 'Auto: decides when to speak'], ['mention', 'Only when called']]), 'Only when called = @name or a keyword.'),
      h('div', { class: 'wide' }, field('Job', area('instructions', 5), 'What the bot does, in plain words (up to ' + state.limits.instructions + ' characters).')),
      h('div', { class: 'wide' }, field('Persona', area('persona', 3), 'How it talks: tone, voice, quirks. Style only; it cannot change the job or the rules.')),
      h('div', { class: 'wide' }, field('Keywords', text('keywords', { placeholder: 'deploy, release' }), 'Words that call it like @name does. Whole words, comma separated.')),
      field('Reply cap (characters)', num('maxChars', 0, state.limits.maxChars), '0 = no cap.'),
      field('Cooldown (seconds)', num('cooldownSec', 0, state.limits.cooldownSec), 'Least gap between its replies, unless a person calls it.'),
      field('History (messages)', num('contextLines', state.limits.contextMin, state.limits.contextMax), 'How much chat it re-reads each turn.'),
      h('div', { class: 'chk-col' }, check('docs', 'May read and write the group\'s documents'), check('talkToBots', 'May react to other bots'), check('enabled', 'Enabled (off = paused)')),
    ),
    h('div', { class: 'actions' }, save, prev, test, !create && del),
    h('div', { class: 'msg' }, h('span', { class: 'dim lbl' }, 'Test message'), testMsg),
    note,
    out,
  )
}

$('new').addEventListener('click', () => select(null))
api('../api/studio').then((s) => { state = s; sidebar(); render() }).catch((e) => { $('main').replaceChildren(h('h1', {}, 'Bot studio'), h('p', { class: 'lead bad' }, e.message)) })
`
