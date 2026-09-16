/**
 * dsh-sync-tool — portable manifest.
 *
 * Each synced repository carries `.dsh-sync.json` describing its own sync
 * setup, so another machine can adopt the folder with one click. Only
 * machine-independent facts are written: the local path, the area id, the
 * enabled flag and the credential reference never leave the machine that owns
 * them.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** File a synced repository carries about its own sync setup. */
export const MANIFEST_NAME = '.dsh-sync.json'

/** The manifest format this build reads and writes. */
export const MANIFEST_VERSION = 1

/**
 * Project one work area onto its portable manifest.
 * @param area - the configured work area.
 * @returns the machine-independent subset.
 */
export function manifestFor(area) {
  return {
    version: MANIFEST_VERSION,
    // Which sync shape wrote this manifest: a folder synced in place, or a
    // work area whose archives are mirrored into a shared sessions repository.
    mode: area.mode === 'sessions' ? 'sessions' : 'folder',
    name: typeof area.title === 'string' && area.title !== ''
      ? area.title
      : (typeof area.name === 'string' ? area.name : ''),
    remote: typeof area.remote === 'string' ? area.remote : '',
    branch: typeof area.branch === 'string' && area.branch !== '' ? area.branch : 'main',
    direction: area.direction ?? 'both',
    autoCommit: area.autoCommit !== false,
    guardSensitive: area.guardSensitive !== false,
    nestedRepos: area.nestedRepos ?? 'refuse',
    extraIgnores: Array.isArray(area.extraIgnores) ? area.extraIgnores : [],
  }
}

/**
 * Write the manifest into a repository root. The content is deterministic for a
 * given configuration, so an unchanged area never dirties the working tree.
 * @param cwd - repository root.
 * @param area - the configured work area.
 * @returns the manifest path.
 */
export function writeManifest(cwd, area) {
  const path = join(cwd, MANIFEST_NAME)
  writeFileSync(path, `${JSON.stringify(manifestFor(area), null, 2)}\n`, 'utf8')
  return path
}

/**
 * Read a manifest from a folder.
 * @param cwd - folder to read from.
 * @returns the manifest, or undefined when absent or not this format.
 */
export function readManifest(cwd) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(cwd, MANIFEST_NAME), 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  if (parsed.version !== MANIFEST_VERSION) return undefined
  return parsed
}

/** Last path segment, used to name an imported area. */
export function baseName(path) {
  const parts = String(path).split(/[\\/]+/u).filter(part => part !== '')
  return parts.length === 0 ? String(path) : parts[parts.length - 1]
}

/**
 * Build a fresh work area from a folder and its manifest. The local path, id,
 * enabled flag and credential reference are supplied here, never read from the
 * manifest.
 * @param path - absolute folder path on this machine.
 * @param manifest - a manifest previously read from that folder.
 * @param id - identity to assign.
 * @returns the area to append to the configuration.
 */
export function areaFromManifest(path, manifest, id) {
  return {
    id,
    name: typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : baseName(path),
    path,
    mode: manifest.mode === 'sessions' ? 'sessions' : 'folder',
    remote: typeof manifest.remote === 'string' ? manifest.remote : '',
    branch: typeof manifest.branch === 'string' && manifest.branch !== '' ? manifest.branch : 'main',
    credentialRef: '',
    direction: manifest.direction ?? 'both',
    enabled: true,
    autoCommit: manifest.autoCommit !== false,
    extraIgnores: Array.isArray(manifest.extraIgnores) ? manifest.extraIgnores : [],
    guardSensitive: manifest.guardSensitive !== false,
    nestedRepos: manifest.nestedRepos ?? 'refuse',
  }
}
