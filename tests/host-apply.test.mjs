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
    debounceMs: 5000,
    commitMessageTemplate: 'dsh-sync: {host} {time} (turn {turn})',
    historyLimit: 20,
    areas: [],
    request: { token: 0, areaId: '', kind: 'none', at: 0 },
  })
})

test('an area needs only id and path; the rest defaults', () => {
  const [area] = Config({ areas: [{ id: 'a1', path: 'D:/work/plugins' }] }).areas
  assert.deepEqual(area, {
    id: 'a1',
    name: '',
    path: 'D:/work/plugins',
    remote: '',
    branch: 'main',
    credentialRef: '',
    direction: 'both',
    enabled: true,
    autoCommit: true,
    extraIgnores: [],
    guardSensitive: true,
  })
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
    revision: 0, running: false, updatedAt: 0, areas: [], history: [],
  })
})

test('apply registers the config section and the status namespace', () => {
  const injected = []
  const sections = []
  const registered = []
  let sourceThunk

  const ctx = {
    inject(dependencies, callback) {
      injected.push(dependencies)
      callback({
        settings: {
          installSection(owner, namespace, schema, entry, hooks) {
            sections.push({ owner, namespace, schema, entry, hooks })
            hooks.setSource(() => ({ enabled: false, syncOnTurnEnd: false, debounceMs: 1, areas: [] }))
            hooks.onChange()
          },
          register(namespace, schema, options) {
            const value = { revision: 0, running: false, updatedAt: 0, areas: [], history: [] }
            registered.push({ namespace, schema, options, value })
            return {
              get: () => value,
              replace: (next) => { registered.at(-1).value = next; return Promise.resolve() },
            }
          },
        },
      })
    },
  }

  const entry = Config({})
  apply(ctx, entry)

  assert.deepEqual(injected, [['settings']], 'the settings service is read optionally, via ctx.inject')

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
  sourceThunk = registered[0].value
  assert.ok(sourceThunk !== undefined)
})

test('apply stays inert when no settings provider is composed', () => {
  const ctx = { inject(_dependencies, _callback) { /* provider absent: callback never runs */ } }
  assert.doesNotThrow(() => { apply(ctx, Config({})) })
})
