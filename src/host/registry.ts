/** `reg.exe` argument lists (without the program name) for the per-user context menu. */
const MENU_KEYS = ['HKCU\\Software\\Classes\\Directory\\Background\\shell\\Pager', 'HKCU\\Software\\Classes\\Directory\\shell\\Pager']
const MENU_ARG = ['%V', '%1'] as const

/** `launch` is the command that opens Pager; the clicked folder is appended as `--cwd "<folder>"`. */
export function contextMenuAdd(o: { launch: string; icon: string }): string[][] {
  return MENU_KEYS.flatMap((key, i) => [
    ['add', key, '/ve', '/d', 'Open Pager here', '/f'],
    ['add', key, '/v', 'Icon', '/t', 'REG_SZ', '/d', o.icon, '/f'],
    ['add', `${key}\\command`, '/ve', '/d', `${o.launch} --cwd "${MENU_ARG[i]}"`, '/f'],
  ])
}

export function contextMenuRemove(): string[][] {
  return MENU_KEYS.map((key) => ['delete', key, '/f'])
}

