/**
 * dsh-sync-tool — git engine.
 *
 * Every command runs through `ctx.subprocess`, never `ctx.shell`: the shell
 * service wraps execution in the sandbox, which refuses writes outside the
 * session workspace under the default `workspace-write` policy, and a
 * `turn/end` hook cannot request an approval (approvals require an open turn).
 * The user-chosen work area is user-controlled, not model-controlled, so the
 * model-facing fence does not apply to it.
 *
 * Credentials never touch argv or disk: the token is delivered as git config
 * injected through the environment (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
 * `GIT_CONFIG_VALUE_n`), which git 2.31+ reads exactly like `-c`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Ignore rules written into a folder that has no `.gitignore` yet. */
export const BUILTIN_IGNORES = Object.freeze([
  'node_modules/',
  'lib/',
  'dist/',
  '*.log',
  '.credentials.yaml',
  'settings.yaml',
])

/** Staged paths that abort an automatic commit. */
export const SENSITIVE_PATTERNS = Object.freeze([
  /(^|\/)\.credentials\.ya?ml$/u,
  /(^|\/)\.env($|\.)/u,
  /(^|\/)\.netrc$/u,
  /(^|\/)settings\.ya?ml$/u,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/u,
])

/** Task-shaped sync outcomes. */
export const SYNC_STATUS = Object.freeze({
  ok: 'ok',
  noop: 'ok',
  conflict: 'conflict',
  error: 'error',
})

/** Resolve one area status from a sync result. */
export function statusOf(result) {
  return result.ok ? 'ok' : (result.conflict === true ? 'conflict' : 'error')
}

/** Regex over git's stderr for the "no identity configured" family of refusals. */
const IDENTITY_FAILURE = /Author identity unknown|Committer identity unknown|unable to auto-detect email address|empty ident name|Please tell me who you are/iu

/**
 * Whether a failed command was refused because the machine has no commit identity.
 * @param result - a command result from {@link GitEngine.run}.
 * @returns true when git refused for want of an author or committer.
 */
export function isIdentityFailure(result) {
  return IDENTITY_FAILURE.test(String(result === undefined || result === null ? '' : result.stderr))
}

/**
 * The identity an automatic commit falls back to when the machine has none of
 * its own. A configured `commitIdentity` wins; otherwise a clearly attributed
 * `dsh-sync` identity, so a commit made on a fresh machine is never anonymous.
 * @param config - resolved plugin configuration.
 * @returns the name and email to hand git.
 */
export function resolveCommitIdentity(config) {
  const configured = config !== null && typeof config === 'object'
    && typeof config.commitIdentity === 'object' && config.commitIdentity !== null
    ? config.commitIdentity
    : {}
  const name = typeof configured.name === 'string' && configured.name.trim() !== ''
    ? configured.name.trim()
    : 'dsh-sync'
  const email = typeof configured.email === 'string' && configured.email.trim() !== ''
    ? configured.email.trim()
    : `dsh-sync@${safeHostname()}`
  return { name, email }
}

/** Hostname safe to embed in a commit message. */
function safeHostname() {
  try {
    return hostname()
  } catch {
    return 'unknown-host'
  }
}

/** Expand the commit message template. */
export function buildCommitMessage(template, turn, now = new Date()) {
  const source = typeof template === 'string' && template.trim() !== ''
    ? template
    : 'dsh-sync: {host} {time} (turn {turn})'
  return source
    .replaceAll('{host}', safeHostname())
    .replaceAll('{time}', now.toISOString())
    .replaceAll('{turn}', String(turn ?? 0))
}

