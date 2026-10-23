// Stand-in for electron/blocks/screen.cjs in the harness page (desktopCapturer needs Electron): same method names and
// the same refusals (control only with confirm, input only in control mode), and a fake desktop drawn on a canvas as the
// capture stream. It exists to exercise screen.js; the real handler is tested in electron/blocks/screen.test.cjs.
function desktop(w, h, hue) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  const draw = (cursor) => {
    const bg = g.createLinearGradient(0, 0, w, h)
    bg.addColorStop(0, `hsl(${hue} 55% 22%)`)
    bg.addColorStop(1, `hsl(${hue + 50} 60% 12%)`)
    g.fillStyle = bg
    g.fillRect(0, 0, w, h)
    g.fillStyle = 'rgba(255,255,255,.07)'
    g.fillRect(0, h - 44, w, 44)
    g.fillStyle = 'rgba(255,255,255,.14)'
    for (let i = 0; i < 6; i++) g.fillRect(16 + i * 46, h - 36, 30, 28)
    // a window
    g.fillStyle = '#16181d'
    g.fillRect(w * 0.12, h * 0.14, w * 0.5, h * 0.55)
    g.fillStyle = '#242830'
    g.fillRect(w * 0.12, h * 0.14, w * 0.5, 28)
    g.fillStyle = '#7ee787'
    g.font = '15px monospace'
    for (let i = 0; i < 9; i++) g.fillText(`$ build step ${i + 1} ... ok`, w * 0.12 + 16, h * 0.14 + 58 + i * 22)
    g.fillStyle = '#e6edf3'
    g.font = '600 20px sans-serif'
    g.fillText(new Date().toLocaleTimeString(), w - 130, h - 14)
    if (cursor) {
      g.fillStyle = '#fff'
      g.strokeStyle = '#000'
      g.beginPath()
      g.moveTo(cursor.x, cursor.y)
      g.lineTo(cursor.x, cursor.y + 22)
      g.lineTo(cursor.x + 6, cursor.y + 17)
      g.lineTo(cursor.x + 12, cursor.y + 24)
      g.lineTo(cursor.x + 14, cursor.y + 22)
      g.lineTo(cursor.x + 8, cursor.y + 16)
      g.lineTo(cursor.x + 15, cursor.y + 15)
      g.closePath()
      g.fill()
      g.stroke()
    }
  }
  return { c, draw }
}

export function mockRpc() {
  const displays = [
    { id: 'screen:0:0', name: 'Display 1', displayId: '1', size: { w: 1920, h: 1200 }, scale: 1.25, primary: true, hostsPager: true, bounds: { x: 0, y: 0, width: 1536, height: 960 } },
    { id: 'screen:1:0', name: 'Display 2', displayId: '2', size: { w: 2560, h: 1440 }, scale: 1, primary: false, hostsPager: false, bounds: { x: 1536, y: 0, width: 2560, height: 1440 } },
  ]
  const hue = { 'screen:0:0': 215, 'screen:1:0': 150 }
  const sessions = new Map()
  window.__inputLog = []
  window.__sessions = sessions
  const thumb = (d) => {
    const m = desktop(320, 200, hue[d.id])
    m.draw()
    return m.c.toDataURL('image/jpeg', 0.7)
  }
  const find = (sid) => {
    const s = sessions.get(sid)
    if (!s) throw new Error('This screen session is closed.')
    return s
  }
  return async function rpc(method, a = {}) {
    switch (method) {
      case 'sources':
        return displays.map((d) => ({ ...d, thumb: thumb(d) }))
      case 'select': {
        const d = displays.find((x) => x.id === a.sourceId)
        if (!d) throw new Error('That display is no longer available.')
        const sid = 's' + (sessions.size + 1)
        sessions.set(sid, { sid, mode: 'view', d })
        return { sid, source: d }
      }
      case 'mode': {
        const s = find(a.sid)
        if (a.mode === 'control' && a.confirm !== true) throw new Error('Control needs your confirmation.')
        s.mode = a.mode
        return { mode: s.mode }
      }
      case 'input': {
        const s = find(a.sid)
        if (s.mode !== 'control') throw new Error('This session is view only.')
        window.__inputLog.push(...a.events)
        const last = [...a.events].reverse().find((e) => e.x !== undefined)
        if (last) s.cursor = last
        return { ok: a.events.length, fail: 0 }
      }
      case 'frame':
        throw new Error('stills are not available in the harness')
      case 'saveRecording':
        window.__saved = a.data.length
        return { saved: true, path: 'C:\\Users\\you\\Videos\\Pager-screen.webm', bytes: a.data.length }
      case 'release':
        sessions.delete(a.sid)
        return true
    }
    throw new Error('Unknown method: ' + method)
  }
}

/** The fake capture: a canvas stream of the selected display, with the injected pointer drawn in so Control is visible. */
export function mockCapture(rpcState = window.__sessions) {
  return async (source) => {
    const m = desktop(source.size.w > 1920 ? 1280 : 960, source.size.w > 1920 ? 720 : 600, source.id === 'screen:1:0' ? 150 : 215)
    const tick = () => {
      const s = [...rpcState.values()].find((x) => x.d.id === source.id)
      const cur = s && s.cursor ? { x: s.cursor.x * m.c.width, y: s.cursor.y * m.c.height } : null
      m.draw(cur)
    }
    tick()
    const iv = setInterval(tick, 100)
    const stream = m.c.captureStream(15)
    const t = stream.getVideoTracks()[0]
    const stop = t.stop.bind(t)
    t.stop = () => {
      clearInterval(iv)
      stop()
    }
    return stream
  }
}
