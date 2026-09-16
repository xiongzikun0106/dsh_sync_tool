/**
 * Host-half contract. Run with `node --test tests/*.test.mjs`.
 *
 * Two things matter here: the plugin must register its user-configuration
 * namespace through `installSection` (that is what pairs the browser card) and
 * it must register a Host-owned status namespace it publishes wholesale.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  apply, AREA_STATUS, Config, DIRECTIONS, name, STATUS_NAMESPACE, StatusConfig, SYNC_NAMESPACE,
} from '../lib/index.js'

test('host half exports the loader row identity and namespaces', () => {
  assert.equal(name, 'sync-tool')
  assert.equal(SYNC_NAMESPACE, 'sync-tool')
  assert.equal(STATUS_NAMESPACE, 'sync-tool-status')
})

test('config resolves the documented defaults', () => {
  assert.deepEqual(Config({}), {
    enabled: true,
    syncOnTurnEnd: true,
    syncOnStartup: false,
    syncAllOnTurnEnd: false,
    debounceMs: 5000,
    commitMessageTemplate: 'dsh-sync: {host} {time} (turn {turn})',
    commitIdentity: { name: '', email: '' },
    historyLimit: 20,
    sessionsRemote: '',
    sessionsRoot: '',
    sessions: {
      enabled: true,
      dir: '.dsh-sessions',
      compression: 'zstd',
      includeDescendants: false,
      maxSessions: 200,
      maxBytes: 0,
      cwdPolicy: 'keep',
      hintOnDeviceSwitch: true,
      statePath: '',
    },
    workspaces: [],
    request: { token: 0, path: '', kind: 'none', at: 0, areaId: '' },
    areas: [],
  })
})

test('the session block merges field by field over its defaults', () => {
  const resolved = Config({ sessions: { compression: 'none', cwdPolicy: 'auto' } }).sessions
  assert.equal(resolved.compression, 'none')
  assert.equal(resolved.cwdPolicy, 'auto')
  assert.equal(resolved.maxSessions, 200, 'untouched fields keep their defaults')
  assert.ok(Config({ sessions: { includeDescendants: false } }).sessions.enabled)
})

test('a work area entry needs only a path; everything else defaults', () => {
  assert.deepEqual(Config({ workspaces: [{ path: 'D:/work/myWeb' }] }).workspaces, [{
    path: 'D:/work/myWeb',
    title: '',
    mode: 'auto',
    remote: '',
    branch: 'main',
    credentialRef: '',
    direction: 'both',
    enabled: true,
    autoCommit: true,
    commitScope: 'all',
    extraIgnores: [],
    guardSensitive: true,
    nestedRepos: 'refuse',
  }])
})

test('the retired areas[] shape still validates, so an old document keeps loading', () => {
  const [area] = Config({ areas: [{ id: 'a1', path: 'D:/work/plugins' }] }).areas
  assert.equal(area.path, 'D:/work/plugins')
  assert.equal(area.nestedRepos, 'init', 'the legacy default is preserved for migration')
})

test('the area status and direction vocabularies are closed', () => {
  assert.deepEqual([...AREA_STATUS], ['idle', 'validating', 'syncing', 'ok', 'conflict', 'error'])
  assert.deepEqual([...DIRECTIONS], ['both', 'push', 'pull'])
  assert.throws(
    () => Config({ areas: [{ id: 'a', path: 'p', direction: 'sideways' }] }),
    /direction expected "both" \| "push" \| "pull"/u,
    'an unknown direction is rejected at validation time',
  )
  assert.throws(
    () => Config({ debounceMs: -1 }),
    /debounceMs/u,
    'a negative debounce is rejected',
  )
})

test('status defaults to an empty, not-running document', () => {
  assert.deepEqual(StatusConfig({}), {
    revision: 0, running: false, updatedAt: 0, workspaces: [], probes: [], history: [],
  })
})

/**
 * A minimal host context: the services `apply` reads, plus an `effect` that
 * understands both the plain-disposer and generator forms.
 */
