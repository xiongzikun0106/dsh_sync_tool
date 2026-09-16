/**
 * Mode S end to end: a work area whose folder is already a git repository.
 *
 * This is the behaviour the whole redesign exists for. The folder is somebody's
 * project — their branch, their remote, their unfinished work — and a sync pass
 * must publish the conversation archive without touching any of it. Everything
 * here is a real git repository except the session store, which is the same
 * in-memory stand-in the session suite uses.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, Config } from '../lib/index.js'
import { delay, fakePersistence, fakeSubprocess, git, installHermeticGitEnv, makeWorld } from './helpers.mjs'

installHermeticGitEnv()

const SESSION_ID = 'session-77777777-8888-9999-aaaa-bbbbbbbbbbbb'

/** A host context: git runs for real, sessions come from the stand-in. */
function stubHostContext(subprocess, persistence) {
  const listeners = new Map()
  const disposers = []
  const state = {
    config: { workspaces: [] },
    status: { revision: 0, running: false, updatedAt: 0, workspaces: [], probes: [], history: [] },
  }
  const ctx = {
    get: (service) => {
      if (service === 'subprocess') return subprocess
      if (service === 'sessionPersistence') return persistence
      return undefined
    },
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
      const scoped = { ...ctx }
      if (_dependencies.includes('settings')) {
        scoped.settings = {
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
        }
      }
      if (_dependencies.includes('systemPrompt')) {
        scoped.systemPrompt = { context: () => () => {} }
      }
      callback(scoped)
    },
  }
  return {
    ctx,
    state,
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

/** One logical stored event, shaped like a decoded one. */
function event(seq) {
  return {
    type: seq === 0 ? 'turn/start' : 'user/message',
    seq,
    time: 1700000000000 + seq,
    data: seq === 0
      ? { turn: 1 }
      : { id: `m${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `line ${seq}` }] },
    ...(seq === 0 ? {} : { surfaceOp: 'append' }),
  }
}

/** Turn a scratch folder into a project: its own repository, remote and commit. */
function makeProject(world, sessionsRemote) {
  writeFileSync(join(world.work, 'project.txt'), 'a real project\n')
  git(world.work, ['init', '-b', 'main'])
  git(world.work, ['add', '-A'])
  git(world.work, ['commit', '-m', 'project commit'])
  git(world.work, ['remote', 'add', 'origin', world.remote])
  git(world.work, ['push', '-u', 'origin', 'main'])
  // Unfinished work that a sync pass must never commit or push.
  writeFileSync(join(world.work, 'wip.txt'), 'work in progress\n')
  mkdirSync(sessionsRemote, { recursive: true })
  execFileSync('git', ['init', '--bare', '-b', 'main', sessionsRemote], { stdio: 'ignore' })
}

test('a project repository is left untouched while its conversations travel', async () => {
  const world = makeWorld()
  try {
    const sessionsRemote = join(world.root, 'sessions.git')
    const mirrors = join(world.root, 'mirrors')
    makeProject(world, sessionsRemote)

    const before = {
      log: git(world.work, ['log', '--oneline']).trim(),
      status: git(world.work, ['status', '--porcelain']).trim(),
      remoteHead: git(world.remote, ['rev-parse', 'main']).trim(),
      branch: git(world.work, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      origin: git(world.work, ['remote', 'get-url', 'origin']).trim(),
    }

    const persistence = fakePersistence([{
      header: {
        version: 3,
        id: SESSION_ID,
        createdAt: 1700000000000,
        cwd: world.work,
        isSeeded: false,
        delegationDepth: 0,
        agentPreset: 'standard',
      },
      events: [event(0), event(1), event(2)],
    }])

    const host = stubHostContext(fakeSubprocess(), persistence)
    const config = Config({
      sessionsRemote,
      sessionsRoot: mirrors,
      debounceMs: 0,
      sessions: { statePath: join(world.root, 'state.json') },
      // `auto` is the default and the interesting case: the probe decides.
      workspaces: [{ path: world.work }],
    })
    host.state.config = config
    apply(host.ctx, config)

    host.emit('session/event', { id: SESSION_ID, header: { cwd: world.work } }, { type: 'turn/end', data: { turn: 1 } })
    const settled = await waitFor(() => host.state.status.history.length > 0)
    assert.ok(settled, 'the turn boundary produced a pass')

    const [workspace] = host.state.status.workspaces
    assert.equal(workspace.mode, 'sessions', 'an existing repository is recognised and not synced in place')
    assert.equal(workspace.status, 'ok', workspace.detail)
    assert.equal(workspace.remote, sessionsRemote, 'the pass reports the repository it published to')

    // --- the project repository is exactly as it was ---
    assert.equal(git(world.work, ['log', '--oneline']).trim(), before.log, 'no commit was added')
    assert.equal(git(world.work, ['status', '--porcelain']).trim(), before.status, 'the working tree is unchanged')
    assert.equal(git(world.remote, ['rev-parse', 'main']).trim(), before.remoteHead, 'nothing was pushed')
    assert.equal(git(world.work, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), before.branch)
    assert.equal(git(world.work, ['remote', 'get-url', 'origin']).trim(), before.origin)
    assert.equal(
      git(world.work, ['ls-files']).includes('.dsh-sessions'),
      false,
      'the archive never enters the project repository',
    )
    assert.equal(existsSync(join(world.work, 'wip.txt')), true, 'unfinished work is still there')
    // The archive is hidden from the project's own `git status` through the
    // repository-private exclude list, not through a tracked `.gitignore`, so
    // the user never sees an unexplained edit and `git add -A` cannot sweep the
    // conversations into the project.
    assert.equal(
      readFileSync(join(world.work, '.git', 'info', 'exclude'), 'utf8').trim().endsWith('.dsh-sessions/'),
      true,
      'the private exclude list hides the archive',
    )
    assert.equal(existsSync(join(world.work, '.gitignore')), false, 'no tracked file was created or edited')

    // --- the archive landed in the local folder and in the sessions repository ---
    const archiveDir = join(world.work, '.dsh-sessions')
    assert.deepEqual(
      readdirSync(archiveDir).sort(),
      ['.dsh-sync.json', `${SESSION_ID}.jsonl.zstd`],
      'the archive directory carries the conversations and its own claim manifest',
    )

    const tracked = git(sessionsRemote, ['ls-tree', '-r', '--name-only', 'main'])
    assert.match(tracked, new RegExp(`${SESSION_ID}\\.jsonl\\.zstd`, 'u'), 'the archive was published')
    assert.match(tracked, /\.dsh-sync\.json/u, 'the mirror carries its own manifest for the next machine')

    // The manifest inside the archive directory is what lets a second machine
    // claim the folder without typing the repository again.
    const manifestPath = tracked.split('\n').find(line => line.endsWith('.dsh-sync.json'))
    assert.ok(manifestPath !== undefined, 'the mirror carries a claim manifest')
    const manifest = JSON.parse(git(sessionsRemote, ['show', `main:${manifestPath}`]))
    assert.equal(manifest.mode, 'sessions')
    assert.equal(manifest.remote, sessionsRemote)
    assert.equal('path' in manifest, false, 'no machine-local facts travel')
  } finally {
    world.cleanup()
  }
})

test('an explicit folder mode still publishes the whole folder', async () => {
  const world = makeWorld()
  try {
    // A folder inside another checkout: the default refuses, an explicit
    // `folder` mode with `nestedRepos: init` is the operator asking for it.
    const outer = join(world.root, 'outer')
    mkdirSync(outer, { recursive: true })
    git(outer, ['init', '-b', 'main'])
    const inner = join(outer, 'inner')
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(inner, 'plugin.js'), 'export default 1\n')

    const persistence = fakePersistence([{
      header: { version: 3, id: SESSION_ID, createdAt: 1, cwd: inner, isSeeded: false, delegationDepth: 0 },
      events: [event(0)],
    }])
    const host = stubHostContext(fakeSubprocess(), persistence)
    const config = Config({
      debounceMs: 0,
      sessions: { statePath: join(world.root, 'state.json') },
      workspaces: [{ path: inner, mode: 'folder', remote: world.remote, nestedRepos: 'init' }],
    })
    host.state.config = config
    apply(host.ctx, config)

    host.emit('session/event', { id: SESSION_ID, header: { cwd: inner } }, { type: 'turn/end', data: { turn: 2 } })
    assert.ok(await waitFor(() => host.state.status.history.length > 0), 'the pass ran')
    const [workspace] = host.state.status.workspaces
    assert.equal(workspace.status, 'ok', workspace.detail)
    assert.match(git(world.remote, ['ls-tree', '--name-only', 'main']), /plugin\.js/u, 'the folder was published')
  } finally {
    world.cleanup()
  }
})
