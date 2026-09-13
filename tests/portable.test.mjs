/**
 * Portable manifest round-trip. The manifest is what lets a second machine
 * adopt a folder, so it must carry the machine-independent facts and nothing
 * that belongs to the machine that wrote it.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  areaFromManifest, baseName, MANIFEST_NAME, manifestFor, readManifest, writeManifest,
} from '../lib/portable.js'

/** A fully populated area, including the machine-local fields. */
const AREA = {
  id: 'a1',
  name: 'My Plugins',
  path: 'D:/work/plugins',
  remote: 'https://example.invalid/me/dsh-sync.git',
  branch: 'trunk',
  credentialRef: 'DSH_SYNC_GIT_TOKEN',
  direction: 'push',
  enabled: false,
  autoCommit: false,
  extraIgnores: ['*.tmp'],
  guardSensitive: true,
  nestedRepos: 'refuse',
}

test('the manifest carries only machine-independent facts', () => {
  const manifest = manifestFor(AREA)
  assert.deepEqual(manifest, {
    version: 1,
    name: 'My Plugins',
    remote: 'https://example.invalid/me/dsh-sync.git',
    branch: 'trunk',
    direction: 'push',
    autoCommit: false,
    guardSensitive: true,
    nestedRepos: 'refuse',
    extraIgnores: ['*.tmp'],
  })
  // The machine-local facts must never travel.
  assert.equal('path' in manifest, false, 'the local path stays local')
  assert.equal('id' in manifest, false, 'the area id stays local')
  assert.equal('credentialRef' in manifest, false, 'the credential reference stays local')
  assert.equal('enabled' in manifest, false, 'the enabled flag stays local')
})

test('a manifest round-trips through disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sync-manifest-'))
  try {
    const path = writeManifest(dir, AREA)
    assert.equal(path, join(dir, MANIFEST_NAME))
    assert.deepEqual(readManifest(dir), manifestFor(AREA))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing or foreign manifest reads as absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sync-manifest-'))
  try {
    assert.equal(readManifest(dir), undefined, 'no file at all')
    writeFileSync(join(dir, MANIFEST_NAME), 'not json', 'utf8')
    assert.equal(readManifest(dir), undefined, 'unparseable')
    writeFileSync(join(dir, MANIFEST_NAME), '{"version":99}', 'utf8')
    assert.equal(readManifest(dir), undefined, 'unknown version')
    writeFileSync(join(dir, MANIFEST_NAME), '[1,2,3]', 'utf8')
    assert.equal(readManifest(dir), undefined, 'not an object')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an imported area takes its identity and secrets from this machine', () => {
  const area = areaFromManifest('E:/elsewhere/plugins', manifestFor(AREA), 'imported-abc')
  assert.equal(area.id, 'imported-abc', 'the id is minted locally')
  assert.equal(area.path, 'E:/elsewhere/plugins', 'the path is the local one')
  assert.equal(area.credentialRef, '', 'no credential reference is inherited')
  assert.equal(area.enabled, true, 'an imported area starts enabled')
  assert.equal(area.remote, AREA.remote, 'the remote travels')
  assert.equal(area.branch, 'trunk', 'the branch travels')
  assert.equal(area.direction, 'push', 'the direction travels')
  assert.equal(area.autoCommit, false)
  assert.equal(area.nestedRepos, 'refuse')
  assert.deepEqual(area.extraIgnores, ['*.tmp'])
})

test('an imported area falls back to its folder name and defaults', () => {
  const area = areaFromManifest('E:/elsewhere/my-plugins/', { version: 1 }, 'imported-xyz')
  assert.equal(area.name, 'my-plugins')
  assert.equal(area.branch, 'main')
  assert.equal(area.direction, 'both')
  assert.equal(area.enabled, true)
  assert.equal(area.nestedRepos, 'init')
  assert.equal(area.remote, '')
  assert.equal(baseName('E:/elsewhere/my-plugins/'), 'my-plugins')
  assert.equal(baseName('D:\\work\\plugins'), 'plugins')
})

test('the manifest file it writes is stable and newline-terminated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sync-manifest-'))
  try {
    writeManifest(dir, AREA)
    const first = readFileSync(join(dir, MANIFEST_NAME), 'utf8')
    writeManifest(dir, { ...AREA, path: 'D:/a/different/path', id: 'other' })
    const second = readFileSync(join(dir, MANIFEST_NAME), 'utf8')
    assert.equal(first, second, 'machine-local changes do not churn the manifest')
    assert.ok(first.endsWith('\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
