/**
 * Work-area resolution: translating a legacy document, deciding how one folder
 * syncs, and grouping a run's work.
 *
 * The decision this module makes is the difference between syncing a folder and
 * hijacking someone's repository, so every branch is pinned here.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Config, workspaceKey } from '../lib/contract.js'
import {
  areaOf, baseName, configuredWorkspaces, groupPasses, migrateConfig, mirrorDirFor, mirrorRoot,
  mirrorSubdir, resolveMode, sessionsRemoteFor,
} from '../lib/workspaces.js'

/** One configured work area, with the fields the defaults supply. */
function entry(overrides = {}) {
  return { ...Config({ workspaces: [{ path: 'D:/work/myWeb' }] }).workspaces[0], ...overrides }
}

/** One resolved member, as `groupPasses` consumes it. */
function member(overrides = {}) {
  const configured = entry(overrides.entry)
  return {
    entry: configured,
    key: workspaceKey(configured.path),
    title: baseName(configured.path),
    mode: overrides.mode ?? 'folder',
    remote: overrides.remote ?? configured.remote,
  }
}

test('the key normalizes separators and case only where the platform does', () => {
  assert.equal(workspaceKey('D:\\work\\myWeb\\'), workspaceKey('D:/work/myWeb'))
  assert.equal(workspaceKey('/home/me/work/A'), workspaceKey('/home/me/work/A'))
  assert.equal(workspaceKey(''), '')
  assert.equal(workspaceKey('   '), '')
  if (process.platform === 'win32') {
    assert.equal(workspaceKey('D:/Work/MyWeb'), workspaceKey('d:/work/myweb'))
  }
})

test('a legacy document folds into workspaces with its intent preserved', () => {
  const legacy = Config({ areas: [{ id: 'a1', name: 'Plugins', path: 'D:/work/plugins', remote: 'r', nestedRepos: 'init' }] })
  const migrated = migrateConfig(legacy)
  assert.equal(migrated.workspaces.length, 1)
  const [workspace] = migrated.workspaces
  assert.equal(workspace.path, 'D:/work/plugins')
  assert.equal(workspace.title, 'Plugins', 'the old display name becomes the title')
  assert.equal(workspace.remote, 'r')
  assert.equal(workspace.mode, 'folder', 'an old area synced its folder in place, and still does')
  assert.equal(workspace.nestedRepos, 'init', 'its nested-repository choice survives')

  // A document this version wrote wins: clearing `areas` on save must not
  // resurrect a work area the user removed.
  const current = Config({ workspaces: [{ path: 'E:/only' }], areas: [{ id: 'a1', path: 'D:/gone' }] })
  assert.deepEqual(migrateConfig(current).workspaces.map(w => w.path), ['E:/only'])
})

test('the configured list carries a stable key and a display title', () => {
  const configured = configuredWorkspaces(Config({
    workspaces: [{ path: 'D:/work/myWeb' }, { path: 'D:/work/other', title: 'Nickname' }],
  }))
  assert.deepEqual(configured.map(m => m.title), ['myWeb', 'Nickname'])
  assert.equal(configured[0].key, workspaceKey('D:/work/myWeb'))
  assert.equal(configured[0].entry.mode, 'auto')
})

test('auto mode leaves a plain directory alone but never touches a repository', () => {
  assert.equal(resolveMode(entry(), { kind: 'none' }), 'folder')
  assert.equal(resolveMode(entry(), { kind: 'repo' }), 'sessions')
  assert.equal(resolveMode(entry(), { kind: 'nested' }), 'sessions')
  assert.equal(resolveMode(entry(), { kind: 'error' }), 'folder', 'an unknown folder is treated as plain')
  assert.equal(resolveMode(entry(), undefined), 'folder')

  // An explicit choice always wins.
  assert.equal(resolveMode(entry({ mode: 'folder' }), { kind: 'repo' }), 'folder')
  assert.equal(resolveMode(entry({ mode: 'sessions' }), { kind: 'none' }), 'sessions')
})

