// The docs site is three static strings: no build step, no files to find at run time, nothing to edit in the install.

export const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pager docs</title><link rel="icon" type="image/svg+xml" href="logo.svg"><script src="theme.js"></script><link rel="stylesheet" href="app.css"></head>
<body>
<aside id="side">
  <div id="brand"><img id="logo" src="logo.svg" alt="" width="26" height="26"><span>pager</span><small id="ver"></small></div>
  <label class="fld" id="find"><svg class="ico" viewBox="0 0 16 16"><path d="M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM14 14l-3.5-3.5"/></svg><input id="q" type="search" placeholder="Search commands and keys" autocomplete="off" spellcheck="false"></label>
  <nav id="nav"></nav>
  <div id="theme" class="seg" role="group" aria-label="Appearance"></div>
</aside>
<main id="main"></main>
<script src="app.js"></script>
</body></html>`

/** Appearance: Dark (pitch black, the default) | Light | System, remembered in this browser; runs in the head so the page never flashes the wrong scheme. */
export const THEME_JS = String.raw`
'use strict'
const KEY = 'pager-theme'
const root = document.documentElement
const saved = () => { try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'system' ? v : 'dark' } catch { return 'dark' } }
const apply = (mode) => root.setAttribute('data-theme', mode)
apply(saved())
addEventListener('DOMContentLoaded', () => {
  const box = document.getElementById('theme')
  if (!box) return
  const draw = () => {
    const now = saved()
    box.replaceChildren(...[['dark', 'Dark'], ['light', 'Light'], ['system', 'System']].map(([id, label]) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.className = id === now ? 'on' : ''
      b.setAttribute('aria-pressed', String(id === now))
      b.addEventListener('click', () => { try { localStorage.setItem(KEY, id) } catch {} apply(id); draw() })
      return b
    }))
  }
  draw()
})
`

// Tern's design system: Geist, near-black page, glass cards on a 1px ring, 6/8/12/16 radii, 1.45-stroke vector icons. Colors flip with
// light-dark(); the page is dark unless the Appearance control picks Light or System (the system scheme). Nothing here is pixelated or stepped art.
export const APP_CSS = `
@font-face{font-family:"Geist";src:url(fonts/geist.woff2) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(fonts/geist-mono.woff2) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
:root{color-scheme:dark;
--page:light-dark(#f4f4f1,#000);--panel:light-dark(#fbfbfa,#09090b);--card:light-dark(#fff,#0f0f12);--raise:light-dark(#f4f4f2,#18181b);
--l1:light-dark(rgba(24,26,44,.06),rgba(255,255,255,.07));--l2:light-dark(rgba(24,26,44,.09),rgba(255,255,255,.1));--l3:light-dark(rgba(24,26,44,.14),rgba(255,255,255,.15));--l4:light-dark(rgba(24,26,44,.22),rgba(255,255,255,.24));
--t1:light-dark(#1b1c20,#ededed);--t2:light-dark(#55575f,#a1a1a1);--t3:light-dark(#6a6c74,#8a8a92);--t4:light-dark(#b3b5bb,#55555c);
--a1:#44cfff;--a2:#3b6cff;--grad:linear-gradient(135deg,var(--a1),var(--a2));--grad-ink:#05070b;
--accent:light-dark(#3d6fff,#5a8cff);--accent-ink:light-dark(#2448c4,#9dbcff);--accent-fill:light-dark(#2f63f0,#2a5fe0);
--live:#a86af4;--ok:light-dark(#2fae74,#3ecf8e);--warn:light-dark(#d98a0b,#f5a524);--bad:light-dark(#e5484d,#ff6166);
--well:light-dark(rgba(255,255,255,.62),rgba(255,255,255,.035));--code-bg:light-dark(#f8f8f6,#0c0c0d);
--pop-bg:light-dark(rgba(255,255,255,.82),rgba(35,35,39,.98));--glass-hi:light-dark(#fff,rgba(255,255,255,.05));
--r-chip:6px;--r-ctl:8px;--r-card:12px;--r-panel:16px;
--sans:"Geist",-apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif;
--mono:"Geist Mono",ui-monospace,"Cascadia Mono","SF Mono",Menlo,Consolas,monospace;
--ease:cubic-bezier(.2,.7,.2,1);--out:cubic-bezier(.16,1,.3,1)}
:root[data-theme=light]{color-scheme:light}
:root[data-theme=system]{color-scheme:light dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--page);color:var(--t1);font:14px/1.5 var(--sans);letter-spacing:-.003em;-webkit-font-smoothing:antialiased}
body{display:grid;grid-template-columns:244px 1fr}
::selection{background:color-mix(in srgb,var(--accent) 22%,transparent)}
:focus-visible{outline:none;box-shadow:0 0 0 1px var(--accent),0 0 0 4px color-mix(in srgb,var(--accent) 18%,transparent)}
svg.ico{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.45;stroke-linecap:round;stroke-linejoin:round}
#side{position:sticky;top:0;height:100vh;padding:14px 10px 12px;background:var(--panel);box-shadow:inset -1px 0 0 var(--l1);display:flex;flex-direction:column;gap:10px;overflow:auto}
#brand{display:flex;align-items:center;gap:10px;padding:2px 8px 6px;font-size:15px;font-weight:600;letter-spacing:-.02em}
#brand small{color:var(--t4);font:500 11px var(--mono);margin-left:auto;letter-spacing:0}
#logo{width:26px;height:26px;border-radius:7px;box-shadow:0 0 0 1px var(--l2),0 6px 16px -6px rgba(59,108,255,.55)}
.fld{display:flex;align-items:center;gap:8px;height:30px;margin:0 2px;padding:0 8px 0 10px;border-radius:var(--r-ctl);background:var(--well);box-shadow:inset 0 0 0 1px var(--l2);color:var(--t3);transition:box-shadow .15s var(--ease)}
.fld .ico{width:14px;height:14px}
.fld:focus-within{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 55%,transparent),0 0 0 3px color-mix(in srgb,var(--accent) 13%,transparent)}
#q{flex:1;min-width:0;height:100%;padding:0;color:var(--t1);background:none;border:0;font:13px var(--sans);outline:none;box-shadow:none}
#q::placeholder{color:var(--t4)}
#q::-webkit-search-cancel-button{display:none}
#nav{display:flex;flex-direction:column;gap:2px}
#nav a{display:flex;align-items:center;gap:10px;height:32px;padding:0 10px;color:var(--t3);text-decoration:none;font-size:13.5px;border-radius:var(--r-ctl);transition:background .15s var(--ease),color .15s var(--ease)}
#nav a .ico{width:15px;height:15px}
#nav a:hover{color:var(--t1);background:var(--l1)}
#nav a.on{color:var(--t1);background:light-dark(var(--card),rgba(255,255,255,.08));box-shadow:light-dark(0 0 0 1px var(--l1),inset 0 1px 0 var(--glass-hi))}
#nav a.on .ico{color:var(--accent)}
#nav a.ext{margin-top:8px;color:var(--t4)}
#nav a.ext .arrow{margin-left:auto;width:12px;height:12px;opacity:.7}
.seg{display:flex;gap:2px;margin:auto 2px 0;padding:2px;height:30px;border-radius:9px;background:var(--l1);box-shadow:inset 0 0 0 1px var(--l1)}
.seg button{flex:1;min-width:0;padding:0 6px;border:0;border-radius:7px;background:none;color:var(--t3);font:500 12px var(--sans);cursor:pointer;transition:background .2s var(--out),color .15s var(--ease),transform .1s}
.seg button:hover{color:var(--t1)}
.seg button:active{transform:scale(.97)}
.seg button.on{color:var(--t1);background:light-dark(var(--card),var(--raise));box-shadow:light-dark(0 1px 2px rgba(0,0,0,.08),inset 0 1px 0 rgba(255,255,255,.08)),0 0 0 1px var(--l1)}
main{padding:34px clamp(18px,4vw,56px) 90px;max-width:1080px;width:100%}
main>*{animation:rise .4s var(--out) both}
@keyframes rise{from{opacity:0;transform:translateY(6px)}}
.kick{font:500 12px var(--mono);color:var(--accent-ink);margin-bottom:6px;letter-spacing:0}
h1{margin:0 0 4px;font-size:26px;font-weight:600;letter-spacing:-.025em;color:var(--t1)}
.lead{color:var(--t2);margin:0 0 24px;max-width:62ch}
h2{margin:30px 0 10px 2px;font-size:12.5px;font-weight:500;letter-spacing:0;color:var(--t3)}
.card{background:var(--card);border-radius:var(--r-card);box-shadow:inset 0 0 0 1px var(--l2),inset 0 1px 0 var(--glass-hi);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);overflow:hidden}
table{width:100%;border-collapse:collapse}
td,th{padding:10px 16px;text-align:left;vertical-align:top}
tr+tr td{box-shadow:inset 0 1px 0 var(--l1)}
th{color:var(--t3);font-weight:500;font-size:12px;box-shadow:inset 0 -1px 0 var(--l1)}
td:first-child{white-space:nowrap;color:var(--accent-ink);font:12.5px/1.6 var(--mono)}
td{color:var(--t2)}
table.rows td:first-child{width:36%}
tbody tr{transition:background .15s var(--ease)}
tr:hover td{background:var(--l1)}
tr:has(th):hover td,tr:has(th):hover th{background:none}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));gap:10px}
.stat{padding:14px 16px}
.stat b{display:block;font-size:24px;font-weight:550;letter-spacing:-.02em;color:var(--t1);line-height:1.2;font-variant-numeric:tabular-nums}
.stat span{color:var(--t3);font-size:12px}
.feat{padding:14px 16px}.feat b{color:var(--t1);font-weight:550;display:block;margin-bottom:4px}.feat p{margin:0;color:var(--t2)}
.bars{display:flex;align-items:flex-end;gap:4px;height:76px;padding:16px 16px 0;box-sizing:content-box}
.bars i{flex:1;min-width:4px;border-radius:4px 4px 2px 2px;background:var(--grad);opacity:.9;transition:opacity .15s var(--ease)}
.bars i:hover{opacity:1}
.bars i.z{background:var(--l2);opacity:1;height:3px!important}
.axis{display:flex;justify-content:space-between;padding:8px 16px 12px;color:var(--t4);font:11.5px var(--mono)}
.bar{height:6px;background:var(--l2);border-radius:999px;min-width:80px}.bar i{display:block;height:100%;border-radius:999px;background:var(--grad)}
.bad{color:var(--bad)}.ok{color:var(--ok)}.dim{color:var(--t3)}
pre{margin:0;padding:12px 16px;white-space:pre-wrap;color:var(--t2);font:12.5px/1.6 var(--mono)}
mark{background:color-mix(in srgb,var(--accent) 16%,transparent);color:inherit;border-radius:3px}
.empty{padding:22px;color:var(--t3)}
@media(max-width:760px){body{grid-template-columns:1fr}#side{position:static;height:auto;box-shadow:inset 0 -1px 0 var(--l1)}.seg{margin-top:0}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}}
@media(prefers-contrast:more){:root{--l1:light-dark(rgba(24,26,44,.2),rgba(255,255,255,.2));--l2:light-dark(rgba(24,26,44,.4),rgba(255,255,255,.4));--t3:light-dark(#3a3c42,#d0d0d4)}}
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
const ICONS = {
  overview: '<path d="M2.5 7.2 8 2.8l5.5 4.4V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5zM6.5 13.5v-4h3v4"/>',
  stats: '<path d="M3 13V8M8 13V3M13 13V6"/>',
  commands: '<path d="M2.5 3.5h11v9h-11zM5 6.5 7 8l-2 1.5M8.5 10H11"/>',
  keys: '<path d="M1.8 4.5h12.4v7H1.8zM4.5 7h.01M7 7h.01M9.5 7h.01M12 7h.01M5 9.5h6"/>',
  cli: '<path d="M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5"/>',
  features: '<path d="m8 2 1.4 3.6L13 7l-3.6 1.4L8 12 6.6 8.4 3 7l3.6-1.4z"/>',
  studio: '<path d="M3 6h10v6.5H3zM8 6V3.5M8 3.5h.01M6 9h.01M10 9h.01"/>',
  arrow: '<path d="M5 11 11 5M6 5h5v5"/>',
}
const icon = (name, cls) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('class', 'ico' + (cls ? ' ' + cls : '')); s.innerHTML = ICONS[name]; return s }
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
  const n = PAGES.findIndex(([id]) => id === p)
  $('nav').replaceChildren(...PAGES.map(([id, label]) => h('a', { href: '#' + id, class: id === p ? 'on' : '' }, icon(id), label)), h('a', { href: 'studio/', class: 'ext' }, icon('studio'), 'Bot studio', icon('arrow', 'arrow')))
  $('main').replaceChildren(h('div', { class: 'kick' }, '0' + (n + 1) + ' \u00b7 ' + PAGES[n][1]), ...view[p]().flat())
}
$('q').addEventListener('input', (e) => { filter = e.target.value.trim().toLowerCase(); if (filter && !['commands', 'keys', 'cli', 'features'].includes(page())) location.hash = '#commands'; else render() })
addEventListener('hashchange', async () => { if (page() === 'stats' || page() === 'overview') stats = await get('api/stats'); render() })
Promise.all([get('api/docs'), get('api/stats')]).then(([d, s]) => { docs = d; stats = s; $('ver').textContent = 'v' + d.version; render() })
  .catch((e) => { $('main').replaceChildren(h('div', { class: 'card empty' }, 'Could not load: ' + e.message)) })
`
