/**
 * Session-record synchronisation contract.
 *
 * These tests run against an in-memory stand-in for `sessionPersistence` that
 * enforces the same invariants the real backend does — contiguous appends, a
 * create that refuses an existing id, an opaque revision that changes on every
 * write — so a passing run means the engine drives the documented contract
 * correctly rather than merely agreeing with itself.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  archiveEntry, archiveName, compareEventLogs, decodeArchive, encodeArchive, inheritedEventCount,
  parseSessionArchive, SESSIONS_DIR, serializeSession, sessionInArea, SessionState, SessionSync,
} from '../lib/sessions.js'
import { installDeviceNotice, NOTICE_NAME, noticeText } from '../lib/notice.js'

const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'

/** One logical event, shaped exactly like a decoded stored event. */
function event(seq, type = 'user/message', extra = {}) {
  return {
    type,
    seq,
    time: 1700000000000 + seq,
    data: type === 'user/message'
      ? { content: [{ type: 'text', text: `line ${seq}` }] }
      : { note: seq },
    surfaceOp: 'append',
    ...extra,
  }
}

/** A header shaped like the real logical `SessionHeader`. */
function header(overrides = {}) {
  return {
    version: 3,
    id: SESSION_ID,
    createdAt: 1700000000000,
    cwd: 'D:\\work\\area',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
    ...overrides,
  }
}

/**
 * An in-memory `sessionPersistence` stand-in that keeps the documented
 * invariants: appends must be contiguous, `create` refuses a live id, and every
 * mutation moves the opaque revision.
 */
export function fakePersistence(initial = []) {
  const store = new Map()
  const handles = []
  let counter = 0
  const stamp = (record) => { record.revision = `r${++counter}` }
  for (const entry of initial) {
    const record = { header: structuredClone(entry.header), events: structuredClone(entry.events) }
    stamp(record)
    store.set(record.header.id, record)
  }
  const snapshot = (record) => ({ header: structuredClone(record.header), revision: record.revision })
  const view = (record) => ({
    id: record.header.id,
    get header() { return structuredClone(record.header) },
    async read() { return { events: structuredClone(record.events) } },
    async append(events) {
      const base = record.events.length
      for (const [index, item] of events.entries()) {
        assert.equal(item.seq, base + index, 'append must be contiguous with the stored log')
      }
      for (const item of events) record.events.push(structuredClone(item))
      stamp(record)
    },
    async flush() {},
    async close() {},
  })
  return {
    store,
    handles,
    async list() { return [...store.values()].map(snapshot) },
    async stat(id) { const record = store.get(id); return record === undefined ? undefined : snapshot(record) },
    async open(id, access) {
      const record = store.get(id)
      if (record === undefined) throw new Error(`session "${id}" not found`)
      const handle = view(record)
      handles.push({ id, access })
      return handle
    },
    async create(created, options = {}) {
      if (store.has(created.id)) throw new Error(`session "${created.id}" already exists`)
      assert.equal(created.version, 3, 'create requires the current logical version')
      if (created.isSeeded === true) {
        assert.ok(Number.isSafeInteger(options.inheritedEventCount), 'a seeded create requires its cut')
      }
      const record = { header: structuredClone(created), events: [] }
      stamp(record)
      store.set(created.id, record)
      return view(record)
    },
  }
}

/** A scratch area plus a machine-local state file. */
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sync-sessions-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const areaPath = join(root, 'area')
  mkdirSync(areaPath, { recursive: true })
  return {
    root,
    areaPath,
    statePath: join(root, 'state', 'sessions.json'),
    area: { id: 'a1', path: areaPath },
    /** A header whose `cwd` is inside this area, so it is in scope. */
    header: (overrides = {}) => header({ cwd: areaPath, ...overrides }),
    /** The archive directory, created on demand. */
    archiveDir: () => {
      const dir = join(areaPath, SESSIONS_DIR)
      mkdirSync(dir, { recursive: true })
      return dir
    },
    /** Write one canonical archive into the area. */
    put: (name, source, events) => {
      const dir = join(areaPath, SESSIONS_DIR)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, name), encodeArchive(serializeSession(source, events), 'zstd'))
      return join(dir, name)
    },
  }
}

