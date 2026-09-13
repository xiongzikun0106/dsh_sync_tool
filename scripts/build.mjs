/**
 * Build the artifacts the DSH loader and the web client consume.
 *
 *  - `lib/*.js`      — the Host half, copied from `src/host/*.js`. The entry is
 *    `src/host/index.js`; sibling modules keep working through relative imports.
 *  - `lib/client.js` — the browser half, wrapped in the lazy-CJS closure
 *    factory the client module table expects:
 *
 *        window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 *    The wrapper is reproduced here because the monorepo's `clientBundle`
 *    tsdown preset is not published; the format is the whole contract, and
 *    the banner/footer/intro below mirror it exactly.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageId = 'dsh-sync-tool'

/** Indent every non-empty line so the emitted factory stays readable. */
function indent(source, tabs) {
  const pad = '\t'.repeat(tabs)
  return source
    .replace(/\s+$/, '')
    .split('\n')
    .map(line => (line.length === 0 ? line : pad + line))
    .join('\n')
}

const hostDir = join(root, 'src', 'host')
await mkdir(join(root, 'lib'), { recursive: true })

const hostFiles = (await readdir(hostDir)).filter(name => name.endsWith('.js')).sort()
let hostBytes = 0
for (const name of hostFiles) {
  const source = await readFile(join(hostDir, name), 'utf8')
  await writeFile(join(root, 'lib', name), source)
  hostBytes += source.length
}

const clientSource = await readFile(join(root, 'src', 'client', 'index.js'), 'utf8')

const clientBundle = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(packageId)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  indent(clientSource, 2),
  '\t\treturn module.exports;',
  '\t} });',
  '',
].join('\n')

await writeFile(join(root, 'lib', 'client.js'), clientBundle)

console.log(`built lib/${hostFiles.join(', lib/')} (${hostBytes} B) and lib/client.js (${clientBundle.length} B)`)

