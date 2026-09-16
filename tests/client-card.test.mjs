/**
 * Browser-half contract, checked without a browser.
 *
 * `lib/client.js` is a lazy-CJS closure factory, so it is loaded exactly the way
 * the browser module table loads it: hand it a `window.__ModuleLoader__` and a
 * `require`, then call the factory.
 *
 * The React stub below is a miniature renderer rather than a one-shot shim: it
 * owns hook frames (so `useState` really holds state, `useRef` really holds a
 * mutable box, and `useEffect` runs after the commit), renders the whole
 * component tree, and re-renders while a setter marks it dirty. That is what
 * lets a test click the real primitives' `Switch`, type into the real inputs,
 * and then read the settings writes the component produced. The primitives
 * package is stubbed with the same fidelity, so no assertion depends on a CSS
 * module or on layout geometry.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// ---------------------------------------------------------------------------
// A hook-aware React stub
// ---------------------------------------------------------------------------

/**
 * Create the React stub plus its render loop.
 *
 * Hook state is keyed by each component's position in the tree, not by a
 * transient call frame. That is what lets a test render the same component a
 * second time (after a click) with a freshly built element tree and still find
 * the state, refs, and effect guards where React would have left them.
 *
 * @returns `{ react, render }` — `render` returns the committed tree.
 */
function createHarness() {
  // componentId -> { slots: unknown[], dirty: boolean }
  const store = new Map()
  let mount = 0
  let freshMount = false
  let componentPath = 'root'
  let slotCursor = 0
  let effects = []
  let pending = false

  /** Mark the component whose hook just ran dirty, so the loop renders again. */
  const invalidate = (ownerPath) => {
    const frame = store.get(ownerPath)
    if (frame !== undefined) frame.dirty = true
    pending = true
  }

  const react = {
    createElement(type, props, ...children) {
      const flat = children
        .flat(Infinity)
        .filter(child => child !== null && child !== undefined && typeof child !== 'boolean')
      return { type, props: props ?? {}, children: flat }
    },
    useState(initial) {
      const index = slotCursor
      // The setter must remember which component owns it: by the time a click
      // calls it, rendering is over and `componentPath` is back at the root.
      const owner = componentPath
      slotCursor += 1
      const frame = store.get(owner) ?? { slots: [], dirty: false }
      if (!(index in frame.slots)) {
        frame.slots[index] = typeof initial === 'function' ? initial() : initial
      }
      return [frame.slots[index], (next) => {
        frame.slots[index] = typeof next === 'function' ? next(frame.slots[index]) : next
        invalidate(owner)
      }]
    },
    useRef(initial) {
      const index = slotCursor
      slotCursor += 1
      const frame = store.get(componentPath) ?? { slots: [], dirty: false }
      if (!(index in frame.slots)) frame.slots[index] = { current: initial }
      return frame.slots[index]
    },
    useMemo(factory) {
      // No dependency tracking: the stubbed primitives never need a cached value.
      slotCursor += 1
      return factory()
    },
    useEffect(callback, deps) {
      const index = slotCursor
      slotCursor += 1
      const frame = store.get(componentPath) ?? { slots: [], dirty: false }
      const previous = frame.slots[index]
      // React's dependency rule, so an effect owned by a pure component (the
      // probe request) does not re-fire on every unrelated render.
      const changed = previous === undefined
        || !Array.isArray(deps)
        || !Array.isArray(previous.deps)
        || deps.length !== previous.deps.length
        || deps.some((value, position) => !Object.is(value, previous.deps[position]))
      if (!changed) return
      frame.slots[index] = { deps }
      effects.push(callback)
    },
    useLayoutEffect() {},
  }

  /** Render each collected effect, keeping the cleanups in the queue. */
  const flushEffects = () => {
    while (effects.length > 0) {
      const queue = effects
      effects = []
      for (const callback of queue) {
        const cleanup = callback()
        if (typeof cleanup === 'function') effects.push(cleanup)
      }
    }
  }

  /** Render one node, giving every function component its own hook store entry. */
  const renderNode = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map(child => renderNode(child))
    const type = node.type
    const props = { ...node.props, children: node.children }
    if (typeof type === 'function') {
      const name = typeof type.name === 'string' && type.name !== '' ? type.name : 'Anonymous'
      const previousPath = componentPath
      const previousCursor = slotCursor
      componentPath = `${previousPath}>${name}`
      slotCursor = 0
      if (!store.has(componentPath)) store.set(componentPath, { slots: [], dirty: false })
      let output
      try {
        output = renderNode(type(props))
      } finally {
        componentPath = previousPath
        slotCursor = previousCursor
      }
      return output
    }
    return {
      type,
      props,
      children: node.children.map(child => renderNode(child)).filter(child => child !== null),
    }
  }

  /** Attach an element's `ref`, the way React does after creating the element. */
  const attachRef = (element) => {
    if (element !== null && typeof element === 'object' && !Array.isArray(element)) {
      const ref = element.props.ref
      if (ref !== undefined && ref !== null) ref.current = element
    }
    return element
  }

  /** Attach refs across a whole committed tree, innermost elements included. */
  const attachRefs = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) {
      for (const child of node) attachRefs(child)
      return node
    }
    attachRef(node)
    for (const child of node.children ?? []) attachRefs(child)
    return node
  }

  return {
    react,
    /**
     * Start one isolated mount. Hook state from a previous mount must not leak
     * in, exactly as a remounted component in a real browser starts fresh, but
     * every later `render` on the same mount keeps its state so a test can
     * click something and then re-render to observe the result.
     */
    beginMount() {
      store.clear()
      mount += 1
      freshMount = true
    },
    render(Component, props) {
      const node = react.createElement(Component, props)
      if (freshMount) freshMount = false
      const root = `m${mount}`
      let current = node
      let step = 0
      while (step < 60) {
        step += 1
        pending = false
        for (const frame of store.values()) frame.dirty = false
        // Render first: this pass is what expands the element tree, and it is
        // where the effects are collected.
        componentPath = root
        slotCursor = 0
        current = renderNode(node)
        attachRefs(current)
        flushEffects()
        // A setter called during the commit (or by the test's click before this
        // render) must be reflected in the tree this call returns.
        if (pending !== true && ![...store.values()].some(frame => frame.dirty === true)) break
      }
      // Drop the collected cleanups: no test unmounts the tree.
      effects = []
      return current
    },
  }
}