/** Canonical form used to compare two folder paths on this platform. */
export function normalizePath(value) {
  const unified = String(value ?? '').trim().replaceAll('\\', '/').replace(/\/+$/u, '')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

/** Whether `child` is `parent` or sits beneath it. */
export function pathContains(parent, child) {
  const base = normalizePath(parent)
  const target = normalizePath(child)
  if (base === '' || target === '') return false
  return target === base || target.startsWith(`${base}/`)
}

/** Extract the path from one `git status --porcelain` line. */
export function porcelainPath(line) {
  const body = String(line).slice(3).trim()
  const arrow = body.lastIndexOf(' -> ')
  return arrow === -1 ? body.replace(/^"|"$/gu, '') : body.slice(arrow + 4).replace(/^"|"$/gu, '')
}

/** First non-empty line of a command's diagnostics, for compact reporting. */
export function firstLine(text) {
  const line = String(text ?? '').split('\n').map(part => part.trim()).find(part => part !== '')
  return line === undefined ? '' : line.slice(0, 300)
}

/** Replace every secret occurrence with a fixed marker. */
export function scrubSecrets(text, secrets) {
  let out = String(text ?? '')
  for (const secret of secrets ?? []) {
    if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join('***')
  }
  return out
}

/** Read one collected stream after the process settled. */
function collectedText(handle, stream) {
  const reader = handle.collected === undefined ? undefined : handle.collected[stream]
  if (reader === undefined) return ''
  try {
    return reader.readFrom(0).text
  } catch {
    return ''
  }
}

/**
 * Runs git for one host context.
 *
 * The engine is deliberately stateless about areas: callers pass the area, and
 * concurrency (one pass at a time per area) is the caller's queue's business.
 */
export class GitEngine {
  /**
   * @param ctx - host cordis context carrying the `subprocess` service.
   * @param options - optional diagnostics sink.
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.executablePath = undefined
  }

  /** Resolve and cache the git executable in this provider's execution world. */
  async executable(env, signal) {
    if (this.executablePath !== undefined) return this.executablePath
    const subprocess = this.ctx.get('subprocess')
    if (subprocess === undefined) {
      throw new Error('the subprocess service is not composed, so git cannot run')
    }
    this.executablePath = await subprocess.resolveExecutable('git', env, signal)
    return this.executablePath
  }

  /**
   * Build the child environment, injecting the credential as git config and,
   * when one is supplied, an explicit commit identity.
   * @param area - the work area being synced.
   * @param token - credential value, or undefined.
   * @param identity - commit identity to force, or undefined to inherit the machine's.
   * @returns the environment and the secrets to scrub from output.
   */
  buildEnvironment(area, token, identity) {
    const env = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    const secrets = []
    if (typeof token === 'string' && token !== '') {
      const basic = Buffer.from(`oauth2:${token}`, 'utf8').toString('base64')
      env.GIT_CONFIG_COUNT = '1'
      env.GIT_CONFIG_KEY_0 = 'http.extraheader'
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`
      // Both the raw token and its encoding must never surface in output.
      secrets.push(token, basic)
    }
    if (identity !== undefined && identity !== null) {
      env.GIT_AUTHOR_NAME = identity.name
      env.GIT_AUTHOR_EMAIL = identity.email
      env.GIT_COMMITTER_NAME = identity.name
      env.GIT_COMMITTER_EMAIL = identity.email
    }
    return { env, secrets }
  }

  /**
   * Describe the repository state around one folder without changing anything.
   *
   * The browser cannot run git, so this is what lets the configuration panel
   * tell a plain directory from an existing project repository before the user
   * decides anything. It never writes: no init, no remote, no commit.
   *
   * @param path - the folder to inspect.
   * @param options - `{ credential, signal }`.
   * @returns `{ kind, root, remote, branch, dirty }`; `kind` is `none` for a
   *   plain directory, `repo` when the folder itself is the repository root,
   *   and `nested` when it sits inside someone else's checkout.
   */
  async probe(path, options = {}) {
    const { env, secrets } = this.buildEnvironment({ path, remote: '', branch: 'main', credentialRef: '' }, options.credential)
    const signal = options.signal
    const idle = { kind: 'none', root: '', remote: '', branch: '', dirty: 0 }
    let top
    try {
      top = await this.run({ cwd: path, args: ['rev-parse', '--show-toplevel'], env, secrets, signal })
    } catch {
      return idle
    }
    if (!top.ok) return idle
    const root = top.stdout.trim()
    if (root === '') return idle

    const remote = await this.run({ cwd: path, args: ['remote', 'get-url', 'origin'], env, secrets, signal })
    const branch = await this.run({ cwd: path, args: ['rev-parse', '--abbrev-ref', 'HEAD'], env, secrets, signal })
    const status = await this.run({ cwd: path, args: ['status', '--porcelain'], env, secrets, signal })
    const branchName = firstLine(branch.stdout)
    return {
      kind: normalizePath(root) === normalizePath(path) ? 'repo' : 'nested',
      root,
      remote: firstLine(remote.stdout),
      // An unborn branch reports the literal "HEAD"; treat that as no branch.
      branch: branchName === 'HEAD' ? '' : branchName,
      dirty: status.ok
        ? status.stdout.split('\n').filter(line => line.trim() !== '').length
        : 0,
    }
  }

  /**
   * Keep a pattern out of `git status` without touching a tracked file.
   *
   * `.git/info/exclude` is the repository's own private ignore list: it is never
   * committed, never pushed, and never shows up as a change the user has to
   * explain. That is exactly what the session archive needs when the plugin is a
   * guest in somebody else's repository — the folder must not appear as
   * untracked, or a later `git add -A` would commit the conversations into a
   * project that has nothing to do with them.
   *
   * The path is resolved through `git rev-parse --git-path`, so worktrees and
   * submodules (where `.git` is a file pointing elsewhere) are handled too.
   *
   * @param cwd - any directory inside the repository.
   * @param patterns - ignore patterns to ensure, verbatim.
   * @param env - child environment.
   * @param secrets - values to scrub.
   * @param signal - cancellation.
   * @returns the file written, or undefined when nothing was needed.
   */
  async ensureLocalExclude(cwd, patterns, env, secrets, signal) {
    const wanted = patterns.filter(pattern => typeof pattern === 'string' && pattern !== '')
    if (wanted.length === 0) return undefined
    const resolved = await this.run({
      cwd, args: ['rev-parse', '--git-path', 'info/exclude'], env, secrets, signal,
    })
    if (!resolved.ok) return undefined
    const reported = firstLine(resolved.stdout)
    if (reported === '') return undefined
    const target = isAbsolute(reported) ? reported : join(cwd, reported)
    let existing = ''
    try {
      existing = readFileSync(target, 'utf8')
    } catch {
      existing = ''
    }
    const lines = existing.split('\n').map(line => line.trimEnd())
    const missing = wanted.filter(pattern => !lines.includes(pattern))
    if (missing.length === 0) return undefined
    const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`
    writeFileSync(target, `${prefix}${missing.join('\n')}\n`, 'utf8')
    return target
  }

  /**
   * Run one git command.
   * @param options - working directory, arguments, environment, secrets, cancellation, deadline.
   * @returns exit code, whether it succeeded, and scrubbed stdout/stderr.
   */
  async run(options) {
    const { cwd, args, env = {}, secrets = [], signal, timeoutMs = 180_000 } = options
    const subprocess = this.ctx.get('subprocess')
    if (subprocess === undefined) {
      throw new Error('the subprocess service is not composed, so git cannot run')
    }
    const git = await this.executable(env, signal)

    const controller = new AbortController()
    const forward = () => controller.abort(signal === undefined ? undefined : signal.reason)
    if (signal !== undefined) {
      if (signal.aborted) forward()
      else signal.addEventListener('abort', forward, { once: true })
    }
    const timer = setTimeout(
      () => controller.abort(new Error(`git timed out after ${timeoutMs} ms`)),
      timeoutMs,
    )

    try {
      const handle = subprocess.spawn({
        argv: [git, ...args],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 256 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 3000,
        signal: controller.signal,
        env: { ...env, GIT_TERMINAL_PROMPT: '0' },
      })
      const outcome = await handle.done
      await handle.waitForExit().catch(() => {})
      const stdout = scrubSecrets(collectedText(handle, 'stdout'), secrets)
      const stderr = scrubSecrets(collectedText(handle, 'stderr'), secrets)
      const code = outcome.exitCode
      this.log(`git ${args.join(' ')} -> ${String(code)}`)
      return { args, code, ok: code === 0, stdout, stderr }
    } catch (error) {
      return {
        args,
        code: null,
        ok: false,
        stdout: '',
        stderr: scrubSecrets(error instanceof Error ? error.message : String(error), secrets),
      }
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', forward)
    }
  }

  /**
   * Ensure the folder's `.gitignore` carries the built-in rules plus the area's
   * extra patterns. Existing content is preserved and only missing lines are
   * appended, so a sync that changes nothing does not churn the file.
   * @param cwd - repository root.
   * @param extraIgnores - additional patterns configured on the area.
   * @returns true when the file changed.
   */
  ensureGitignore(cwd, extraIgnores = []) {
    const path = join(cwd, '.gitignore')
    const extras = (Array.isArray(extraIgnores) ? extraIgnores : [])
      .filter(entry => typeof entry === 'string' && entry.trim() !== '')
      .map(entry => entry.trim())
    const desired = [...BUILTIN_IGNORES, ...extras]

    let existing = ''
    try {
      existing = readFileSync(path, 'utf8')
    } catch {
      existing = ''
    }
    const present = new Set(
      existing.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== ''),
    )
    const missing = desired.filter(pattern => !present.has(pattern))
    if (existing !== '' && missing.length === 0) return false

    const body = existing === ''
      ? `${desired.join('\n')}\n`
      : `${existing.replace(/\s+$/u, '')}\n${missing.join('\n')}\n`
    writeFileSync(path, body, 'utf8')
    return true
  }

  /**
   * Run one full sync pass for a single work area.
   *
   * Sequence: identify the repository, point `origin` at the configured remote,
   * commit local changes, integrate the remote (fast-forward, or rebase when
   * both sides moved), then push. A rebase failure is always aborted so the
   * working tree is left as the user had it, and reported as a conflict.
   *
   * Two optional hooks let a caller contribute work that belongs to the same
   * pass: `beforeCommit` runs once the repository is identified and `origin` is
   * aligned, so anything it writes is included in this commit; `afterIntegrate`
   * runs once the working tree holds the remote's content, so anything it reads
   * sees what the other machine published. Neither can fail the pass.
   *
   * @param options - the area, resolved config, credential value, turn number,
   *   cancellation, and the optional pass hooks.
   * @returns the area status to publish.
   */
  async syncArea(options) {
    const { area, config, credential, turn, signal } = options
    const { env, secrets } = this.buildEnvironment(area, credential)
    const branch = String(area.branch ?? 'main').trim() === '' ? 'main' : String(area.branch).trim()
    const remote = String(area.remote ?? '').trim()
    const direction = area.direction ?? 'both'
    /** Extra status parts contributed by the pass hooks. */
    const hookParts = []
    const runHook = async (hook) => {
      if (typeof hook !== 'function') return
      try {
        const produced = await hook(area)
        if (Array.isArray(produced)) {
          for (const part of produced) {
            if (typeof part === 'string' && part !== '') hookParts.push(part)
          }
        }
      } catch (error) {
        hookParts.push(`附加步骤失败：${firstLine(error instanceof Error ? error.message : String(error))}`)
      }
    }
    const same = (left, right) => normalizePath(left) === normalizePath(right)
    const broken = (status, detail, extra = {}) => ({
      status,
      detail,
      head: extra.head ?? '',
      ahead: extra.ahead ?? 0,
      behind: extra.behind ?? 0,
    })
    const fail = (detail, result) => broken('error', `${detail}${result === undefined ? '' : `：${firstLine(result.stderr)}`}`)

    // 1. Identify the repository, and decide what to do inside a parent one.
    // A folder under an unrelated checkout is the common case on Windows (a
    // home directory that is itself a repository, with `$DSH_HOME` beneath it),
    // so the default is to initialise an independent nested repository there
    // rather than refusing the user's chosen folder.
    const toplevel = await this.run({ cwd: area.path, args: ['rev-parse', '--show-toplevel'], env, secrets, signal })
    let nestedInside
    if (!toplevel.ok) {
      const init = await this.run({ cwd: area.path, args: ['init', '-b', branch], env, secrets, signal })
      if (!init.ok) return fail('git init 失败', init)
    } else if (!same(toplevel.stdout, area.path)) {
      if ((area.nestedRepos ?? 'refuse') === 'refuse') {
        return broken(
          'error',
          `该目录位于另一个 git 仓库内部（仓库根：${toplevel.stdout.trim()}），已按配置拒绝操作`,
        )
      }
      nestedInside = toplevel.stdout.trim()
      const init = await this.run({ cwd: area.path, args: ['init', '-b', branch], env, secrets, signal })
      if (!init.ok) return fail('git init 失败', init)
    }

    // 2. Point origin at the configured remote.
    if (remote !== '') {
      const current = await this.run({ cwd: area.path, args: ['remote', 'get-url', 'origin'], env, secrets, signal })
      if (!current.ok) {
        const added = await this.run({ cwd: area.path, args: ['remote', 'add', 'origin', remote], env, secrets, signal })
        if (!added.ok) return fail('添加 remote 失败', added)
      } else if (current.stdout.trim() !== remote) {
        const set = await this.run({ cwd: area.path, args: ['remote', 'set-url', 'origin', remote], env, secrets, signal })
        if (!set.ok) return fail('更新 remote 失败', set)
      }
    }

    // Anything the caller wants committed with this pass must be on disk before
    // the status check below, so the hook runs before the commit, not after it.
    await runHook(options.hooks?.beforeCommit)

    // 3. Commit local changes.
    //
    // `area.commitPaths` narrows the commit to those paths. That is what lets
    // the plugin live inside a repository the user already owns: the pass
    // publishes the session archive and leaves every other working-tree change
    // exactly as it found it, including anything the user staged themselves.
    let committed = false
    let identityUsed
    const scope = Array.isArray(area.commitPaths) && area.commitPaths.length > 0 ? area.commitPaths : undefined
    const scoped = (args) => (scope === undefined ? args : [...args, '--', ...scope])
    if (area.autoCommit !== false) {
      const status = await this.run({ cwd: area.path, args: scoped(['status', '--porcelain']), env, secrets, signal })
      if (!status.ok) return fail('git status 失败', status)
      const lines = status.stdout.split('\n').map(line => line.trimEnd()).filter(line => line !== '')
      if (lines.length > 0) {
        const staged = lines.map(porcelainPath)
        const sensitive = staged.filter(path => SENSITIVE_PATTERNS.some(pattern => pattern.test(path)))
        if (sensitive.length > 0 && area.guardSensitive !== false) {
          return broken(
            'error',
            `检测到敏感文件，已拒绝自动提交：${sensitive.slice(0, 3).join('、')}`,
          )
        }
        this.ensureGitignore(area.path, area.extraIgnores)
        const add = await this.run({ cwd: area.path, args: scoped(['add', '-A']), env, secrets, signal })
        if (!add.ok) return fail('git add 失败', add)
        const message = buildCommitMessage(config.commitMessageTemplate, turn)
        const commitArgs = scoped(['commit', '-m', message, '--no-verify'])
        let commit = await this.run({ cwd: area.path, args: commitArgs, env, secrets, signal })
        if (!commit.ok && isIdentityFailure(commit)) {
          // A machine that never configured a git identity is exactly the fresh
          // "second machine" this plugin exists to serve, so an identity refusal
          // must not fail the whole sync. Retry once with the configured or
          // derived identity: a real ambient identity is never overridden, and
          // the substitution is announced rather than hidden.
          const identity = resolveCommitIdentity(config)
          const retry = this.buildEnvironment(area, credential, identity)
          const second = await this.run({
            cwd: area.path,
            args: commitArgs,
            env: retry.env,
            secrets: retry.secrets,
            signal,
          })
          if (second.ok) {
            commit = second
            identityUsed = identity
          }
        }
        if (!commit.ok) return fail('git commit 失败', commit)
        committed = true
      }
    }

    // 4. Integrate the remote.
    let behind = 0
    let ahead = 0
    const remoteRef = `origin/${branch}`
    const hasHead = (await this.run({ cwd: area.path, args: ['rev-parse', '--verify', '--quiet', 'HEAD'], env, secrets, signal })).ok
    if (remote !== '' && direction !== 'push') {
      // Fetch the remote's refs rather than one refspec: asking for a branch
      // that does not exist yet (the very first push) is a fatal error, and an
      // empty remote is a normal starting state.
      const fetch = await this.run({
        cwd: area.path,
        args: ['fetch', '--prune', 'origin'],
        env,
        secrets,
        signal,
      })
      if (!fetch.ok) return fail('git fetch 失败（检查远端地址、网络或凭据）', fetch)

      const remoteExists = (await this.run({
        cwd: area.path,
        args: ['rev-parse', '--verify', '--quiet', remoteRef],
        env,
        secrets,
        signal,
      })).ok

      if (remoteExists && !hasHead) {
        // Unborn local branch with content on the remote: adopt it.
        const adopt = await this.run({
          cwd: area.path,
          args: ['checkout', '-B', branch, remoteRef],
          env,
          secrets,
          signal,
        })
        if (!adopt.ok) return fail('检出远端分支失败', adopt)
      } else if (remoteExists && hasHead) {
        const counts = await this.run({
          cwd: area.path,
          args: ['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`],
          env,
          secrets,
          signal,
        })
        if (counts.ok) {
          const [remoteSide, localSide] = counts.stdout.trim().split(/\s+/u).map(Number)
          behind = Number.isFinite(remoteSide) ? remoteSide : 0
          ahead = Number.isFinite(localSide) ? localSide : 0
        }
        if (behind > 0 && ahead === 0) {
          const fastForward = await this.run({
            cwd: area.path,
            args: ['merge', '--ff-only', remoteRef],
            env,
            secrets,
            signal,
          })
          if (!fastForward.ok) return fail('快进合并失败', fastForward)
          behind = 0
        } else if (behind > 0) {
          const rebase = await this.run({
            cwd: area.path,
            args: ['pull', '--rebase', '--autostash', 'origin', branch],
            env,
            secrets,
            signal,
          })
          if (!rebase.ok) {
            // Leave the working tree exactly as the user had it.
            await this.run({ cwd: area.path, args: ['rebase', '--abort'], env, secrets, signal })
            return broken(
              'conflict',
              `本地与远端都已改动且无法自动 rebase，已中止并保留本地文件；请手动处理后重试：${firstLine(rebase.stderr)}`,
            )
          }
          behind = 0
        }
      }
    }

    // The working tree now holds whatever the remote published, so a caller
    // that derives local state from committed files reads the merged result.
    await runHook(options.hooks?.afterIntegrate)

    // 5. Push.
    if (remote !== '' && direction !== 'pull') {
      const push = await this.run({
        cwd: area.path,
        args: ['push', '-u', 'origin', branch],
        env,
        secrets,
        signal,
      })
      if (!push.ok) {
        return broken('error', `git push 失败（检查远端地址、网络或凭据）：${firstLine(push.stderr)}`)
      }
    }

    // Counts read during integration predate the push, so a pass that just
    // published would still report itself ahead of the remote it just updated.
    // Re-read them at report time so the status the user sees is true when they
    // see it.
    if (remote !== '' && direction !== 'pull') {
      const counts = await this.run({
        cwd: area.path,
        args: ['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`],
        env,
        secrets,
        signal,
      })
      if (counts.ok) {
        const [remoteSide, localSide] = counts.stdout.trim().split(/\s+/u).map(Number)
        if (Number.isFinite(remoteSide)) behind = remoteSide
        if (Number.isFinite(localSide)) ahead = localSide
      }
    }

    const head = await this.run({ cwd: area.path, args: ['rev-parse', 'HEAD'], env, secrets, signal })
    const headSha = head.ok ? head.stdout.trim() : ''
    const parts = []
    if (nestedInside !== undefined) parts.push('父仓库内独立仓库')
    if (committed) {
      parts.push(identityUsed === undefined ? '已提交' : `已提交（回退身份 ${identityUsed.name}，本机未配置 git 身份）`)
    }
    if (remote === '') parts.push('未配置远端')
    else if (direction === 'pull') parts.push('已拉取')
    else if (direction === 'push') parts.push('已推送')
    else parts.push('已同步')
    if (behind > 0) parts.push(`落后 ${behind}`)
    if (ahead > 0) parts.push(`领先 ${ahead}`)
    parts.push(...hookParts)
    return broken('ok', parts.join(' · '), { head: headSha, ahead, behind })
  }
}

export default GitEngine