/** A `SessionSync` wired to one fake backend. */
function syncFor(ctx, statePath) {
  return new SessionSync({ get: (service) => (service === 'sessionPersistence' ? ctx : undefined) }, { statePath })
}

test('session scope is the work area and its subdirectories', () => {
  assert.equal(sessionInArea('D:\\work\\area', 'D:\\work\\area'), true)
  assert.equal(sessionInArea('D:\\work\\area', 'D:\\work\\area\\src'), true)
  assert.equal(sessionInArea('D:\\work\\area', 'D:\\work\\other'), false)
  assert.equal(sessionInArea('D:\\work\\area', undefined), false)
  assert.equal(sessionInArea('D:\\work\\area', ''), false)
  assert.equal(sessionInArea('D:/work/area', 'D:\\work\\area\\src'), true, 'separators do not matter')
  assert.equal(sessionInArea('D:\\work\\area', 'D:\\work\\area\\src', false), false)
})

test('archive names round-trip and reject anything unsafe', () => {
  assert.equal(archiveName(SESSION_ID, 'zstd'), `${SESSION_ID}.jsonl.zstd`)
  assert.equal(archiveName(SESSION_ID, 'none'), `${SESSION_ID}.jsonl`)
  assert.deepEqual(archiveEntry(`${SESSION_ID}.jsonl.zstd`), { id: SESSION_ID, compression: 'zstd' })
  assert.deepEqual(archiveEntry(`${SESSION_ID}.jsonl`), { id: SESSION_ID, compression: 'none' })
  assert.equal(archiveEntry('notes.txt'), undefined)
  assert.equal(archiveEntry('..%2Fescape.jsonl'), undefined)
  assert.equal(archiveEntry('a/b.jsonl'), undefined)
})

test('canonical serialization round-trips every header field and event', () => {
  const source = header({ parentSession: 'session-parent', origin: 'subagent', delegationDepth: 1 })
  const events = [event(0, 'turn/start'), event(1), event(2, 'tool/call'), event(3, 'turn/end')]
  const text = serializeSession(source, events)
  const [headLine] = text.split('\n')
  assert.deepEqual(Object.keys(JSON.parse(headLine)), [
    'type', 'version', 'id', 'createdAt', 'cwd', 'parentSession', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset',
  ], 'the header line uses the harness physical key order and whitelist')

  const parsed = parseSessionArchive(text)
  assert.equal(parsed.formatVersion, 3)
  assert.deepEqual(parsed.header, source)
  assert.deepEqual(parsed.events, events)
})

test('optional header fields are omitted, never null', () => {
  const bare = { version: 3, id: SESSION_ID, createdAt: 5, isSeeded: false, delegationDepth: 0 }
  const [headLine] = serializeSession(bare, []).split('\n')
  assert.equal(headLine, JSON.stringify({
    type: 'session', version: 3, id: SESSION_ID, createdAt: 5, isSeeded: false, delegationDepth: 0,
  }))
  assert.deepEqual(parseSessionArchive(`${headLine}\n`).header, bare)
})

test('a malformed archive is refused instead of partially applied', () => {
  const good = serializeSession(header(), [event(0), event(1)])
  assert.throws(() => parseSessionArchive(''), /archive is empty/u)
  assert.throws(() => parseSessionArchive('{"type":"session"}\n'), /unusable id/u)
  assert.throws(() => parseSessionArchive(good.replace('"seq":1', '"seq":7')), /expected 1/u)
  assert.throws(() => parseSessionArchive(good.replace('"type":"user/message","seq":0', '"seq":0')), /no event type/u)
  assert.throws(() => parseSessionArchive(good.replace('\n{"type":"user/message","seq":1', '\n\n{"type":"user/message","seq":1')), /is blank/u)
  assert.throws(() => parseSessionArchive(good.replace('"time":1700000000000', '"time":"soon"')), /numeric time/u)
})