// ---------------------------------------------------------------------------
// The primitives stub
// ---------------------------------------------------------------------------

/** Readable text of a rendered tree. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

/** Every element in a rendered tree matching a predicate. */
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

/**
 * The harness whose `react` the primitives stub renders through. One instance
 * is shared by every test so the stub's own components are the very components
 * the render loop knows how to drive.
 */
const harness = createHarness()

/**
 * Build the `@deepseek-ai/dsh-client-ui-primitives` stub.
 * @param clipboard - an array the `writeClipboard` stub records into.
 * @returns the module object the bundle's `require` returns.
 */
function primitivesStub(clipboard) {
  const React = harness.react
  const passthrough = name => function Stub(props) {
    return React.createElement('div', { 'data-primitive': name, ...props }, props.children)
  }
  return {
    Button: function StubButton(props) {
      return React.createElement('button', {
        type: 'button',
        'data-primitive': 'Button',
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, props.icon, props.children)
    },
    Input: passthrough('Input'),
    Switch: function StubSwitch(props) {
      return React.createElement('button', {
        type: 'button',
        role: 'switch',
        'data-primitive': 'Switch',
        'aria-checked': props.checked === true,
        'aria-label': props.label,
        disabled: props.disabled === true,
        title: props.title,
        onClick: () => { props.onChange(props.checked !== true) },
      }, props.label)
    },
    Pill: passthrough('Pill'),
    Tag: function StubTag(props) {
      return React.createElement('span', { 'data-primitive': 'Tag', 'data-tone': props.tone }, props.children)
    },
    StateDot: function StubStateDot(props) {
      return React.createElement('span', {
        'data-primitive': 'StateDot',
        'data-state': props.state,
        'data-size': props.size,
      })
    },
    Tooltip: function StubTooltip(props) {
      return React.createElement('span', { 'data-primitive': 'Tooltip', title: props.label }, props.children)
    },
    DisclosureRow: function StubDisclosureRow(props) {
      return React.createElement(
        'div',
        { 'data-primitive': 'DisclosureRow' },
        React.createElement('span', null, props.title),
        props.open === true ? props.children : null,
      )
    },
    useAnchoredPosition: () => null,
    useAnchoredMaxHeight: () => undefined,
    useDismissOnOutsidePointer: () => {},
    writeClipboard: (text) => { clipboard.push(text); return Promise.resolve(true) },
    relativeTime: () => ({ unit: 'minutes', n: 5 }),
    // Every icon exports as an empty component, so a real icon name in the
    // bundle can never crash the stub.
    IconBranchOutline16: () => null,
    IconSettingsOutline16: () => null,
    IconCopyOutline16: () => null,
    IconFolderOpenOutline16: () => null,
    IconRefreshOutline16: () => null,
  }
}

/**
 * Load the built bundle the way the client module table does.
 * @param options - the config and status scopes the two namespaces bind to.
 * @returns the module, its registrations, and the harness that rendered it.
 */
function mountClient(options = {}) {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const clipboard = []
  const primitives = primitivesStub(clipboard)
  const specifiers = []

  const requireShim = (specifier) => {
    specifiers.push(specifier)
    if (specifier === 'react') return harness.react
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    if (specifier === 'react-dom') return { createPortal: node => node }
    throw new Error(`the client bundle must not require "${specifier}"`)
  }

  let entry
  const window = { __ModuleLoader__: { load(candidate) { entry = candidate } } }
  // eslint-disable-next-line no-new-func -- the bundle is the artifact under test
  new Function('window', source)(window)
  assert.ok(entry !== undefined, 'the bundle registered itself with the module loader')
  assert.equal(entry.id, 'dsh-sync-tool')
  assert.equal(typeof entry.factory, 'function')

  const module = entry.factory(requireShim)
  const registrations = []
  const bound = []
  const injected = []
  const ctx = {
    settingsScope: {
      bind: (spec) => {
        bound.push(spec.namespace)
        return spec.namespace === 'sync-tool-status' ? options.statusScope : options.configScope
      },
    },
    slots: {
      inject(name, callback) { injected.push(name); callback() },
      register(registration, Component) { registrations.push({ options: registration, Component }); return () => {} },
    },
  }
  module.apply(ctx)
  // Every mounted client is its own app instance: start it with a clean hook
  // store so no earlier test's state can be read back here.
  harness.beginMount()

  return { module, harness, registrations, bound, injected, clipboard, specifiers }
}

/**
 * A bound settings scope over a fixed snapshot, recording every write.
 *
 * A write also lands in the snapshot, because the surfaces here paint
 * optimistically: the card and the panel re-render from the document they just
 * wrote, and that is what the user sees while the Host round-trips.
 *
 * @param initial - the settings document to start from.
 * @param status - the snapshot's transport status.
 * @returns the scope plus its recorded `writes`.
 */
function stubScope(initial, status = 'ready') {
  const writes = []
  const snapshot = {
    status,
    value: initial,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const set = (field, next) => {
    writes.push({ field, next })
    const current = snapshot.value
    snapshot.value = current !== null && typeof current === 'object' ? { ...current, [field]: next } : { [field]: next }
    snapshot.revision += 1
    return Promise.resolve()
  }
  return {
    writes,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set,
    unset: (field) => {
      writes.push({ field, unset: true })
      return Promise.resolve()
    },
  }
}

/**
 * Accept either a raw settings document or an already-built scope, so a test
 * can read the writes from the very scope the component was given.
 * @param candidate - a document or a scope.
 * @returns a scope.
 */
function asScope(candidate) {
  return candidate !== null && typeof candidate === 'object' && typeof candidate.set === 'function'
    ? candidate
    : stubScope(candidate)
}

/** The workspace registration. */
function cardOf(registrations) {
  const entry = registrations.find(candidate => candidate.options.name === 'settings.plugin.item')
  assert.ok(entry !== undefined, 'the card registered into the Plugins settings tab')
  return entry
}

/** The header control registration. */
function buttonOf(registrations) {
  const entry = registrations.find(candidate => candidate.options.name === 'conversation.session.header.utilities')
  assert.ok(entry !== undefined, 'the header control registered into the utilities seat')
  return entry
}

/** Find the one element matching a predicate, asserting it exists. */
function findOne(node, predicate, message) {
  const found = findAll(node, predicate)
  assert.ok(found.length > 0, message)
  return found[0]
}

/** Find the buttons whose rendered text contains a phrase. */
function buttonsWithText(node, phrase) {
  return findAll(node, element => element.type === 'button' && textOf(element).includes(phrase))
}

/** The folder the header control resolves for the seeded session. */
const WORKSPACE_PATH = 'D:\\work\\dsh_sync_tool'

/** One `WorkspaceView` as the Workspace UI publishes it. */
const WORKSPACE_VIEW = {
  workspaceId: 'w1',
  path: WORKSPACE_PATH,
  title: 'Plugins',
  sessionIds: ['s1'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

/** The framework's standard session props, all present. */
function sessionProps(overrides = {}) {
  return {
    sessionId: overrides.sessionId ?? 's1',
    useWorkspaces: overrides.useWorkspaces ?? (selector => selector({ items: overrides.items ?? [WORKSPACE_VIEW] })),
    useSessions: overrides.useSessions ?? (selector => selector({ byId: { s1: { cwd: WORKSPACE_PATH } } })),
    useSession: overrides.useSession ?? (selector => selector({ openState: 'open', running: false, blank: false })),
  }
}

/**
 * A standard selector hook over a fixed state, resolving however the component
 * calls it. Cordis' `useSession`/`useWorkspaces` always hand back the selected
 * value, but a stub that ignored its `selector` argument would silently return
 * the whole state, so this one applies the selector either way.
 * @param state - the state a real hook would select from.
 * @returns the hook function.
 */
function selectorHook(state) {
  const hook = (selectorOrAbsent) => {
    if (typeof selectorOrAbsent !== 'function') return state
    const selected = selectorOrAbsent(state)
    return typeof selected === 'function' ? selected(state) : selected
  }
  return hook
}

/** Mount the header control over a config/status document or scope. */
function mountButton(config, status) {
  const configScope = asScope(config)
  const statusScope = asScope(status)
  const mounted = mountClient({ configScope, statusScope })
  const entry = buttonOf(mounted.registrations)
  const injected = entry.options.inject()
  const renderWith = extra => mounted.harness.render(entry.Component, { ...injected, ...sessionProps(extra), ...extra })
  return { ...mounted, entry, configScope, statusScope, renderWith }
}

/** Mount the card over a config/status document or scope. */
function mountCard(config, status) {
  const configScope = asScope(config)
  const statusScope = asScope(status)
  const mounted = mountClient({ configScope, statusScope })
  const entry = cardOf(mounted.registrations)
  const injected = entry.options.inject()
  const renderCard = props => mounted.harness.render(entry.Component, { ...injected, ...props })
  return { ...mounted, entry, configScope, statusScope, renderCard }
}

/**
 * The last write to one config field, or undefined.
 * @param scope - the recording scope.
 * @param field - the settings field.
 * @returns the recorded write.
 */
function lastWrite(scope, field) {
  return scope.writes.filter(write => write.field === field).at(-1)
}

/**
 * Click something that saves before it requests, then let the write chain
 * settle. `保存并同步` writes the workspace first and bumps the request channel
 * second, so a synchronous assertion would see only the first write.
 * @param element - the element whose `onClick` to invoke.
 * @returns a promise for the settled write chain.
 */
async function clickSettled(element) {
  element.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * Open the header control's panel and return the tree with it open.
 * @param renderWith - the mount's renderer.
 * @returns the committed tree.
 */
function openPanel(renderWith) {
  const closed = renderWith({})
  findOne(closed, node => node.props['aria-expanded'] !== undefined, 'the trigger rendered').props.onClick()
  return renderWith({})
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('the bundle declares the client plugin and makes exactly two contributions', () => {
  const { module } = mountClient({ configScope: stubScope({}), statusScope: stubScope({}) })
  assert.equal(module.name, 'sync-tool-client')
  assert.deepEqual(module.inject, ['slots', 'settingsScope'])
  assert.equal(typeof module.apply, 'function')
})

test('both slots register with their contract options', () => {
  const mounted = mountClient({
    configScope: stubScope({ enabled: true, workspaces: [] }),
    statusScope: stubScope({ workspaces: [], probes: [], history: [] }),
  })

  assert.deepEqual(mounted.bound, ['sync-tool', 'sync-tool-status'], 'both namespaces are bound')
  assert.deepEqual(
    mounted.injected,
    ['settings.plugin.item', 'conversation.session.header.utilities'],
    'one card plus one header control',
  )
  assert.equal(mounted.registrations.length, 2)

  const card = cardOf(mounted.registrations)
  assert.equal(card.options.key, 'sync-tool', 'the card pairs with the Host namespace')
  assert.equal(typeof card.Component, 'function')

  const button = buttonOf(mounted.registrations)
  assert.equal(button.options.id, 'sync-tool-workspace', 'a list seat identifies entries by id')
  assert.equal(button.options.order, 200, 'order places the control at the right edge')
  assert.equal(button.options.key, undefined, 'a list seat does not use the keyed-slot key')
  assert.equal(typeof button.Component, 'function')

  // The binder is the only settings transport the two contributions use.
  assert.ok(cardOf(mounted.registrations).options.inject().configScope !== undefined)
  assert.ok(buttonOf(mounted.registrations).options.inject().statusScope !== undefined)
})

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

test('the card renders the global switches, the shared sessions repository, and the workspace overview', () => {
  const { renderCard } = mountCard(
    {
      enabled: true,
      syncOnTurnEnd: true,
      syncOnStartup: false,
      syncAllOnTurnEnd: false,
      debounceMs: 5000,
      sessionsRemote: '',
      workspaces: [],
    },
    { running: false, workspaces: [], probes: [], history: [] },
  )

  const tree = renderCard({ useWorkspaces: selector => selector({ items: [WORKSPACE_VIEW] }) })
  const text = textOf(tree)

  assert.match(text, /工作区 Git 同步/u)
  assert.match(text, /启用插件/u)
  assert.match(text, /每轮对话后同步/u)
  assert.match(text, /启动时同步/u)
  assert.match(text, /每轮同步全部工作区/u)
  assert.match(text, /共享会话仓库/u, 'the shared sessions repository is a first-class row')
  assert.match(text, /已有自己 git 仓库的工作区/u)
  assert.match(text, /还没有配置任何工作区/u)
  assert.match(text, /DSH 工作区总览（1）/u, 'the overview lists every DSH workspace')
  assert.match(text, /未配置同步/u, 'a workspace without config is marked as such')
  assert.match(text, /暂无同步历史/u)

  const inputs = findAll(tree, node => node.type === 'input')
  assert.ok(
    inputs.some(node => node.props.type === 'number' && node.props.value === 5000),
    'the debounce field is a number input holding the configured value',
  )
})

test('the card still renders without the workspace hook, and with history', () => {
  const { renderCard } = mountCard(
    {
      enabled: true,
      workspaces: [{ path: WORKSPACE_PATH, title: 'Plugins', mode: 'sessions', remote: 'https://example.invalid/s.git' }],
    },
    {
      running: false,
      workspaces: [{
        id: 'd:/work/dsh_sync_tool',
        path: WORKSPACE_PATH,
        status: 'ok',
        at: 1789302227110,
        head: 'abc1234567',
        ahead: 1,
        behind: 2,
      }],
      probes: [],
      history: [{ at: 1789302227110, ok: true, summary: 'Plugins · 已同步' }],
    },
  )

  const text = textOf(renderCard({}))
  assert.match(text, /已配置工作区（1）/u)
  assert.match(text, /Plugins/u)
  assert.match(text, /只同步对话/u, 'the configured row shows its mode')
  assert.match(text, /HEAD abc1234567/u)
  assert.match(text, /↑1 ↓2/u)
  assert.match(text, /Plugins · 已同步/u, 'history renders')
  assert.match(text, /当前连接没有提供工作区列表/u, 'the overview degrades instead of throwing')
})

test('flipping a card switch writes that exact field', () => {
  const { configScope, renderCard } = mountCard(
    {
      enabled: true,
      syncOnTurnEnd: true,
      syncOnStartup: false,
      syncAllOnTurnEnd: false,
      debounceMs: 5000,
      workspaces: [],
    },
    { running: false, workspaces: [], probes: [], history: [] },
  )

  const startup = findOne(
    renderCard({}),
    node => node.props['data-primitive'] === 'Switch' && node.props['aria-label'] === '启动时同步',
    'the startup switch rendered',
  )
  startup.props.onClick()
  assert.equal(lastWrite(configScope, 'syncOnStartup').next, true, 'the switch writes its own field on')

  const all = findOne(
    renderCard({}),
    node => node.props['data-primitive'] === 'Switch' && node.props['aria-label'] === '每轮同步全部工作区',
    'the sync-all switch rendered',
  )
  all.props.onClick()
  assert.equal(lastWrite(configScope, 'syncAllOnTurnEnd').next, true)
  assert.match(textOf(renderCard({})), /已配置工作区（0）/u, 'an unrelated write does not disturb the tree')
})

test('the shared sessions repository input commits on blur', () => {
  const { configScope, renderCard } = mountCard(
    { enabled: true, debounceMs: 5000, sessionsRemote: '', workspaces: [] },
    { running: false, workspaces: [], probes: [], history: [] },
  )

  const field = findOne(
    renderCard({}),
    node => node.type === 'input' && node.props['aria-label'] === '共享会话仓库',
    'the shared sessions repository input rendered',
  )
  assert.equal(field.props.placeholder, 'https://github.com/<you>/dsh-sessions.git')
  field.props.onChange({ target: { value: '  https://example.invalid/me/dsh-sessions.git  ' } })
  const blurred = findOne(
    renderCard({}),
    node => node.type === 'input' && node.props['aria-label'] === '共享会话仓库',
    'the input is still mounted after typing',
  )
  blurred.props.onBlur()
  assert.equal(lastWrite(configScope, 'sessionsRemote').next, 'https://example.invalid/me/dsh-sessions.git')
})

// ---------------------------------------------------------------------------
// The header control
// ---------------------------------------------------------------------------

test('the header control renders for the session workspace and null when there is none', () => {
  const { renderWith } = mountButton({ workspaces: [] }, { workspaces: [], probes: [], history: [] })

  const tree = renderWith({})
  const trigger = findOne(
    tree,
    node => node.type === 'button' && node.props['data-sync-status'] !== undefined,
    'the trigger rendered',
  )
  assert.equal(trigger.props['aria-haspopup'], 'dialog')
  assert.equal(trigger.props['aria-expanded'], 'false')
  assert.match(trigger.props['aria-label'], /同步：Plugins/u, 'the title names the workspace')
  assert.match(trigger.props.title, /dsh_sync_tool/u, 'the title carries the path')
  assert.match(textOf(trigger), /待同步/u)

  // Neither a workspace row nor a session cwd: render nothing at all.
  assert.equal(renderWith({ items: [], useSessions: undefined }), null, 'no workspace and no cwd means no control')
  assert.equal(renderWith({ sessionId: '' }), null, 'no session id means no control')
})

test('the header control falls back to the session cwd when the workspace hook is absent', () => {
  const { renderWith } = mountButton({ workspaces: [] }, { workspaces: [], probes: [], history: [] })
  const tree = renderWith({ useWorkspaces: undefined })
  const trigger = findOne(
    tree,
    node => node.type === 'button' && node.props['data-sync-status'] !== undefined,
    'the trigger rendered',
  )
  assert.match(trigger.props['aria-label'], /dsh_sync_tool/u, 'the folder basename titles the control')
})

test('a blank session renders nothing', () => {
  const { renderWith } = mountButton({ workspaces: [] }, { workspaces: [], probes: [], history: [] })
  assert.equal(renderWith({ useSession: selectorHook({ openState: 'blank', running: false, blank: true }) }), null)
  assert.notEqual(renderWith({ useSession: selectorHook({ openState: 'open', running: false, blank: false }) }), null)
})

test('opening the panel asks the Host to probe the folder exactly once', () => {
  const { configScope, renderWith } = mountButton(
    { workspaces: [], request: { token: 4 } },
    { workspaces: [], probes: [], history: [] },
  )

  const tree = openPanel(renderWith)
  const probes = configScope.writes.filter(write => write.field === 'request' && write.next.kind === 'probe')
  assert.equal(probes.length, 1, 'the panel asks once, not on every render')
  assert.equal(probes[0].next.path, WORKSPACE_PATH, 'the request names the workspace folder')
  assert.equal(probes[0].next.token, 5, 'the token is bumped from the stored value')
  assert.ok(probes[0].next.at > 0)

  const panel = findOne(tree, node => node.props['data-sync-panel'] !== undefined, 'the panel rendered')
  assert.equal(panel.props['data-sync-panel'], WORKSPACE_PATH)
  assert.match(textOf(panel), /正在检查这个文件夹…/u, 'an unanswered probe reads as still checking')
})

test('a repository probe with a remote saves sessions mode and syncs', async () => {
  const { configScope, renderWith } = mountButton(
    {
      workspaces: [],
      sessionsRemote: 'https://example.invalid/shared/dsh-sessions.git',
      request: { token: 0 },
    },
    {
      running: false,
      workspaces: [],
      probes: [{
        id: 'd:/work/dsh_sync_tool',
        path: WORKSPACE_PATH,
        kind: 'repo',
        remote: 'https://example.invalid/me/dsh_sync_tool.git',
        branch: 'main',
        root: WORKSPACE_PATH,
        dirty: 2,
        manifestRemote: '',
        at: 1789302227110,
        error: '',
      }],
      history: [],
    },
  )

  let tree = openPanel(renderWith)
  const text = textOf(tree)
  assert.match(text, /已是一个 git 仓库/u)
  assert.match(text, /远端：https:\/\/example\.invalid\/me\/dsh_sync_tool\.git/u)
  assert.match(text, /分支：main · 未提交文件：2/u)
  assert.match(text, /插件不会动这个仓库的文件、分支和提交/u, 'the promise is stated for an existing repository')
  assert.match(text, /留空则用共享会话仓库：https:\/\/example\.invalid\/shared\/dsh-sessions\.git/u)

  // The sessions-repository input follows the contract's prefill order:
  // configured remote, then the global sessions repository, then the manifest.
  // This workspace is not configured yet, so the global value wins — the
  // project repository's own remote is deliberately *not* mirrored.
  const inputOf = node => node.type === 'input' && node.props['aria-label'] === '会话仓库'
  const remoteInput = findOne(tree, inputOf, 'the sessions-repository input rendered')
  assert.equal(remoteInput.props.value, 'https://example.invalid/shared/dsh-sessions.git')

  // Type a dedicated sessions repository, then press the primary action.
  remoteInput.props.onChange({ target: { value: 'https://example.invalid/me/plugins-sessions.git' } })
  tree = renderWith({})
  findOne(tree, inputOf, 'the input survives the re-render').props.onBlur()
  tree = renderWith({})
  await clickSettled(findOne(
    tree,
    node => node.type === 'button' && textOf(node).includes('保存并同步'),
    'the primary action rendered',
  ))

  const workspaces = lastWrite(configScope, 'workspaces')
  assert.ok(workspaces !== undefined, 'save-and-sync writes the workspace list')
  assert.equal(workspaces.next.length, 1)
  const saved = workspaces.next[0]
  assert.equal(saved.path, WORKSPACE_PATH)
  assert.equal(saved.title, 'Plugins')
  assert.equal(saved.mode, 'sessions', 'an existing repository mirrors sessions only')
  assert.equal(saved.remote, 'https://example.invalid/me/plugins-sessions.git')
  assert.equal(saved.direction, 'both')
  assert.equal(saved.enabled, true)

  const areas = lastWrite(configScope, 'areas')
  assert.ok(areas !== undefined, 'the retired areas field is cleared in the same commit')
  assert.deepEqual(areas.next, [])

  const request = lastWrite(configScope, 'request')
  assert.ok(request !== undefined, 'the save request reached the command channel')
  assert.equal(request.next.kind, 'sync')
  assert.equal(request.next.path, WORKSPACE_PATH)
  assert.equal(request.next.token, 1)
})

test('the panel offers a folder repository when the probe finds no repository', async () => {
  const { configScope, renderWith } = mountButton(
    { workspaces: [], sessionsRemote: '', request: { token: 0 } },
    { running: false, workspaces: [], probes: [{ id: 'd:/work/new', path: WORKSPACE_PATH, kind: 'none', at: 1 }], history: [] },
  )

  let tree = openPanel(renderWith)
  const text = textOf(tree)
  assert.match(text, /这个文件夹还不是 git 仓库。/u)
  assert.match(text, /插件会在文件夹里 init、提交并推送/u)
  assert.doesNotMatch(text, /插件不会动这个仓库/u, 'no promise about a repository that does not exist')

  const inputOf = node => node.type === 'input' && node.props['aria-label'] === '远程仓库'
  assert.equal(
    findOne(tree, inputOf, 'the remote input is labelled for a plain folder').props.placeholder,
    'https://github.com/<you>/<repo>.git',
  )
  findOne(tree, inputOf, 'the remote input rendered').props.onChange({ target: { value: 'https://example.invalid/me/new.git' } })
  tree = renderWith({})
  findOne(tree, inputOf, 'the input survives the re-render').props.onBlur()
  tree = renderWith({})
  await clickSettled(findOne(
    tree,
    node => node.type === 'button' && textOf(node).includes('保存并同步'),
    'the primary action rendered',
  ))

  const saved = lastWrite(configScope, 'workspaces').next[0]
  assert.equal(saved.mode, 'folder', 'a plain folder is the sync target itself')
  assert.equal(saved.remote, 'https://example.invalid/me/new.git')
  assert.equal(saved.commitScope, 'archive', 'folder mode still commits only the session archive by default')
  assert.equal(lastWrite(configScope, 'request').next.kind, 'sync')
})

test('a nested folder is explained without promising to create a repository', () => {
  const { renderWith } = mountButton(
    { workspaces: [], request: { token: 0 } },
    { running: false, workspaces: [], probes: [{ id: 'x', path: WORKSPACE_PATH, kind: 'nested', root: 'D:\\work', at: 1 }], history: [] },
  )

  const text = textOf(openPanel(renderWith))
  assert.match(text, /这个文件夹在另一个 git 仓库内部（仓库根：D:\\work）/u)
  assert.match(text, /插件不会在这里建独立仓库/u)
  assert.match(text, /插件不会动这个仓库的文件、分支和提交/u)
})

test('an errored probe surfaces the probe error', () => {
  const { renderWith } = mountButton(
    { workspaces: [], request: { token: 0 } },
    { running: false, workspaces: [], probes: [{ id: 'x', path: WORKSPACE_PATH, kind: 'error', error: 'git 不可用', at: 1 }], history: [] },
  )
  assert.match(textOf(openPanel(renderWith)), /探针失败：git 不可用/u)
})

test('a folder another machine synced offers a one-click claim', async () => {
  const { configScope, renderWith } = mountButton(
    { workspaces: [], request: { token: 0 } },
    {
      running: false,
      workspaces: [],
      probes: [{
        id: 'x',
        path: WORKSPACE_PATH,
        kind: 'repo',
        remote: '',
        manifestRemote: 'https://example.invalid/other/dsh-sync.git',
        at: 1,
      }],
      history: [],
    },
  )

  const tree = openPanel(renderWith)
  const text = textOf(tree)
  assert.match(text, /这个文件夹已由另一台机器同步过/u)
  assert.match(text, /https:\/\/example\.invalid\/other\/dsh-sync\.git/u)

  await clickSettled(findOne(
    tree,
    node => node.type === 'button' && textOf(node).includes('[ 启用 ]'),
    'the claim control rendered',
  ))

  const saved = lastWrite(configScope, 'workspaces').next[0]
  assert.equal(saved.mode, 'sessions', 'an existing repository claims in sessions mode')
  assert.equal(saved.remote, 'https://example.invalid/other/dsh-sync.git')
  assert.deepEqual(lastWrite(configScope, 'areas').next, [])
  assert.equal(lastWrite(configScope, 'request').next.kind, 'sync')

  // Once configured, the prompt disappears.
  const configured = mountButton(
    {
      workspaces: [{
        path: WORKSPACE_PATH,
        title: 'Plugins',
        mode: 'sessions',
        remote: 'https://example.invalid/other/dsh-sync.git',
      }],
      request: { token: 0 },
    },
    {
      running: false,
      workspaces: [],
      probes: [{ id: 'x', path: WORKSPACE_PATH, kind: 'repo', manifestRemote: 'https://example.invalid/other/dsh-sync.git', at: 1 }],
      history: [],
    },
  )
  assert.doesNotMatch(
    textOf(openPanel(configured.renderWith)),
    /已由另一台机器同步过/u,
    'a configured workspace has nothing to claim',
  )
})

test('a configured workspace shows its result, its actions, and the advanced block', async () => {
  const { configScope, renderWith } = mountButton(
    {
      workspaces: [{ path: WORKSPACE_PATH, title: 'Plugins', mode: 'sessions', remote: 'https://example.invalid/me/s.git', branch: 'main' }],
      request: { token: 0 },
    },
    {
      running: false,
      workspaces: [{
        id: 'd:/work/dsh_sync_tool',
        path: WORKSPACE_PATH,
        title: 'Plugins',
        status: 'error',
        at: 1789302227110,
        detail: 'git push 失败：认证被拒绝',
        head: '29bcb36c8d7255b690e4873dca63ccc74d52be99',
        ahead: 2,
        behind: 1,
      }],
      probes: [{ id: 'x', path: WORKSPACE_PATH, kind: 'repo', remote: 'https://example.invalid/me/s.git', at: 1 }],
      history: [],
    },
  )

  const closed = renderWith({})
  const trigger = findOne(closed, node => node.props['data-sync-status'] !== undefined, 'the trigger rendered')
  assert.equal(trigger.props['data-sync-status'], 'error', 'the trigger carries the machine-readable state')
  assert.match(textOf(trigger), /错误/u)
  trigger.props.onClick()
  let tree = renderWith({})

  const text = textOf(tree)
  assert.match(text, /错误 · 5 分钟前 · HEAD 29bcb36c8d · ↑2 ↓1/u, 'the status line shows time, HEAD, and divergence')
  assert.match(text, /认证被拒绝/u)

  findOne(tree, node => node.type === 'button' && textOf(node) === '立即同步', '立即同步 rendered').props.onClick()
  assert.equal(lastWrite(configScope, 'request').next.kind, 'sync')
  assert.equal(lastWrite(configScope, 'request').next.path, WORKSPACE_PATH)

  // The advanced block is collapsed by default; its controls must not exist yet.
  assert.doesNotMatch(text, /提交范围/u)
  findOne(tree, node => node.type === 'button' && textOf(node).includes('高级'), 'the advanced disclosure rendered').props.onClick()
  tree = renderWith({})
  const advanced = textOf(tree)
  assert.match(advanced, /自动（推荐）/u)
  assert.match(advanced, /只提交 \.dsh-sessions/u)
  assert.doesNotMatch(advanced, /你的对话内容会一起被推送/u, 'the shared-repository warning needs a risky choice')

  // Choosing a whole-folder commit on an existing repository raises the warning.
  findOne(
    tree,
    node => node.type === 'select' && node.props['aria-label'] === '提交范围',
    'the commit-scope select rendered',
  ).props.onChange({ target: { value: 'all' } })
  await Promise.resolve()
  const afterScope = lastWrite(configScope, 'workspaces')
  assert.ok(afterScope !== undefined, 'the advanced select writes the workspace list')
  assert.equal(afterScope.next[0].commitScope, 'all')
  assert.match(
    textOf(renderWith({})),
    /如果这个仓库是公开的或与别人共享，你的对话内容会一起被推送。/u,
  )
})

test('cancel-sync removes only this workspace entry and clears the retired areas field', () => {
  const { configScope, renderWith } = mountButton(
    {
      workspaces: [
        { path: WORKSPACE_PATH, title: 'Plugins', mode: 'sessions', remote: 'https://example.invalid/me/s.git' },
        { path: 'D:\\work\\other', title: 'other', mode: 'sessions', remote: '' },
      ],
      request: { token: 0 },
    },
    { running: false, workspaces: [], probes: [], history: [] },
  )

  findOne(openPanel(renderWith), node => node.type === 'button' && textOf(node).includes('取消同步'), 'cancel rendered')
    .props.onClick()

  const remaining = lastWrite(configScope, 'workspaces').next
  assert.equal(remaining.length, 1, 'only the current workspace is removed')
  assert.equal(remaining[0].path, 'D:\\work\\other')
  assert.deepEqual(lastWrite(configScope, 'areas').next, [])
})

test('the panel copies the workspace path and says so', async () => {
  const { clipboard, renderWith } = mountButton(
    { workspaces: [], request: { token: 0 } },
    { running: false, workspaces: [], probes: [{ id: 'x', path: WORKSPACE_PATH, kind: 'none', at: 1 }], history: [] },
  )

  let tree = openPanel(renderWith)
  findOne(
    tree,
    node => node.type === 'button' && node.props['aria-label'] === `复制路径 ${WORKSPACE_PATH}`,
    'the copy control rendered',
  ).props.onClick()
  await Promise.resolve()
  tree = renderWith({})
  assert.deepEqual(clipboard, [WORKSPACE_PATH])
  assert.match(textOf(tree), /已复制/u)
})

test('Escape closes the panel and returns focus to the trigger', () => {
  const { renderWith } = mountButton({ workspaces: [], request: { token: 0 } }, { workspaces: [], probes: [], history: [] })
  let tree = openPanel(renderWith)
  assert.ok(findAll(tree, node => node.props['data-sync-panel'] !== undefined).length > 0, 'the panel is open')

  const focused = []
  findOne(tree, node => node.props['data-sync-status'] !== undefined, 'the trigger survived')
    .props.ref.current.focus = () => { focused.push('trigger') }
  const root = findOne(tree, node => typeof node.props.onKeyDown === 'function', 'the wrapper handles Escape')
  root.props.onKeyDown({ key: 'Escape', preventDefault: () => {} })

  tree = renderWith({})
  assert.equal(findAll(tree, node => node.props['data-sync-panel'] !== undefined).length, 0, 'Escape closed the panel')
  assert.equal(
    findOne(tree, node => node.props['aria-expanded'] !== undefined, 'the trigger survives the close').props['aria-expanded'],
    'false',
  )
  assert.deepEqual(focused, ['trigger'], 'focus returned to the trigger')
})

test('the panel offers sync actions only for a configured workspace', () => {
  const { renderWith } = mountButton(
    { workspaces: [], request: { token: 0 } },
    { running: false, workspaces: [], probes: [{ id: 'x', path: WORKSPACE_PATH, kind: 'none', at: 1 }], history: [] },
  )
  const tree = openPanel(renderWith)
  assert.equal(buttonsWithText(tree, '立即同步').length, 0, 'nothing to sync before it is configured')
  assert.equal(buttonsWithText(tree, '取消同步').length, 0)
  assert.match(textOf(tree), /尚未同步/u, 'an unconfigured workspace has no result line')
})

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

test('a loading settings snapshot still renders every surface', () => {
  // A scope whose namespace is still loading reports `loading`, which is the
  // snapshot shape both contributions must render through.
  const configScope = stubScope({}, 'loading')
  const statusScope = stubScope({}, 'loading')
  const mounted = mountClient({ configScope, statusScope })

  const card = cardOf(mounted.registrations)
  const cardText = textOf(mounted.harness.render(card.Component, card.options.inject()))
  assert.match(cardText, /工作区 Git 同步/u)
  assert.match(cardText, /读取状态中…/u)

  const button = buttonOf(mounted.registrations)
  const tree = mounted.harness.render(button.Component, { ...button.options.inject(), ...sessionProps() })
  const trigger = findOne(tree, node => node.props['data-sync-status'] !== undefined, 'the trigger renders while loading')
  assert.equal(trigger.props['data-sync-status'], 'idle')
})

test('a read-only connection disables writes without breaking rendering', () => {
  const configScope = stubScope({})
  configScope.getSnapshot = () => ({
    status: 'ready',
    value: { enabled: true, debounceMs: 5000, workspaces: [] },
    writable: false,
    mode: 'user',
  })
  const mounted = mountClient({
    configScope,
    statusScope: stubScope({ running: false, workspaces: [], probes: [], history: [] }),
  })

  const card = cardOf(mounted.registrations)
  const tree = mounted.harness.render(card.Component, card.options.inject())
  assert.match(textOf(tree), /当前连接不接受设置写入，配置为只读。/u)
  assert.equal(
    findOne(tree, node => node.props['data-primitive'] === 'Switch', 'the switches still render').props.disabled,
    true,
  )
})

test('the bundle requires nothing outside the frozen module table', () => {
  const mounted = mountClient({ configScope: stubScope({}), statusScope: stubScope({}) })
  for (const specifier of mounted.specifiers) {
    assert.ok(
      specifier === 'react' || specifier === 'react-dom' || specifier === '@deepseek-ai/dsh-client-ui-primitives',
      `unexpected require("${specifier}")`,
    )
  }
})
