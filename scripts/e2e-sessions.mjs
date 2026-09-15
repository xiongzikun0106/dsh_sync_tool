/**
 * Real-backend end-to-end check for session synchronisation.
 *
 * Unlike the unit tests, this drives the harness's own packages. It proves four
 * things that a stand-in cannot:
 *
 *  1. the canonical text this plugin writes matches what the backend itself
 *     writes for an uncompressed root;
 *  2. a session exported from one root is rebuilt in a second root with the
 *     same id, header and event sequence — through `create`/`append` only;
 *  3. the rebuilt session is a first-class stored session there: it is listed,
 *     `stat` reports it, and a read handle returns the identical log;
 *  4. the device-switch notice is accepted by the real prompt registry and
 *     rendered into the dynamic runtime-context snapshot — the channel the loop
 *     appends after the cached history — while contributing nothing at all for
 *     a session that did not arrive from another machine.
 *
 * Usage:
 *   node scripts/e2e-sessions.mjs [profile-root]
 *
 * `profile-root` defaults to `$DSH_PROFILE_ROOT`, then to the profile directory
 * of the running harness (`$DSH_HOME/profiles`), which is where the harness's
 * own `@deepseek-ai/*` packages are installed. The check never touches the
 * machine's real session root: every root it uses is a fresh temp directory.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { installDeviceNotice, NOTICE_NAME } from '../lib/notice.js'
import { decodeArchive, parseSessionArchive, serializeSession, SESSIONS_DIR, SessionSync } from '../lib/sessions.js'

const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : join(homedir(), '.dsh')
const profileRoot = process.argv[2] ?? process.env.DSH_PROFILE_ROOT ?? join(dshHome, 'profiles')

const require = createRequire(join(profileRoot, 'package.json'))
const load = async (specifier) => import(pathToFileURL(require.resolve(specifier)).href)

const { Context } = await load('@deepseek-ai/cordis')
const Jsonl = (await load('@deepseek-ai/dsh-session-persistence-jsonl')).default
const llm = await load('@deepseek-ai/dsh-llm')

/** Boot one backend over a fresh root and return its service. */
async function backend(root, compression) {
  const ctx = new Context()
  await ctx.plugin(Jsonl, { root, ...(compression === undefined ? {} : { compression }) })
  return ctx.get('sessionPersistence')
}

/** A header shaped like the real logical one. */
function sessionHeader(id, cwd) {
  return { version: 3, id, createdAt: 1700000000000, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
}

/**
 * A message as it is actually stored: the harness factories carry an explicit
 * `undefined` for absent optional fields, and the persistence contract accepts
 * only lossless JSON, so the durable form is the JSON projection of them.
 */
const stored = (message) => JSON.parse(JSON.stringify(message))

/** A small but representative log: user, assistant, tool call, tool result, turn end. */
function sessionEvents() {
  return [
    { type: 'turn/start', seq: 0, time: 1700000000001, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 1700000000002,
      data: stored(llm.createUserMessage({
        content: [{ type: 'text', text: 'Check the README in this repo' }],
        source: { kind: 'user' },
      })),
      surfaceOp: 'append',
    },
    { type: 'step/start', seq: 2, time: 1700000000003, data: { turn: 1, step: 1 } },
    {
      type: 'tool/call',
      seq: 3,
      time: 1700000000004,
      data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"README.md"}' },
    },
    {
      type: 'tool/result',
      seq: 4,
      time: 1700000000005,
      data: {
        turn: 1,
        step: 1,
        message: stored(llm.createToolResultMessage({
          callId: 'c1',
          ok: true,
          content: [{ type: 'text', text: '# Title\n' }],
        })),
      },
      surfaceOp: 'append',
      sourceEventSeqs: [3],
    },
    {
      type: 'assistant/message',
      seq: 5,
      time: 1700000000006,
      data: {
        turn: 1,
        step: 1,
        message: stored(llm.createAssistantMessage({
          content: [{ type: 'text', text: 'The README has one line.' }],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        })),
        stream: [],
      },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: 6, time: 1700000000007, data: { turn: 1, step: 1, reason: 'completed' } },
    { type: 'turn/end', seq: 7, time: 1700000000008, data: { turn: 1, reason: 'completed' } },
  ]
}