test('a seeded cut is recovered from the log itself', () => {
  const seeded = header({ isSeeded: true, parentSession: 'session-parent' })
  const events = [event(0), event(1), event(2, 'session/end-seed', { data: { inherited: true } }), event(3)]
  assert.equal(inheritedEventCount(seeded, events), 2)
  assert.equal(inheritedEventCount(header(), events), 0, 'an unseeded session has no cut')
  assert.equal(
    inheritedEventCount(seeded, [event(0), event(1, 'session/end-seed', { data: {} })]),
    undefined,
    'a seeded header without the tagged marker cannot be recreated and must be reported',
  )
})

test('log comparison distinguishes every verdict', () => {
  const base = [event(0), event(1)]
  assert.equal(compareEventLogs(base, [event(0), event(1)]).verdict, 'equal')
  assert.equal(compareEventLogs([...base, event(2)], base).verdict, 'local-ahead')
  assert.equal(compareEventLogs(base, [...base, event(2)]).verdict, 'remote-ahead')
  assert.equal(compareEventLogs(base, [...base, event(2)]).from, 2)
  assert.equal(compareEventLogs(base, [event(0), event(9)]).verdict, 'diverged')
  assert.equal(compareEventLogs(base, [event(0), event(1, 'assistant/message')]).verdict, 'diverged')
})

test('both archive encodings survive a round trip', () => {
  const text = serializeSession(header(), [event(0)])
  for (const compression of ['none', 'zstd']) {
    const bytes = encodeArchive(text, compression)
    assert.equal(decodeArchive(bytes, compression), text)
    if (compression === 'zstd') assert.ok(bytes.byteLength < Buffer.byteLength(text) || bytes[0] === 0x28)
  }
})

test('the engine exports in-scope sessions and then leaves them alone', async (t) => {
  const world = scratch(t)
  const backend = fakePersistence([
    { header: world.header(), events: [event(0), event(1)] },
    { header: world.header({ id: 'session-outside', cwd: 'D:\\elsewhere' }), events: [event(0)] },
  ])
  const sync = syncFor(backend, world.statePath)

  const first = await sync.exportArea(world.area, {})
  assert.equal(first.exported, 1, 'only the in-scope session is written')
  assert.equal(first.failed, 0)
  const archivePath = join(world.areaPath, SESSIONS_DIR, `${SESSION_ID}.jsonl.zstd`)
  const parsed = parseSessionArchive(decodeArchive(readFileSync(archivePath), 'zstd'))
  assert.equal(parsed.header.id, SESSION_ID)
  assert.deepEqual(parsed.events, [event(0), event(1)])

  const second = await sync.exportArea(world.area, {})
  assert.deepEqual(
    { exported: second.exported, unchanged: second.unchanged },
    { exported: 0, unchanged: 1 },
    'an unchanged session costs no rewrite',
  )

  backend.store.get(SESSION_ID).events.push(...[event(2), event(3)])
  backend.store.get(SESSION_ID).revision = 'r-new'
  const third = await sync.exportArea(world.area, {})
  assert.equal(third.exported, 1, 'a grown log is re-exported')
  assert.equal(parseSessionArchive(decodeArchive(readFileSync(archivePath), 'zstd')).events.length, 4)
})

