/**
 * dsh-sync-tool — the Host ↔ browser contract.
 *
 * Both halves of this plugin are out-of-tree, so the settings document is the
 * only vocabulary they share: the Host serves two namespaces from here and the
 * browser half writes one and reads the other. Keeping the three schemas in
 * their own module means the card, the header panel, and the sync engine cannot
 * drift apart, and it gives a reader one place to see what the plugin actually
 * stores.
 *
 * Layering is unchanged: schema defaults, then the composition row's `config`,
 * then the user document section.
 */
import z from '@deepseek-ai/schemastery'

/** How a work area's sync target is chosen. */
export const MODES = Object.freeze(['auto', 'folder', 'sessions'])

/** Sync directions. */
export const DIRECTIONS = Object.freeze(['both', 'push', 'pull'])

/**
 * Which paths an automatic commit may include.
 * `all` commits the whole folder; `archive` commits only the session archive
 * directory, which is what keeps an existing project repository untouched.
 */
export const COMMIT_SCOPES = Object.freeze(['all', 'archive'])

/** Command kinds the browser half may request. */
export const REQUEST_KINDS = Object.freeze(['none', 'sync', 'import', 'probe'])

/** Status values one work area can report. */
export const WORKSPACE_STATUS = Object.freeze(['idle', 'validating', 'syncing', 'ok', 'conflict', 'error'])

/**
 * What a work area's folder looks like on disk.
 * `none` is a plain directory, `repo` is a git repository root, `nested` is a
 * directory inside someone else's repository, `error` means git could not
 * answer.
 */
export const PROBE_KINDS = Object.freeze(['unknown', 'none', 'repo', 'nested', 'error'])

/** Archive subdirectory inside a work area (mirrors `sessions.js`). */
const DEFAULT_SESSIONS_DIR = '.dsh-sessions'

/**
 * Join key for one work area: the configured path, normalized for comparison.
 * Case-insensitive only on Windows, because POSIX paths distinguish case.
 * @param path - a configured or observed absolute path.
 * @returns a stable key, or an empty string when there is no path.
 */
