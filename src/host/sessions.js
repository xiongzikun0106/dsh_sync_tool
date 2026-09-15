/**
 * dsh-sync-tool — Session record synchronisation.
 *
 * Sessions are the thing a person actually accumulates inside a work area, so
 * they travel with the folder: this module turns a stored Session into the
 * canonical JSONL form the harness itself uses for export, keeps one such file
 * per Session inside `<area>/.dsh-sessions/`, and rebuilds a native, loadable,
 * identically-identified Session on the receiving machine.
 *
 * Design constraints that shaped it (all verified against the harness source):
 *
 *  - The archive never lives under the session root. The JSONL backend treats
 *    *every* directory below that root as a project directory, and one root
 *    must use exactly one physical encoding, so a repository there would be
 *    both misread and rejected.
 *  - Import goes through the public persistence contract
 *    (`create`/`append`/`flush`/`close`) instead of writing bytes. The backend
 *    then picks the local generation file name and encoding, so the result is a
 *    first-class native Session rather than a lookalike — same id, same header,
 *    same event sequence, same timestamps.
 *  - The header's `cwd` is never rewritten by default. The shipped presets
 *    render `{{cwd}}` into the system prompt, so changing it would replace
 *    surface node 0 and invalidate the provider's prefix cache from token 0 —
 *    exactly the "fresh session" cost this feature exists to avoid.
 *  - Both halves are best-effort: a Session problem must never break the git
 *    pass, and an unreadable archive is reported, never guessed at.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import zlib from 'node:zlib'

/** Default subdirectory (inside a work area) that holds session archives. */
export const SESSIONS_DIR = '.dsh-sessions'

/** Subdirectory that receives an archive that could not be applied cleanly. */
export const CONFLICT_DIR = 'conflicts'

/** Logical session-format version this build reads and writes. */
export const SESSION_FORMAT_VERSION = 3

/** Events appended per batch; keeps one huge history off the heap at once. */
export const APPEND_BATCH = 200

/** Physical encodings an archive directory may use. */
export const COMPRESSIONS = Object.freeze(['zstd', 'none'])

/** How a missing local working directory is handled on import. */
export const CWD_POLICIES = Object.freeze(['keep', 'auto', 'area'])

/** Session ids become file names, so they must be a single safe path segment. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/

/** Machine-local state schema version. */
const STATE_VERSION = 1

/**
 * Whether this Node build can do Zstandard through `node:zlib`. The harness
 * itself requires it, so this is a guard for exotic runtimes, not the norm.
 * @returns true when both zstd entry points exist.
 */
export function zstdAvailable() {
  return typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function'
}

/**
 * Name this machine is recorded under in state and notices.
 * @returns a short host label, never empty.
 */
export function hostLabel() {
  const candidates = [process.env.COMPUTERNAME, process.env.HOSTNAME, process.env.NAME]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return 'unknown-host'
}

/**
 * Resolve the harness home the way `dshHomePath()` does: `$DSH_HOME`, then
 * `~/.dsh`. Reimplemented locally so the plugin needs no extra dependency.
 * @returns absolute harness home directory.
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return resolve(join(homedir(), '.dsh'))
}

/**
 * Default machine-local state file for session bookkeeping.
 * @returns absolute path inside the harness home.
 */
export function defaultStatePath() {
  return join(dshHome(), 'sync-tool', 'sessions.json')
}

/** Case- and separator-insensitive absolute path key. */
function normalize(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const slashed = value.replace(/\\/gu, '/').replace(/\/+$/u, '')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/**
 * Whether a session belongs to a work area.
 * @param areaPath - configured work-area folder.
 * @param cwd - the session header's working directory.
 * @param includeDescendants - count sessions started in a subdirectory.
 * @returns true when the session is in scope for that area.
 */
export function sessionInArea(areaPath, cwd, includeDescendants = true) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return false
  const area = normalize(areaPath)
  const target = normalize(cwd)
  if (area === '' || target === '') return false
  if (area === target) return true
  if (includeDescendants !== true) return false
  return target.startsWith(`${area}/`)
}

