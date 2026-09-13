/**
 * Turn-boundary auto-sync: `turn/end` selects the areas whose folder contains
 * the session's working directory, coalesces bursts, and drives a real git pass.
 *
 * The settings service is stubbed (it is a plain value channel here), while
 * every git invocation is genuine. Run with `node --test tests/*.test.mjs`.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, Config } from '../lib/index.js'
import {
  areaFor, delay, fakeSubprocess, git, installHermeticGitEnv, makeWorld,
} from './helpers.mjs'

installHermeticGitEnv()

/**
 * A host context with a live config value, a live status document, and
 * captured event listeners.
 */
function stubHostContext(subprocess) {
  const listeners = new Map()
  const disposers = []
  const state = {
    config: { areas: [] },
    status: { revision: 0, running: false, updatedAt: 0, areas: [], history: [] },
  }

  const ctx = {
    get: (service) => (service === 'subprocess' ? subprocess : undefined),
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    effect(callback) {
      const result = callback()
      if (result !== undefined && typeof result.next === 'function') {
        const step = result.next()
        if (step.done !== true && typeof step.value === 'function') disposers.push(step.value)
      } else if (typeof result === 'function') {
        disposers.push(result)
      }
      return () => {}
    },
    inject(_dependencies, callback) {
      callback({
        settings: {
          installSection(_owner, _namespace, _schema, _entry, hooks) {
            hooks.setSource(() => state.config)
            hooks.onChange()
          },
          register() {
            return {
              get: () => state.status,
              replace: (next) => { state.status = next; return Promise.resolve() },
            }
          },
        },
      })
    },
  }

  return {
    ctx,
    state,
    disposers,
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
  }
}

/** Poll until a predicate holds. */
async function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(50)
  }
  return false
}

test('a finished turn inside an area syncs that area', async () => {
  const world = makeWorld()
  try {
    writeFileSync(join(world.work, 'a.txt'), 'hello\n')
    const host = stubHostContext(fakeSubprocess())
    const config = Config({ areas: [areaFor(world)], debounceMs: 0 })
    host.state.config = config
    apply(host.ctx, config)

    host.emit('session/event', { header: { cwd: world.work } }, { type: 'turn/end', data: { turn: 5 } })

    const settled = await waitFor(() => host.state.status.history.length > 0)
    assert.ok(settled, 'the turn boundary produced a sync pass')

    const [area] = host.state.status.areas
    assert.equal(area.id, 'a1')
    assert.equal(area.status, 'ok', area.detail)
    assert.notEqual(area.head, '')

    // The commit really reached the bare remote.
    assert.equal(git(world.remote, ['rev-parse', 'main']).trim(), area.head)
    assert.ok(existsSync(join(world.work, '.gitignore')))
    assert.match(host.state.status.history[0].summary, /turn 5|A ·/u)

    // The repository is self-describing for the next machine.
    const manifest = JSON.parse(readFileSync(join(world.work, '.dsh-sync.json'), 'utf8'))
    assert.equal(manifest.version, 1)
    assert.equal(manifest.remote, world.remote)
    assert.equal(manifest.branch, 'main')
    assert.equal('path' in manifest, false, 'the local path is not in the manifest')
    // And the manifest travelled to the remote with the commit.
    assert.ok(git(world.remote, ['ls-tree', '--name-only', 'main']).includes('.dsh-sync.json'))
  } finally {
    world.cleanup()
  }
})

test('a turn outside every area is ignored', async () => {
  const world = makeWorld()
  try {
    writeFileSync(join(world.work, 'a.txt'), 'hello\n')
    const host = stubHostContext(fakeSubprocess())
    const config = Config({ areas: [areaFor(world)], debounceMs: 0 })
    host.state.config = config
    apply(host.ctx, config)

    host.emit('session/event', { header: { cwd: world.root } }, { type: 'turn/end', data: { turn: 1 } })
    await delay(600)

    assert.equal(host.state.status.history.length, 0, 'nothing was synced')
    assert.throws(() => git(world.remote, ['rev-parse', 'main']), 'the remote stayed empty')
  } finally {
    world.cleanup()
  }
})

test('syncAllOnTurnEnd makes an unrelated turn sync every enabled area', async () => {
  const world = makeWorld()
  try {
    writeFileSync(join(world.work, 'a.txt'), 'hello\n')
    const host = stubHostContext(fakeSubprocess())
    const config = Config({ areas: [areaFor(world)], debounceMs: 0, syncAllOnTurnEnd: true })
    host.state.config = config
    apply(host.ctx, config)

    host.emit('session/event', { header: { cwd: world.root } }, { type: 'turn/end', data: { turn: 2 } })

    const settled = await waitFor(() => host.state.status.history.length > 0)
    assert.ok(settled, 'the unrelated turn still synced')
    assert.equal(host.state.status.areas[0].status, 'ok')
  } finally {
    world.cleanup()
  }
})

test('bursts of turn boundaries coalesce into one pass', async () => {
  const world = makeWorld()
  try {
    writeFileSync(join(world.work, 'a.txt'), 'hello\n')
    const host = stubHostContext(fakeSubprocess())
    const config = Config({ areas: [areaFor(world)], debounceMs: 400 })
    host.state.config = config
    apply(host.ctx, config)

    for (let turn = 1; turn <= 4; turn += 1) {
      host.emit('session/event', { header: { cwd: world.work } }, { type: 'turn/end', data: { turn } })
      await delay(30)
    }

    const settled = await waitFor(() => host.state.status.history.length > 0)
    assert.ok(settled, 'the coalesced pass ran')
    await delay(500)
    assert.equal(host.state.status.history.length, 1, `expected one coalesced pass, got ${host.state.status.history.length}`)
  } finally {
    world.cleanup()
  }
})

test('syncOnTurnEnd: false disables turn-boundary syncing', async () => {
  const world = makeWorld()
  try {
    writeFileSync(join(world.work, 'a.txt'), 'hello\n')
    const host = stubHostContext(fakeSubprocess())
    const config = Config({ areas: [areaFor(world)], debounceMs: 0, syncOnTurnEnd: false })
    host.state.config = config
    apply(host.ctx, config)

    host.emit('session/event', { header: { cwd: world.work } }, { type: 'turn/end', data: { turn: 1 } })
    await delay(600)
    assert.equal(host.state.status.history.length, 0)
  } finally {
    world.cleanup()
  }
})

test('a failing sync never throws out of the turn-boundary listener', async () => {
  const world = makeWorld()
  try {
    const host = stubHostContext(fakeSubprocess())
    // A folder that does not exist: validation fails before git is invoked.
    const config = Config({
      areas: [areaFor(world, { path: join(world.root, 'missing') })],
      debounceMs: 0,
    })
    host.state.config = config
    apply(host.ctx, config)

    assert.doesNotThrow(() => {
      host.emit('session/event', { header: { cwd: world.root } }, { type: 'turn/end', data: { turn: 1 } })
    })

    const settled = await waitFor(() => host.state.status.areas.some(area => area.status === 'error'))
    assert.ok(settled, 'the folder problem was reported')
    assert.match(host.state.status.areas[0].detail, /不存在/u)
    assert.equal(host.state.status.running, false, 'the run flag is cleared')
  } finally {
    world.cleanup()
  }
})
