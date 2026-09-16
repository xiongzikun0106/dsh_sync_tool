/**
 * dsh-sync-tool — Sessions mirror.
 *
 * A work area whose folder is already a git repository is not the plugin's to
 * commit in: that repository holds the user's code, their branch and their
 * unfinished work. The archive of their conversations still has to travel, so it
 * is published through a repository the plugin owns end to end — a *mirror*.
 *
 * A mirror is an ordinary checkout at `$DSH_HOME/sync-tool/repos/<hash>`; the
 * point of it is that the normal git pass runs there unchanged, which means
 * credentials, the commit-identity fallback, the fast-forward/rebase policy and
 * conflict aborting all apply without a second implementation.
 *
 * Copying is deliberately asymmetric:
 *
 *  - **into** the mirror, a work area's folder is mirrored exactly, so a session
 *    the user deleted stops being published;
 *  - **out of** the mirror, files are merged in and never deleted, because a
 *    deletion there would destroy a local archive that the export half may have
 *    just written mid-pass.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

/** File names never copied between a work area and a mirror. */
const SKIP = new Set(['.git'])

/**
 * Every file below one directory, as paths relative to it.
 * @param root - directory to walk.
 * @returns relative paths, deepest last; empty when the directory is absent.
 */
export function listFiles(root) {
  if (!existsSync(root)) return []
  const found = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) found.push(relative(root, full))
    }
  }
  walk(root)
  return found
}

/**
 * Copy one file, creating its parent directory and carrying the source's
 * timestamps onto the copy.
 *
 * The timestamps matter: the "did this change?" test below compares size and
 * modification time, and the platforms disagree about what a copy does to the
 * destination's mtime (Windows preserves it, POSIX stamps the copy). Carrying
 * them explicitly is what makes a repeated pass copy nothing at all, on both.
 */
function copyOne(source, target) {
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  try {
    const stats = statSync(source)
    utimesSync(target, stats.atime, stats.mtime)
  } catch {
    // A timestamp is an optimisation: without it the next pass copies again.
  }
}

/**
 * Whether two files differ in size or modification time.
 *
 * The comparison uses the millisecond `Date` rather than the raw `mtimeMs`
 * float, because that `Date` is exactly what `copyOne` writes: Node rounds the
 * filesystem's sub-millisecond precision for the `Date` but keeps it in the
 * float, so comparing the floats would report every freshly copied file as
 * changed and re-copy the whole archive on every pass.
 */
function differs(source, target) {
  try {
    const left = statSync(source)
    const right = statSync(target)
    return left.size !== right.size || left.mtime.getTime() !== right.mtime.getTime()
  } catch {
    return true
  }
}

/**
 * Mirror `source` into `target`: copy every file, refresh changed ones, and
 * remove files that no longer exist at the source.
 *
 * The removal half is what makes a deletion travel, and it is only ever used in
 * this direction (work area → mirror). An absent source is treated as "nothing
 * to say" rather than "empty", so a folder that is temporarily unavailable can
 * never wipe what other machines published.
 *
 * @param source - the work area's archive directory.
 * @param target - the mirror directory that represents it.
 * @returns `{ copied, removed }`, or undefined when the source does not exist.
 */
export function mirrorDirectory(source, target) {
  if (!existsSync(source)) return undefined
  const wanted = new Set(listFiles(source))
  let copied = 0
  for (const relativePath of wanted) {
    const from = join(source, relativePath)
    const to = join(target, relativePath)
    if (differs(from, to)) {
      copyOne(from, to)
      copied += 1
    }
  }
  let removed = 0
  for (const relativePath of listFiles(target)) {
    if (wanted.has(relativePath)) continue
    try {
      rmSync(join(target, relativePath), { force: true })
      removed += 1
    } catch {
      // A file that cannot be removed is reported by the commit that follows.
    }
  }
  return { copied, removed }
}

/**
 * Merge `source` into `target`: copy every file, refreshing changed ones, and
 * leave everything else alone.
 *
 * @param source - the mirror directory.
 * @param target - the work area's archive directory.
 * @returns `{ copied }`, or undefined when the source does not exist.
 */
export function mergeDirectory(source, target) {
  if (!existsSync(source)) return undefined
  mkdirSync(target, { recursive: true })
  let copied = 0
  for (const relativePath of listFiles(source)) {
    const from = join(source, relativePath)
    const to = join(target, relativePath)
    if (differs(from, to)) {
      copyOne(from, to)
      copied += 1
    }
  }
  return { copied }
}
