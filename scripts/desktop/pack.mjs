// Builds release/Pager (the own-window host) and release/Pager-<version>-win-x64.zip. No installer, no auto-updater.
// PAGER_RELEASE_DIR builds somewhere else instead of release/ (which is emptied first), for when a Pager runs from release/Pager.
// Set PAGER_SIGN_CMD (a command template containing {file}) to Authenticode-sign every PE that gets loaded.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const desk = path.join(root, 'desktop')
const rel = path.resolve(process.env.PAGER_RELEASE_DIR ?? path.join(root, 'release'))
const out = path.join(rel, 'Pager')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const win = process.platform === 'win32'

function run(cmd, args, cwd = root) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: win && /\.cmd$|^npm$/.test(cmd) })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`)
}
function size(p) {
  const s = statSync(p)
  return s.isDirectory() ? readdirSync(p).reduce((n, f) => n + size(path.join(p, f)), 0) : s.size
}
function must(p) {
  if (!existsSync(p)) throw new Error(`missing ${p}`)
  return p
}
function walk(dir, fn) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, fn)
    else fn(p)
  }
}

console.log('1/6 build pager')
run('npm', ['run', 'build'])

console.log('2/6 install electron + xterm')
run('npm', ['ci', '--no-audit', '--no-fund'], desk)
// Electron 44 does not download its binary on install; this fetches (or reuses the cached) dist/.
run(process.execPath, [path.join(desk, 'node_modules', 'electron', 'install.js')], desk)

console.log('3/6 stage electron')
rmSync(rel, { recursive: true, force: true })
cpSync(must(path.join(desk, 'node_modules', 'electron', 'dist')), out, { recursive: true })
renameSync(path.join(out, 'electron.exe'), path.join(out, 'Pager.exe'))
// The exe's own resources are what the taskbar, a pinned shortcut, Alt+Tab and Task Manager show: without this they stay Electron's.
const stamp = [
  '--set-icon', must(path.join(desk, 'assets', 'pager.ico')),
  '--set-file-version', pkg.version,
  '--set-product-version', pkg.version,
  ...Object.entries({ ProductName: 'Pager', FileDescription: 'Pager', InternalName: 'Pager', OriginalFilename: 'Pager.exe', CompanyName: 'Pager' }).flatMap(([k, v]) => ['--set-version-string', k, v]),
]
run(must(path.join(desk, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')), [path.join(out, 'Pager.exe'), ...stamp])
rmSync(path.join(out, 'resources', 'default_app.asar'), { force: true })
const locales = path.join(out, 'locales')
for (const f of readdirSync(locales)) if (f !== 'en-US.pak') rmSync(path.join(locales, f))
for (const f of ['LICENSES.chromium.html']) rmSync(path.join(out, f), { force: true })

console.log('4/6 app + pager')
const app = path.join(out, 'resources', 'app')
mkdirSync(app, { recursive: true })
writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'pager-desktop', version: pkg.version, main: 'electron/main.cjs' }))
cpSync(path.join(desk, 'electron'), path.join(app, 'electron'), { recursive: true })
const renderer = path.join(app, 'renderer')
// `blocks/_harness/` is dev-only (loopback servers and fixtures for the block pages); it stays out of the product.
cpSync(path.join(desk, 'renderer'), renderer, { recursive: true, filter: (src) => path.basename(src) !== '_harness' })
const nm = path.join(desk, 'node_modules', '@xterm')
const vendor = path.join(renderer, 'vendor')
mkdirSync(vendor, { recursive: true })
cpSync(must(path.join(nm, 'xterm', 'lib', 'xterm.js')), path.join(vendor, 'xterm.js'))
cpSync(must(path.join(nm, 'xterm', 'css', 'xterm.css')), path.join(vendor, 'xterm.css'))
cpSync(must(path.join(nm, 'addon-fit', 'lib', 'addon-fit.js')), path.join(vendor, 'addon-fit.js'))
cpSync(must(path.join(nm, 'addon-webgl', 'lib', 'addon-webgl.js')), path.join(vendor, 'addon-webgl.js'))
cpSync(must(path.join(desk, 'assets', 'pager.png')), path.join(renderer, 'pager.png'))

// The pty child: a real node.exe (Microsoft/OpenJS-signed), not Electron acting as node.
mkdirSync(path.join(out, 'resources', 'node'), { recursive: true })
cpSync(process.execPath, path.join(out, 'resources', 'node', 'node.exe'))

const inner = path.join(app, 'pager')
mkdirSync(inner, { recursive: true })
cpSync(path.join(root, 'dist'), path.join(inner, 'dist'), { recursive: true })
// The installer reads its icon from desktop/ next to dist/.
cpSync(path.join(desk, 'assets'), path.join(inner, 'desktop', 'assets'), { recursive: true })
for (const f of ['package.json', 'package-lock.json', 'CHANGELOG.md', 'LICENSE']) if (existsSync(path.join(root, f))) cpSync(path.join(root, f), path.join(inner, f))
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], inner)
// Native addons ship a prebuild per platform; only this one runs here.
function prune(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = path.join(dir, e.name)
    if (e.name === 'prebuilds') {
      for (const d of readdirSync(p)) if (d !== 'win32-x64') rmSync(path.join(p, d), { recursive: true, force: true })
    } else prune(p)
  }
}
prune(path.join(inner, 'node_modules'))
// Tests and source maps are dead weight in the app.
walk(path.join(inner, 'dist'), (p) => {
  if (p.endsWith('.test.js') || p.endsWith('.map')) rmSync(p)
})

console.log('5/6 sign')
const sign = process.env.PAGER_SIGN_CMD
if (sign !== undefined && sign !== '') {
  if (!sign.includes('{file}')) throw new Error('PAGER_SIGN_CMD must contain {file}')
  walk(out, (p) => {
    if (!/\.(exe|dll|node)$/i.test(p)) return
    const r = spawnSync(sign.replaceAll('{file}', `"${p}"`), { shell: true, stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`signing failed for ${p}`)
  })
} else {
  console.log('   PAGER_SIGN_CMD not set: binaries stay unsigned (Windows Smart App Control may refuse them; see README)')
}

console.log('6/6 zip')
const zip = path.join(rel, `Pager-${pkg.version}-win-x64.zip`)
run('tar', ['-a', '-c', '-f', zip, '-C', rel, 'Pager'])
// install.ps1 checks the zip against this file before it unpacks anything.
writeFileSync(`${zip}.sha256`, `${createHash('sha256').update(readFileSync(zip)).digest('hex')}  ${path.basename(zip)}\n`)
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`
console.log(`done: ${mb(size(out))} unpacked, ${mb(size(zip))} zipped -> ${zip}`)