/** Wrap one service as the `ctx.get` this plugin's engine expects. */
const hostOf = (service) => ({ get: (name) => (name === 'sessionPersistence' ? service : undefined) })

/** Discover the single logical log file under a root. */
function onlyLogFile(root) {
  const [project] = readdirSync(root)
  const [session] = readdirSync(join(root, project))
  // POSIX holds a `session.lock` file beside the log; Windows uses a kernel
  // semaphore and leaves nothing behind.
  const file = readdirSync(join(root, project, session)).find(name => name.includes('.jsonl'))
  return join(root, project, session, file)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-sync-e2e-'))
const report = []
const step = (label, detail = '') => {
  report.push(`${label}${detail === '' ? '' : ` —?${detail}`}`)
  console.log(`ok  ${label}${detail === '' ? '' : ` —?${detail}`}`)
}

try {
  const machineA = join(root, 'machine-a')
  const machineB = join(root, 'machine-b')
  const plain = join(root, 'plain')
  for (const dir of [machineA, machineB, plain]) mkdirSync(dir, { recursive: true })

  const id = 'session-abcdef01-2345-6789-abcd-ef0123456789'
  const events = sessionEvents()

  // ---- 1. The canonical text matches the backend's own uncompressed text ----
  const plainBackend = await backend(plain, 'none')
  const plainHandle = await plainBackend.create(sessionHeader(id, plain))
  await plainHandle.append(events)
  await plainHandle.flush()
  await plainHandle.close()
  const nativeText = readFileSync(onlyLogFile(plain), 'utf8')
  const mine = serializeSession(sessionHeader(id, plain), events)
  const reparsed = parseSessionArchive(mine)
  assert.deepEqual(reparsed.header, sessionHeader(id, plain))
  assert.deepEqual(reparsed.events, events, 'the canonical text re-reads to the same logical events')

  // The only permitted difference is the backend's run-length encoding of
  // `sourceEventSeqs`; the decoded values must be identical either way.
  const nativeLines = nativeText.trimEnd().split('\n')
  const mineLines = mine.trimEnd().split('\n')
  assert.equal(nativeLines.length, mineLines.length, 'same number of lines as the backend writes')
  assert.equal(nativeLines[0], mineLines[0], 'the header line is byte-identical')
  const differing = nativeLines.filter((line, index) => line !== mineLines[index]).length
  assert.ok(differing <= 1, `at most the storage-encoded row may differ (saw ${differing})`)
  step('canonical text matches the backend text', `${nativeLines.length} lines, ${differing} storage-encoded`)

  // ---- 2. Export from a real root ----
  const backendA = await backend(join(root, 'root-a'))
  const handleA = await backendA.create(sessionHeader(id, machineA))
  await handleA.append(events)
  await handleA.flush()
  await handleA.close()

  const syncA = new SessionSync(hostOf(backendA), { statePath: join(root, 'state-a.json') })
  const exported = await syncA.exportArea({ id: 'a', path: machineA }, {})
  assert.deepEqual([exported.exported, exported.failed], [1, 0], exported.notes.join(' | '))
  const archivePath = join(machineA, SESSIONS_DIR, `${id}.jsonl.zstd`)
  const archive = parseSessionArchive(decodeArchive(readFileSync(archivePath), 'zstd'))
  assert.equal(archive.header.cwd, machineA)
  assert.deepEqual(archive.events, events)
  step('export from a real session root', `${readFileSync(archivePath).byteLength} B`)

  // ---- 3. "Travel" the folder and import on a second machine ----
  cpSync(join(machineA, SESSIONS_DIR), join(machineB, SESSIONS_DIR), { recursive: true })
  const backendB = await backend(join(root, 'root-b'))
  const syncB = new SessionSync(hostOf(backendB), { statePath: join(root, 'state-b.json') })

  assert.equal(await backendB.stat(id), undefined, 'the second machine starts without the session')
  const imported = await syncB.importArea({ id: 'b', path: machineB }, {})
  assert.deepEqual([imported.imported, imported.failed], [1, 0])

  const listed = await backendB.list()
  assert.equal(listed.length, 1, 'the rebuilt session is a stored session, not a private artifact')
  assert.equal(String(listed[0].header.id), id)
  assert.equal(listed[0].header.cwd, machineA, 'the working directory is preserved, so the prompt envelope matches')

  const reader = await backendB.open(id, 'read')
  let restoredHeader
  let restoredEvents
  try {
    restoredHeader = reader.header
    restoredEvents = (await reader.read(0, undefined)).events
  } finally {
    await reader.close()
  }
  assert.deepEqual(restoredHeader, sessionHeader(id, machineA))
  assert.deepEqual(restoredEvents, events, 'every event survives with its seq, time and payload')
  step('import into a second real session root', `${restoredEvents.length} events, identical`)

  // ---- 4. Idempotence: a second pass reads nothing and changes nothing ----
  const again = await syncB.importArea({ id: 'b', path: machineB }, {})
  assert.deepEqual([again.imported, again.appended, again.conflicts, again.failed], [0, 0, 0, 0])
  const after = await backendB.open(id, 'read')
  try {
    assert.deepEqual((await after.read(0, undefined)).events, events)
  } finally {
    await after.close()
  }
  step('re-running the import is a no-op')

  // ---- 5. A continued session on the second machine re-exports cleanly ----
  const writer = await backendB.open(id, 'write')
  try {
    await writer.append([{ type: 'turn/start', seq: 8, time: 1700000000009, data: { turn: 2 } }])
    await writer.flush()
  } finally {
    await writer.close()
  }
  const reExport = await syncB.exportArea({ id: 'b', path: machineB }, {})
  assert.deepEqual([reExport.exported, reExport.failed], [1, 0], JSON.stringify(reExport))
  const grown = parseSessionArchive(decodeArchive(readFileSync(archivePath.replace(machineA, machineB)), 'zstd'))
  assert.equal(grown.events.length, events.length + 1, 'the second machine publishes its own continuation')
  step('a continued session is re-exported', `${grown.events.length} events`)

  // ---- 6. The real prompt registry renders the device-switch notice ----
  const SystemPrompt = (await load('@deepseek-ai/dsh-system-prompt')).default
  const { joinContextSections, renderContextSections } = await load('@deepseek-ai/dsh-system-prompt')
  const promptCtx = new Context()
  await promptCtx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  const importedAt = Date.parse('2026-03-04T05:06:07Z')
  installDeviceNotice(promptCtx, {
    imports: () => ({ [id]: { host: 'studio-pc', at: importedAt, originalCwd: '/old/area', cwd: '/new/area', rewritten: true } }),
    enabled: () => true,
    archiveDir: () => '/new/area/.dsh-sessions',
  })

  const agentFor = (sessionId) => ({ session: { header: { id: sessionId } } })
  // `ctx.inject` registers once the service is live, which is a tick after the
  // plugin is mounted.
  await new Promise(resolve => { setTimeout(resolve, 50) })
  const forImported = await promptCtx.systemPrompt.assemble({ agent: agentFor(id) })
  const rendered = renderContextSections(forImported)
  const notice = rendered.find(entry => entry.name === NOTICE_NAME)
  assert.ok(notice !== undefined, 'the notice is part of the dynamic runtime-context snapshot')
  assert.match(joinContextSections(rendered), /studio-pc/u)
  assert.match(joinContextSections(rendered), /\/old\/area/u)

  const forLocal = await promptCtx.systemPrompt.assemble({ agent: agentFor('session-made-here') })
  assert.equal(
    renderContextSections(forLocal).some(entry => entry.name === NOTICE_NAME),
    false,
    'a session that started on this machine contributes nothing at all',
  )
  step('the prompt registry renders the notice only for imported sessions', `${rendered.length} context section(s)`)

  console.log(`\n${report.length} checks passed against @deepseek-ai/dsh-session-persistence-jsonl`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

