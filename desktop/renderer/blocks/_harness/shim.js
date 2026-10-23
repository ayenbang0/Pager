// Stand-in for the shell: window.pager.d.block -> HTTP -> the real database.cjs (see serve.mjs), plus a block ctx.
export async function config() {
  return (await fetch('/config.json')).json()
}

export function makeBlockRpc(name) {
  return async (method, args) => {
    const r = await fetch(`/rpc/${name}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args || {}) })
    const j = await r.json()
    if (!j.ok) throw Object.assign(new Error(j.error.message), { code: j.error.code })
    return j.result
  }
}

export function makeCtx({ args = {}, cwd = '' } = {}) {
  const listeners = new Set()
  const rpc = makeBlockRpc('database')
  const toasts = document.getElementById('toasts')
  return {
    args,
    cwd,
    rpc,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    emit: (ev, payload) => listeners.forEach((fn) => fn(ev, payload)),
    setTitle: (t) => { document.title = t + ' · Database harness' },
    close() {},
    openBlock() {},
    openPath() {},
    toast(level, text) {
      const t = document.createElement('div')
      t.className = 'toast ' + level
      t.textContent = text
      toasts.append(t)
      setTimeout(() => t.remove(), 3500)
    },
  }
}
