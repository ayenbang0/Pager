// Runs before first paint (classic script in <head>, no imports): restores the last theme/layout from the UI cache so the skeleton never flashes
// the wrong colours, and stamps the performance marks the shell reports.
;(() => {
  performance.mark('shell-boot')
  try {
    const c = JSON.parse(localStorage.getItem('pager.ui.v1') || '{}')
    const root = document.documentElement
    const dark = c.theme === 'dark' || (c.theme !== 'light' && (c.theme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : true))
    root.dataset.theme = dark ? 'dark' : 'light'
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
