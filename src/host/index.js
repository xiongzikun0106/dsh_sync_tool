/**
 * dsh-sync-tool — Host half.
 *
 * Owns two settings namespaces, which are the whole Host↔browser contract:
 *
 *  - `sync-tool`        user configuration (work areas, triggers, commands),
 *                       registered through `installSection` so the browser card
 *                       pairs with it by namespace key.
 *  - `sync-tool-status` Host-published runtime state (per-workspace result,
 *                       folder probes, capped history). The browser half binds
 *                       this scope read-only; no card claims the key.
 *
 * The configuration unit is a **DSH workspace folder**, not a list this plugin
 * maintains: the Harness owns workspaces, records which sessions belong to each,
 * and the user picks folders in its own sidebar. What the plugin adds is one
 * question per folder — "which remote does this sync to?" — and it answers where
 * it goes from the folder itself:
 *
 *  - a plain directory is synced in place (its own repository, archives inside);
 *  - a folder that is already a git repository is left completely alone, and
 *    only its conversation archives are published through a repository the
 *    plugin owns end to end (see `./mirror.js`).
 *
 * Settings is also the command channel: an out-of-tree plugin has no generated
 * Remote namespace, so the browser half bumps `request.token` and this half
 * watches the committed value. The git engine lives in `./git.js`, the folder
 * probe and pass planning in `./workspaces.js`, session records in
 * `./sessions.js`, and the device-switch notice in `./notice.js`.
 */
import { mkdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

import {
  Config, MODES, PROBE_KINDS, REQUEST_KINDS, STATUS_BASE, StatusConfig, WORKSPACE_STATUS, workspaceKey,
} from './contract.js'
import { buildCommitMessage, GitEngine } from './git.js'
import { mergeDirectory, mirrorDirectory } from './mirror.js'
import { installDeviceNotice } from './notice.js'
import { MANIFEST_NAME, manifestFor, readManifest, writeManifest } from './portable.js'
import { archiveDir, SESSIONS_DIR, SessionSync } from './sessions.js'
import {
  areaOf, configuredWorkspaces, groupPasses, migrateConfig, mirrorDirFor, mirrorRoot, mirrorSubdir,
  resolveMode, sessionsRemoteFor,
} from './workspaces.js'

/** Cordis plugin name (the loader row's `name` is the module specifier). */
export const name = 'sync-tool'

/** User-configuration namespace; the browser card claims this key. */
export const SYNC_NAMESPACE = 'sync-tool'

/** Host-published status namespace; consumed read-only by the browser half. */
export const STATUS_NAMESPACE = 'sync-tool-status'

/** Status values one work area can report. */
export const AREA_STATUS = WORKSPACE_STATUS

/** Sync directions and command kinds, re-exported for callers and tests. */
export { DIRECTIONS, MODES, PROBE_KINDS, REQUEST_KINDS } from './contract.js'

/** Configuration and status schemas, re-exported for the loader and tests. */
export { Config, StatusConfig }

/** Why one folder is unusable, or undefined when it is fine. */
export function folderProblem(path) {
  if (typeof path !== 'string' || path.trim() === '') return '路径为空 / empty path'
  if (!isAbsolute(path)) return '必须是绝对路径 / not an absolute path'
  let stats
  try {
    stats = statSync(path)
  } catch {
    return '目录不存在或不可访问 / does not exist or is not accessible'
  }
  if (!stats.isDirectory()) return '不是目录 / not a directory'
  return undefined
}

/** Error text for a status note. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Mount the Host half.
 * @param ctx - host cordis context.
 * @param config - schema-resolved configuration for this row.
 */
export function apply(ctx, config) {
  // The authoritative configuration thunk: the resolved settings scope while a
  // provider is attached, the composition entry otherwise.
  let resolveConfig = () => config

  /** Runtime state the engine writes and the status publisher reads. */
  const runtime = {
    running: false,
    workspaces: new Map(),
    probes: new Map(),
    notes: new Map(),
    history: [],
    revision: 0,
    statusScope: undefined,
    seenRequestToken: -1,
    disposed: false,
  }

  const engine = new GitEngine(ctx, { log: () => {} })
  const sessionSync = new SessionSync(ctx, { log: () => {} })

  /** Serialize every pass: one git sequence at a time, globally. */
  let queue = Promise.resolve()

  const warn = (message) => { console.warn(`[sync-tool] ${message}`) }

  /** Resolved configuration with any legacy `areas[]` folded in. */
  const current = () => migrateConfig(resolveConfig() ?? {})

  /** Session-record settings, shared by every work area. */
  const sessionConfig = () => current().sessions ?? {}

  /** Configured work areas with their stable keys and titles. */
  const entries = () => configuredWorkspaces(current())

  /** The configured entry for one workspace key. */
  const entryFor = (key) => entries().find(member => member.key === key)

  /** The archive directory of one entry. */
  const archiveOf = (entry) => archiveDir(entry.path, sessionConfig().dir)

  /** Keep the engine's bookkeeping pointed at the configured file. */
  const useSessionState = () => sessionSync.useState(sessionConfig().statePath)

  // The device-switch notice reads the import records this machine keeps, so it
  // is registered once, globally, and decides per assembled session.
  installDeviceNotice(ctx, {
    imports: () => {
      useSessionState()
      return sessionSync.imports()
    },
    enabled: () => sessionConfig().hintOnDeviceSwitch !== false,
    archiveDir: (record) => {
      const member = entryFor(record?.areaId)
      return member === undefined ? '' : archiveOf(member.entry)
    },
  })

  /** Compute and write the status document. */
  const publish = () => {
    const scope = runtime.statusScope
    if (scope === undefined) return
    // Teardown disposes the settings namespace around the same time our fiber's
    // drain runs, so a publish from a pass that outlived its services is
    // expected to fail. Once we have been told to stop, the status document is
    // not worth a warning.
    if (runtime.disposed) return
    const conf = current()
    const limit = Number.isFinite(conf.historyLimit) ? conf.historyLimit : 20

    const workspaces = entries().map((member) => {
      const observed = runtime.workspaces.get(member.key)
      const problem = folderProblem(member.entry.path)
      if (problem !== undefined) {
        return {
          id: member.key,
          path: member.entry.path,
          title: member.title,
          mode: observed?.mode ?? 'auto',
          status: 'error',
          at: Date.now(),
          detail: problem,
          head: '',
          ahead: 0,
          behind: 0,
          remote: '',
          branch: '',
        }
      }
      // `id` is restated last: an observed entry must never lose the field the
      // status schema requires, or the whole document would be rejected.
      return {
        ...(observed ?? {
          mode: 'auto', status: 'idle', at: 0, detail: '', head: '', ahead: 0, behind: 0, remote: '', branch: '',
        }),
        id: member.key,
        path: member.entry.path,
        title: member.title,
      }
    })

    runtime.revision += 1
    void scope.replace({
      revision: runtime.revision,
      running: runtime.running,
      updatedAt: Date.now(),
      workspaces,
      probes: [...runtime.probes.values()].slice(-40),
      history: runtime.history.slice(-Math.max(1, limit)),
    }).catch((error) => {
      warn(`status publish failed: ${messageOf(error)}`)
    })
  }

  /** Resolve one entry's credential value through the credentials seam. */
  const resolveCredential = async (ref) => {
    if (typeof ref !== 'string' || ref === '') return undefined
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return undefined
    try {
      const hit = await credentials.resolve(ref)
      return hit === undefined ? undefined : hit.value
    } catch (error) {
      warn(`credential "${ref}" could not be resolved: ${messageOf(error)}`)
      return undefined
    }
  }

  /**
   * The session ids the Harness accounts to one folder.
   *
   * This is the authoritative membership: a workspace records its own ordered
   * `sessionIds`, and reads them only for sessions whose canonical working
   * directory still matches the workspace path. `resolveByPath` is the exact
   * path → workspace query; the `list()` scan is the fallback for a folder git
   * cannot canonicalize (a missing directory, say).
   *
   * @param entry - the configured entry.
   * @returns session ids; empty when no registry is composed.
   */
  const workspaceMembers = async (entry) => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return []
    try {
      const direct = await registry.resolveByPath(entry.path)
      if (direct !== undefined) return [...direct.sessionIds]
    } catch {
      // A folder that does not exist cannot be canonicalized; fall through.
    }
    try {
      const found = registry.list().find(candidate => workspaceKey(candidate.path) === workspaceKey(entry.path))
      return found === undefined ? [] : [...found.sessionIds]
    } catch (error) {
      warn(`workspace lookup failed for "${entry.path}": ${messageOf(error)}`)
      return []
    }
  }

  /**
   * Inspect one folder and remember the answer for the status document.
   * @param entry - the configured entry, or a bare `{ path, credentialRef }`.
   * @param key - the workspace key the probe is published under.
   * @param signal - optional cancellation.
   * @returns the probe record.
   */
  const probeFolder = async (entry, key, signal) => {
    const credential = await resolveCredential(entry.credentialRef)
    let observed
    try {
      observed = await engine.probe(entry.path, { credential, signal })
    } catch (error) {
      observed = { kind: 'error', root: '', remote: '', branch: '', dirty: 0, error: messageOf(error) }
    }
    // A folder that already carries a manifest tells us how the other machine
    // synced it. In sessions mode the manifest lives inside the archive
    // directory, so both places are checked.
    const manifest = readManifest(entry.path) ?? readManifest(join(entry.path, sessionConfig().dir))
    const probe = {
      id: key,
      path: entry.path,
      kind: PROBE_KINDS.includes(observed.kind) ? observed.kind : 'unknown',
      remote: observed.remote ?? '',
      branch: observed.branch ?? '',
      root: observed.root ?? '',
      dirty: Number.isFinite(observed.dirty) ? observed.dirty : 0,
      manifestRemote: typeof manifest?.remote === 'string' ? manifest.remote : '',
      at: Date.now(),
      error: observed.error ?? '',
    }
    runtime.probes.set(key, probe)
    return probe
  }

  /** Status fragments for one session step's summary. */
  const describeSessions = (kind, summary) => {
    const parts = []
    if (kind === 'export' && summary.exported > 0) parts.push(`会话↑${summary.exported}`)
    if (kind === 'import' && summary.imported > 0) parts.push(`会话↓${summary.imported}`)
    if (kind === 'import' && summary.appended > 0) parts.push(`会话并入${summary.appended}`)
    if (summary.conflicts > 0) parts.push(`会话冲突${summary.conflicts}`)
    if (summary.failed > 0) parts.push(`会话失败${summary.failed}`)
    return parts
  }

  /** Keep one session step's notes for the history entry of this pass. */
  const rememberNotes = (key, notes) => {
    if (!Array.isArray(notes) || notes.length === 0) return
    const kept = runtime.notes.get(key) ?? []
    kept.push(...notes)
    runtime.notes.set(key, kept)
  }

  /** Record and publish one work area's finished pass. */
  const finalize = (member, mode, result, remote, branch) => {
    const value = {
      ...result,
      id: member.key,
      path: member.entry.path,
      title: member.title,
      mode,
      remote,
      branch,
      at: Date.now(),
    }
    runtime.workspaces.set(member.key, value)
    const notes = runtime.notes.get(member.key) ?? []
    runtime.history.push({
      at: value.at,
      id: member.key,
      ok: value.status === 'ok',
      summary: `${member.title} · ${value.detail}${notes.length === 0 ? '' : ` · ${notes.slice(0, 2).join('；')}`}`,
    })
    runtime.notes.delete(member.key)
    publish()
  }

  /** Mark one work area as in flight. */
  const markSyncing = (member, mode, remote, branch) => {
    runtime.workspaces.set(member.key, {
      id: member.key,
      path: member.entry.path,
      title: member.title,
      mode,
      status: 'syncing',
      at: Date.now(),
      detail: '同步中…',
      head: '',
      ahead: 0,
      behind: 0,
      remote,
      branch,
    })
    publish()
  }

  /** Record a work area the pass left alone, with the reason. */
  const markIdle = (member, mode, detail) => {
    runtime.workspaces.set(member.key, {
      id: member.key,
      path: member.entry.path,
      title: member.title,
      mode,
      status: 'idle',
      at: Date.now(),
      detail,
      head: '',
      ahead: 0,
      behind: 0,
      remote: '',
      branch: '',
    })
    publish()
  }

  /**
   * Sync one work area in place: the folder is its own repository.
   * @param member - `{ entry, key, title }`.
   * @param conf - the resolved configuration.
   * @param options - `{ turn, signal }`.
   */
  const syncFolder = async (member, conf, options) => {
    const commitPaths = member.entry.commitScope === 'archive' ? [sessionConfig().dir ?? SESSIONS_DIR] : undefined
    const area = areaOf(member, { commitPaths })
    markSyncing(member, 'folder', area.remote, area.branch)
    // Keep the repository self-describing before the commit, so the manifest
    // travels with the folder to the next machine.
    try {
      writeManifest(area.path, { ...area, name: member.title })
    } catch (error) {
      warn(`manifest write failed for "${area.path}": ${messageOf(error)}`)
    }
    const credential = await resolveCredential(area.credentialRef)
    let result
    try {
      result = await engine.syncArea({
        area,
        config: conf,
        credential,
        turn: options.turn ?? 0,
        signal: options.signal,
        hooks: {
          beforeCommit: async () => {
            // The archive is written first: this very commit publishes it.
            const members = await workspaceMembers(area)
            const summary = await sessionSync.exportArea(area, sessionConfig(), options.signal, { members })
            rememberNotes(member.key, summary.notes)
            return describeSessions('export', summary)
          },
          afterIntegrate: async () => {
            const summary = await sessionSync.importArea(area, sessionConfig(), options.signal)
            rememberNotes(member.key, summary.notes)
            return describeSessions('import', summary)
          },
        },
      })
    } catch (error) {
      result = { status: 'error', detail: `同步失败：${messageOf(error)}`, head: '', ahead: 0, behind: 0 }
    }
    finalize(member, 'folder', result, area.remote, area.branch)
  }

  /**
   * Sync the sessions repository shared by every work area that mirrors into it.
   *
   * The mirror is a plugin-owned checkout, so the whole git policy applies there
   * unchanged; the work areas themselves are only read and written through their
   * archive directories, never through their own repository.
   *
   * @param bucket - `{ remote, members }`.
   * @param conf - the resolved configuration.
   * @param options - `{ turn, signal }`.
   */
  const syncRepo = async (bucket, conf, options) => {
    const shared = bucket.remote === String(conf.sessionsRemote ?? '').trim()
    const mirrorPath = mirrorDirFor(bucket.remote, mirrorRoot(conf))
    // A checkout needs somewhere to live before git can be asked anything: the
    // first command runs with the mirror itself as its working directory.
    try {
      mkdirSync(mirrorPath, { recursive: true })
    } catch (error) {
      warn(`mirror directory "${mirrorPath}" could not be created: ${messageOf(error)}`)
    }
    const prepared = bucket.members.map(member => ({ ...member, subdir: mirrorSubdir(member, shared) }))
    const first = prepared[0]
    const area = {
      id: `sessions:${mirrorPath}`,
      path: mirrorPath,
      remote: bucket.remote,
      branch: first.entry.branch,
      credentialRef: first.entry.credentialRef,
      direction: first.entry.direction,
      enabled: true,
      autoCommit: true,
      commitPaths: undefined,
      extraIgnores: [],
      guardSensitive: false,
      // The mirror lives under the harness home, which may itself sit inside a
      // checkout, and it holds nothing but plugin-owned archives.
      nestedRepos: 'init',
    }
    for (const member of prepared) markSyncing(member, 'sessions', area.remote, area.branch)
    const credential = await resolveCredential(area.credentialRef)
    const { env, secrets } = engine.buildEnvironment(area, credential)
    let result
    try {
      result = await engine.syncArea({
        area,
        config: conf,
        credential,
        turn: options.turn ?? 0,
        signal: options.signal,
        hooks: {
          beforeCommit: async () => {
            const parts = []
            for (const member of prepared) {
              const folderArea = areaOf(member)
              const members = await workspaceMembers(member.entry)
              const summary = await sessionSync.exportArea(folderArea, sessionConfig(), options.signal, { members })
              rememberNotes(member.key, summary.notes)
              parts.push(...describeSessions('export', summary))
              // The archive directory carries its own manifest, so a second
              // machine that clones this repository can claim the folder without
              // being told the URL again. Writing it at the source keeps the
              // mirror a faithful copy instead of a delete-and-recreate each pass.
              try {
                writeManifest(archiveOf(member.entry), {
                  ...folderArea, remote: area.remote, name: member.title, mode: 'sessions',
                })
              } catch (error) {
                warn(`manifest write failed for "${archiveOf(member.entry)}": ${messageOf(error)}`)
              }
              const target = member.subdir === '' ? mirrorPath : join(mirrorPath, member.subdir)
              const mirrored = mirrorDirectory(archiveOf(member.entry), target)
              if (mirrored === undefined) {
                parts.push(`${member.title} 还没有归档目录`)
                continue
              }
              // The archive sits inside somebody's project, so it is hidden from
              // that project's `git status` through its own private exclude list:
              // no tracked file is edited, and a later `git add -A` cannot sweep
              // the conversations into the project's history.
              const repoRoot = member.probe?.root !== undefined && member.probe.root !== ''
                ? member.probe.root
                : member.entry.path
              const relativeArchive = relative(repoRoot, archiveOf(member.entry)).replace(/\\/gu, '/')
              try {
                await engine.ensureLocalExclude(
                  repoRoot,
                  [`${relativeArchive === '' ? '.' : relativeArchive}/`],
                  env,
                  secrets,
                  options.signal,
                )
              } catch (error) {
                warn(`local exclude failed for "${repoRoot}": ${messageOf(error)}`)
              }
              try {
                writeManifest(target, { ...folderArea, remote: area.remote, name: member.title, mode: 'sessions' })
              } catch (error) {
                warn(`mirror manifest write failed for "${target}": ${messageOf(error)}`)
              }
            }
            return parts
          },
          afterIntegrate: async () => {
            const parts = []
            for (const member of prepared) {
              const source = member.subdir === '' ? mirrorPath : join(mirrorPath, member.subdir)
              mergeDirectory(source, archiveOf(member.entry))
              const summary = await sessionSync.importArea(areaOf(member), sessionConfig(), options.signal)
              rememberNotes(member.key, summary.notes)
              parts.push(...describeSessions('import', summary))
            }
            return parts
          },
        },
      })
    } catch (error) {
      result = { status: 'error', detail: `同步失败：${messageOf(error)}`, head: '', ahead: 0, behind: 0 }
    }
    for (const member of prepared) finalize(member, 'sessions', result, area.remote, area.branch)
  }

  /** Run one sync pass over the selected work areas, publishing as it goes. */
  const runPass = async (options = {}) => {
    useSessionState()
    const conf = current()
    const wanted = Array.isArray(options.keys) && options.keys.length > 0 ? new Set(options.keys) : undefined
    const selected = entries().filter((member) => {
      if (member.entry.enabled === false) return false
      if (wanted !== undefined) return wanted.has(member.key)
      if (typeof options.key === 'string' && options.key !== '') return member.key === options.key
      return true
    })

    runtime.running = true
    publish()
    try {
      const prepared = []
      for (const member of selected) {
        if (runtime.disposed) return
        const problem = folderProblem(member.entry.path)
        if (problem !== undefined) {
          runtime.workspaces.set(member.key, {
            id: member.key,
            path: member.entry.path,
            title: member.title,
            mode: 'auto',
            status: 'error',
            at: Date.now(),
            detail: problem,
            head: '',
            ahead: 0,
            behind: 0,
            remote: '',
            branch: '',
          })
          publish()
          continue
        }
        const probe = await probeFolder(member.entry, member.key, options.signal)
        const mode = resolveMode(member.entry, probe)
        const remote = mode === 'sessions'
          ? sessionsRemoteFor(member.entry, conf)
          : String(member.entry.remote ?? '').trim()
        prepared.push({ ...member, mode, remote, probe })
      }
      publish()

      const groups = groupPasses(prepared)
      for (const member of groups.unconfigured) {
        markIdle(member, member.mode, '未配置远端仓库 / no remote configured')
      }
      for (const member of groups.folders) {
        if (runtime.disposed) return
        await syncFolder(member, conf, options)
      }
      for (const bucket of groups.repos) {
        if (runtime.disposed) return
        await syncRepo(bucket, conf, options)
      }
    } finally {
      runtime.running = false
      publish()
    }
  }

  /** Queue one pass behind whatever is already running. */
  const enqueuePass = (options = {}) => {
    const next = queue.then(() => runPass(options), () => runPass(options))
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Turn-boundary coalescing: bursty or nested turns inside one window collapse
   * into a single queued pass.
   */
  const pending = { keys: new Set(), all: false, turn: 0, timer: undefined }

  const flushPending = () => {
    pending.timer = undefined
    const keys = [...pending.keys]
    const { all, turn } = pending
    pending.keys.clear()
    pending.all = false
    if (all) enqueuePass({ turn })
    else if (keys.length > 0) enqueuePass({ turn, keys })
  }

  /**
   * The configured work area one session belongs to, or undefined.
   *
   * Membership is the Harness's answer, not a path comparison: a workspace
   * records the sessions it owns, and a session's working directory only counts
   * once `realpath` agrees with the workspace path. The working-directory
   * fallback covers a deployment without the workspace registry.
   *
   * @param session - the session a turn just finished in.
   * @returns the configured entry, or undefined.
   */
  const entryForSession = (session) => {
    const id = session?.id === undefined ? '' : String(session.id)
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined && id !== '') {
      try {
        const owner = registry.list().find(candidate => candidate.sessionIds.includes(id))
        if (owner !== undefined) {
          const member = entryFor(workspaceKey(owner.path))
          if (member !== undefined) return member
        }
      } catch (error) {
        warn(`workspace lookup failed: ${messageOf(error)}`)
      }
    }
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return undefined
    const key = workspaceKey(cwd)
    return entries().find(member => member.key === key)
  }

  /**
   * Decide what a finished turn should sync: the work area the session belongs
   * to, or every area when the user asked for that.
   * @param session - the session the turn belonged to.
   * @param event - the `turn/end` payload.
   */
  const scheduleTurnSync = (session, event) => {
    const conf = current()
    if (conf.enabled === false || conf.syncOnTurnEnd === false) return
    if (entries().filter(member => member.entry.enabled !== false).length === 0) return

    const member = entryForSession(session)
    if (member === undefined) {
      if (conf.syncAllOnTurnEnd !== true) return
      pending.all = true
    } else {
      pending.keys.add(member.key)
    }
    pending.turn = Number.isFinite(event?.data?.turn) ? event.data.turn : 0

    const delay = Number.isFinite(conf.debounceMs) ? Math.max(0, conf.debounceMs) : 5000
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.timer = setTimeout(flushPending, delay)
  }

  // Turn boundaries are durable session events; `session/event` listeners are
  // post-commit and fire-and-forget, so a slow or failing sync can never delay
  // or break the conversation.
  ctx.on('session/event', (session, event) => {
    if (event === undefined || event.type !== 'turn/end') return
    try {
      scheduleTurnSync(session, event)
    } catch (error) {
      warn(`turn scheduling failed: ${messageOf(error)}`)
    }
  })

  ctx.effect(function* () {
    // Keep the fiber alive across an in-flight pass, and stop accepting new work
    // the moment this plugin unloads.
    yield async () => {
      runtime.disposed = true
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer)
        pending.timer = undefined
      }
      await queue
      sessionSync.save()
    }
  }, 'sync-tool: pass drain')

  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings

    /** Answer one probe request for a folder that may not be configured yet. */
    const probeRequest = async (path) => {
      if (typeof path !== 'string' || path.trim() === '') return
      const key = workspaceKey(path)
      const member = entryFor(key)
      await probeFolder(member?.entry ?? { path, credentialRef: '' }, key)
      publish()
    }

    settings.installSection(ctx, SYNC_NAMESPACE, Config, config, {
      setSource: (resolved) => { resolveConfig = resolved },
      onChange: () => {
        const conf = current()
        publish()
        const request = conf.request ?? {}
        const token = Number.isFinite(request.token) ? Number(request.token) : 0
        // The first observation only records the baseline.
        if (runtime.seenRequestToken === -1) {
          runtime.seenRequestToken = token
          return
        }
        if (token === runtime.seenRequestToken) return
        runtime.seenRequestToken = token
        const path = typeof request.path === 'string' && request.path !== ''
          ? request.path
          : (typeof request.areaId === 'string' ? request.areaId : '')
        if (request.kind === 'probe' || request.kind === 'import') {
          void probeRequest(path)
        } else if (request.kind === 'sync' && conf.enabled !== false) {
          enqueuePass({ key: workspaceKey(path) })
        }
      },
    })

    // The status namespace is Host-owned: published wholesale, never merged,
    // because `update` deep-merges and would splice lists element-wise.
    runtime.statusScope = settings.register(STATUS_NAMESPACE, StatusConfig, { base: STATUS_BASE })

    publish()

    if ((resolveConfig() ?? {}).enabled !== false && (resolveConfig() ?? {}).syncOnStartup === true) {
      enqueuePass({})
    }
  })

  console.log(
    `[sync-tool] host half loaded (namespaces "${SYNC_NAMESPACE}", "${STATUS_NAMESPACE}",`
    + ` sessions -> "${sessionSync.state.path}")`,
  )
}

export { buildCommitMessage, GitEngine, MANIFEST_NAME, manifestFor, SessionSync }
