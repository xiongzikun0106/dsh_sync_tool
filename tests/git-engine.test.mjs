/**
 * Git engine integration tests against a real bare repository.
 *
 * `ctx.subprocess` is faked with `node:child_process`, but every git invocation
 * is genuine: real repositories, real branches, real rebases and real
 * conflicts. Run with `node --test tests/*.test.mjs`.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

import {
  buildCommitMessage, GitEngine, normalizePath, porcelainPath, scrubSecrets,
} from '../lib/git.js'

/** A `ctx.subprocess` stand-in that really spawns the requested argv. */
function fakeSubprocess() {
  return {
    async resolveExecutable(command) { return command },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      const done = new Promise((resolve) => {
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      const reader = (get) => ({ readFrom: () => ({ text: get(), nextOffset: 0, lossy: false }) })
      return {
        stdin: undefined,
        stdout: child.stdout,
        stderr: child.stderr,
        collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) },
        done,
        terminate() { child.kill() },
        async waitForExit() { await done; return true },
      }
    },
  }
}

/** A ctx exposing only the services the engine reads. */
function engineContext() {
  const subprocess = fakeSubprocess()
  return { get: (service) => (service === 'subprocess' ? subprocess : undefined) }
}

/** Run git for test setup. */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Build a scratch world: one bare remote, one working clone. */
function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sync-test-'))
  const remote = join(root, 'remote.git')
  const work = join(root, 'work-a')
  mkdirSync(remote, { recursive: true })
  mkdirSync(work, { recursive: true })
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' })
  return { root, remote, work, cleanup: () => { rmSync(root, { recursive: true, force: true }) } }
}

/** The area shape the engine consumes. */
function areaFor(world, overrides = {}) {
  return {
    id: 'a1',
    name: 'A',
    path: world.work,
    remote: world.remote,
    branch: 'main',
    credentialRef: '',
    direction: 'both',
    enabled: true,
    autoCommit: true,
    extraIgnores: [],
    guardSensitive: true,
    ...overrides,
  }
}

const CONFIG = { commitMessageTemplate: 'dsh-sync: {host} {time} (turn {turn})' }

// Keep commits hermetic regardless of the machine's global git identity.
process.env.GIT_AUTHOR_NAME = 'dsh-sync-test'
process.env.GIT_AUTHOR_EMAIL = 'dsh-sync-test@example.invalid'
process.env.GIT_COMMITTER_NAME = 'dsh-sync-test'
process.env.GIT_COMMITTER_EMAIL = 'dsh-sync-test@example.invalid'
// This machine's home directory is itself a git repository, which would make
// every scratch folder look like it sits inside a parent checkout. Cap git's
// upward search at the system temp directory so each test owns its own world.
process.env.GIT_CEILING_DIRECTORIES = tmpdir()

test('pure helpers behave', () => {
  assert.equal(normalizePath('D:\\Work\\Plugins\\'), 'd:/work/plugins')
  assert.equal(porcelainPath(' M src/index.js'), 'src/index.js')
  assert.equal(porcelainPath('R  old.js -> new.js'), 'new.js')
  assert.equal(scrubSecrets('token=abc123456 ok', ['abc123456']), 'token=*** ok')
  assert.equal(scrubSecrets('short', ['abc']), 'short', 'too-short secrets are not rewritten')
  const message = buildCommitMessage('dsh-sync: {host} {time} (turn {turn})', 7, new Date('2026-01-01T00:00:00Z'))
  assert.match(message, /^dsh-sync: \S+ 2026-01-01T00:00:00\.000Z \(turn 7\)$/u)
})