/**
 * Archive file name for one session.
 * @param id - session id.
 * @param compression - physical encoding of the archive.
 * @returns file name inside the archive directory.
 */
export function archiveName(id, compression = 'zstd') {
  return compression === 'none' ? `${id}.jsonl` : `${id}.jsonl.zstd`
}

/**
 * Parse an archive file name back into its session id and encoding.
 * @param name - directory entry name.
 * @returns the pair, or undefined when the entry is not an archive.
 */
export function archiveEntry(name) {
  if (typeof name !== 'string') return undefined
  if (name.endsWith('.jsonl.zstd')) {
    const id = name.slice(0, -'.jsonl.zstd'.length)
    return SAFE_ID.test(id) ? { id, compression: 'zstd' } : undefined
  }
  if (name.endsWith('.jsonl')) {
    const id = name.slice(0, -'.jsonl'.length)
    return SAFE_ID.test(id) ? { id, compression: 'none' } : undefined
  }
  return undefined
}

/**
 * Archive directory for one work area.
 * @param areaPath - configured work-area folder.
 * @param dir - configured subdirectory name.
 * @returns absolute directory path.
 */
export function archiveDir(areaPath, dir = SESSIONS_DIR) {
  return join(areaPath, typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : SESSIONS_DIR)
}

/**
 * Serialize a decoded session into the canonical JSONL archive text.
 *
 * The header line mirrors the harness's physical header exactly, including its
 * strict key whitelist and its "omit, never null" rule for optional fields; the
 * body is one logical event per line, in stored order.
 *
 * @param header - the session's logical header, from a persistence handle.
 * @param events - the session's logical events, contiguous from seq 0.
 * @returns UTF-8 text ending in a newline.
 */
export function serializeSession(header, events) {
  const record = {
    type: 'session',
    version: Number.isSafeInteger(header.version) ? header.version : SESSION_FORMAT_VERSION,
    id: header.id,
    createdAt: header.createdAt,
  }
  if (header.cwd !== undefined) record.cwd = header.cwd
  if (header.parentSession !== undefined) record.parentSession = header.parentSession
  record.isSeeded = header.isSeeded === true
  if (header.origin !== undefined) record.origin = header.origin
  record.delegationDepth = Number.isSafeInteger(header.delegationDepth) ? header.delegationDepth : 0
  if (header.agentPreset !== undefined) record.agentPreset = header.agentPreset
  const lines = [JSON.stringify(record)]
  for (const event of events) lines.push(JSON.stringify(event))
  return `${lines.join('\n')}\n`
}

/**
 * Parse canonical archive text back into a logical header and its events.
 *
 * Validation is strict and loud on purpose: a malformed archive must be
 * reported rather than partially applied, because a half-imported session is
 * indistinguishable from a corrupt one to every later reader.
 *
 * @param text - archive text.
 * @returns `{ header, events, formatVersion }`.
 * @throws {Error} when the text is not a well-formed canonical session log.
 */
