// The bot studio: three static strings like the docs, on the docs' stylesheet (Tern's tokens, Geist, glass cards). No build step, nothing to find at run time.

export const STUDIO_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pager bot studio</title><link rel="icon" type="image/svg+xml" href="../logo.svg"><script src="../theme.js"></script><link rel="stylesheet" href="../app.css"><link rel="stylesheet" href="../studio.css"></head>
<body>
<aside id="side">
  <div id="brand"><img id="logo" src="../logo.svg" alt="" width="26" height="26"><span>pager</span><small>studio</small></div>
  <nav id="nav"><a href="../"><svg class="ico" viewBox="0 0 16 16"><path d="M9.5 3.5 5 8l4.5 4.5"/></svg>Docs and stats</a></nav>
  <div id="bots"></div>
  <button id="new" class="btn"><svg class="ico" viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9"/></svg>New bot</button>
  <div id="theme" class="seg" role="group" aria-label="Appearance"></div>
</aside>
<main id="main"></main>
<script src="../studio.js"></script>
</body></html>`

export const STUDIO_CSS = `
#side #new{margin:2px 2px 0;justify-content:center}
#bots{display:flex;flex-direction:column;gap:2px}
#bots a{display:block;padding:6px 10px;color:var(--t3);text-decoration:none;font-size:13.5px;border-radius:var(--r-ctl);cursor:pointer;transition:background .15s var(--ease),color .15s var(--ease)}
#bots a:hover{color:var(--t1);background:var(--l1)}
#bots a.on{color:var(--t1);background:light-dark(var(--card),rgba(255,255,255,.08));box-shadow:light-dark(0 0 0 1px var(--l1),inset 0 1px 0 var(--glass-hi))}
#bots a small{display:block;color:var(--t4);font-size:11.5px}
#bots a.off{opacity:.55}
.btn{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;color:var(--t1);background:light-dark(var(--card),var(--raise));border:0;border-radius:var(--r-ctl);box-shadow:inset 0 0 0 1px var(--l2),inset 0 1px 0 var(--glass-hi);font:500 13.5px var(--sans);letter-spacing:-.003em;cursor:pointer;transition:box-shadow .15s var(--ease),transform .1s,opacity .15s}
.btn:hover{box-shadow:inset 0 0 0 1px var(--l3),inset 0 1px 0 var(--glass-hi)}
.btn:active{transform:scale(.97)}
.btn.primary{color:var(--grad-ink);background:var(--grad);box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 6px 18px -6px rgba(59,108,255,.55)}
.btn.primary:hover{box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 8px 22px -6px rgba(59,108,255,.7)}
.btn.danger:hover{color:var(--bad);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--bad) 60%,transparent)}
.btn:disabled{opacity:.4;cursor:default;transform:none}
.form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 20px;padding:20px}
.form .wide{grid-column:1/-1}
label.f{display:block}
label.f>span{display:block;margin-bottom:6px;color:var(--t2);font-size:13px;font-weight:500}
label.f>small{display:block;margin-top:5px;color:var(--t3);font-size:12px}
input[type=text],input[type=number],select,textarea{width:100%;height:30px;padding:0 10px;color:var(--t1);background:var(--well);border:0;border-radius:var(--r-ctl);box-shadow:inset 0 0 0 1px var(--l2);font:13px var(--sans);outline:none;transition:box-shadow .15s var(--ease)}
input[type=text]::placeholder,textarea::placeholder{color:var(--t4)}
input:focus,select:focus,textarea:focus{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 55%,transparent),0 0 0 3px color-mix(in srgb,var(--accent) 13%,transparent)}
input:disabled,select:disabled{opacity:.45}
textarea{height:auto;min-height:92px;padding:8px 10px;resize:vertical;line-height:1.5}
select{appearance:none;-webkit-appearance:none;padding-right:28px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%238a8a92' stroke-width='1.45' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;background-size:13px}
select option{background:var(--card);color:var(--t1)}
.chk{display:flex;align-items:center;gap:9px;color:var(--t1);font-size:13.5px;cursor:pointer}
.chk input{appearance:none;-webkit-appearance:none;width:15px;height:15px;margin:0;flex:none;border-radius:4px;background:none;box-shadow:inset 0 0 0 1px var(--l4);cursor:pointer;transition:background .2s var(--out),box-shadow .2s var(--out)}
.chk input:checked{background:var(--accent-fill) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m3.8 8.4 2.8 2.8 5.6-6'/%3E%3C/svg%3E") center/11px no-repeat;box-shadow:none}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 0}
.note{margin:12px 0 0;min-height:1.5em;font-size:13px}
.out{margin-top:10px;padding:12px 16px;white-space:pre-wrap;color:var(--t2)}
.out b{color:var(--accent-ink);font-weight:550}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.msg{display:flex;align-items:center;gap:12px;margin-top:12px}
.pad{padding:6px 10px}
.lbl{font-size:13px}
.chk-col{display:grid;gap:12px;align-content:start}
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