function stubContext() {
  const injected = []
  const sections = []
  const registered = []
  const disposers = []
  const listeners = new Map()
  const contexts = []

  const ctx = {
    get: () => undefined,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    effect(callback, _name) {
      const result = callback()
      if (result !== undefined && typeof result.next === 'function') {
        // Generator form: the body does not run until the first next().
        const step = result.next()
        if (step.done !== true && typeof step.value === 'function') disposers.push(step.value)
      } else if (typeof result === 'function') {
        disposers.push(result)
      }
      return () => {}
    },
    inject(dependencies, callback) {
      injected.push(dependencies)
      const scoped = { ...ctx }
      if (dependencies.includes('settings')) {
        scoped.settings = {
          installSection(owner, namespace, schema, entry, hooks) {
            sections.push({ owner, namespace, schema, entry, hooks })
            hooks.setSource(() => ({ enabled: false, syncOnTurnEnd: false, debounceMs: 1, workspaces: [] }))
            hooks.onChange()
          },
          register(namespace, schema, options) {
            const value = { revision: 0, running: false, updatedAt: 0, workspaces: [], probes: [], history: [] }
            registered.push({ namespace, schema, options, value })
            return {
              get: () => value,
              replace: (next) => { registered.at(-1).value = next; return Promise.resolve() },
            }
          },
        }
      }
      if (dependencies.includes('systemPrompt')) {
        scoped.systemPrompt = {
          context(entry) { contexts.push(entry); return () => {} },
          section(entry) { contexts.push(entry); return () => {} },
        }
      }
      callback(scoped)
    },
  }

  return { ctx, injected, sections, registered, disposers, listeners, contexts }
}

test('apply registers the config section and the status namespace', () => {
  const { ctx, injected, sections, registered, disposers, listeners, contexts } = stubContext()

  const entry = Config({})
  apply(ctx, entry)

  assert.deepEqual(
    injected.map((entry) => entry[0]).sort(),
    ['settings', 'systemPrompt'],
    'every service is read optionally, via ctx.inject',
  )

  assert.ok(listeners.has('session/event'), 'the turn-boundary hook is registered on the fiber')
  assert.equal(listeners.get('session/event').length, 1)

  assert.equal(contexts.length, 1, 'the device notice is one conditional runtime-context contribution')
  assert.equal(contexts[0].name, 'sync-tool:device-switch')
  assert.equal(typeof contexts[0].text, 'function')

  assert.equal(sections.length, 1)
  const [section] = sections
  assert.equal(section.owner, ctx, 'the consumer context is the owner')
  assert.equal(section.namespace, SYNC_NAMESPACE)
  assert.equal(section.schema, Config)
  assert.equal(section.entry, entry)
  assert.equal(typeof section.hooks.setSource, 'function')
  assert.equal(typeof section.hooks.onChange, 'function')
  assert.equal(typeof section.hooks.validate, 'undefined', 'no extra validation is declared')

  assert.equal(registered.length, 1)
  assert.equal(registered[0].namespace, STATUS_NAMESPACE)
  assert.equal(registered[0].schema, StatusConfig)
  assert.ok(registered[0].options.base !== undefined, 'the status namespace declares a composition base')
  // The initial publish ran: a valid status document with the configured work areas.
  assert.equal(registered[0].value.running, false)
  assert.deepEqual(registered[0].value.workspaces, [])
  assert.deepEqual(registered[0].value.probes, [])

  assert.equal(disposers.length, 2, 'the drain and the notice registration both live on the fiber')
  assert.equal(typeof disposers[0], 'function')
})

test('the notice stays silent for a session this machine did not import', () => {
  const { ctx, contexts } = stubContext()
  apply(ctx, Config({}))
  const [notice] = contexts
  assert.equal(notice.text({ agent: undefined }), '')
  assert.equal(notice.text({ agent: { session: { header: { id: 'session-x' } } } }), '')
})

test('apply stays inert when no settings provider is composed', () => {
  const { ctx, disposers } = stubContext()
  ctx.inject = (_dependencies, _callback) => { /* provider absent: callback never runs */ }
  assert.doesNotThrow(() => { apply(ctx, Config({})) })
  assert.equal(disposers.length, 1, 'the drain effect is still registered')
})