export function parseSessionArchive(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('archive is empty')
  const lines = text.split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length === 0) throw new Error('archive has no header line')

  let head
  try {
    head = JSON.parse(lines[0])
  } catch (error) {
    throw new Error(`archive header is not JSON: ${messageOf(error)}`)
  }
  if (head === null || typeof head !== 'object' || Array.isArray(head) || head.type !== 'session') {
    throw new Error('archive header is not a session header')
  }
  if (typeof head.id !== 'string' || !SAFE_ID.test(head.id)) throw new Error('archive header has an unusable id')
  if (!Number.isSafeInteger(head.createdAt) || head.createdAt < 0) {
    throw new Error('archive header createdAt must be a non-negative safe integer')
  }
  if (typeof head.isSeeded !== 'boolean') throw new Error('archive header isSeeded must be a boolean')
  if (head.delegationDepth !== undefined
    && (!Number.isSafeInteger(head.delegationDepth) || head.delegationDepth < 0)) {
    throw new Error('archive header delegationDepth must be a non-negative safe integer')
  }
  if (head.cwd !== undefined && (typeof head.cwd !== 'string' || head.cwd === '')) {
    throw new Error('archive header cwd must be a non-empty string')
  }

  const header = {
    version: SESSION_FORMAT_VERSION,
    id: head.id,
    createdAt: head.createdAt,
    isSeeded: head.isSeeded,
    delegationDepth: Number.isSafeInteger(head.delegationDepth) ? head.delegationDepth : 0,
  }
  if (head.cwd !== undefined) header.cwd = head.cwd
  if (typeof head.parentSession === 'string' && head.parentSession !== '') header.parentSession = head.parentSession
  if (head.origin === 'subagent') header.origin = 'subagent'
  if (typeof head.agentPreset === 'string' && head.agentPreset !== '') header.agentPreset = head.agentPreset

  const events = []
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') throw new Error(`archive line ${index + 1} is blank`)
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      throw new Error(`archive line ${index + 1} is not JSON: ${messageOf(error)}`)
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error(`archive line ${index + 1} is not an event object`)
    }
    if (typeof event.type !== 'string' || event.type === '') {
      throw new Error(`archive line ${index + 1} has no event type`)
    }
    if (event.seq !== index - 1) {
      throw new Error(`archive line ${index + 1} has seq ${String(event.seq)}, expected ${index - 1}`)
    }
    if (typeof event.time !== 'number' || !Number.isFinite(event.time)) {
      throw new Error(`archive line ${index + 1} has no numeric time`)
    }
    events.push(event)
  }
  return { header, events, formatVersion: Number.isSafeInteger(head.version) ? head.version : 0 }
}

/**
 * Recover a seeded session's inherited prefix length from its own event log.
 *
 * A fork stores the cut as a tagged `session/end-seed` marker whose sequence
 * number *is* the inherited length, so the value never has to be duplicated
 * beside the archive.
 *
 * @param header - the decoded logical header.
 * @param events - the decoded events.
 * @returns the inherited event count, or undefined when a seeded header carries no marker.
 */
export function inheritedEventCount(header, events) {
  if (header.isSeeded !== true) return 0
  for (const event of events) {
    if (event.type !== 'session/end-seed') continue
    if (event.data === null || typeof event.data !== 'object') continue
    if (event.data.inherited === true) return event.seq
  }
  return undefined
}

/**
 * Compare a stored local log with an archive.
 *
 * A shared sequence number at the same index, with the same type, time and
 * payload, is what makes a prefix common: the harness assigns `seq` on append,
 * so two histories that agree that far are the same history.
 *
 * @param local - local logical events, contiguous from seq 0.
 * @param remote - archive events, contiguous from seq 0.
 * @returns `{ verdict, from }`, verdict being `equal`, `local-ahead`,
 *   `remote-ahead` or `diverged`.
 */
export function compareEventLogs(local, remote) {
  const shared = Math.min(local.length, remote.length)
  for (let index = 0; index < shared; index += 1) {
    const left = local[index]
    const right = remote[index]
    if (left.seq !== right.seq || left.type !== right.type || left.time !== right.time
      || JSON.stringify(left) !== JSON.stringify(right)) {
      return { verdict: 'diverged', from: index }
    }
  }
  if (local.length === remote.length) return { verdict: 'equal', from: shared }
  if (local.length > remote.length) return { verdict: 'local-ahead', from: shared }
  return { verdict: 'remote-ahead', from: shared }
}

/**
 * Compress archive text for the configured encoding.
 * @param text - canonical JSONL text.
 * @param compression - `zstd` or `none`.
 * @returns the bytes to store.
 */
export function encodeArchive(text, compression) {
  const raw = Buffer.from(text, 'utf8')
  if (compression === 'none') return raw
  if (!zstdAvailable()) throw new Error('this Node build has no Zstandard support in node:zlib')
  return zlib.zstdCompressSync(raw)
}