export function workspaceKey(path) {
  if (typeof path !== 'string' || path.trim() === '') return ''
  const slashed = path.trim().replace(/\\/gu, '/').replace(/\/+$/u, '')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/**
 * Session-record settings. They are deployment-wide rather than per work area:
 * every work area uses the same subdirectory name, encoding, and cwd policy, so
 * one place to change them beats one place per folder.
 */
const SessionsSchema = z.object({
  /** Whether sessions travel with the work area. */
  enabled: z.boolean().default(true),
  /** Subdirectory of the work area that holds the archives. */
  dir: z.string().default(DEFAULT_SESSIONS_DIR),
  /** Archive encoding: compact `zstd`, or `none` for reviewable plain text. */
  compression: z.union(['zstd', 'none']).default('zstd'),
  /** Include sessions whose working directory is a subdirectory of the area. */
  includeDescendants: z.boolean().default(false),
  /** Per area, how many of the newest in-scope sessions to synchronise. */
  maxSessions: z.natural().default(200),
  /** Skip a single archive larger than this many bytes; 0 means no limit. */
  maxBytes: z.natural().default(0),
  /** What to do when the recorded working directory does not exist here. */
  cwdPolicy: z.union(['keep', 'auto', 'area']).default('keep'),
  /** Tell the model, invisibly, that this session came from another machine. */
  hintOnDeviceSwitch: z.boolean().default(true),
  /** Machine-local bookkeeping file; empty uses `$DSH_HOME/sync-tool/sessions.json`. */
  statePath: z.string().default(''),
})

/** Schema defaults, restated so `Config({})` needs no nested merge. */
const SESSION_DEFAULTS = {
  enabled: true,
  dir: DEFAULT_SESSIONS_DIR,
  compression: 'zstd',
  includeDescendants: false,
  maxSessions: 200,
  maxBytes: 0,
  cwdPolicy: 'keep',
  hintOnDeviceSwitch: true,
  statePath: '',
}

/** One work area: a DSH workspace folder and how it synchronises. */
const WorkspaceSchema = z.object({
  /** Absolute local folder. Also the entry's identity. */
  path: z.string().required(),
  /** Display title; falls back to the folder's basename. */
  title: z.string().default(''),
  /**
   * `auto` decides from the folder: a git repository (or a folder inside one)
   * synchronises sessions only, a plain directory synchronises everything.
   */
  mode: z.union([...MODES]).default('auto'),
  /**
   * Remote for `folder` mode. In `sessions` mode an empty value means "use the
   * shared `sessionsRemote`"; a value names a repository dedicated to this one
   * work area's sessions.
   */
  remote: z.string().default(''),
  /** Branch tracked on the remote. */
  branch: z.string().default('main'),
  /** Credential reference name resolved through ctx.credentials. */
  credentialRef: z.string().default(''),
  /** Sync direction. */
  direction: z.union([...DIRECTIONS]).default('both'),
  /** Whether automatic sync includes this work area. */
  enabled: z.boolean().default(true),
  /** Commit local changes before pulling/pushing. */
  autoCommit: z.boolean().default(true),
  /** Which paths an automatic commit may include. */
  commitScope: z.union([...COMMIT_SCOPES]).default('all'),
  /** Extra ignore patterns on top of the built-in set. */
  extraIgnores: z.array(z.string()).default([]),
  /** Refuse to commit when a sensitive file is staged. */
  guardSensitive: z.boolean().default(true),
  /**
   * A folder that already sits inside another checkout is the common case for a
   * work area the user picked from the sidebar, and creating a nested repository
   * there would leave a stray `.git` in their project, so refusal is the default.
   */
  nestedRepos: z.union(['refuse', 'init']).default('refuse'),
})

/** Default entry, restated for the schema's `default`. */
const WORKSPACE_DEFAULTS = {
  path: '',
  title: '',
  mode: 'auto',
  remote: '',
  branch: 'main',
  credentialRef: '',
  direction: 'both',
  enabled: true,
  autoCommit: true,
  commitScope: 'all',
  extraIgnores: [],
  guardSensitive: true,
  nestedRepos: 'refuse',
}

/**
 * The retired `areas[]` entry, still accepted so a settings document written by
 * an earlier version keeps loading; `migrateConfig` folds it into `workspaces`.
 */
const LegacyAreaSchema = z.object({
  id: z.string().required(),
  name: z.string().default(''),
  path: z.string().required(),
  remote: z.string().default(''),
  branch: z.string().default('main'),
  credentialRef: z.string().default(''),
  direction: z.union([...DIRECTIONS]).default('both'),
  enabled: z.boolean().default(true),
  autoCommit: z.boolean().default(true),
  extraIgnores: z.array(z.string()).default([]),
  guardSensitive: z.boolean().default(true),
  nestedRepos: z.union(['init', 'refuse']).default('init'),
})

/** Resolved configuration for one composition row. */
export const Config = z.object({
  /** Master switch for every automatic sync. */
  enabled: z.boolean().default(true),
  /** Sync the work area a finished turn belonged to. */
  syncOnTurnEnd: z.boolean().default(true),
  /** Run one pass over every enabled work area when the Host starts. */
  syncOnStartup: z.boolean().default(false),
  /** Sync every enabled work area at a turn boundary instead of only the current one. */
  syncAllOnTurnEnd: z.boolean().default(false),
  /** Coalescing window for bursty turn boundaries, in milliseconds. */
  debounceMs: z.natural().default(5000),
  /** Commit message template; `{host}`, `{time}` and `{turn}` are substituted. */
  commitMessageTemplate: z.string().default('dsh-sync: {host} {time} (turn {turn})'),
  /**
   * Identity for automatic commits, used **only** when the machine has no git
   * identity of its own. Blank falls back to `dsh-sync@<hostname>`.
   */
  commitIdentity: z.object({
    name: z.string().default(''),
    email: z.string().default(''),
  }).default({ name: '', email: '' }),
  /** How many history entries the status namespace keeps. */
  historyLimit: z.natural().default(20),
  /**
   * The shared sessions repository. Every `sessions` work area that does not
   * name a repository of its own mirrors its archive here, under a folder named
   * after the work area, so one repository carries the conversations of every
   * project instead of one repository per project.
   */
  sessionsRemote: z.string().default(''),
  /**
   * Where the plugin keeps its mirror checkouts of sessions repositories. Empty
   * uses `$DSH_HOME/sync-tool/repos`; set it to put them on another drive.
   */
  sessionsRoot: z.string().default(''),
  /** Session-record settings, shared by every work area. */
  sessions: SessionsSchema.default(SESSION_DEFAULTS),
  /** Configured work areas. */
  workspaces: z.array(WorkspaceSchema).default([]),
  /**
   * Command channel: the browser half bumps `token` to ask the Host to act.
   * Settings is the only documented browser→Host write channel for an
   * out-of-tree plugin, so commands ride fields the Host watches.
   */
  request: z.object({
    /** Monotonic request id; a change is what the Host acts on. */
    token: z.natural().default(0),
    /** Target work-area path; empty targets every enabled work area. */
    path: z.string().default(''),
    /** `none` is the idle value. */
    kind: z.union([...REQUEST_KINDS]).default('none'),
    /** When the browser issued the request. */
    at: z.natural().default(0),
    /** Retired field, still accepted so an older document keeps loading. */
    areaId: z.string().default(''),
  }).default({ token: 0, path: '', kind: 'none', at: 0, areaId: '' }),
  /** Retired field, still accepted so an older document keeps loading. */
  areas: z.array(LegacyAreaSchema).default([]),
})

/** One history entry. */
const HistoryEntrySchema = z.object({
  at: z.natural().required(),
  id: z.string().default(''),
  ok: z.boolean().required(),
  summary: z.string().default(''),
})

/** One work area's latest observed state. */
const WorkspaceStatusSchema = z.object({
  /** Join key: the normalized work-area path. */
  id: z.string().required(),
  /** The configured path, for display. */
  path: z.string().default(''),
  /** Display title. */
  title: z.string().default(''),
  /** The mode this pass actually used. */
  mode: z.union([...MODES]).default('auto'),
  status: z.union([...WORKSPACE_STATUS]).default('idle'),
  at: z.natural().default(0),
  detail: z.string().default(''),
  head: z.string().default(''),
  ahead: z.natural().default(0),
  behind: z.natural().default(0),
  /** Remote the pass pushed to, or would push to when none is configured. */
  remote: z.string().default(''),
  /** Branch the pass used. */
  branch: z.string().default(''),
})

/**
 * What one folder looks like on disk, answered by the Host because the browser
 * cannot run git. The card and the header panel both render from this.
 */
const ProbeSchema = z.object({
  /** Join key: the normalized path that was probed. */
  id: z.string().required(),
  path: z.string().default(''),
  kind: z.union([...PROBE_KINDS]).default('unknown'),
  /** `origin` of the enclosing repository, when there is one. */
  remote: z.string().default(''),
  /** Currently checked-out branch, when there is a repository. */
  branch: z.string().default(''),
  /** Repository root, when the folder is inside one. */
  root: z.string().default(''),
  /** How many paths the folder's repository reports as changed. */
  dirty: z.natural().default(0),
  /** Remote recorded in the folder's own `.dsh-sync.json`, for claiming. */
  manifestRemote: z.string().default(''),
  at: z.natural().default(0),
  error: z.string().default(''),
})

/** Host-published status document. */
export const StatusConfig = z.object({
  /** Bumped on every publish so the browser half can tell snapshots apart. */
  revision: z.natural().default(0),
  /** Whether a sync pass is in flight. */
  running: z.boolean().default(false),
  /** Timestamp of the last publish. */
  updatedAt: z.natural().default(0),
  /** Latest state per configured work area. */
  workspaces: z.array(WorkspaceStatusSchema).default([]),
  /** Latest folder probe per requested path. */
  probes: z.array(ProbeSchema).default([]),
  /** Most recent results, newest last, capped at `historyLimit`. */
  history: z.array(HistoryEntrySchema).default([]),
})

/** Status document defaults, restated for the published base layer. */
export const STATUS_BASE = { revision: 0, running: false, updatedAt: 0, workspaces: [], probes: [], history: [] }

/** One work area entry's own defaults, exported for the browser half's writes. */
export const WORKSPACE_ENTRY_DEFAULTS = WORKSPACE_DEFAULTS

export { LegacyAreaSchema, WorkspaceSchema, SessionsSchema, SESSION_DEFAULTS }