test('first sync initialises the repository, commits and pushes', async () => {
  const world = makeWorld()
  try {
    writeFileSync(join(world.work, 'a.txt'), 'hello\n')
    const engine = new GitEngine(engineContext())
    const result = await engine.syncArea({ area: areaFor(world), config: CONFIG, turn: 1 })

    assert.equal(result.status, 'ok', result.detail)
    assert.match(result.detail, /已提交/u)
    assert.notEqual(result.head, '')

    // The remote actually received it.
    const remoteHead = git(world.remote, ['rev-parse', 'main']).trim()
    assert.equal(remoteHead, result.head)
    // A default .gitignore was written into the folder.
    assert.ok(existsSync(join(world.work, '.gitignore')))
    assert.match(readFileSync(join(world.work, '.gitignore'), 'utf8'), /node_modules\//u)
  } finally {
    world.cleanup()
  }
})

test('a second pass with no changes is a no-op, not a failure', async () => {
  const world = makeWorld()
  try {
    writeFileSync(join(world.work, 'a.txt'), 'hello\n')
    const engine = new GitEngine(engineContext())
    const first = await engine.syncArea({ area: areaFor(world), config: CONFIG, turn: 1 })
    const second = await engine.syncArea({ area: areaFor(world), config: CONFIG, turn: 2 })

    assert.equal(second.status, 'ok', second.detail)
    assert.doesNotMatch(second.detail, /已提交/u, 'nothing was committed the second time')
    assert.equal(second.head, first.head, 'HEAD did not move')
    // `.gitignore` is written before staging, so the first pass produced exactly
    // one commit carrying the file and the ignore rules together.
    const count = git(world.remote, ['rev-list', '--count', 'main']).trim()
    assert.equal(count, '1')
  } finally {
    world.cleanup()
  }
})

test('a divergent remote is rebased onto and then pushed', async () => {
  const world = makeWorld()
  try {
    writeFileSync(join(world.work, 'a.txt'), 'hello\n')
    const engine = new GitEngine(engineContext())
    await engine.syncArea({ area: areaFor(world), config: CONFIG, turn: 1 })

    // Machine B clones, changes a different file, and pushes.
    const other = join(world.root, 'work-b')
    execFileSync('git', ['clone', world.remote, other], { stdio: 'ignore' })
    writeFileSync(join(other, 'b.txt'), 'from machine B\n')
    git(other, ['add', '-A'])
    git(other, ['commit', '-m', 'from B'])
    git(other, ['push', 'origin', 'main'])

    // Machine A changes its own file, then syncs.
    writeFileSync(join(world.work, 'a.txt'), 'hello again\n')
    const result = await engine.syncArea({ area: areaFor(world), config: CONFIG, turn: 2 })

    assert.equal(result.status, 'ok', result.detail)
    assert.doesNotMatch(result.detail, /冲突/u)
    // A now carries B's file and B's commit is an ancestor of A's pushed head.
    assert.ok(existsSync(join(world.work, 'b.txt')), 'the remote change was integrated')
    assert.equal(git(world.remote, ['rev-parse', 'main']).trim(), result.head)
    const ancestors = git(world.remote, ['rev-list', 'main']).trim().split('\n')
    assert.ok(ancestors.length >= 3, `expected a rebased history, got ${String(ancestors.length)} commits`)
  } finally {
    world.cleanup()
  }
})

test('a real conflict stops with a conflict status and leaves the tree untouched', async () => {
  const world = makeWorld()
  try {
    writeFileSync(join(world.work, 'shared.txt'), 'base\n')
    const engine = new GitEngine(engineContext())
    await engine.syncArea({ area: areaFor(world), config: CONFIG, turn: 1 })

    const other = join(world.root, 'work-b')
    execFileSync('git', ['clone', world.remote, other], { stdio: 'ignore' })
    writeFileSync(join(other, 'shared.txt'), 'from B\n')
    git(other, ['add', '-A'])
    git(other, ['commit', '-m', 'B edits shared'])
    git(other, ['push', 'origin', 'main'])

    writeFileSync(join(world.work, 'shared.txt'), 'from A\n')
    const result = await engine.syncArea({ area: areaFor(world), config: CONFIG, turn: 2 })

    assert.equal(result.status, 'conflict', `expected conflict, got ${result.status}: ${result.detail}`)
    assert.match(result.detail, /保留本地文件/u)

    // The rebase was aborted: no rebase in progress, and A's content survived.
    assert.ok(!existsSync(join(world.work, '.git', 'rebase-merge')), 'no rebase left in progress')
    assert.ok(!existsSync(join(world.work, '.git', 'rebase-apply')), 'no rebase left in progress')
    assert.equal(readFileSync(join(world.work, 'shared.txt'), 'utf8').replaceAll('\r\n', '\n'), 'from A\n')
    // Nothing was pushed by the failed pass.
    assert.equal(git(other, ['rev-parse', 'main']).trim(), git(world.remote, ['rev-parse', 'main']).trim())
  } finally {
    world.cleanup()
  }
})

test('a staged credential file aborts the commit', async () => {
  const world = makeWorld()
  try {
    writeFileSync(join(world.work, 'a.txt'), 'hello\n')
    writeFileSync(join(world.work, '.credentials.yaml'), 'version: 1\n')
    const engine = new GitEngine(engineContext())
    const result = await engine.syncArea({ area: areaFor(world), config: CONFIG, turn: 1 })

    assert.equal(result.status, 'error')
    assert.match(result.detail, /敏感文件/u)
    assert.match(result.detail, /\.credentials\.yaml/u)
    // Nothing reached the remote.
    assert.throws(() => git(world.remote, ['rev-parse', 'main']))
  } finally {
    world.cleanup()
  }
})

test('a folder inside another checkout gets its own nested repository by default', async () => {
  const world = makeWorld()
  try {
    // An unrelated parent repository that already owns the folder.
    git(world.work, ['init', '-b', 'main'])
    writeFileSync(join(world.work, 'parent.txt'), 'parent repo content\n')

    const nested = join(world.work, 'nested')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'b.txt'), 'nested content\n')

    const engine = new GitEngine(engineContext())
    const result = await engine.syncArea({
      area: areaFor(world, { path: nested }),
      config: CONFIG,
      turn: 1,
    })

    assert.equal(result.status, 'ok', result.detail)
    assert.match(result.detail, /父仓库内独立仓库/u)
    // The nested folder became its own repository with its own remote.
    assert.equal(normalizePath(git(nested, ['rev-parse', '--show-toplevel'])), normalizePath(nested))
    assert.equal(normalizePath(git(nested, ['remote', 'get-url', 'origin'])), normalizePath(world.remote))
    // The parent repository was left alone.
    assert.equal(normalizePath(git(world.work, ['rev-parse', '--show-toplevel'])), normalizePath(world.work))
  } finally {
    world.cleanup()
  }
})

