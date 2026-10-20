// The docs site is three static strings: no build step, no files to find at run time, nothing to edit in the install.

export const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pager docs</title><link rel="stylesheet" href="app.css"></head>
<body>
<aside id="side">
  <div id="brand"><img id="logo" src="logo.png" alt=""><span>pager</span><small id="ver"></small></div>
  <input id="q" type="search" placeholder="search commands and keys" autocomplete="off" spellcheck="false">
  <nav id="nav"></nav>
</aside>
<main id="main"></main>
<script src="app.js"></script>
</body></html>`

export const APP_CSS = `
:root{--bg:#000;--panel:rgba(255,255,255,.045);--ring:rgba(255,255,255,.14);--text:#c0caf5;--muted:#7a82a8;--accent:#7aa2f7;--purple:#bb9af7;--cyan:#2ac3de;--green:#9ece6a;--red:#f7768e;--yellow:#e0af68;
--mono:"Cascadia Mono","Cascadia Code",Consolas,monospace}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:13.5px/1.55 var(--mono)}
body{display:grid;grid-template-columns:232px 1fr}
#side{position:sticky;top:0;height:100vh;padding:18px 14px;border-right:1px solid var(--ring);display:flex;flex-direction:column;gap:14px;overflow:auto}
#brand{display:flex;align-items:center;gap:10px;font-size:15px;color:var(--accent)}
#brand small{color:var(--muted);font-size:11px;margin-left:auto}
#logo{width:28px;height:28px;image-rendering:pixelated}
#q{width:100%;padding:7px 10px;color:var(--text);background:var(--panel);border:1px solid var(--ring);border-radius:8px;font:inherit;outline:none}
#q:focus{border-color:var(--accent)}
#nav a{display:block;padding:6px 10px;margin:1px 0;color:var(--muted);text-decoration:none;border-radius:6px;border:1px solid transparent}
#nav a:hover{color:var(--text)}
#nav a.on{color:var(--accent);background:var(--panel);border-color:var(--ring)}
main{padding:28px clamp(18px,4vw,56px) 80px;max-width:1040px;width:100%}
h1{margin:0 0 4px;font-size:20px;font-weight:600;color:var(--text)}
h1::before{content:"> ";color:var(--accent)}
.lead{color:var(--muted);margin:0 0 22px}
h2{margin:30px 0 10px;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--purple)}
.card{background:var(--panel);border:1px solid var(--ring);border-radius:12px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
table{width:100%;border-collapse:collapse}
td,th{padding:8px 14px;text-align:left;vertical-align:top}
tr+tr td{border-top:1px solid rgba(255,255,255,.07)}
th{color:var(--muted);font-weight:400;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
td:first-child{white-space:nowrap;color:var(--cyan)}
table.rows td:first-child{width:36%}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));gap:10px}
.stat{padding:14px 16px}
.stat b{display:block;font-size:24px;font-weight:600;color:var(--text);line-height:1.2}
.stat span{color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.feat{padding:14px 16px}.feat b{color:var(--accent);display:block;margin-bottom:4px}.feat p{margin:0;color:var(--muted)}
.bars{display:flex;align-items:flex-end;gap:3px;height:76px;padding:14px 16px;box-sizing:content-box}
.bars i{flex:1;min-width:4px;background:var(--accent);opacity:.9;image-rendering:pixelated}
.bars i.z{background:rgba(255,255,255,.12);height:3px!important}
.axis{display:flex;justify-content:space-between;padding:0 16px 10px;color:var(--muted);font-size:11px}
.bar{height:6px;background:rgba(255,255,255,.1);border-radius:3px;min-width:80px}.bar i{display:block;height:100%;border-radius:3px;background:var(--accent)}
.bad{color:var(--red)}.ok{color:var(--green)}.dim{color:var(--muted)}
pre{margin:0;padding:12px 16px;white-space:pre-wrap;color:var(--muted)}
mark{background:rgba(122,162,247,.28);color:inherit;border-radius:3px}
.empty{padding:22px;color:var(--muted)}
@media(max-width:760px){body{grid-template-columns:1fr}#side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--ring)}}
`

export const APP_JS = String.raw`
'use strict'
const $ = (id) => document.getElementById(id)
const h = (tag, props, ...kids) => {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) k === 'class' ? (e.className = v) : k === 'style' ? (e.style.cssText = v) : e.setAttribute(k, v) // cssText: the CSP forbids style attributes, not the CSSOM
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)))
  return e
}
const PAGES = [['overview', 'Overview'], ['stats', 'Usage stats'], ['commands', 'Commands'], ['keys', 'Keyboard'], ['cli', 'Command line'], ['features', 'Features']]
const fmtN = (n) => n.toLocaleString()
const fmtMs = (ms) => { const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); return m < 60 ? m + 'm ' + (s % 60) + 's' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm' }
const ago = (ts) => { if (!ts) return 'never'; const d = (Date.now() - ts) / 1000; return d < 90 ? 'just now' : d < 5400 ? Math.round(d / 60) + 'm ago' : d < 129600 ? Math.round(d / 3600) + 'h ago' : Math.round(d / 86400) + 'd ago' }
const get = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p + ' ' + r.status); return r.json() })

