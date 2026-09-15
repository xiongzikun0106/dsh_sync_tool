/**
 * Git engine integration tests against a real bare repository.
 *
 * `ctx.subprocess` is faked with `node:child_process`, but every git invocation
 * is genuine: real repositories, real branches, real rebases and real
 * conflicts. Run with `node --test tests/*.test.mjs`.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  buildCommitMessage, GitEngine, isIdentityFailure, normalizePath, pathContains, porcelainPath,
  resolveCommitIdentity, scrubSecrets,
} from '../lib/git.js'
import {
  areaFor, CONFIG, engineContext, git, installHermeticGitEnv, makeWorld,
} from './helpers.mjs'

installHermeticGitEnv()

test('pure helpers behave', () => {
  // Case folding is Windows-only: a POSIX filesystem is case sensitive, so the
  // same input must NOT be folded there.
  assert.equal(
    normalizePath('D:\\Work\\Plugins\\'),
    process.platform === 'win32' ? 'd:/work/plugins' : 'D:/Work/Plugins',
  )
  assert.equal(normalizePath('/a/b///'), '/a/b', 'trailing separators are dropped')
  assert.equal(normalizePath('  /a/b  '), '/a/b', 'surrounding whitespace is dropped')

  // pathContains decides which areas a finished turn touches, so it must agree
  // with normalizePath on both platforms.
  assert.equal(pathContains('/work/plugins', '/work/plugins'), true, 'a folder contains itself')
  assert.equal(pathContains('/work/plugins', '/work/plugins/sub/dir'), true, 'a descendant matches')
  assert.equal(pathContains('/work/plugins', '/work/plugins-other'), false, 'a name prefix is not a descendant')
  assert.equal(pathContains('/work/plugins', '/work'), false, 'a parent does not match')
  assert.equal(pathContains('', '/work'), false, 'an empty root matches nothing')

  assert.equal(porcelainPath(' M src/index.js'), 'src/index.js')
  assert.equal(porcelainPath('R  old.js -> new.js'), 'new.js')
  assert.equal(scrubSecrets('token=abc123456 ok', ['abc123456']), 'token=*** ok')
  assert.equal(scrubSecrets('short', ['abc']), 'short', 'too-short secrets are not rewritten')
  const message = buildCommitMessage('dsh-sync: {host} {time} (turn {turn})', 7, new Date('2026-01-01T00:00:00Z'))
  assert.match(message, /^dsh-sync: \S+ 2026-01-01T00:00:00\.000Z \(turn 7\)$/u)
})

test('the fallback commit identity is configurable and clearly attributed', () => {
  const derived = resolveCommitIdentity({})
  assert.equal(derived.name, 'dsh-sync')
  assert.match(derived.email, /^dsh-sync@\S+$/u, 'the derived identity names the tool and the machine')

  assert.deepEqual(
    resolveCommitIdentity({ commitIdentity: { name: '  Ada  ', email: '  ada@example.com  ' } }),
    { name: 'Ada', email: 'ada@example.com' },
    'a configured identity is trimmed and wins',
  )
  assert.deepEqual(
    resolveCommitIdentity({ commitIdentity: { name: 'Ada', email: '' } }),
    { name: 'Ada', email: derived.email },
    'a half-configured identity keeps the derived email',
  )

  assert.equal(isIdentityFailure({ stderr: 'fatal: Author identity unknown' }), true)
  assert.equal(isIdentityFailure({ stderr: '*** Please tell me who you are.' }), true)
  assert.equal(isIdentityFailure({ stderr: 'fatal: not a git repository' }), false)
  assert.equal(isIdentityFailure(undefined), false)
})

test('a machine with no git identity still commits, using the announced fallback', async () => {
  const world = makeWorld()
  // Strip every identity source so this reproduces a freshly provisioned
  // machine: no GIT_AUTHOR_*, no user.name anywhere, and auto-detection refused.
  const keys = [
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
  ]
  const saved = new Map(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  process.env.GIT_CONFIG_GLOBAL = join(world.root, 'no-such-global-gitconfig')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'user.useConfigOnly'
  process.env.GIT_CONFIG_VALUE_0 = 'true'

  try {
    // Control: git itself must refuse the commit, or the test proves nothing.
    const dry = execFileSync('git', ['-C', world.work, 'init', '-b', 'main'], { stdio: 'ignore' })
    void dry
    writeFileSync(join(world.work, 'a.txt'), 'hello\n')
    execFileSync('git', ['-C', world.work, 'add', '-A'], { stdio: 'ignore' })
    let refused = false
    try {
      execFileSync('git', ['-C', world.work, 'commit', '-m', 'x'], { stdio: 'ignore' })
    } catch {
      refused = true
    }
    assert.ok(refused, 'the environment really has no commit identity')

    const engine = new GitEngine(engineContext())
    const result = await engine.syncArea({ area: areaFor(world), config: CONFIG, turn: 1 })

    assert.equal(result.status, 'ok', result.detail)
    assert.match(result.detail, /回退身份 dsh-sync/u, 'the substitution is announced, not hidden')
    assert.notEqual(result.head, '')

    const author = git(world.remote, ['log', '-1', '--format=%an <%ae>']).trim()
    assert.match(author, /^dsh-sync </u, `unexpected author: ${author}`)
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    world.cleanup()
  }
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
    // The counts are re-read after the push, so a published pass reports itself
    // level with the remote it just updated.
    assert.equal(result.ahead, 0, 'a pass that just pushed must not report itself ahead')
    assert.equal(result.behind, 0)

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

test('pass hooks write before the commit and read after the merge', async () => {
  const world = makeWorld()
  try {
    const engine = new GitEngine(engineContext())
    writeFileSync(join(world.work, 'from-a.txt'), 'a\n')
    await engine.syncArea({ area: areaFor(world), config: CONFIG, turn: 1 })

    // The second machine starts from what the first one published.
    const second = join(world.root, 'work-b')
    mkdirSync(second, { recursive: true })
    execFileSync('git', ['clone', world.remote, second], { stdio: 'ignore' })
    writeFileSync(join(world.work, 'from-a.txt'), 'a-changed-on-a\n')

    const order = []
    await engine.syncArea({
      area: areaFor(world),
      config: CONFIG,
      turn: 2,
      hooks: {
        beforeCommit: (area) => {
          // Written here, so this very commit publishes it.
          writeFileSync(join(area.path, 'collected.txt'), 'session archive\n')
          order.push('beforeCommit')
        },
        afterIntegrate: () => { order.push('afterIntegrate') },
      },
    })
    assert.deepEqual(order, ['beforeCommit', 'afterIntegrate'])
    assert.match(
      git(world.remote, ['show', 'main:collected.txt']),
      /session archive/u,
      'what beforeCommit writes reaches the remote in the same pass',
    )

    let seen
    await engine.syncArea({
      area: areaFor(world, { id: 'a2', path: second }),
      config: CONFIG,
      turn: 3,
      hooks: { afterIntegrate: (area) => { seen = readFileSync(join(area.path, 'from-a.txt'), 'utf8') } },
    })
    assert.equal(
      (seen ?? '').replace(/\r\n/gu, '\n'),
      'a-changed-on-a\n',
      'afterIntegrate runs once the working tree holds the merged content',
    )
  } finally {
    world.cleanup()
  }
})

test('a throwing pass hook is reported and never fails the git pass', async () => {
  const world = makeWorld()
  try {
    writeFileSync(join(world.work, 'a.txt'), 'hello\n')
    const engine = new GitEngine(engineContext())
    const result = await engine.syncArea({
      area: areaFor(world),
      config: CONFIG,
      turn: 1,
      hooks: {
        beforeCommit: () => { throw new Error('session store exploded') },
        afterIntegrate: () => ['会话↓1'],
      },
    })
    assert.equal(result.status, 'ok')
    assert.match(result.detail, /附加步骤失败：session store exploded/u)
    assert.match(result.detail, /会话↓1/u, 'a hook that returns fragments contributes them to the status')
  } finally {
    world.cleanup()
  }
})

test('a second pass with no changes is a no-op, not a failure', async () => {  const world = makeWorld()
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

test('extraIgnores take effect, and the ignore file is not churned', async () => {
  const world = makeWorld()
  try {
    writeFileSync(join(world.work, 'a.txt'), 'hello\n')
    writeFileSync(join(world.work, 'scratch.tmp'), 'not for the remote\n')
    const engine = new GitEngine(engineContext())
    const area = areaFor(world, { extraIgnores: ['*.tmp'] })

    const result = await engine.syncArea({ area, config: CONFIG, turn: 1 })
    assert.equal(result.status, 'ok', result.detail)

    const ignorePath = join(world.work, '.gitignore')
    const written = readFileSync(ignorePath, 'utf8')
    assert.match(written, /^\*\.tmp$/mu, 'the configured pattern is present')
    assert.match(written, /^node_modules\/$/mu, 'the built-in rules are present too')

    // The pattern is written before staging, so the file never reaches the remote.
    const tracked = git(world.remote, ['ls-tree', '-r', '--name-only', 'main']).trim().split('\n')
    assert.ok(!tracked.includes('scratch.tmp'), `scratch.tmp should be ignored, tree=${JSON.stringify(tracked)}`)

    // A second pass must not rewrite or duplicate.
    await engine.syncArea({ area, config: CONFIG, turn: 2 })
    const after = readFileSync(ignorePath, 'utf8')
    assert.equal(after, written, 'nothing missing means nothing rewritten')
    assert.equal((after.match(/^\*\.tmp$/gmu) ?? []).length, 1, 'the pattern is not duplicated')
  } finally {
    world.cleanup()
  }
})
