/**
 * Shared test harness: a `ctx.subprocess` stand-in that really spawns the
 * requested argv, plus a scratch world with a genuine bare remote.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A `ctx.subprocess` stand-in that really spawns the requested argv. */
export function fakeSubprocess() {
  return {
    async resolveExecutable(command) { return command },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      const done = new Promise((resolve) => {
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      const reader = (get) => ({ readFrom: () => ({ text: get(), nextOffset: 0, lossy: false }) })
      return {
        stdin: undefined,
        stdout: child.stdout,
        stderr: child.stderr,
        collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) },
        done,
        terminate() { child.kill() },
        async waitForExit() { await done; return true },
      }
    },
  }
}

/** A ctx exposing only the services the engine reads. */
export function engineContext() {
  const subprocess = fakeSubprocess()
  return { get: (service) => (service === 'subprocess' ? subprocess : undefined) }
}

/** Run git for test setup. */
export function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Build a scratch world: one bare remote, one working clone. */
export function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sync-test-'))
  const remote = join(root, 'remote.git')
  const work = join(root, 'work-a')
  mkdirSync(remote, { recursive: true })
  mkdirSync(work, { recursive: true })
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' })
  return { root, remote, work, cleanup: () => { rmSync(root, { recursive: true, force: true }) } }
}

/** The area shape the engine consumes. */
export function areaFor(world, overrides = {}) {
  return {
    id: 'a1',
    name: 'A',
    path: world.work,
    remote: world.remote,
    branch: 'main',
    credentialRef: '',
    direction: 'both',
    enabled: true,
    autoCommit: true,
    extraIgnores: [],
    guardSensitive: true,
    nestedRepos: 'init',
    ...overrides,
  }
}

/** Composition configuration used by the tests. */
export const CONFIG = { commitMessageTemplate: 'dsh-sync: {host} {time} (turn {turn})' }

/**
 * Call once per test process, before the tests run. Keeps commits hermetic and
 * caps git's upward repository search at the temp directory — this machine's
 * home directory is itself a repository, which would otherwise make every
 * scratch folder look like it sits inside a parent checkout.
 */
export function installHermeticGitEnv() {
  process.env.GIT_AUTHOR_NAME = 'dsh-sync-test'
  process.env.GIT_AUTHOR_EMAIL = 'dsh-sync-test@example.invalid'
  process.env.GIT_COMMITTER_NAME = 'dsh-sync-test'
  process.env.GIT_COMMITTER_EMAIL = 'dsh-sync-test@example.invalid'
  process.env.GIT_CEILING_DIRECTORIES = tmpdir()
}

/** Promise-based sleep. */
export function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
