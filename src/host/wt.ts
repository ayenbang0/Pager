export interface PassArgs {
  cwd?: string
  words?: string[]
}

/** The `pager` arguments that make a freshly started pager open a tab for the request. */
export function passArgs(o: PassArgs): string[] {
  if (o.cwd === undefined && (o.words === undefined || o.words.length === 0)) return []
  return ['run', ...(o.cwd === undefined ? [] : ['--cwd', o.cwd]), ...(o.words === undefined || o.words.length === 0 ? [] : ['--', ...o.words])]
}

/** `wt.exe` arguments for a new Pager tab in the one window named `pager`. `;` separates wt commands, so it is escaped. */
export function wtArgs(o: PassArgs & { node: string; cli: string; solid?: boolean }): string[] {
  const args = ['-w', 'pager', 'new-tab', '--title', 'pager', '-p', o.solid === true ? 'Pager Solid' : 'Pager', ...(o.cwd === undefined ? [] : ['-d', o.cwd]), o.node, o.cli, ...passArgs(o)]
  return args.map((a) => a.replaceAll(';', '\\;'))
}
