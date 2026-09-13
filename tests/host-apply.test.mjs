/**
 * Host-half contract: the plugin injects the optional `settings` service and
 * registers its namespace through `installSection`, which is what makes the
 * browser card pair with it. Run with `node --test tests/`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, Config, name, SYNC_NAMESPACE } from '../lib/index.js'

test('host half exports the loader row identity', () => {
  assert.equal(name, 'sync-tool')
  assert.equal(SYNC_NAMESPACE, 'sync-tool')
})

test('config resolves schema defaults', () => {
  assert.deepEqual(Config({}), { enabled: true, syncOnTurnEnd: true, debounceMs: 5000 })
})

test('apply registers the namespace through installSection', () => {
  const injected = []
  const registered = []

  const ctx = {
    inject(dependencies, callback) {
      injected.push(dependencies)
      callback({
        settings: {
          installSection(owner, namespace, schema, entry, hooks) {
            registered.push({ owner, namespace, schema, entry, hooks })
            // The real provider hands the consumer the authoritative thunk and
            // then notifies once.
            hooks.setSource(() => ({ enabled: false, syncOnTurnEnd: false, debounceMs: 1 }))
            hooks.onChange()
          },
        },
      })
    },
  }

  const entry = Config({})
  apply(ctx, entry)

  assert.deepEqual(injected, [['settings']], 'the settings service is read optionally, via ctx.inject')
  assert.equal(registered.length, 1)

  const [registration] = registered
  assert.equal(registration.owner, ctx, 'the consumer context is the owner')
  assert.equal(registration.namespace, SYNC_NAMESPACE)
  assert.equal(registration.schema, Config)
  assert.equal(registration.entry, entry)
  assert.equal(typeof registration.hooks.setSource, 'function')
  assert.equal(typeof registration.hooks.onChange, 'function')
  assert.equal(typeof registration.hooks.validate, 'undefined', 'no extra validation is declared')
})

test('apply stays inert when no settings provider is composed', () => {
  const ctx = { inject(_dependencies, _callback) { /* provider absent: callback never runs */ } }
  assert.doesNotThrow(() => { apply(ctx, Config({})) })
})