/**
 * Decompress archive bytes for the configured encoding.
 * @param bytes - stored archive bytes.
 * @param compression - `zstd` or `none`.
 * @returns the canonical JSONL text.
 */
export function decodeArchive(bytes, compression) {
  if (compression === 'none') return bytes.toString('utf8')
  if (!zstdAvailable()) throw new Error('this Node build has no Zstandard support in node:zlib')
  return zlib.zstdDecompressSync(bytes).toString('utf8')
}

/**
 * Read and decode one archive file.
 * @param path - archive path.
 * @param compression - configured encoding.
 * @returns the canonical JSONL text.
 */
export function readArchive(path, compression) {
  return decodeArchive(readFileSync(path), compression)
}

/**
 * Write bytes atomically, so a concurrent reader never sees a partial archive.
 * @param path - destination path.
 * @param data - bytes or text to write.
 */
export function writeAtomic(path, data) {
  const temp = `${path}.tmp`
  writeFileSync(temp, data)
  renameSync(temp, path)
}

/**
 * Machine-local session bookkeeping.
 *
 * It records what this machine already exported (so a pass rereads nothing) and
 * which sessions arrived from another machine, which is the entire basis for
 * the device-switch prompt notice. It never travels in the repository.
 */
export class SessionState {
  /**
   * @param path - absolute state file path; an empty value falls back to the harness home.
   */
  constructor(path) {
    this.path = typeof path === 'string' && path.trim() !== '' ? path : defaultStatePath()
    this.data = { version: STATE_VERSION, exported: {}, archives: {}, imported: {} }
    this.dirty = false
    this.read()
  }