test('a sessions work area prefers its own repository over the shared one', () => {
  const config = Config({ sessionsRemote: 'https://shared/sessions.git' })
  assert.equal(
    sessionsRemoteFor(entry({ remote: 'https://mine/sessions.git' }), config),
    'https://mine/sessions.git',
  )
  assert.equal(sessionsRemoteFor(entry(), config), 'https://shared/sessions.git')
  assert.equal(sessionsRemoteFor(entry(), Config({})), '')
})

test('a run groups by repository, and reports what has no remote', () => {
  const shared = 'https://shared/sessions.git'
  const groups = groupPasses([
    member({ entry: { path: 'D:/plain' }, mode: 'folder', remote: 'https://a/plain.git' }),
    member({ entry: { path: 'D:/proj-a' }, mode: 'sessions', remote: shared }),
    member({ entry: { path: 'D:/proj-b' }, mode: 'sessions', remote: shared }),
    member({ entry: { path: 'D:/proj-c' }, mode: 'sessions', remote: 'https://mine/c.git' }),
    member({ entry: { path: 'D:/unset' }, mode: 'sessions', remote: '' }),
    member({ entry: { path: 'D:/plain-unset' }, mode: 'folder', remote: '' }),
  ])
  assert.deepEqual(groups.folders.map(m => m.entry.path), ['D:/plain'])
  assert.equal(groups.repos.length, 2, 'two repositories, three sessions work areas')
  const byRemote = new Map(groups.repos.map(bucket => [bucket.remote, bucket.members.map(m => m.entry.path)]))
  assert.deepEqual(byRemote.get(shared), ['D:/proj-a', 'D:/proj-b'])
  assert.deepEqual(byRemote.get('https://mine/c.git'), ['D:/proj-c'])
  assert.deepEqual(groups.unconfigured.map(m => m.entry.path), ['D:/unset', 'D:/plain-unset'])
})

test('a mirror is keyed by its repository and by where it is rooted', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sync-mirrors-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const one = mirrorDirFor('https://example/a.git', root)
  const two = mirrorDirFor('https://example/a.git', root)
  const other = mirrorDirFor('https://example/b.git', root)
  assert.equal(one, two, 'the same repository reuses one mirror')
  assert.notEqual(one, other)
  assert.ok(one.startsWith(root))
  assert.equal(mirrorRoot(Config({ sessionsRoot: root })), root)
  assert.match(mirrorRoot(Config({})), /sync-tool[\\/]repos$/u)
})

test('a shared repository gives each work area its own folder', () => {
  const first = member({ entry: { path: 'D:/work/myWeb' } })
  const second = member({ entry: { path: 'D:/work/myWeb' } })
  const other = member({ entry: { path: 'D:/other/myWeb' } })
  assert.equal(mirrorSubdir(first, true), mirrorSubdir(second, true), 'the same folder is stable')
  assert.notEqual(mirrorSubdir(first, true), mirrorSubdir(other, true), 'same basename, different folder')
  assert.match(mirrorSubdir(first, true), /^myWeb-[0-9a-f]{6}$/u)
  assert.equal(mirrorSubdir(first, false), '', 'a dedicated repository uses its root')
})

test('the area the engine consumes carries the entry and the overrides', () => {
  const configured = member({
    entry: {
      path: 'D:/work/myWeb',
      remote: 'https://a/b.git',
      branch: 'trunk',
      credentialRef: 'TOKEN',
      direction: 'push',
      nestedRepos: 'init',
      guardSensitive: false,
    },
  })
  const area = areaOf(configured, { path: '/mirror/x', commitPaths: ['.dsh-sessions'], remote: 'https://c/d.git' })
  assert.equal(area.id, configured.key)
  assert.equal(area.path, '/mirror/x')
  assert.equal(area.remote, 'https://c/d.git')
  assert.equal(area.branch, 'trunk')
  assert.equal(area.credentialRef, 'TOKEN')
  assert.equal(area.direction, 'push')
  assert.deepEqual(area.commitPaths, ['.dsh-sessions'])
  assert.equal(area.guardSensitive, false)
  assert.equal(area.nestedRepos, 'init')
  assert.equal(areaOf(configured).path, 'D:/work/myWeb', 'a path override is optional')
})