test('export respects maxSessions and maxBytes and reports what it skipped', async (t) => {
  const world = scratch(t)
  const backend = fakePersistence([
    { header: world.header({ id: 'session-a', createdAt: 3 }), events: [event(0)] },
    { header: world.header({ id: 'session-b', createdAt: 2 }), events: [event(0)] },
    { header: world.header({ id: 'session-c', createdAt: 1 }), events: [event(0)] },
  ])
  const sync = syncFor(backend, world.statePath)
  const limited = await sync.exportArea(world.area, { maxSessions: 2 })
  assert.equal(limited.exported, 2)
  assert.equal(limited.skipped, 1)
  assert.match(limited.notes.join(' '), /maxSessions=2/u)
  assert.deepEqual(
    readdirSync(join(world.areaPath, SESSIONS_DIR)).sort(),
    ['session-a.jsonl.zstd', 'session-b.jsonl.zstd'],
    'the newest sessions win',
  )

  const capped = await syncFor(backend, world.statePath).exportArea(world.area, { maxBytes: 1 })
  assert.equal(capped.exported, 0)
  assert.equal(capped.skipped, 1, 'only the session with no archive yet is reconsidered')
  assert.equal(capped.unchanged, 2, 'the two already-exported sessions are not reread')
  assert.match(capped.notes.join(' '), /maxBytes=1/u)
})

test('export never overwrites an archive this machine has not imported yet', async (t) => {
  const world = scratch(t)
  const backend = fakePersistence([{ header: world.header(), events: [event(0)] }])
  const path = world.put(`${SESSION_ID}.jsonl.zstd`, world.header(), [event(0), event(1), event(2)])
  const summary = await syncFor(backend, world.statePath).exportArea(world.area, {})
  assert.equal(summary.exported, 0)
  assert.equal(summary.skipped, 1)
  assert.match(summary.notes.join(' '), /留给导入处理/u)
  assert.equal(
    parseSessionArchive(decodeArchive(readFileSync(path), 'zstd')).events.length,
    3,
    'the other machine\'s longer log is intact',
  )
})

test('import recreates a missing session natively, preserving identity', async (t) => {
  const world = scratch(t)
  const events = [event(0, 'turn/start'), event(1), event(2, 'turn/end')]
  world.put(`${SESSION_ID}.jsonl.zstd`, world.header(), events)

  const backend = fakePersistence()
  const sync = syncFor(backend, world.statePath)
  const summary = await sync.importArea(world.area, {})
  assert.deepEqual(
    { imported: summary.imported, failed: summary.failed },
    { imported: 1, failed: 0 },
  )
  const stored = backend.store.get(SESSION_ID)
  assert.deepEqual(stored.header, world.header(), 'the header, including cwd, is preserved verbatim')
  assert.deepEqual(stored.events, events, 'every event keeps its seq, time and payload')
  assert.equal(sync.imports()[SESSION_ID].host.length > 0, true, 'the import is recorded for the notice')
  assert.equal(sync.imports()[SESSION_ID].rewritten, false)
})

test('import keeps a missing working directory unless the user asks otherwise', async (t) => {
  const world = scratch(t)
  const missing = join(world.root, 'gone')
  const stage = (name) => {
    const path = join(world.root, name)
    mkdirSync(join(path, SESSIONS_DIR), { recursive: true })
    const id = `session-${name}`
    writeFileSync(
      join(path, SESSIONS_DIR, archiveName(id, 'zstd')),
      encodeArchive(serializeSession(header({ id, cwd: missing }), [event(0)]), 'zstd'),
    )
    return { id, path }
  }

  const kept = stage('kept')
  const keepBackend = fakePersistence()
  const keepSync = syncFor(keepBackend, join(world.root, 'state', 'keep.json'))
  assert.equal((await keepSync.importArea(kept, {})).imported, 1)
  assert.equal(keepBackend.store.get(kept.id).header.cwd, missing, 'the default never rewrites cwd')
  assert.equal(keepSync.imports()[kept.id].rewritten, false)

  const auto = stage('auto')
  const autoBackend = fakePersistence()
  await syncFor(autoBackend, join(world.root, 'state', 'auto.json')).importArea(auto, { cwdPolicy: 'auto' })
  assert.equal(autoBackend.store.get(auto.id).header.cwd, auto.path, 'auto falls back to the area')

  const forced = stage('forced')
  const forcedBackend = fakePersistence()
  const forcedSync = syncFor(forcedBackend, join(world.root, 'state', 'forced.json'))
  await forcedSync.importArea(forced, { cwdPolicy: 'area' })
  assert.equal(forcedBackend.store.get(forced.id).header.cwd, forced.path)
  assert.equal(forcedSync.imports()[forced.id].originalCwd, missing, 'the original path is still reported')
  assert.equal(forcedSync.imports()[forced.id].rewritten, true)
})

