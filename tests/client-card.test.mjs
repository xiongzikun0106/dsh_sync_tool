/**
 * Browser-half contract, checked without a browser.
 *
 * `lib/client.js` is a lazy-CJS closure factory, so it can be loaded exactly the
 * way the browser module table loads it: hand it a `window.__ModuleLoader__`
 * and a `require`, then call the factory. React is stubbed just enough to walk
 * the element tree the card produces, which catches render-time crashes and
 * pins the slot registration the Plugins tab depends on.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Load the built bundle the way the client module table does. */
function loadClientModule() {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const effects = []
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) }
    },
    // Hooks return stable values: one deterministic render is all a smoke test needs.
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (callback) => { effects.push(callback) },
  }

  let entry
  const window = { __ModuleLoader__: { load(candidate) { entry = candidate } } }
  const requireShim = (specifier) => {
    if (specifier === 'react') return react
    throw new Error(`the client bundle must not require "${specifier}"`)
  }

  // eslint-disable-next-line no-new-func -- the bundle is the artifact under test
  new Function('window', source)(window)
  assert.ok(entry !== undefined, 'the bundle registered itself with the module loader')
  assert.equal(entry.id, 'dsh-sync-tool')
  assert.equal(typeof entry.factory, 'function')
  return { module: entry.factory(requireShim), effects }
}

/** Render an element tree, invoking function components. */
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(child => render(child)).join('')
  const { type, props, children } = node
  if (typeof type === 'function') return render(type({ ...props, children }))
  return (children ?? []).map(child => render(child)).join('')
}

/**
 * Replace every function-component element with its output, recursively, so the
 * resulting tree can be searched for the host elements nested components created.
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(child => expand(child)).flat(Infinity)
  const { type, props, children } = node
  if (typeof type === 'function') return expand(type({ ...props, children }))
  return { ...node, children: (children ?? []).map(child => expand(child)).flat(Infinity) }
}

/** Find every element matching a predicate. */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, found)
  return found
}