let docs, stats, filter = ''
const hl = (text) => {
  if (!filter) return text
  const i = text.toLowerCase().indexOf(filter)
  return i < 0 ? text : [text.slice(0, i), h('mark', {}, text.slice(i, i + filter.length)), text.slice(i + filter.length)]
}
const match = (...s) => !filter || s.some((x) => x.toLowerCase().includes(filter))
const table = (head, rows) => rows.length ? h('div', { class: 'card' }, h('table', { class: head ? '' : 'rows' }, head && h('tr', {}, head.map((t, i) => h('th', { class: i && t === '#' ? 'n' : '' }, t === '#' ? '' : t))), rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))) : h('div', { class: 'card empty' }, 'No matches.')
const stat = (n, label) => h('div', { class: 'card stat' }, h('b', {}, n), h('span', {}, label))
const chart = (vals, labels) => {
  const max = Math.max(1, ...vals)
  return h('div', { class: 'card' }, h('div', { class: 'bars', title: '' }, vals.map((v, i) => h('i', { class: v ? '' : 'z', style: 'height:' + Math.max(3, Math.round((v / max) * 76)) + 'px', title: (labels ? labels[i] + ': ' : '') + v }))),
    h('div', { class: 'axis' }, h('span', {}, labels ? labels[0] : ''), h('span', {}, 'max ' + max), h('span', {}, labels ? labels[labels.length - 1] : '')))
}
const dayLabels = (n) => Array.from({ length: n }, (_, i) => { const d = new Date(Date.now() - (n - 1 - i) * 864e5); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) })

