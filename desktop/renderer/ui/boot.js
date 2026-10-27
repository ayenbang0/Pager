// Runs before first paint (classic script in <head>, no imports): restores the last theme/layout from the UI cache so the skeleton never flashes
// the wrong colours, and stamps the performance marks the shell reports.
;(() => {
  performance.mark('shell-boot')
  try {
    const c = JSON.parse(localStorage.getItem('pager.ui.v1') || '{}')
    const root = document.documentElement
    const dark = c.theme === 'dark' || (c.theme !== 'light' && (c.theme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : true))
    root.dataset.theme = dark ? 'dark' : 'light'
    // Caption-button symbols must match the theme before first paint (the light palette needs dark ones).
    if (window.pager && window.pager.chrome) window.pager.chrome('titlebar', dark ? '#b4b8c4' : '#4b4f57')
    const keep = (p, v, all) => {
      if (!v || all.indexOf(v) < 0) return
      for (const a of all) root.classList.remove(p + a)
      root.classList.add(p + v)
    }
    keep('lay-', c.layout, ['rail', 'float', 'tiles', 'studio'])
    keep('dense-', c.density, ['compact', 'islands'])
    keep('tabs-', c.tabs === 'vertical' ? 'v' : 'h', ['h', 'v'])
    keep('mat-', c.material, ['glass', 'clear', 'solid'])
    if (c.status_bar) root.classList.add('tn-status')
    if (c.opacity > 0) root.style.setProperty('--tint', String(c.material === 'solid' ? 1 : c.opacity / 100))
  } catch {
    // defaults from the markup stay
  }
  // Two frames after the skeleton exists = the first time the user can see the shell.
  requestAnimationFrame(() => requestAnimationFrame(() => performance.mark('shell-first-paint')))
})()

  // If the shell never gets past its skeleton (a module failed to load or threw), say why instead of staying blank.
  const errs = []
  window.addEventListener('error', (e) => errs.push(e.message || (e.target && e.target.src ? `cannot load ${e.target.src}` : 'error')), true)
  window.addEventListener('unhandledrejection', (e) => errs.push(String((e.reason && e.reason.message) || e.reason)))
  setTimeout(() => {
    if (performance.getEntriesByName('shell-ready').length) return
    const host = document.getElementById('panes')
    if (!host) return
    const box = document.createElement('div')
    box.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;color:var(--t2,#aaa);font:13px/1.5 system-ui,sans-serif'
    box.textContent = `Pager could not start its window.${errs.length ? ' ' + errs.slice(-2).join(' · ') : ' The daemon did not answer.'}`
    host.replaceChildren(box)
  }, 8000)