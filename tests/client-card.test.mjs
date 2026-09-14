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

/**
 * Load the built bundle the way the client module table does.
 * @param reactOverride - stub React to inject; defaults to the stateless one.
 *   `statefulReact()` below adds real state so a click can be followed.
 */
function loadClientModule(reactOverride) {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const effects = []
  const react = reactOverride ?? {
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

/**
 * A stub React whose `useState` really holds state, so a click handler can be
 * invoked and the component re-rendered to observe the result. Hook slots are
 * keyed by call order, so only the top-level component under test may use hooks
 * (every component this plugin renders below it is deliberately hook-free).
 */
function statefulReact() {
  let slots = []
  let cursor = 0
  return {
    react: {
      createElement(type, props, ...children) {
        return { type, props: props ?? {}, children: children.flat(Infinity) }
      },
      useState(initial) {
        const index = cursor
        cursor += 1
        if (!(index in slots)) {
          slots[index] = typeof initial === 'function' ? initial() : initial
        }
        return [slots[index], (next) => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next
        }]
      },
      // Consumes a slot, like React, so call order stays faithful.
      useEffect() { cursor += 1 },
    },
    /** Render the top-level component with a fresh hook cursor. */
    render(Component, props) {
      cursor = 0
      return Component(props)
    },
  }
}

/** The settings card registration (keyed by the config namespace). */
function cardOf(registrations) {
  const entry = registrations.find(candidate => candidate.options.name === 'settings.plugin.item')
  assert.ok(entry !== undefined, 'the card registered into the Plugins settings tab')
  return entry
}

/** The header status-indicator registration. */
function indicatorOf(registrations) {
  const entry = registrations.find(
    candidate => candidate.options.name === 'conversation.session.header.utilities',
  )
  assert.ok(entry !== undefined, 'the status indicator registered into the header utilities seat')
  return entry
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

test('the bundle declares the client plugin, binds both namespaces, and makes two contributions', () => {
  const { module } = loadClientModule()
  assert.equal(module.name, 'sync-tool-client')
  assert.deepEqual(module.inject, ['slots', 'remote', 'settingsScope'])
  assert.equal(typeof module.apply, 'function')

  const configScope = stubScope({ enabled: true, areas: [] })
  const statusScope = stubScope({ running: false, areas: [], history: [] })
  const { ctx, bound, registrations, injected } = stubClientContext(configScope, statusScope)

  module.apply(ctx)

  assert.deepEqual(bound, ['sync-tool', 'sync-tool-status'], 'both namespaces are bound')
  // One card in the Plugins tab, one badge in the conversation header.
  assert.deepEqual(injected, ['settings.plugin.item', 'conversation.session.header.utilities'])
  assert.equal(registrations.length, 2)

  const card = cardOf(registrations)
  assert.equal(card.options.name, 'settings.plugin.item')
  assert.equal(card.options.key, 'sync-tool', 'the card pairs with the Host namespace')
  assert.equal(typeof card.Component, 'function')

  const indicator = indicatorOf(registrations)
  assert.equal(indicator.options.id, 'sync-tool-status', 'a list seat identifies entries by id')
  assert.equal(typeof indicator.options.order, 'number', 'a list seat orders entries')
  assert.equal(indicator.options.key, undefined, 'a list seat does not use the keyed-slot key')
  assert.equal(typeof indicator.Component, 'function')
})

test('the card renders for an empty configuration', () => {
  const { module } = loadClientModule()
  const configScope = stubScope({ enabled: true, syncOnTurnEnd: true, debounceMs: 5000, areas: [] })
  const statusScope = stubScope({ running: false, areas: [], history: [] })
  const { ctx, registrations } = stubClientContext(configScope, statusScope)
  module.apply(ctx)

  const props = cardOf(registrations).options.inject()
  assert.ok(props.configScope !== undefined && props.statusScope !== undefined)
  assert.equal(typeof props.pickDirectory, 'function')
  assert.equal(props.presetsPath, 'C:\\Users\\tester\\.dsh\\.agent-presets')

  const text = render(cardOf(registrations).Component(props))
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

  const card = cardOf(registrations).Component(cardOf(registrations).options.inject())
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

  const card = cardOf(registrations).Component(cardOf(registrations).options.inject())
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
  const text = render(cardOf(registrations).Component(cardOf(registrations).options.inject()))
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

  const props = cardOf(registrations).options.inject()
  assert.equal(props.presetsPath, undefined, 'no home means no quick-add path')
  const text = render(cardOf(registrations).Component(props))
  assert.match(text, /添加路径/u, 'manual entry is always available')
  assert.match(text, /选择目录并添加/u)
})

// ---------------------------------------------------------------------------
// Header status indicator
// ---------------------------------------------------------------------------

/** A configured work area as the config namespace stores it. */
const INDICATOR_AREA = {
  id: 'a1',
  name: 'Plugins',
  path: 'D:\\dsh_sync_tool',
  remote: 'https://example.invalid/me/dsh-sync.git',
  branch: 'main',
  direction: 'both',
  enabled: true,
}

/**
 * Load the bundle, apply it, and hand back the header indicator ready to render.
 * @param options - config/status documents, scope sync state, and whether to use
 *   the stateful React (required for following a click).
 */
function mountIndicator(options = {}) {
  const harness = options.stateful === true ? statefulReact() : undefined
  const { module } = loadClientModule(harness === undefined ? undefined : harness.react)
  const scopeStatus = options.scopeStatus ?? 'ready'
  const configScope = stubScope(options.config, scopeStatus)
  const statusScope = stubScope(options.status, scopeStatus)
  const { ctx, registrations } = stubClientContext(configScope, statusScope)
  module.apply(ctx)

  const entry = indicatorOf(registrations)
  const props = entry.options.inject()
  const renderWith = extra => (harness === undefined
    ? entry.Component({ ...props, ...extra })
    : harness.render(entry.Component, { ...props, ...extra }))

  return { entry, props, renderWith, configScope, statusScope }
}

test('the indicator takes both scopes so it can name areas it reports on', () => {
  const { props } = mountIndicator({
    config: { areas: [INDICATOR_AREA] },
    status: { running: false, areas: [], history: [] },
  })
  // The status document carries only { id, status, at, detail, head, ahead,
  // behind } — no name or path — so names must come from the config scope.
  assert.ok(props.configScope !== undefined, 'the config scope supplies area names and paths')
  assert.ok(props.statusScope !== undefined, 'the status scope supplies observed state')
})

test('the indicator labels every overall state', () => {
  const healthy = {
    running: false,
    updatedAt: 1789302227110,
    areas: [{ id: 'a1', status: 'ok', at: 1, detail: '', head: '', ahead: 0, behind: 0 }],
    history: [{ at: 1, areaId: 'a1', ok: true, summary: 'Plugins · 已同步' }],
  }
  const cases = [
    {
      name: 'a loading scope is neutral',
      scopeStatus: 'loading',
      config: { areas: [] },
      status: { areas: [], history: [] },
      expect: /读取中/u,
    },
    {
      name: 'an unavailable scope is neutral',
      scopeStatus: 'unavailable',
      config: { areas: [] },
      status: { areas: [], history: [] },
      expect: /不可用/u,
    },
    {
      name: 'no work area is neutral, never an error',
      config: { areas: [] },
      status: { running: false, areas: [], history: [] },
      expect: /未配置/u,
    },
    {
      name: 'a pass in flight reads as syncing',
      config: { areas: [INDICATOR_AREA] },
      status: { running: true, areas: [], history: [] },
      expect: /同步中/u,
    },
    {
      name: 'a conflict outranks a healthy sibling',
      config: { areas: [INDICATOR_AREA] },
      status: {
        running: false,
        areas: [
          { id: 'a1', status: 'ok', at: 1, detail: '', head: '', ahead: 0, behind: 0 },
          { id: 'a2', status: 'conflict', at: 2, detail: '冲突', head: '', ahead: 0, behind: 0 },
        ],
        history: [],
      },
      expect: /冲突/u,
    },
    {
      name: 'an error is reported',
      config: { areas: [INDICATOR_AREA] },
      status: {
        running: false,
        areas: [{ id: 'a1', status: 'error', at: 2, detail: 'git push 失败', head: '', ahead: 0, behind: 0 }],
        history: [],
      },
      expect: /错误/u,
    },
    {
      name: 'a healthy sync reads as synced',
      config: { areas: [INDICATOR_AREA] },
      status: healthy,
      expect: /已同步/u,
    },
    {
      name: 'nothing attempted yet is idle',
      config: { areas: [INDICATOR_AREA] },
      status: {
        running: false,
        areas: [{ id: 'a1', status: 'idle', at: 0, detail: '', head: '', ahead: 0, behind: 0 }],
        history: [],
      },
      expect: /待同步/u,
    },
  ]

  for (const item of cases) {
    const { renderWith } = mountIndicator({
      config: item.config,
      status: item.status,
      ...item.scopeStatus === undefined ? {} : { scopeStatus: item.scopeStatus },
    })
    const tree = renderWith()
    const buttons = findAll(expand(tree), node => node.type === 'button')
    assert.equal(buttons.length, 1, `${item.name}: only the collapsed badge renders`)
    assert.match(render(buttons[0]), item.expect, item.name)
    // The machine-readable state rides alongside the copy.
    const badge = findAll(expand(tree), node => node.props['data-sync-status'] !== undefined)[0]
    assert.ok(badge !== undefined, `${item.name}: the badge carries its state`)
  }
})

test('clicking the indicator expands per-area detail, HEAD, ahead/behind and history', () => {
  const { renderWith } = mountIndicator({
    stateful: true,
    config: { areas: [INDICATOR_AREA] },
    status: {
      running: false,
      updatedAt: 1789302227110,
      areas: [{
        id: 'a1',
        status: 'error',
        at: 1789302227110,
        detail: 'git push 失败（检查远端地址、网络或凭据）：认证被拒绝',
        head: '29bcb36c8d7255b690e4873dca63ccc74d52be99',
        ahead: 2,
        behind: 1,
      }],
      history: [
        { at: 1789302227110, areaId: 'a1', ok: false, summary: 'Plugins · git push 失败：认证被拒绝' },
        { at: 1789302000000, areaId: 'a1', ok: true, summary: 'Plugins · 已提交 · 已同步' },
      ],
    },
  })

  // Collapsed to start: the badge only.
  let tree = renderWith()
  assert.doesNotMatch(render(tree), /最近历史/u, 'the detail panel is closed initially')
  const badge = findAll(expand(tree), node => node.type === 'button')[0]
  assert.equal(badge.props['aria-expanded'], 'false')
  assert.equal(badge.props.onClick === undefined, false, 'the badge is clickable')

  // Click it.
  badge.props.onClick()
  tree = renderWith()
  const text = render(tree)
  assert.match(text, /同步状态/u, 'the panel title appears')
  assert.match(text, /Plugins/u, 'the area name is joined in from the config scope')
  assert.match(text, /错误/u, 'the area status is shown')
  assert.match(text, /HEAD 29bcb36c8d/u, 'the HEAD is shortened for display')
  assert.match(text, /↑2 ↓1/u, 'ahead and behind are shown')
  assert.match(text, /认证被拒绝/u, 'the failure reason is shown')
  assert.match(text, /最近历史/u, 'history is shown')
  assert.match(text, /Plugins · git push 失败/u, 'a failed history entry is listed')
  assert.match(text, /已提交 · 已同步/u, 'a successful history entry is listed')

  // The badge now reports itself as expanded.
  const openBadge = findAll(expand(tree), node => node.props['aria-expanded'] !== undefined)[0]
  assert.equal(openBadge.props['aria-expanded'], 'true')

  // The close control collapses it again.
  const close = findAll(expand(tree), node => node.type === 'button')
    .find(node => node.props.title === '收起')
  assert.ok(close !== undefined, 'the panel renders a close control')
  close.props.onClick()
  assert.doesNotMatch(render(renderWith()), /最近历史/u, 'closing hides the panel')
})

test('the expanded panel with no configured area points at the card', () => {
  const { renderWith } = mountIndicator({
    stateful: true,
    config: { areas: [] },
    status: { running: false, areas: [], history: [] },
  })
  const tree = renderWith()
  findAll(expand(tree), node => node.type === 'button')[0].props.onClick()
  const text = render(renderWith())
  assert.match(text, /还没有工作区域/u)
  assert.match(text, /sync-tool 卡片/u, 'it tells the operator where to configure one')
})

test('the panel omits history when none has been recorded', () => {
  const { renderWith } = mountIndicator({
    stateful: true,
    config: { areas: [INDICATOR_AREA] },
    status: {
      running: false,
      areas: [{ id: 'a1', status: 'ok', at: 5, detail: '已同步', head: 'abc1234567', ahead: 0, behind: 0 }],
      history: [],
    },
  })
  const tree = renderWith()
  findAll(expand(tree), node => node.type === 'button')[0].props.onClick()
  const text = render(renderWith())
  assert.match(text, /已同步/u)
  assert.doesNotMatch(text, /最近历史/u, 'no history section without entries')
})