test('import appends a remote tail, then stops rereading anything', async (t) => {
  const world = scratch(t)
  const local = [event(0), event(1)]
  const remote = [...local, event(2), event(3)]
  world.put(`${SESSION_ID}.jsonl.zstd`, world.header(), remote)

  const backend = fakePersistence([{ header: world.header(), events: local }])
  const sync = syncFor(backend, world.statePath)
  const summary = await sync.importArea(world.area, {})
  assert.equal(summary.appended, 1)
  assert.deepEqual(backend.store.get(SESSION_ID).events, remote, 'only the missing tail is appended')

  backend.handles.length = 0
  const again = await sync.importArea(world.area, {})
  assert.equal(again.unchanged, 1)
  assert.deepEqual(backend.handles, [], 'an unchanged pair is decided from metadata alone')
})

test('import leaves a longer local log alone and re-exports it', async (t) => {
  const world = scratch(t)
  const path = world.put(`${SESSION_ID}.jsonl.zstd`, world.header(), [event(0)])

  const backend = fakePersistence([{ header: world.header(), events: [event(0), event(1), event(2)] }])
  const sync = syncFor(backend, world.statePath)
  assert.equal((await sync.importArea(world.area, {})).unchanged, 1)
  assert.equal(backend.store.get(SESSION_ID).events.length, 3, 'the local branch is not truncated')

  // The archive was pulled, not exported here; once the two agree the export
  // half must be allowed to publish this machine's longer log.
  const exported = await sync.exportArea(world.area, {})
  assert.equal(exported.exported, 1)
  assert.equal(parseSessionArchive(decodeArchive(readFileSync(path), 'zstd')).events.length, 3)
})

test('a real fork parks both branches instead of losing either', async (t) => {
  const world = scratch(t)
  const remote = [event(0), event(1, 'assistant/message'), event(2, 'turn/end')]
  world.put(`${SESSION_ID}.jsonl.zstd`, world.header(), remote)

  const local = [event(0), event(1, 'user/message'), event(2, 'assistant/message')]
  const backend = fakePersistence([{ header: world.header(), events: local }])
  const sync = syncFor(backend, world.statePath)
  const summary = await sync.importArea(world.area, {})
  assert.equal(summary.conflicts, 1)
  assert.deepEqual(backend.store.get(SESSION_ID).events, local, 'the live branch is untouched')

  const conflicts = join(world.areaPath, SESSIONS_DIR, 'conflicts')
  const parked = readdirSync(conflicts).sort()
  assert.equal(parked.length, 2)
  const remoteCopy = parked.find(name => name.endsWith('.remote.jsonl'))
  const localCopy = parked.find(name => name.endsWith('.local.jsonl'))
  assert.deepEqual(parseSessionArchive(readFileSync(join(conflicts, remoteCopy), 'utf8')).events, remote)
  assert.deepEqual(parseSessionArchive(readFileSync(join(conflicts, localCopy), 'utf8')).events, local)

  const again = await sync.importArea(world.area, {})
  assert.equal(again.conflicts, 1)
  assert.equal(readdirSync(conflicts).length, 2, 're-running parks nothing new')
})