const view = {
  overview() {
    return [h('h1', {}, 'pager'), h('p', { class: 'lead' }, 'Everything pager can do, and how you have been using it. Served from this machine only.'),
      h('h2', {}, 'At a glance'), h('div', { class: 'grid' }, stat(fmtN(docs.commands.length), 'slash commands'), stat(fmtN(docs.keys.reduce((n, s) => n + s.rows.length, 0)), 'key bindings'), stat(fmtN(stats.chat.sent + stats.chat.received), 'messages'), stat(fmtN(stats.agents.turns), 'agent turns'), stat(fmtN(stats.terminal.total), 'terminal commands')),
      h('h2', {}, 'Start here'), h('div', { class: 'grid' }, ...docs.features.slice(0, 4).map((f) => h('div', { class: 'card feat' }, h('b', {}, f.title), h('p', {}, f.body))))]
  },
  stats() {
    const c = stats.chat, a = stats.agents, t = stats.terminal
    const total = Math.max(1, ...a.byAgent.map((x) => x.turns)), top = Math.max(1, ...t.top.map((x) => x.count))
    return [h('h1', {}, 'Usage stats'), h('p', { class: 'lead' }, 'Computed from files in your data directory, updated ' + new Date(stats.generatedAt).toLocaleTimeString() + '. Nothing leaves your machine.'),
      h('h2', {}, 'Chat'), h('div', { class: 'grid' }, stat(fmtN(c.sent), 'sent'), stat(fmtN(c.received), 'received'), stat(c.contacts + ' (' + c.online + ' online)', 'contacts'), stat(fmtN(c.groups), 'groups'), stat(fmtN(c.unread), 'unread'), stat(c.busiest ? c.busiest.title : 'none', 'busiest this week')),
      h('h2', {}, 'Messages, last 7 days'), chart(c.week, dayLabels(7)),
      h('h2', {}, 'Agents'), h('div', { class: 'grid' }, stat(fmtN(a.turns), 'turns'), stat(fmtMs(a.ms), 'working time'), stat(fmtN(a.files), 'files changed'), stat(fmtN(a.tokensIn) + ' in / ' + fmtN(a.tokensOut) + ' out', 'tokens'), stat(a.reviews.approved + ' / ' + a.reviews.changes, 'reviews ok / changes')),
      h('h2', {}, 'Agent turns, last 14 days'), chart(a.week, dayLabels(14)),
      h('h2', {}, 'By agent'), table(['Agent', 'Backend', '#', 'Time', 'Files', 'Tokens in/out', 'Last'], a.byAgent.map((x) => [x.agent, h('span', { class: 'dim' }, x.cli), h('div', { class: 'bar' }, h('i', { style: 'width:' + Math.round((x.turns / total) * 100) + '%' })), x.turns + ' turns · ' + fmtMs(x.ms), x.files, fmtN(x.tokensIn) + ' / ' + fmtN(x.tokensOut), ago(x.lastTs)])),
      ...(a.usages.length ? [h('h2', {}, 'Reported by the agents'), ...a.usages.map((u) => h('div', { class: 'card', style: 'margin-bottom:10px' }, h('pre', {}, u.agent + '  (' + ago(u.at) + ')\n' + u.text)))] : []),
      h('h2', {}, 'Terminal'), h('div', { class: 'grid' }, stat(fmtN(t.total), 'commands'), stat(fmtN(t.failed), 'failed'), stat(t.total ? Math.round((1 - t.failed / t.total) * 100) + '%' : '-', 'success'), stat(fmtMs(t.ms), 'running time')),
      h('h2', {}, 'Terminal commands, last 30 days'), chart(t.days, dayLabels(30)),
      h('h2', {}, 'Most used programs'), table(['Program', '#', 'Runs', 'Failed'], t.top.map((x) => [x.program, h('div', { class: 'bar' }, h('i', { style: 'width:' + Math.round((x.count / top) * 100) + '%' })), x.count, h('span', { class: x.failed ? 'bad' : 'dim' }, x.failed)]))]
  },
  commands() {
    const out = [h('h1', {}, 'Commands'), h('p', { class: 'lead' }, 'Type these in the message box. Ctrl+P opens the same actions as a searchable palette.')]
    const rows = docs.commands.filter((c) => match(c.usage, c.summary))
    out.push(table(null, rows.map((c) => [hl(c.usage), hl(c.summary)])))
    for (const g of docs.subcommands) {
      const r = g.rows.filter((c) => match(c.usage, c.summary))
      if (r.length) out.push(h('h2', {}, g.title), table(null, r.map((c) => [hl(c.usage), hl(c.summary)])))
    }
    return out
  },
  keys() {
    const out = [h('h1', {}, 'Keyboard'), h('p', { class: 'lead' }, 'In the Terminal tab almost every key goes to your shell; Ctrl+H, Ctrl+P and the tab keys are the exceptions noted below.')]
    for (const s of docs.keys) { const r = s.rows.filter((x) => match(x[0], x[1], s.title)); if (r.length) out.push(h('h2', {}, s.title), table(null, r.map((x) => [hl(x[0]), hl(x[1])]))) }
    out.push(h('h2', {}, 'Desktop window'), table(null, [['Ctrl+Shift+M', 'Cycle material: solid black, glass, mica'], ['Ctrl+Shift+Up / Down', 'Glass opacity'], ['Ctrl+= / Ctrl+- / Ctrl+0', 'Font size'], ['Ctrl+Shift+C / V', 'Copy / paste'], ['F1', 'This page']]))
    return out
  },
  cli() {
    return [h('h1', {}, 'Command line'), h('p', { class: 'lead' }, 'Run these in any shell.'), table(null, docs.cli.filter((c) => match(c.usage, c.summary)).map((c) => [hl(c.usage), hl(c.summary)])), h('h2', {}, 'Environment'), table(null, docs.env.map((c) => [c.usage, c.summary]))]
  },
  features() {
    return [h('h1', {}, 'Features'), h('div', { class: 'grid', style: 'margin-top:18px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))' }, docs.features.filter((f) => match(f.title, f.body)).map((f) => h('div', { class: 'card feat' }, h('b', {}, f.title), h('p', {}, f.body))))]
  },
}

const page = () => { const p = location.hash.slice(1); return view[p] ? p : 'overview' }
const render = () => {
  const p = page()
  $('nav').replaceChildren(...PAGES.map(([id, label]) => h('a', { href: '#' + id, class: id === p ? 'on' : '' }, label)))
  $('main').replaceChildren(...view[p]().flat())
}
$('q').addEventListener('input', (e) => { filter = e.target.value.trim().toLowerCase(); if (filter && !['commands', 'keys', 'cli', 'features'].includes(page())) location.hash = '#commands'; else render() })
addEventListener('hashchange', async () => { if (page() === 'stats' || page() === 'overview') stats = await get('api/stats'); render() })
Promise.all([get('api/docs'), get('api/stats')]).then(([d, s]) => { docs = d; stats = s; $('ver').textContent = 'v' + d.version; render() })
  .catch((e) => { $('main').replaceChildren(h('div', { class: 'card empty' }, 'Could not load: ' + e.message)) })
`
