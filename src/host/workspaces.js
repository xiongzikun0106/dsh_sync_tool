/**
 * dsh-sync-tool — Work-area resolution.
 *
 * The plugin no longer owns a list of folders. DSH owns workspaces: the user
 * picks a folder, conversations live inside it, and membership is recorded by
 * the Harness. This module answers the three questions the sync engine actually
 * has — which workspace does this session belong to, which sessions does a
 * workspace hold, and what does its folder look like on disk — and turns the
 * configured entries into the passes a sync run has to perform.
 *
 * Two shapes are deliberately kept apart:
 *
 *  - a **config entry**: what the user configured for one folder (`path` plus
 *    how to sync it);
 *  - a **pass**: either one folder synced in place (`folder` mode) or one shared
 *    sessions repository carrying the archives of several folders (`sessions`
 *    mode). Grouping happens here so the engine never syncs the same repository
 *    twice in one run.
 */
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'

import { workspaceKey } from './contract.js'
import { dshHome } from './sessions.js'

/**
 * Fold a legacy `areas[]` document into `workspaces[]`.
 *
 * A settings document written by an earlier version must keep loading, so the
 * retired field stays in the schema and is translated here. Entries are
 * translated with their own intent preserved: an old area synced its whole
 * folder in place, so it becomes explicit `folder` mode rather than the new
 * `auto` default (which would silently narrow an existing project repository's
 * sync to sessions only).
 *
 * @param config - the resolved configuration.
 * @returns the configuration with a populated `workspaces` array.
 */
export function migrateConfig(config) {
  const current = config ?? {}
  const workspaces = Array.isArray(current.workspaces) ? current.workspaces : []
  const areas = Array.isArray(current.areas) ? current.areas : []
  // The user document wins whenever it has been written by this version: the
  // browser half clears `areas` on every save, so a stale legacy list can never
  // resurrect a work area the user removed.
  if (workspaces.length > 0 || areas.length === 0) return { ...current, workspaces }
  return {
    ...current,
    workspaces: areas.map(area => ({
      path: String(area.path ?? ''),
      title: String(area.name ?? ''),
      mode: 'folder',
      remote: String(area.remote ?? ''),
      branch: String(area.branch ?? 'main'),
      credentialRef: String(area.credentialRef ?? ''),
      direction: area.direction ?? 'both',
      enabled: area.enabled !== false,
      autoCommit: area.autoCommit !== false,
      commitScope: 'all',
      extraIgnores: Array.isArray(area.extraIgnores) ? area.extraIgnores : [],
      guardSensitive: area.guardSensitive !== false,
      nestedRepos: area.nestedRepos === 'refuse' ? 'refuse' : 'init',
    })),
  }
}

/**
 * Configured entries, with a stable key and a display title.
 * @param config - the resolved configuration.
 * @returns `[{ entry, key, title }]`.
 */
export function configuredWorkspaces(config) {
  const workspaces = migrateConfig(config).workspaces ?? []
  return workspaces.map((entry) => {
    const path = String(entry.path ?? '')
    return {
      entry,
      key: workspaceKey(path),
      title: String(entry.title ?? '') !== '' ? String(entry.title) : baseName(path),
    }
  })
}

/** Folder name of a path, tolerating both separators and trailing slashes. */
export function baseName(path) {
  const cleaned = String(path ?? '').replace(/[\\/]+$/u, '')
  const leaf = basename(cleaned.replace(/\\/gu, '/'))
  return leaf === '' || leaf === '.' || leaf === '/' ? cleaned : leaf
}

/**
 * Decide how one work area syncs, from its own setting and the folder probe.
 * @param entry - the configured entry.
 * @param probe - the folder probe, or undefined when it could not be taken.
 * @returns `folder` (sync the folder in place) or `sessions` (archive only).
 */
export function resolveMode(entry, probe) {
  if (entry?.mode === 'folder' || entry?.mode === 'sessions') return entry.mode
  // A folder that is already somebody's repository must not be hijacked: its
  // files, commits and branch belong to the user, so only the archive travels.
  return probe?.kind === 'repo' || probe?.kind === 'nested' ? 'sessions' : 'folder'
}