test('import refuses an archive whose encoding or format does not match', async (t) => {
  const world = scratch(t)
  world.put('session-plain.jsonl', world.header({ id: 'session-plain' }), [event(0)])

  const backend = fakePersistence()
  const summary = await syncFor(backend, world.statePath).importArea(world.area, {})
  assert.equal(summary.failed, 1)
  assert.match(summary.notes.join(' '), /compression/u)
  assert.equal(backend.store.size, 0)

  const other = scratch(t)
  const future = fakePersistence()
  other.put(`${SESSION_ID}.jsonl.zstd`, other.header(), [event(0)])
  const futurePath = join(other.areaPath, SESSIONS_DIR, `${SESSION_ID}.jsonl.zstd`)
  writeFileSync(futurePath, encodeArchive(
    serializeSession(other.header(), [event(0)]).replace('"version":3', '"version":9'),
    'zstd',
  ))
  const refused = await syncFor(future, other.statePath).importArea(other.area, {})
  assert.equal(refused.failed, 1)
  assert.match(refused.notes.join(' '), /会话格式 v9/u)
  assert.equal(future.store.size, 0)
})

test('a seeded session is recreated with its recorded cut', async (t) => {
  const world = scratch(t)
  const seeded = world.header({ id: 'session-seeded', isSeeded: true, parentSession: 'session-parent' })
  const events = [event(0), event(1), event(2, 'session/end-seed', { data: { inherited: true } }), event(3)]
  world.put('session-seeded.jsonl.zstd', seeded, events)

  const backend = fakePersistence()
  const seen = []
  const original = backend.create
  backend.create = async (created, options) => { seen.push({ created, options }); return original(created, options) }
  const summary = await syncFor(backend, world.statePath).importArea(world.area, {})
  assert.equal(summary.imported, 1)
  assert.equal(seen[0].options.inheritedEventCount, 2)
  assert.deepEqual(backend.store.get('session-seeded').events, events)
})

test('the instance list is the only thing that decides scope', async (t) => {
  const world = scratch(t)
  const backend = fakePersistence([
    { header: world.header({ id: 'session-deep', cwd: join(world.areaPath, 'src', 'inner') }), events: [event(0)] },
    { header: { version: 3, id: 'session-nowhere', createdAt: 1, isSeeded: false, delegationDepth: 0 }, events: [event(0)] },
  ])
  const sync = syncFor(backend, world.statePath)
  const summary = await sync.exportArea(world.area, {})
  assert.equal(summary.exported, 1)
  assert.equal(summary.skipped, 0, 'a session with no cwd is simply out of scope, not an error')

  const excluded = await syncFor(backend, join(world.root, 'state', 'flat.json'))
    .exportArea(world.area, { includeDescendants: false })
  assert.equal(excluded.exported, 0)
})

test('state survives a restart and drops records for vanished sessions', async (t) => {
  const world = scratch(t)
  const first = new SessionState(world.statePath)
  first.markImported(SESSION_ID, { host: 'laptop', at: 1 })
  first.markImported('session-gone', { host: 'laptop', at: 1 })
  first.markExported('a1', SESSION_ID, { revision: 'r1', size: 1, mtimeMs: 2 })
  first.save()

  const reloaded = new SessionState(world.statePath)
  assert.equal(reloaded.imported(SESSION_ID).host, 'laptop')
  assert.equal(reloaded.exported('a1', SESSION_ID).revision, 'r1')
  reloaded.pruneImports(new Set([SESSION_ID]))
  reloaded.save()
  assert.deepEqual(Object.keys(new SessionState(world.statePath).imports()), [SESSION_ID])

  writeFileSync(world.statePath, '{not json')
  assert.deepEqual(Object.keys(new SessionState(world.statePath).imports()), [], 'corruption costs a reread, not a crash')
})