/** A bound settings scope over a fixed snapshot. */
function stubScope(value, status = 'ready') {
  const snapshot = { status, value, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host' }
  const writes = []
  return {
    writes,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: (field, next) => { writes.push({ field, next }); return Promise.resolve() },
    unset: (field) => { writes.push({ field, unset: true }); return Promise.resolve() },
  }
}

/** A client context capturing what the plugin registers. */
function stubClientContext(configScope, statusScope) {
  const bound = []
  const registrations = []
  const injected = []
  const ctx = {
    settingsScope: {
      bind: (spec) => {
        bound.push(spec.namespace)
        return spec.namespace === 'sync-tool-status' ? statusScope : configScope
      },
    },
    slots: {
      inject(name, callback) { injected.push(name); callback() },
      register(options, Component) { registrations.push({ options, Component }); return () => {} },
    },
    remote: {
      $host: { home: 'C:\\Users\\tester\\.dsh' },
      directoryPicker: { pick: async () => 'D:\\picked\\folder' },
    },
  }
  return { ctx, bound, registrations, injected }
}

const AREA = {
  id: 'a1',
  name: 'Plugins',
  path: 'D:\\dsh_sync_tool',
  remote: 'https://example.invalid/me/dsh-sync.git',
  branch: 'main',
  credentialRef: '',
  direction: 'both',
  enabled: true,
  autoCommit: true,
  extraIgnores: [],
  guardSensitive: true,
  nestedRepos: 'init',
}

test('the bundle declares the client plugin and binds both namespaces', () => {
  const { module } = loadClientModule()
  assert.equal(module.name, 'sync-tool-client')
  assert.deepEqual(module.inject, ['slots', 'remote', 'settingsScope'])
  assert.equal(typeof module.apply, 'function')

  const configScope = stubScope({ enabled: true, areas: [] })
  const statusScope = stubScope({ running: false, areas: [], history: [] })
  const { ctx, bound, registrations, injected } = stubClientContext(configScope, statusScope)

  module.apply(ctx)

  assert.deepEqual(bound, ['sync-tool', 'sync-tool-status'], 'both namespaces are bound')
  assert.deepEqual(injected, ['settings.plugin.item'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'settings.plugin.item')
  assert.equal(registrations[0].options.key, 'sync-tool', 'the card pairs with the Host namespace')
  assert.equal(typeof registrations[0].Component, 'function')
})

test('the card renders for an empty configuration', () => {
  const { module } = loadClientModule()
  const configScope = stubScope({ enabled: true, syncOnTurnEnd: true, debounceMs: 5000, areas: [] })
  const statusScope = stubScope({ running: false, areas: [], history: [] })
  const { ctx, registrations } = stubClientContext(configScope, statusScope)
  module.apply(ctx)

  const props = registrations[0].options.inject()
  assert.ok(props.configScope !== undefined && props.statusScope !== undefined)
  assert.equal(typeof props.pickDirectory, 'function')
  assert.equal(props.presetsPath, 'C:\\Users\\tester\\.dsh\\.agent-presets')

  const text = render(registrations[0].Component(props))
  assert.match(text, /工作区域 Git 同步/u)
  assert.match(text, /还没有工作区域/u)
  assert.match(text, /选择目录并添加/u)
  assert.match(text, /暂无同步历史/u)
})

test('the card renders configured areas with their state', () => {
  const { module } = loadClientModule()
  const configScope = stubScope({ enabled: true, areas: [AREA] })
  const statusScope = stubScope({
    running: false,
    areas: [{
      id: 'a1',
      status: 'ok',
      at: 1789302227110,
      detail: '已同步',
      head: '29bcb36c8d7255b690e4873dca63ccc74d52be99',
      ahead: 0,
      behind: 0,
    }],
    history: [{ at: 1789302227110, areaId: 'a1', ok: true, summary: 'Plugins · 已同步' }],
  })
  const { ctx, registrations } = stubClientContext(configScope, statusScope)
  module.apply(ctx)

  const card = registrations[0].Component(registrations[0].options.inject())
  const text = render(card)
  assert.match(text, /D:\\dsh_sync_tool/u, 'the folder path is shown')
  assert.match(text, /已同步/u, 'the area status is shown')
  assert.match(text, /Plugins · 已同步/u, 'history is shown')
  assert.match(text, /工作区域（1）/u)

  // Field values live in input props, not in text children.
  const values = findAll(expand(card), node => node.type === 'input').map(node => node.props.value)
  assert.ok(
    values.includes('https://example.invalid/me/dsh-sync.git'),
    `the remote input holds the URL, got ${JSON.stringify(values)}`,
  )
  assert.ok(values.includes('main'), 'the branch input holds the branch')
})

test('add and import write the expected settings fields', async () => {
  const { module } = loadClientModule()
  const configScope = stubScope({ enabled: true, areas: [] })
  const statusScope = stubScope({ running: false, areas: [], history: [] })
  const { ctx, registrations } = stubClientContext(configScope, statusScope)
  module.apply(ctx)

  const card = registrations[0].Component(registrations[0].options.inject())
  const buttons = findAll(expand(card), node => node.type === 'button')

  // The picker button goes through the directory-picker Remote.
  const pickButton = buttons.find(node => render(node).includes('选择目录并添加'))
  assert.ok(pickButton !== undefined, 'the pick button rendered')
  await pickButton.props.onClick()
  await Promise.resolve()
  const added = configScope.writes.find(write => write.field === 'areas')
  assert.ok(added !== undefined, 'an area write happened')
  assert.equal(added.next.length, 1)
  assert.equal(added.next[0].path, 'D:\\picked\\folder')
  assert.equal(added.next[0].name, 'folder')
  assert.equal(added.next[0].direction, 'both')
  assert.equal(added.next[0].nestedRepos, 'init')

  // The import button issues an import request carrying the picked path.
  const importButton = buttons.find(node => render(node).includes('从仓库导入'))
  assert.ok(importButton !== undefined, 'the import button rendered')
  await importButton.props.onClick()
  await Promise.resolve()
  const request = configScope.writes.filter(write => write.field === 'request').at(-1)
  assert.equal(request.next.kind, 'import')
  assert.equal(request.next.areaId, 'D:\\picked\\folder')
  assert.ok(request.next.token >= 1)
})

test('a settings snapshot that is loading still renders', () => {
  const { module } = loadClientModule()
  const configScope = stubScope(undefined, 'loading')
  const statusScope = stubScope(undefined, 'loading')
  const { ctx, registrations } = stubClientContext(configScope, statusScope)
  module.apply(ctx)
  const text = render(registrations[0].Component(registrations[0].options.inject()))
  assert.match(text, /读取状态中/u)
  assert.match(text, /工作区域 Git 同步/u)
})

test('a card with no directory picker still offers manual entry', () => {
  const { module } = loadClientModule()
  const configScope = stubScope({ enabled: true, areas: [] })
  const statusScope = stubScope({ running: false, areas: [], history: [] })
  const { ctx, registrations } = stubClientContext(configScope, statusScope)
  // A composition without the picker backend: the Remote namespace is absent.
  ctx.remote = { $host: { home: undefined } }
  module.apply(ctx)

  const props = registrations[0].options.inject()
  assert.equal(props.presetsPath, undefined, 'no home means no quick-add path')
  const text = render(registrations[0].Component(props))
  assert.match(text, /添加路径/u, 'manual entry is always available')
  assert.match(text, /选择目录并添加/u)
})