  /** Load the state file, tolerating both absence and corruption. */
  read() {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    for (const key of ['exported', 'archives', 'imported']) {
      const value = parsed[key]
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) this.data[key] = value
    }
  }

  /** Persist the state file when anything changed. */
  save() {
    if (!this.dirty) return
    try {
      mkdirSync(resolve(this.path, '..'), { recursive: true })
      writeAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`)
      this.dirty = false
    } catch {
      // Bookkeeping only: losing it costs a reread, never correctness.
    }
  }

  /**
   * Record one successful export.
   * @param areaId - work-area id.
   * @param id - session id.
   * @param fingerprint - what was written.
   */
  markExported(areaId, id, fingerprint) {
    this.data.exported[`${areaId}::${id}`] = fingerprint
    this.dirty = true
  }

  /**
   * Read the last export fingerprint for one session.
   * @param areaId - work-area id.
   * @param id - session id.
   * @returns the fingerprint, or undefined.
   */
  exported(areaId, id) {
    return asRecord(this.data.exported[`${areaId}::${id}`])
  }

  /**
   * Record the observed fingerprint of one archive file.
   * @param id - session id.
   * @param fingerprint - size, mtime, event count, last known local revision.
   */
  markArchive(id, fingerprint) {
    this.data.archives[id] = fingerprint
    this.dirty = true
  }

  /**
   * Read the last observed fingerprint of one archive file.
   * @param id - session id.
   * @returns the fingerprint, or undefined.
   */
  archive(id) {
    return asRecord(this.data.archives[id])
  }

  /**
   * Record that one session arrived from another machine.
   * @param id - session id.
   * @param record - origin facts used by the device-switch notice.
   */
  markImported(id, record) {
    this.data.imported[id] = record
    this.dirty = true
  }

  /**
   * Read one import record.
   * @param id - session id.
   * @returns the record, or undefined when the session started on this machine.
   */
  imported(id) {
    return asRecord(this.data.imported[id])
  }

  /** Every import record, keyed by session id. */
  imports() {
    return this.data.imported
  }

  /**
   * Drop import records for sessions the local store no longer has.
   * @param existing - set of session ids the local store reports.
   */
  pruneImports(existing) {
    for (const id of Object.keys(this.data.imported)) {
      if (existing.has(id)) continue
      delete this.data.imported[id]
      this.dirty = true
    }
  }
}

/** Narrow an unknown state value to a plain record. */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** Archive file size and modification time, or undefined when absent. */
function fileFingerprint(path) {
  try {
    const stats = statSync(path)
    return { size: Number(stats.size), mtimeMs: Number(stats.mtimeMs) }
  } catch {
    return undefined
  }
}

/** Whether a path exists and is a directory. */
function directoryExists(path) {
  if (typeof path !== 'string' || path === '') return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Error text for a status note. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Session export/import engine.
 *
 * It consumes exactly one harness service, `sessionPersistence`, for every read
 * and write of a stored session; everything else is plain file I/O on the
 * archive the existing git engine already carries.
 */
export class SessionSync {
  /**
   * @param ctx - host cordis context.
   * @param options - `{ log, statePath }`.
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.state = new SessionState(options.statePath)
  }

  /** The persistence service, or undefined when this deployment has none. */
  persistence() {
    return this.ctx.get('sessionPersistence')
  }

  /** Flush bookkeeping to disk. */
  save() {
    this.state.save()
  }

  /** Session ids this machine imported from another machine. */
  imports() {
    return this.state.imports()
  }

  /**
   * Write every in-scope session of one work area into its archive.
   * @param area - configured work area.
   * @param config - the resolved `sessions` configuration block.
   * @param signal - optional cancellation.
   * @returns a summary `{ exported, unchanged, skipped, failed, notes }`.
   */
  async exportArea(area, config, signal) {
    const summary = { exported: 0, unchanged: 0, skipped: 0, failed: 0, notes: [] }
    const persistence = this.persistence()
    if (persistence === undefined) return summary
    const dir = archiveDir(area.path, config?.dir)
    const compression = config?.compression === 'none' ? 'none' : 'zstd'
    if (compression === 'zstd' && !zstdAvailable()) {
      summary.notes.push('本机 Node 不支持 zstd，已跳过会话导出')
      return summary
    }

    let snapshots
    try {
      snapshots = await persistence.list()
    } catch (error) {
      summary.failed += 1
      summary.notes.push(`读取会话列表失败：${messageOf(error)}`)
      return summary
    }

    const inScope = []
    const rememberedImports = this.state.imports()
    for (const snapshot of snapshots) {
      const header = snapshot?.header
      if (header === undefined || header === null) continue
      const id = String(header.id)
      // A subagent child is a session of this work area too, and it travels
      // with its parent: the parent's history refers to it.
      const inArea = sessionInArea(area.path, header.cwd, config?.includeDescendants !== false)
      // A session this area imported keeps travelling with it even when the
      // recorded working directory belongs to the machine it came from: without
      // this, a continuation made here could never be published back.
      const adopted = rememberedImports[id]?.areaId !== undefined
        && String(rememberedImports[id].areaId) === String(area.id)
      if (!inArea && !adopted) continue
      inScope.push({ header, revision: String(snapshot.revision ?? '') })
    }

    const limit = Number.isFinite(config?.maxSessions) && config.maxSessions > 0
      ? Math.floor(config.maxSessions)
      : 200
    inScope.sort((left, right) => (right.header.createdAt ?? 0) - (left.header.createdAt ?? 0))
    if (inScope.length > limit) {
      summary.skipped += inScope.length - limit
      summary.notes.push(`超出 maxSessions=${limit}，未同步 ${inScope.length - limit} 条较旧会话`)
    }

    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      summary.failed += 1
      summary.notes.push(`无法创建归档目录：${messageOf(error)}`)
      return summary
    }

    for (const entry of inScope.slice(0, limit)) {
      signal?.throwIfAborted?.()
      const id = String(entry.header.id)
      try {
        const outcome = await this.#exportOne({ area, config, persistence, id, revision: entry.revision, dir, compression })
        if (outcome === 'exported') {
          summary.exported += 1
        } else if (outcome.startsWith('skipped')) {
          summary.skipped += 1
          const reason = outcome.slice(outcome.indexOf(':') + 1)
          if (reason !== '') summary.notes.push(reason)
        } else {
          summary.unchanged += 1
        }
      } catch (error) {
        summary.failed += 1
        summary.notes.push(`导出 ${id} 失败：${messageOf(error)}`)
      }
    }
    this.state.save()
    return summary
  }

  /**
   * Export one session, or explain why it was left alone.
   * @returns `exported`, `unchanged`, or `skipped:<reason>`.
   */
  async #exportOne({ area, config, persistence, id, revision, dir, compression }) {
    if (!SAFE_ID.test(id)) return `skipped:会话 id 不可用作文件名，已跳过：${id}`
    const path = join(dir, archiveName(id, compression))
    const onDisk = fileFingerprint(path)
    const remembered = this.state.exported(area.id, id)

    // Unchanged on both sides since the last pass: nothing to read at all.
    if (remembered !== undefined && onDisk !== undefined
      && remembered.revision === revision
      && remembered.size === onDisk.size && remembered.mtimeMs === onDisk.mtimeMs) {
      return 'unchanged'
    }

    const handle = await persistence.open(id, 'read')
    let header
    let events
    try {
      header = handle.header
      events = (await handle.read(0, undefined)).events
    } finally {
      await handle.close()
    }

    // An archive this machine never wrote is another machine's publication.
    // Overwriting a longer or different one would destroy its work, so only a
    // log that already contains everything the archive holds may replace it.
    if (onDisk !== undefined && remembered === undefined) {
      const archive = this.#loadArchive(id, path, compression, onDisk)
      const { verdict } = compareEventLogs(events, archive.events)
      if (verdict === 'equal') {
        this.#adoptArchive(area, id, events.length, onDisk)
        return 'unchanged'
      }
      if (verdict !== 'local-ahead') {
        return `skipped:${id} 的归档比本地新或已分叉，留给导入处理`
      }
    }

    const bytes = encodeArchive(serializeSession(header, events), compression)
    const maxBytes = Number.isFinite(config?.maxBytes) ? config.maxBytes : 0
    if (maxBytes > 0 && bytes.byteLength > maxBytes) {
      return `skipped:${id} 超过 maxBytes=${maxBytes}，已跳过`
    }
    writeAtomic(path, bytes)
    const after = fileFingerprint(path)
    const fingerprint = {
      revision,
      events: events.length,
      size: after?.size ?? 0,
      mtimeMs: after?.mtimeMs ?? 0,
      at: Date.now(),
    }
    this.state.markExported(area.id, id, fingerprint)
    this.state.markArchive(id, { size: fingerprint.size, mtimeMs: fingerprint.mtimeMs, events: events.length })
    return 'exported'
  }

  /**
   * Rebuild every archived session of one work area that this machine lacks.
   * @param area - configured work area.
   * @param config - the resolved `sessions` configuration block.
   * @param signal - optional cancellation.
   * @returns a summary `{ imported, appended, unchanged, conflicts, failed, notes }`.
   */
  async importArea(area, config, signal) {
    const summary = { imported: 0, appended: 0, unchanged: 0, conflicts: 0, failed: 0, notes: [] }
    const persistence = this.persistence()
    if (persistence === undefined) return summary
    const dir = archiveDir(area.path, config?.dir)
    const compression = config?.compression === 'none' ? 'none' : 'zstd'

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return summary
    }

    let existing
    try {
      existing = new Set()
      for (const snapshot of await persistence.list()) {
        if (snapshot?.header?.id !== undefined) existing.add(String(snapshot.header.id))
      }
    } catch (error) {
      summary.failed += 1
      summary.notes.push(`读取会话列表失败：${messageOf(error)}`)
      return summary
    }
    this.state.pruneImports(existing)

    for (const dirent of entries) {
      signal?.throwIfAborted?.()
      if (!dirent.isFile()) continue
      const parsed = archiveEntry(dirent.name)
      if (parsed === undefined) continue
      if (parsed.compression !== compression) {
        summary.failed += 1
        summary.notes.push(`${dirent.name} 与配置的 compression（${compression}）不一致，已跳过`)
        continue
      }
      try {
        const outcome = await this.#importOne({
          area,
          config,
          persistence,
          id: parsed.id,
          path: join(dir, dirent.name),
          compression,
        })
        if (outcome === 'imported') summary.imported += 1
        else if (outcome === 'appended') summary.appended += 1
        else if (outcome === 'conflict') summary.conflicts += 1
        else summary.unchanged += 1
      } catch (error) {
        summary.failed += 1
        summary.notes.push(`导入 ${parsed.id} 失败：${messageOf(error)}`)
      }
    }
    this.state.save()
    return summary
  }

  /**
   * Apply one archive file: create, extend, or refuse.
   * @returns `imported`, `appended`, `unchanged` or `conflict`.
   */
  async #importOne({ area, config, persistence, id, path, compression }) {
    const onDisk = fileFingerprint(path)
    const remembered = this.state.archive(id)
    const archiveChanged = remembered === undefined || onDisk === undefined
      || remembered.size !== onDisk.size || remembered.mtimeMs !== onDisk.mtimeMs

    let archive
    if (archiveChanged) archive = this.#loadArchive(id, path, compression, onDisk)

    const existing = await persistence.stat(id)
    if (existing === undefined) {
      if (archive === undefined) archive = this.#loadArchive(id, path, compression, onDisk)
      const placement = await this.#create(persistence, id, archive, area, config)
      this.#markImported(id, archive, area, placement)
      // The local log now equals the archive: record that, so the export half
      // stops treating this archive as another machine's unpublished work.
      this.#adoptArchive(area, id, archive.events.length, onDisk)
      return 'imported'
    }

    // Both sides unchanged since the last comparison: no log read at all. The
    // remembered verdict is repeated so a parked conflict stays visible until
    // it is resolved, instead of silently disappearing on the next pass.
    const localRevision = String(existing.revision ?? '')
    if (!archiveChanged && remembered?.localRevision !== undefined
      && remembered.localRevision === localRevision) {
      return remembered.verdict === 'diverged' ? 'conflict' : 'unchanged'
    }

    if (archive === undefined) archive = this.#loadArchive(id, path, compression, onDisk)
    const local = await this.#readEvents(persistence, id)
    const { verdict, from } = compareEventLogs(local, archive.events)

    if (verdict === 'remote-ahead') {
      const writer = await persistence.open(id, 'write')
      try {
        for (let start = from; start < archive.events.length; start += APPEND_BATCH) {
          await writer.append(archive.events.slice(start, start + APPEND_BATCH))
        }
        await writer.flush()
      } finally {
        await writer.close()
      }
      const after = await persistence.stat(id)
      this.#rememberCompared(id, archive.events.length, String(after?.revision ?? ''), onDisk, verdict)
      this.#markImported(id, archive, area, { originalCwd: archive.header.cwd, rewritten: false })
      this.#adoptArchive(area, id, archive.events.length, onDisk)
      return 'appended'
    }

    if (verdict === 'diverged') {
      // Both machines continued the same session offline. Nothing is discarded:
      // the local branch stays live, and both branches are parked side by side
      // under stable names so the repository shows exactly what happened.
      const conflicts = join(archiveDir(area.path, config?.dir), CONFLICT_DIR)
      mkdirSync(conflicts, { recursive: true })
      const stamp = String(onDisk?.mtimeMs ?? 0)
      writeAtomic(join(conflicts, `${id}.${stamp}.remote.jsonl`), serializeSession(archive.header, archive.events))
      writeAtomic(
        join(conflicts, `${id}.${stamp}.${hostLabel()}.local.jsonl`),
        serializeSession(existing.header, local),
      )
      this.#rememberCompared(id, archive.events.length, localRevision, onDisk, verdict)
      return 'conflict'
    }

    this.#rememberCompared(id, archive.events.length, localRevision, onDisk, verdict)
    return 'unchanged'
  }

  /**
   * Record that this machine's log and the archive now agree, so the next
   * export pass compares revisions instead of refusing the archive outright.
   */
  #adoptArchive(area, id, events, onDisk) {
    const local = this.state.archive(id)
    this.state.markExported(area.id, id, {
      revision: typeof local?.localRevision === 'string' ? local.localRevision : '',
      events,
      size: onDisk?.size ?? 0,
      mtimeMs: onDisk?.mtimeMs ?? 0,
      at: Date.now(),
    })
  }

  /** Read, decode, validate and remember one archive. */
  #loadArchive(id, path, compression, onDisk) {
    const archive = parseSessionArchive(readArchive(path, compression))
    if (archive.header.id !== id) {
      throw new Error(`归档内 header id "${archive.header.id}" 与文件名不一致`)
    }
    if (archive.formatVersion !== SESSION_FORMAT_VERSION) {
      throw new Error(`归档为会话格式 v${String(archive.formatVersion)}，本机只支持 v${SESSION_FORMAT_VERSION}`)
    }
    this.state.markArchive(id, { size: onDisk?.size ?? 0, mtimeMs: onDisk?.mtimeMs ?? 0, events: archive.events.length })
    return archive
  }

  /** Record the local side of a comparison so the next pass can skip it. */
  #rememberCompared(id, events, localRevision, onDisk, verdict) {
    this.state.markArchive(id, {
      size: onDisk?.size ?? 0,
      mtimeMs: onDisk?.mtimeMs ?? 0,
      events,
      localRevision,
      verdict,
    })
  }

  /** Read one session's logical events through a read handle. */
  async #readEvents(persistence, id) {
    const handle = await persistence.open(id, 'read')
    try {
      return (await handle.read(0, undefined)).events
    } finally {
      await handle.close()
    }
  }

  /**
   * Create one session natively and replay its whole history into it.
   * @returns the placement decision, for the device-switch notice.
   */
  async #create(persistence, id, archive, area, config) {
    const header = { ...archive.header }
    const originalCwd = archive.header.cwd
    const policy = config?.cwdPolicy === 'auto' || config?.cwdPolicy === 'area' ? config.cwdPolicy : 'keep'
    let rewritten = false
    if (policy === 'area') {
      header.cwd = area.path
      rewritten = originalCwd !== area.path
    } else if (policy === 'auto') {
      const usable = originalCwd !== undefined && directoryExists(originalCwd)
      if (!usable) {
        header.cwd = area.path
        rewritten = true
      }
    }

    const inherited = inheritedEventCount(header, archive.events)
    if (inherited === undefined) throw new Error('seeded session archive has no session/end-seed marker')
    const handle = await persistence.create(header, inherited === 0 ? undefined : { inheritedEventCount: inherited })
    try {
      for (let start = 0; start < archive.events.length; start += APPEND_BATCH) {
        await handle.append(archive.events.slice(start, start + APPEND_BATCH))
      }
      await handle.flush()
    } finally {
      await handle.close()
    }
    const after = await persistence.stat(id)
    this.state.markArchive(id, {
      ...(this.state.archive(id) ?? {}),
      localRevision: String(after?.revision ?? ''),
    })
    return { originalCwd, cwd: header.cwd, rewritten }
  }

  /** Record that a session on this machine came from another machine. */
  #markImported(id, archive, area, placement) {
    this.state.markImported(id, {
      at: Date.now(),
      areaId: String(area.id ?? ''),
      host: hostLabel(),
      originalCwd: typeof placement.originalCwd === 'string' ? placement.originalCwd : '',
      cwd: typeof placement.cwd === 'string' ? placement.cwd : '',
      rewritten: placement.rewritten === true,
      events: archive.events.length,
    })
  }
}

/**
 * Remove a stray temporary file left by an interrupted atomic write.
 * @param dir - archive directory.
 */
export function cleanTemporaries(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.endsWith('.tmp')) continue
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      // Best effort only.
    }
  }
}