/** Repository a `sessions` work area mirrors into, or '' when none is set. */
export function sessionsRemoteFor(entry, config) {
  const own = String(entry?.remote ?? '').trim()
  if (own !== '') return own
  return String(config?.sessionsRemote ?? '').trim()
}

/**
 * Group the selected work areas into the passes one run performs.
 *
 * @param selected - `[{ entry, key, title, mode, remote }]`, mode already resolved.
 * @returns `{ folders, repos, unconfigured }`; `repos` is keyed by remote URL, so
 *   several work areas sharing one sessions repository produce a single pass.
 */
export function groupPasses(selected) {
  const folders = []
  const repos = new Map()
  const unconfigured = []
  for (const member of selected) {
    if (member.mode === 'sessions') {
      if (member.remote === '') {
        unconfigured.push(member)
        continue
      }
      const bucket = repos.get(member.remote) ?? { remote: member.remote, members: [] }
      bucket.members.push(member)
      repos.set(member.remote, bucket)
      continue
    }
    if (String(member.remote ?? '').trim() === '') {
      unconfigured.push(member)
      continue
    }
    folders.push(member)
  }
  return { folders, repos: [...repos.values()], unconfigured }
}

/**
 * Root of the plugin-owned mirrors.
 * @param config - the resolved configuration; `sessionsRoot` overrides the default.
 * @returns absolute directory; each repository gets its own child.
 */
export function mirrorRoot(config) {
  const configured = String(config?.sessionsRoot ?? '').trim()
  if (configured !== '') return resolve(configured)
  return join(dshHome(), 'sync-tool', 'repos')
}

/**
 * Mirror working tree for one sessions repository.
 * Keyed by the remote URL, because the identity of a mirror is the repository it
 * publishes, not the work area that happens to write into it.
 * @param remote - repository URL.
 * @param root - the mirrors root; defaults to {@link mirrorRoot}.
 * @returns absolute directory path.
 */
export function mirrorDirFor(remote, root) {
  const digest = createHash('sha1').update(String(remote ?? '').trim()).digest('hex').slice(0, 12)
  return join(root ?? mirrorRoot(), digest)
}

/**
 * Subdirectory one work area owns inside a mirror or at a mirror's root.
 *
 * A shared sessions repository keeps every work area in its own folder; a
 * repository dedicated to a single work area puts the archive at its root,
 * which is what a person expects when they open that repository.
 *
 * @param member - `{ key, title, entry }`.
 * @param shared - whether the repository is the shared `sessionsRemote`.
 * @returns the relative subdirectory, `''` for the repository root.
 */
export function mirrorSubdir(member, shared) {
  if (shared !== true) return ''
  const leaf = baseName(member.entry.path).replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 40)
  const digest = createHash('sha1').update(member.key).digest('hex').slice(0, 6)
  return `${leaf === '' ? 'workspace' : leaf}-${digest}`
}

/**
 * The area-shaped object the git engine consumes for one entry.
 * @param member - `{ entry, key, title }`.
 * @param options - `{ path, commitPaths, nestedRepos, remote, branch }` overrides.
 * @returns an object with exactly the fields `GitEngine.syncArea` reads.
 */
export function areaOf(member, options = {}) {
  const entry = member.entry
  return {
    id: member.key,
    path: options.path ?? entry.path,
    remote: options.remote ?? entry.remote,
    branch: options.branch ?? entry.branch,
    credentialRef: entry.credentialRef,
    direction: options.direction ?? entry.direction,
    enabled: entry.enabled !== false,
    autoCommit: entry.autoCommit !== false,
    commitPaths: options.commitPaths,
    extraIgnores: Array.isArray(entry.extraIgnores) ? entry.extraIgnores : [],
    guardSensitive: entry.guardSensitive !== false,
    nestedRepos: options.nestedRepos ?? entry.nestedRepos,
  }
}