test('a folder inside another checkout is refused when configured to refuse', async () => {
  const world = makeWorld()
  try {
    git(world.work, ['init', '-b', 'main'])
    writeFileSync(join(world.work, 'parent.txt'), 'parent repo content\n')
    const nested = join(world.work, 'nested')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'b.txt'), 'nested content\n')

    const engine = new GitEngine(engineContext())
    const result = await engine.syncArea({
      area: areaFor(world, { path: nested, nestedRepos: 'refuse' }),
      config: CONFIG,
      turn: 1,
    })

    assert.equal(result.status, 'error')
    assert.match(result.detail, /另一个 git 仓库内部/u)
    // No repository was created in the refused folder.
    assert.ok(!existsSync(join(nested, '.git')), 'nothing was initialised')
  } finally {
    world.cleanup()
  }
})

test('push-only never pulls and pull-only never pushes', async () => {
  const world = makeWorld()
  try {
    writeFileSync(join(world.work, 'a.txt'), 'hello\n')
    const engine = new GitEngine(engineContext())
    await engine.syncArea({ area: areaFor(world), config: CONFIG, turn: 1 })

    // A pull-only area commits locally and never publishes.
    writeFileSync(join(world.work, 'local.txt'), 'local only\n')
    const pulled = await engine.syncArea({
      area: areaFor(world, { direction: 'pull' }),
      config: CONFIG,
      turn: 2,
    })
    assert.equal(pulled.status, 'ok', pulled.detail)
    assert.match(pulled.detail, /已拉取/u)
    const remoteTree = git(world.remote, ['ls-tree', '--name-only', 'main']).trim().split('\n')
    assert.ok(!remoteTree.includes('local.txt'), 'pull-only did not push the local commit')

    // A push-only area publishes without integrating.
    const pushed = await engine.syncArea({
      area: areaFor(world, { direction: 'push' }),
      config: CONFIG,
      turn: 3,
    })
    assert.equal(pushed.status, 'ok', pushed.detail)
    assert.match(pushed.detail, /已推送/u)
  } finally {
    world.cleanup()
  }
})

test('a missing remote is reported without failing the local commit', async () => {
  const world = makeWorld()
  try {
    writeFileSync(join(world.work, 'a.txt'), 'hello\n')
    const engine = new GitEngine(engineContext())
    const result = await engine.syncArea({
      area: areaFor(world, { remote: '' }),
      config: CONFIG,
      turn: 1,
    })
    assert.equal(result.status, 'ok', result.detail)
    assert.match(result.detail, /未配置远端/u)
    assert.notEqual(result.head, '')
  } finally {
    world.cleanup()
  }
})
