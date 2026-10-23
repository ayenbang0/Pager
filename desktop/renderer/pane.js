// The browser pane's chrome: tabs, address bar, buttons. The pages themselves are native views the main process
// lays over #viewport; this file only reports where that box is and shows the tab state main sends.
import { icon } from './ui/icons.js'

const P = window.pager
const $ = (id) => document.getElementById(id)
const pane = $('pane')
const split = $('split')
const addr = $('addr')
const vp = $('viewport')
let state = { visible: false, active: -1, tabs: [], notice: '' }
let focusAddress = false
let noticeTimer

const send = (cmd, arg) => P && P.browser && P.browser(cmd, arg)
const el = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function report() {
  if (!state.visible) return
  const r = vp.getBoundingClientRect()
  send('bounds', { x: r.x, y: r.y, width: r.width, height: r.height })
}

const iconBtn = (btn, name) => btn.replaceChildren(icon(name))
iconBtn($('back'), 'arrow-left')
iconBtn($('fwd'), 'arrow-right')
iconBtn($('hide'), 'close')

function render() {
  pane.hidden = split.hidden = !state.visible
  document.body.classList.toggle('web', state.visible)
  document.querySelectorAll('[data-browser-toggle]').forEach((b) => b.classList.toggle('on', state.visible))
  const strip = $('tabs')
  strip.replaceChildren(
    ...state.tabs.map((t) => {
      const tab = el('div', t.id === state.active ? 'tab on' : 'tab')
      tab.title = t.url
      const x = el('button', 'x')
      x.append(icon('close', 11))
      tab.append(el('span', 'ttl', (t.loading ? '… ' : '') + t.title), x)
      tab.addEventListener('click', () => send('activate', t.id))
      tab.addEventListener('auxclick', (e) => e.button === 1 && send('close', t.id))
      x.addEventListener('click', (e) => {
        e.stopPropagation()
        send('close', t.id)
      })
      return tab
    }),
    (() => {
      const b = el('button', 'plus')
      b.append(icon('plus', 13))
      b.dataset.tip = 'New tab'
      b.dataset.tipKeys = 'Ctrl+T'
      b.addEventListener('click', () => {
        focusAddress = true
        send('new')
      })
      return b
    })(),
  )
  const t = state.tabs.find((x) => x.id === state.active)
  if (document.activeElement !== addr) addr.value = t ? t.url : ''
  $('back').disabled = !t || !t.back
  $('fwd').disabled = !t || !t.forward
  iconBtn($('reload'), t && t.loading ? 'close' : 'refresh')
  $('reload').dataset.tip = t && t.loading ? 'Stop' : 'Reload'
  $('reload').dataset.tipKeys = t && t.loading ? '' : 'F5'
  const note = $('note')
  note.textContent = state.notice || note.textContent
  if (state.notice) {
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => (note.textContent = ''), 4000)
  }
  if (focusAddress && state.visible) {
    focusAddress = false
    addr.focus()
    addr.select()
  }
  requestAnimationFrame(report)
}

if (P && P.onBrowser) {
  P.onBrowser((s) => {
    state = s
    render()
  })
  P.onBrowserKey((name) => {
    if (name === 'address') {
      addr.focus()
      addr.select()
    } else if (name === 'new') {
      focusAddress = true
      send('new')
    } else if (name === 'close') send('close')
    else send(name)
  })
}
new ResizeObserver(report).observe(vp)
window.addEventListener('resize', report)

$('back').addEventListener('click', () => send('back'))
$('fwd').addEventListener('click', () => send('forward'))
$('reload').addEventListener('click', () => send('reload'))
$('hide').addEventListener('click', () => send('hide'))
addr.addEventListener('focus', () => addr.select())
addr.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    send('go', addr.value)
    addr.blur()
  } else if (e.key === 'Escape') {
    addr.blur()
    render()
  }
})
// Chords while the pane's own chrome has focus (a page that has focus is handled by the main process).
pane.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey) return
  const k = e.key.toLowerCase()
  if (!e.shiftKey && k === 'l') (e.preventDefault(), addr.focus(), addr.select())
  else if (!e.shiftKey && k === 't') (e.preventDefault(), (focusAddress = true), send('new'))
  else if (!e.shiftKey && k === 'w') (e.preventDefault(), send('close'))
  else if (e.shiftKey && k === 'b') (e.preventDefault(), send('toggle'))
})

// The divider: drag to give the pane more or less of the window.
split.addEventListener('pointerdown', (e) => {
  split.setPointerCapture(e.pointerId)
  const move = (m) => {
    const w = Math.min(Math.max(window.innerWidth - m.clientX, 300), Math.floor(window.innerWidth * 0.75))
    document.documentElement.style.setProperty('--pane-w', `${w}px`)
  }
  const up = () => {
    split.removeEventListener('pointermove', move)
    split.removeEventListener('pointerup', up)
  }
  split.addEventListener('pointermove', move)
  split.addEventListener('pointerup', up)
})
send('state')
