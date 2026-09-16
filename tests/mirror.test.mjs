/**
 * Mirror copy semantics.
 *
 * The two directions are deliberately asymmetric — into a mirror removes what
 * the source no longer has, out of a mirror never deletes — and this is where a
 * regression would quietly destroy somebody's local archive.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { listFiles, mergeDirectory, mirrorDirectory } from '../lib/mirror.js'

/** A scratch root removed when the test ends. */
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sync-mirror-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}

/** Write one file, creating parents. */
function put(root, name, body) {
  const path = join(root, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

test('every file below a directory is listed, and .git never is', (t) => {
  const root = scratch(t)
  put(root, 'a.jsonl.zstd', 'a')
  put(root, 'conflicts/b.local.jsonl', 'b')
  put(root, '.git/config', 'not yours')
  assert.deepEqual(listFiles(root).sort(), ['a.jsonl.zstd', join('conflicts', 'b.local.jsonl')])
  assert.deepEqual(listFiles(join(root, 'missing')), [], 'an absent directory lists nothing')
})

test('mirroring copies, refreshes and removes', (t) => {
  const root = scratch(t)
  const source = join(root, 'source')
  const target = join(root, 'target')
  put(source, 'one.jsonl', 'one')
  put(source, 'nested/two.jsonl', 'two')
  const first = mirrorDirectory(source, target)
  assert.deepEqual(first, { copied: 2, removed: 0 })
  assert.equal(readFileSync(join(target, 'one.jsonl'), 'utf8'), 'one')
  assert.equal(readFileSync(join(target, 'nested', 'two.jsonl'), 'utf8'), 'two')

  const second = mirrorDirectory(source, target)
  assert.deepEqual(second, { copied: 0, removed: 0 }, 'an unchanged source copies nothing')

  // A deletion at the source is a deletion in the mirror: the user deleting a
  // conversation should stop publishing it.
  rmSync(join(source, 'nested', 'two.jsonl'))
  const third = mirrorDirectory(source, target)
  assert.equal(third.removed, 1)
  assert.equal(readdirSync(target).includes('nested'), true, 'the empty directory may remain')
  assert.deepEqual(listFiles(target), ['one.jsonl'])

  // An absent source says nothing at all: a folder that is temporarily
  // unavailable must never wipe what another machine published.
  assert.equal(mirrorDirectory(join(root, 'gone'), target), undefined)
  assert.deepEqual(listFiles(target), ['one.jsonl'])
})

test('merging copies and refreshes but never deletes', (t) => {
  const root = scratch(t)
  const source = join(root, 'source')
  const target = join(root, 'target')
  put(source, 'shared.jsonl', 'from-mirror')
  put(target, 'local-only.jsonl', 'mine')
  put(target, 'shared.jsonl', 'stale')

  const result = mergeDirectory(source, target)
  assert.deepEqual(result, { copied: 1 })
  assert.equal(readFileSync(join(target, 'shared.jsonl'), 'utf8'), 'from-mirror')
  assert.equal(readFileSync(join(target, 'local-only.jsonl'), 'utf8'), 'mine', 'the local archive survives')

  assert.equal(mergeDirectory(join(root, 'gone'), target), undefined)
  assert.deepEqual(listFiles(target).sort(), ['local-only.jsonl', 'shared.jsonl'])
})
