// Rebuilds desktop/renderer/vendor/files/ (CodeMirror 6, marked + DOMPurify + KaTeX + Mermaid, pdf.js) with esbuild.
// Dependencies are NOT installed in the repo: from a scratch folder run
//   npm i --prefix %TEMP%/vend-files esbuild @codemirror/{state,view,language,commands,search,autocomplete,legacy-modes,lang-javascript,lang-json,lang-css,lang-html,lang-xml,lang-markdown,lang-python,lang-rust,lang-cpp,lang-java,lang-go,lang-php,lang-sql,lang-yaml} @lezer/highlight marked dompurify katex mermaid pdfjs-dist
//   node desktop/vendor-src/files/build.mjs %TEMP%/vend-files
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = path.resolve(process.argv[2] || path.join(process.env.TEMP || '/tmp', 'vend-files'))
const nm = path.join(scratch, 'node_modules')
const out = path.resolve(here, '..', '..', 'renderer', 'vendor', 'files')
const require = createRequire(path.join(scratch, 'x.js'))
const esbuild = require('esbuild')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const common = {
  bundle: true, format: 'esm', minify: true, target: 'chrome130', legalComments: 'none', nodePaths: [nm], logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
}
await esbuild.build({
  ...common,
  entryPoints: { cm: path.join(here, 'cm.js'), md: path.join(here, 'md.js'), pdf: path.join(here, 'pdf.js') },
  outdir: out, splitting: true, chunkNames: 'chunks/[name]-[hash]',
})
await esbuild.build({ ...common, entryPoints: { 'pdf.worker': path.join(nm, 'pdfjs-dist', 'build', 'pdf.worker.mjs') }, outdir: out })

// KaTeX stylesheet with woff2 only.
const kdist = path.join(nm, 'katex', 'dist')
mkdirSync(path.join(out, 'katex', 'fonts'), { recursive: true })
let css = readFileSync(path.join(kdist, 'katex.min.css'), 'utf8')
css = css.replace(/,url\([^)]*\.woff\) format\("woff"\)/g, '').replace(/,url\([^)]*\.ttf\) format\("truetype"\)/g, '')
writeFileSync(path.join(out, 'katex', 'katex.css'), css)
for (const f of readdirSync(path.join(kdist, 'fonts'))) if (f.endsWith('.woff2')) cpSync(path.join(kdist, 'fonts', f), path.join(out, 'katex', 'fonts', f))

// pdf.js standard fonts / cmaps are read lazily by the worker; ship the small ones.
for (const d of ['cmaps', 'standard_fonts']) if (existsSync(path.join(nm, 'pdfjs-dist', d))) cpSync(path.join(nm, 'pdfjs-dist', d), path.join(out, 'pdf-' + d), { recursive: true })

const lic = ['@codemirror/view', '@lezer/common', 'marked', 'dompurify', 'katex', 'mermaid', 'pdfjs-dist']
  .map((p) => {
    const f = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].map((n) => path.join(nm, p, n)).find(existsSync)
    return `==== ${p} ====\n${f ? readFileSync(f, 'utf8') : '(see package)'}`
  }).join('\n\n')
writeFileSync(path.join(out, 'LICENSES.txt'), 'Bundled by desktop/vendor-src/files/build.mjs. Each package keeps its own licence (MIT / Apache-2.0 / MPL-2.0).\n\n' + lic)
console.log('built', pathToFileURL(out).href)
