// Stand-in for the shell around the notebook block: window.pager.d.block -> HTTP -> the real notebook.cjs (notebook-server.cjs).
export function makeCtx({ args = {}, cwd = '' } = {}) {
  const listeners = new Set()
  const es = new EventSource('/events')
  es.onmessage = (m) => {
    const { event, payload } = JSON.parse(m.data)
    for (const fn of listeners) fn(event, payload)
  }
  const rpc = async (method, a) => {
    const r = await fetch(`/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pager-harness': '1' }, body: JSON.stringify(a || {}) })
    const j = await r.json()
    if (!j.ok) throw new Error(j.error.message)
    return j.result
  }
  return {
    args,
    cwd,
    rpc,
    onEvent: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    setTitle: (t) => { document.title = t + ' · notebook harness' },
    close() {},
    openBlock() {},
    openPath() {},
    toast(level, text) {
      const t = document.createElement('div')
      t.className = 'toast ' + level
      t.textContent = text
      document.getElementById('toasts').append(t)
      setTimeout(() => t.remove(), 3000)
    },
  }
}