test('the device notice names the other machine, the old path and the local one', () => {
  const text = noticeText(
    { host: 'studio-pc', at: Date.parse('2026-03-04T05:06:07Z'), originalCwd: 'D:\\old\\area', cwd: 'D:\\new\\area', rewritten: true },
    { archiveDir: 'D:\\new\\area\\.dsh-sessions' },
  )
  assert.match(text, /studio-pc/u)
  assert.match(text, /2026-03-04/u)
  assert.match(text, /D:\\old\\area/u)
  assert.match(text, /D:\\new\\area/u)
  assert.match(text, /confirm a path exists/u)
  assert.equal(noticeText({ host: 'x', at: 1 }).includes('{{'), false, 'the notice must not look like a prompt variable')
})

test('the notice contributes only for sessions this machine imported', () => {
  const registrations = []
  const context = {
    inject: (services, callback) => {
      assert.deepEqual(services, ['systemPrompt'])
      callback({
        effect: (register) => register(),
        systemPrompt: { context: (entry) => { registrations.push(entry); return () => {} } },
      })
    },
  }
  installDeviceNotice(context, {
    imports: () => ({ [SESSION_ID]: { host: 'laptop', at: 1, originalCwd: 'D:\\old' } }),
    enabled: () => true,
    archiveDir: () => 'D:\\area\\.dsh-sessions',
  })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].name, NOTICE_NAME)
  assert.equal(registrations[0].text({ agent: undefined }), '')
  assert.equal(registrations[0].text({ agent: { session: { header: { id: 'session-other' } } } }), '')
  assert.match(registrations[0].text({ agent: { session: { header: { id: SESSION_ID } } } }), /laptop/u)

  const off = []
  installDeviceNotice({
    inject: (_services, callback) => callback({
      effect: (register) => register(),
      systemPrompt: { context: (entry) => { off.push(entry); return () => {} } },
    }),
  }, { imports: () => ({ [SESSION_ID]: { host: 'laptop' } }), enabled: () => false })
  assert.equal(off[0].text({ agent: { session: { header: { id: SESSION_ID } } } }), '')
})

test('a session an area imported keeps travelling with it, wherever its cwd is', async (t) => {
  const world = scratch(t)
  const elsewhere = join(world.root, 'other-machine', 'area')
  mkdirSync(elsewhere, { recursive: true })
  world.put(`${SESSION_ID}.jsonl.zstd`, header({ id: SESSION_ID, cwd: elsewhere }), [event(0)])

  const backend = fakePersistence()
  const sync = syncFor(backend, world.statePath)
  assert.equal((await sync.importArea(world.area, {})).imported, 1)

  // Without the import record this session is out of scope here, and a
  // continuation made on this machine could never be published back.
  const orphan = await syncFor(backend, join(world.root, 'state', 'orphan.json')).exportArea(world.area, {})
  assert.equal(orphan.exported, 0)

  backend.store.get(SESSION_ID).events.push(event(1))
  backend.store.get(SESSION_ID).revision = 'r-grown'
  const published = await sync.exportArea(world.area, {})
  assert.equal(published.exported, 1)
  assert.equal(
    parseSessionArchive(decodeArchive(readFileSync(
      join(world.areaPath, SESSIONS_DIR, `${SESSION_ID}.jsonl.zstd`),
    ), 'zstd')).events.length,
    2,
  )

  // The record belongs to that area: another area does not inherit it.
  const other = join(world.root, 'unrelated')
  mkdirSync(other, { recursive: true })
  assert.equal((await sync.exportArea({ id: 'a2', path: other }, {})).exported, 0)
})

test('an unavailable persistence service is a no-op, not a failure', async (t) => {
  const world = scratch(t)
  const sync = new SessionSync({ get: () => undefined }, { statePath: world.statePath })
  const exported = await sync.exportArea(world.area, {})
  const imported = await sync.importArea(world.area, {})
  assert.deepEqual([exported.exported, exported.failed, imported.imported, imported.failed], [0, 0, 0, 0])
})
