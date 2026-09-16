/**
 * dsh-sync-tool — browser half.
 *
 * This file runs INSIDE the client module table's closure factory, so
 * `require`, `module`, and `exports` are supplied by the wrapper emitted in
 * `scripts/build.mjs`; it is not a standalone ES module. Cross-plugin
 * collaboration goes through Cordis services only, because the client bundle
 * purity gate forbids value imports between plugin packages. Only React, the
 * UI primitives package, and `react-dom` may be required here.
 *
 * The vocabulary is `src/host/contract.js` and nothing else: this half edits
 * the `sync-tool` namespace, reads the Host-published `sync-tool-status`
 * namespace, and asks the Host to act by bumping `request.token`.
 *
 * Alignment with DSH workspaces is the product rule. A DSH workspace is one
 * folder, and one folder is one sync target, so every surface here resolves
 * the *current workspace folder* first:
 *
 *  - the Plugins card is the fallback entry point and the whole-plugin
 *    overview (the header is hidden on a blank session, so the card is the
 *    only reachable surface there);
 *  - `conversation.session.header.utilities` holds the primary entry point:
 *    a compact status control that opens an anchored panel configuring the
 *    folder the current session belongs to.
 *
 * Both contributions are registered from `apply` below.
 */
const React = require('react')

/** User-configuration namespace; must match the Host half. */
const SYNC_NAMESPACE = 'sync-tool'

/** Host-published status namespace; must match the Host half. */
const STATUS_NAMESPACE = 'sync-tool-status'

/** Cordis client plugin name. */
exports.name = 'sync-tool-client'

/** Slot registry and the namespace scope binder. */
exports.inject = ['slots', 'settingsScope']

/** Per-workspace status copy, keyed by `contract.js`'s `WORKSPACE_STATUS`. */
const STATUS_LABEL = {
  idle: '待同步',
  validating: '校验中',
  syncing: '同步中',
  ok: '已同步',
  conflict: '冲突',
  error: '错误',
}

/** Dot colour per status, so the dot and its word always agree. */
const STATUS_COLOR = {
  idle: 'var(--dsw-alias-label-secondary, #888)',
  validating: 'var(--dsw-alias-label-secondary, #888)',
  syncing: 'var(--dsw-alias-brand-primary, #3b82f6)',
  ok: 'var(--dsw-alias-state-success-primary, #16a34a)',
  conflict: 'var(--dsw-alias-state-warn-primary, #d97706)',
  error: 'var(--dsw-alias-state-error-primary, #dc2626)',
}

/** The `StateDot` semantic matching each contract status. */
const STATUS_DOT_STATE = {
  idle: 'idle',
  validating: 'ongoing',
  syncing: 'ongoing',
  ok: 'done',
  conflict: 'warning',
  error: 'error',
}

/** Copy for a folder that is not a repository (yet). */
const NOT_A_REPO = '这个文件夹还不是 git 仓库。'
const NOT_A_REPO_HINT = '填一个远端仓库地址，插件会在文件夹里 init、提交并推送（含 .dsh-sessions/ 对话记录）。'

/** The promise every existing-repository case makes. */
const NEVER_TOUCHES_REPO = '插件不会动这个仓库的文件、分支和提交。它只把这里的对话记录同步到你的会话仓库。'

/** Shown once a whole-folder commit could carry conversations to a shared remote. */
const SHARED_REPO_WARNING = '如果这个仓库是公开的或与别人共享，你的对话内容会一起被推送。'

/** Session-remote input placeholder, shared by both panel forms. */
const REMOTE_PLACEHOLDER = 'https://github.com/<you>/<repo>.git'

/** How long the path-copy control claims success. */
const COPIED_MS = 1600

/**
 * One workspace entry's defaults when the browser half creates it.
 *
 * Restated from `contract.js`'s `WORKSPACE_ENTRY_DEFAULTS` because the client
 * bundle purity gate forbids value imports between the plugin's two halves. A
 * field the user has not touched must still reach the Host as the schema's own
 * default, so these values have to stay in step with that schema by hand.
 */
const WORKSPACE_ENTRY_DEFAULTS = {
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

/** The `<title>`/`aria-label` prefix of the header control. */
const TRIGGER_LABEL = '同步'

/**
 * A selector hook that always reports "nothing", used wherever the plugin
 * reads a standard hook the composition may not supply. Calling it keeps the
 * hook count of the component stable whether or not the real hook exists.
 * @returns the empty selector result.
 */
const emptySelector = () => undefined

/**
 * Look up the current session's workspace among the Workspace UI's rows.
 *
 * The rows are the standard props' `WorkspaceView[]`; a session belongs to the
 * first workspace that accounts for it. Anything unexpected (no hook, no
 * items, no match) degrades to `undefined`, never to a throw.
 *
 * @param useWorkspaces - the optional standard selector hook.
 * @param sessionId - the current session's id.
 * @returns the matching view, or undefined.
 */
function findWorkspace(useWorkspaces, sessionId) {
  if (typeof useWorkspaces !== 'function' || typeof sessionId !== 'string' || sessionId === '') {
    return undefined
  }
  const snapshot = useWorkspaces(state => (state === undefined || state === null ? undefined : state.items))
  const items = snapshot !== undefined && snapshot !== null && Array.isArray(snapshot) ? snapshot : []
  return items.find(item => item !== null && typeof item === 'object'
    && Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
}

/**
 * The anchor point of one sync target: a folder path plus a display title.
 *
 * Preference order is the Workspace UI (the product rule), then the session's
 * recorded `cwd` (a composition without the Workspace UI), then nothing at all
 * — in which case the header control renders nothing rather than guessing.
 *
 * @param useWorkspaces - the optional standard selector hook.
 * @param useSessions - the optional standard selector hook.
 * @param sessionId - the current session's id.
 * @returns `{ path, title }`; `path` is empty when unknown.
 */
function resolveTarget(useWorkspaces, useSessions, sessionId) {
  const view = findWorkspace(useWorkspaces, sessionId)
  if (view !== undefined && typeof view.path === 'string' && view.path !== '') {
    return {
      path: view.path,
      title: typeof view.title === 'string' && view.title !== '' ? view.title : baseName(view.path),
    }
  }
  if (typeof useSessions === 'function' && typeof sessionId === 'string' && sessionId !== '') {
    const session = useSessions(state => (state === undefined || state === null ? undefined : state.byId[sessionId]))
    const cwd = session !== null && typeof session === 'object' ? session.cwd : undefined
    if (typeof cwd === 'string' && cwd !== '') {
      return { path: cwd, title: baseName(cwd) }
    }
  }
  return { path: '', title: '' }
}

/**
 * The remote the panel's input should show, in the contract's stated order.
 *
 * A value the user has typed in this panel session wins over everything (it is
 * the one the buttons will write). Otherwise the folder's own configuration
 * comes first, then what the Host read back from the folder's manifest, then —
 * for a repository that mirrors into the shared sessions repository — the
 * global `sessionsRemote` as a prefill.
 *
 * @param workspace - the configured entry, if there is one.
 * @param probe - the folder's probe record, if there is one.
 * @param sessionsRemote - the global sessions repository.
 * @param draft - what the user has typed since opening the panel.
 * @param isRepo - whether the folder already sits inside a repository.
 * @returns the value for the input.
 */
function resolveRemote(workspace, probe, sessionsRemote, draft, isRepo) {
  if (typeof draft === 'string' && draft !== '') return draft
  const configured = workspace !== undefined && workspace !== null ? workspace.remote : ''
  if (typeof configured === 'string' && configured !== '') return configured
  const claimed = probe !== undefined && probe !== null ? probe.manifestRemote : ''
  if (typeof claimed === 'string' && claimed !== '') return claimed
  return isRepo && typeof sessionsRemote === 'string' ? sessionsRemote : ''
}

/**
 * Loose path equality for the browser half.
 *
 * The Host's join key (`workspaceKey` in `contract.js`) is platform-aware: it
 * lowercases on Windows only. The browser cannot know the Host's platform, so
 * this comparison normalizes separators, drops a trailing slash, and lowercases
 * both sides. On POSIX that means two paths differing only in case compare
 * equal — a false positive that cannot happen in practice, because the
 * workspaces compared here are absolute paths produced by one Host.
 *
 * @param left - a configured or observed path.
 * @param right - the other path.
 * @returns whether the two name the same folder.
 */
function samePath(left, right) {
  return normalizePath(left) === normalizePath(right)
}

/** Normalize one path into the loose comparison key. */
function normalizePath(path) {
  if (typeof path !== 'string') return ''
  return path.trim().replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
}

/** Display name for a folder path. */
function baseName(path) {
  const parts = String(path).split(/[\\/]+/u).filter(part => part !== '')
  return parts.length === 0 ? String(path) : parts[parts.length - 1]
}

/** Shorten a commit-ish for display. */
function shortSha(value) {
  return typeof value === 'string' && value !== ''
    ? (value.length > 10 ? value.slice(0, 10) : value)
    : '—'
}

/** Render a timestamp as a short local time, or an em dash when unknown. */
function timeText(at) {
  return typeof at === 'number' && at > 0 ? new Date(at).toLocaleTimeString() : '—'
}

/** Render a timestamp through the primitives' shared relative-time bucket. */
function relativeText(at, now) {
  if (typeof at !== 'number' || at <= 0) return '—'
  const bucket = primitives.relativeTime(at, now)
  if (bucket === undefined || bucket === null || typeof bucket !== 'object') return timeText(at)
  const value = typeof bucket.n === 'number' ? bucket.n : 0
  if (bucket.unit === 'now') return '刚刚'
  if (bucket.unit === 'minutes') return `${value} 分钟前`
  if (bucket.unit === 'hours') return `${value} 小时前`
  if (bucket.unit === 'days') return `${value} 天前`
  if (bucket.unit === 'months') return `${value} 个月前`
  if (bucket.unit === 'years') return `${value} 年前`
  return timeText(at)
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

let primitivesCache
/** The referenced UI primitives, or an inert stand-in when unavailable. */
const primitives = new Proxy({}, {
  get(_target, key) {
    if (primitivesCache === undefined) {
      try {
        primitivesCache = require('@deepseek-ai/dsh-client-ui-primitives')
      } catch {
        primitivesCache = {}
      }
    }
    const value = primitivesCache[key]
    if (value !== undefined) return value
    // Unknown name: a tag that renders nothing, so a renamed primitive degrades
    // into a missing glyph instead of a render-time TypeError.
    return () => null
  },
})

/** Render one inline icon by primitive name, or nothing when it is unavailable. */
function icon(name, size, className) {
  const Component = primitives[name]
  if (typeof Component !== 'function') return null
  return React.createElement(Component, { size, className })
}

let portalCache
/** Lazily resolve `createPortal`; absent outside a real browser bundle. */
function portal(node) {
  if (portalCache === undefined) {
    try {
      portalCache = require('react-dom').createPortal
    } catch {
      portalCache = null
    }
  }
  if (typeof portalCache !== 'function' || typeof document === 'undefined') return node
  return portalCache(node, document.body)
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = {
  card: {
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28))',
    borderRadius: '10px',
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
  },
  titleRow: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
  title: { margin: 0, fontSize: '14px', fontWeight: 600 },
  subtitle: { fontSize: '12px', opacity: 0.6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  sectionTitle: { fontSize: '12px', fontWeight: 600, opacity: 0.85, marginTop: '2px' },
  toggles: { display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'center', fontSize: '12px' },
  label: { display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer', fontSize: '12px' },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px' },
  rows: { display: 'flex', flexDirection: 'column', gap: '6px' },
  rowMain: { display: 'flex', flexDirection: 'column', gap: '3px', flex: 1, minWidth: '180px' },
  rowName: { fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  mono: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '11px',
    wordBreak: 'break-all',
  },
  dim: { opacity: 0.65 },
  muted: { fontSize: '11px', opacity: 0.6 },
  area: {
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))',
    borderRadius: '8px',
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '7px',
  },
  grid: { display: 'grid', gridTemplateColumns: '88px 1fr', gap: '6px 10px', alignItems: 'center', fontSize: '12px' },
  fieldLabel: { opacity: 0.65, fontSize: '12px' },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    fontSize: '12px',
    padding: '4px 6px',
    borderRadius: '5px',
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))',
    background: 'var(--dsw-alias-bg-base, transparent)',
    color: 'inherit',
  },
  inputMono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  select: { fontSize: '12px', padding: '4px 6px', borderRadius: '5px', background: 'transparent', color: 'inherit' },
  buttons: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
  button: {
    fontSize: '12px',
    padding: '5px 11px',
    borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
    background: 'var(--dsw-alias-bg-layer-2, transparent)',
    color: 'inherit',
    cursor: 'pointer',
  },
  buttonPrimary: {
    fontSize: '12px',
    padding: '5px 11px',
    borderRadius: '6px',
    border: '1px solid var(--dsw-alias-brand-primary, #3b82f6)',
    background: 'var(--dsw-alias-brand-primary, #3b82f6)',
    color: '#fff',
    cursor: 'pointer',
  },
  buttonDanger: {
    fontSize: '12px',
    padding: '3px 9px',
    borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
    background: 'transparent',
    color: 'var(--dsw-alias-state-error-primary, #dc2626)',
    cursor: 'pointer',
  },
  link: {
    fontSize: '11px',
    padding: '0 2px',
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-brand-primary, #3b82f6)',
    cursor: 'pointer',
  },
  status: { fontSize: '12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  notice: { fontSize: '12px', lineHeight: 1.5, margin: 0, opacity: 0.75 },
  error: {
    fontSize: '12px',
    margin: 0,
    padding: '6px 8px',
    borderRadius: '6px',
    background: 'var(--dsw-alias-bg-layer-2, rgba(220,38,38,0.08))',
    color: 'var(--dsw-alias-state-error-primary, #dc2626)',
  },
  warn: {
    fontSize: '11px',
    lineHeight: 1.5,
    margin: 0,
    padding: '6px 8px',
    borderRadius: '6px',
    background: 'var(--dsw-alias-bg-layer-2, rgba(217,119,6,0.10))',
    color: 'var(--dsw-alias-state-warn-primary, #d97706)',
  },
  emphasis: {
    fontSize: '11px',
    lineHeight: 1.5,
    margin: 0,
    padding: '6px 8px',
    borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
    opacity: 0.9,
  },
  claim: {
    fontSize: '11px',
    lineHeight: 1.5,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
    padding: '6px 8px',
    borderRadius: '6px',
    background: 'var(--dsw-alias-bg-layer-2, rgba(59,130,246,0.08))',
  },
  history: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    maxHeight: '150px',
    overflowY: 'auto',
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },

  // ---- Header control ---------------------------------------------------------
  // The wrapper closes over both the trigger and the panel so the outside-pointer
  // dismissal knows what "inside" means. The panel itself is portaled to
  // `document.body` and positioned from the trigger's viewport rect.
  root: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    height: '24px',
    maxWidth: '190px',
    fontSize: '11px',
    lineHeight: 1.2,
    padding: '0 8px',
    borderRadius: '999px',
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
    background: 'var(--dsw-alias-bg-layer-2, transparent)',
    color: 'inherit',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  triggerLabel: { overflow: 'hidden', textOverflow: 'ellipsis' },
  dot: { width: '8px', height: '8px', borderRadius: '50%', flex: 'none', display: 'inline-block' },
  panel: {
    position: 'fixed',
    zIndex: 60,
    boxSizing: 'border-box',
    width: '400px',
    maxWidth: '92vw',
    maxHeight: '70vh',
    overflowY: 'auto',
    textAlign: 'left',
    padding: '12px',
    borderRadius: '10px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.32))',
    background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, Canvas))',
    boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    color: 'inherit',
  },
  panelHead: { display: 'flex', alignItems: 'flex-start', gap: '8px' },
  panelHeadText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  panelTitle: { fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  panelPath: {
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'copy',
    textAlign: 'left',
    padding: 0,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '11px',
    opacity: 0.7,
    wordBreak: 'break-all',
  },
  panelCopied: { fontSize: '10px', color: 'var(--dsw-alias-state-success-primary, #16a34a)' },
  panelClose: {
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '15px',
    lineHeight: 1,
    padding: '0 2px',
    opacity: 0.7,
    flex: 'none',
  },
  panelSection: { fontSize: '11px', fontWeight: 600, opacity: 0.75 },
  panelStatus: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' },
  panelAdvanced: { display: 'flex', flexDirection: 'column', gap: '0' },
  disclosureButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 600,
    opacity: 0.8,
    padding: '2px 0',
    textAlign: 'left',
  },
  panelHint: { fontSize: '11px', lineHeight: 1.45, opacity: 0.7, margin: 0 },
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** Subscribe to one bound settings scope. */
function useScope(scope) {
  const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot())
  React.useEffect(() => {
    setSnapshot(scope.getSnapshot())
    return scope.subscribe(() => { setSnapshot(scope.getSnapshot()) })
  }, [scope])
  return snapshot
}

/**
 * A text input that keeps its own draft and commits on blur or Enter, so a
 * write never fires per keystroke. Everywhere else this file uses a raw
 * `<input>`; this exists only where the committed value is a git remote or
 * another field the Host validates.
 */
function DraftInput(props) {
  const [draft, setDraft] = React.useState(props.value ?? '')
  React.useEffect(() => { setDraft(props.value ?? '') }, [props.value])
  const commit = () => {
    if (props.value !== undefined && props.value !== null && String(props.value) === draft) return
    props.onCommit(draft)
  }
  return React.createElement('input', {
    type: 'text',
    style: props.mono === true ? { ...styles.input, ...styles.inputMono } : styles.input,
    value: draft,
    placeholder: props.placeholder ?? '',
    'aria-label': props.label ?? props.placeholder ?? '',
    spellCheck: false,
    disabled: props.disabled === true,
    onChange: (event) => { setDraft(event.target.value) },
    onBlur: commit,
    onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
  })
}

/** One 8px status dot plus its word, for compact rows. */
function StatusInline(props) {
  const status = typeof props.status === 'string' && props.status !== '' ? props.status : 'idle'
  const color = STATUS_COLOR[status] ?? STATUS_COLOR.idle
  const label = STATUS_LABEL[status] ?? status
  return React.createElement(
    'span',
    { style: { ...styles.row, gap: '5px' } },
    React.createElement('span', { style: { ...styles.dot, background: color }, 'aria-hidden': 'true' }),
    React.createElement('span', { style: { fontSize: '12px', color } }, label),
  )
}

/** Filled `StateDot` for rows that should read as a semantic status chip. */
function StatusDot(props) {
  const status = typeof props.status === 'string' && props.status !== '' ? props.status : 'idle'
  return React.createElement(primitives.StateDot, {
    state: STATUS_DOT_STATE[status] ?? 'idle',
    size: 8,
  })
}

/** A labelled boolean switch built from the primitives' `Switch`. */
function SwitchField(props) {
  const switchProps = {
    checked: props.checked === true,
    label: props.label,
    disabled: props.disabled === true,
    title: props.title ?? props.label,
    onChange: (next) => { props.onChange(next) },
  }
  const control = typeof primitives.Switch === 'function'
    ? React.createElement(primitives.Switch, switchProps)
    : React.createElement('input', {
      type: 'checkbox',
      checked: switchProps.checked,
      disabled: switchProps.disabled,
      title: switchProps.title,
      'aria-label': props.label,
      onChange: (event) => { props.onChange(event.target.checked) },
    })
  return React.createElement(
    'span',
    { style: styles.label, title: props.title ?? undefined },
    control,
    React.createElement('span', null, props.label),
  )
}

/** A labelled `<select>` over a fixed option list. */
function SelectField(props) {
  return React.createElement(
    'select',
    {
      style: styles.select,
      value: props.value,
      disabled: props.disabled === true,
      'aria-label': props.label,
      onChange: (event) => { props.onChange(event.target.value) },
    },
    ...props.options.map(option => React.createElement(
      'option',
      { key: option.value, value: option.value },
      option.label,
    )),
  )
}

/** One work area's row in the card: identity, status, HEAD, and two actions. */
function WorkspaceRow(props) {
  const workspace = props.workspace ?? {}
  const status = props.status ?? {}
  const state = typeof status.status === 'string' && status.status !== '' ? status.status : 'idle'
  const path = typeof workspace.path === 'string' ? workspace.path : ''
  const name = typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : baseName(path)
  const modeLabel = workspace.mode === 'folder' ? '整个文件夹' : workspace.mode === 'sessions' ? '只同步对话' : '自动'
  return React.createElement(
    'div',
    { style: styles.area },
    React.createElement(
      'div',
      { style: styles.row },
      React.createElement(StatusDot, { status: state }),
      React.createElement('span', { style: styles.rowName, title: path }, name),
      React.createElement(primitives.Tag, {
        tone: state === 'error' ? 'danger' : state === 'ok' ? 'success' : 'neutral',
      }, modeLabel),
      React.createElement('span', { style: styles.rowMain }),
      React.createElement(primitives.Button, {
        size: 'sm',
        onClick: () => { props.onSync(path) },
        disabled: props.disabled === true,
      }, '同步'),
      React.createElement(primitives.Button, {
        size: 'sm',
        onClick: () => { props.onRemove(path) },
        disabled: props.disabled === true,
      }, '移除'),
    ),
    React.createElement('div', { style: { ...styles.mono, ...styles.dim } }, path),
    React.createElement(
      'div',
      { style: styles.row },
      React.createElement(StatusInline, { status: state }),
      React.createElement('span', { style: { ...styles.mono, ...styles.dim } }, `HEAD ${shortSha(status.head)}`),
      React.createElement('span', { style: { ...styles.mono, ...styles.dim } }, `↑${Number(status.ahead) || 0} ↓${Number(status.behind) || 0}`),
      React.createElement('span', { style: { ...styles.mono, ...styles.dim } }, `最近 ${timeText(Number(status.at) || 0)}`),
    ),
    typeof status.detail === 'string' && status.detail !== ''
      ? React.createElement('div', { style: styles.muted }, status.detail)
      : null,
  )
}

/** One DSH workspace row in the card's overview section. */
function WorkspaceOverviewRow(props) {
  const view = props.view ?? {}
  const path = typeof view.path === 'string' ? view.path : ''
  const title = typeof view.title === 'string' && view.title !== '' ? view.title : baseName(path)
  return React.createElement(
    'div',
    { style: styles.row },
    React.createElement(StatusDot, { status: props.configured === true ? 'ok' : 'idle' }),
    React.createElement('span', { style: styles.rowName, title: path }, title),
    React.createElement('span', { style: { ...styles.mono, ...styles.dim, flex: 1, minWidth: '140px' } }, path),
    React.createElement(primitives.Tag, { tone: props.configured === true ? 'success' : 'quiet' },
      props.configured === true ? '已配置同步' : '未配置同步'),
  )
}

/** The last ten history entries, newest first. */
function HistoryList(props) {
  const history = Array.isArray(props.history) ? props.history : []
  const recent = [...history].reverse().slice(0, 10)
  if (recent.length === 0) {
    return React.createElement('p', { style: styles.notice }, '暂无同步历史。')
  }
  return React.createElement(
    'ul',
    { style: styles.history },
    ...recent.map((entry, index) => React.createElement(
      'li',
      {
        key: `${String(entry.at)}-${String(index)}`,
        style: { color: entry.ok === true ? 'inherit' : STATUS_COLOR.error },
      },
      `${entry.ok === true ? '✓' : '✗'} ${timeText(Number(entry.at) || 0)} · ${String(entry.summary ?? '')}`,
    )),
  )
}

// ---------------------------------------------------------------------------
// The Plugins card
// ---------------------------------------------------------------------------

/**
 * One row of the card's global switches. Pure presentation; the card owns the
 * single `write` path.
 */
function CardControls(props) {
  const value = props.value ?? {}
  const disabled = props.disabled === true
  return React.createElement(
    'div',
    { style: styles.toggles },
    React.createElement(SwitchField, {
      label: '启用插件',
      checked: value.enabled !== false,
      disabled,
      onChange: (next) => { props.onWrite('enabled', next) },
    }),
    React.createElement(SwitchField, {
      label: '每轮对话后同步',
      checked: value.syncOnTurnEnd !== false,
      disabled,
      onChange: (next) => { props.onWrite('syncOnTurnEnd', next) },
    }),
    React.createElement(SwitchField, {
      label: '启动时同步',
      checked: value.syncOnStartup === true,
      disabled,
      onChange: (next) => { props.onWrite('syncOnStartup', next) },
    }),
    React.createElement(SwitchField, {
      label: '每轮同步全部工作区',
      title: '默认只同步当前会话所属的工作区；勾选后每轮都同步全部启用的工作区',
      checked: value.syncAllOnTurnEnd === true,
      disabled,
      onChange: (next) => { props.onWrite('syncAllOnTurnEnd', next) },
    }),
    React.createElement(
      'span',
      { style: styles.label },
      React.createElement('span', null, '防抖'),
      React.createElement('input', {
        type: 'number',
        min: 0,
        step: 500,
        disabled,
        'aria-label': '防抖毫秒',
        value: value.debounceMs ?? 5000,
        style: { ...styles.input, width: '84px' },
        onChange: (event) => { props.onWrite('debounceMs', Math.max(0, Number(event.target.value) || 0)) },
      }),
      React.createElement('span', null, 'ms'),
    ),
  )
}

/**
 * The Plugins-tab card.
 *
 * Role: the fallback entry point and the plugin-wide overview. The primary
 * entry point is the header control in {@link WorkspaceSyncButton}; the header
 * is hidden on a blank session, so this card must stand alone.
 *
 * Hooks: the two scopes, the session picker, and the optional workspace list,
 * always in the same order. Everything below is hook-free, which keeps a test
 * able to render any subtree directly.
 *
 * @param props - injected `configScope`/`statusScope` plus the optional
 *   standard `useWorkspaces` hook.
 * @returns the card element.
 */
function SyncCard(props) {
  const config = useScope(props.configScope)
  const status = useScope(props.statusScope)
  const value = config.value ?? {}
  const statusValue = status.value ?? {}
  const workspaces = Array.isArray(value.workspaces) ? value.workspaces : []
  const probes = Array.isArray(statusValue.probes) ? statusValue.probes : []
  const observed = Array.isArray(statusValue.workspaces) ? statusValue.workspaces : []
  const history = Array.isArray(statusValue.history) ? statusValue.history : []
  const writable = config.writable === true && config.mode === 'host'
  const [error, setError] = React.useState('')
  const rows = allWorkspaceViews(props.useWorkspaces)

  /** Write one config field, surfacing failures instead of swallowing them. */
  const write = async (field, next) => {
    setError('')
    try {
      await props.configScope.set(field, next)
    } catch (cause) {
      setError(`写入设置失败 / failed to write settings: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  /** Drop this workspace's config entry (the "移除" action). */
  const removeWorkspace = (path) => {
    void write('workspaces', workspaces.filter(candidate => !samePath(candidate.path, path)))
    void write('areas', [])
  }

  return React.createElement(
    'section',
    { style: styles.card },
    React.createElement(
      'div',
      { style: styles.titleRow },
      React.createElement('h3', { style: styles.title }, '工作区 Git 同步'),
      React.createElement('span', { style: styles.subtitle }, 'dsh-sync-tool'),
    ),
    React.createElement(
      'p',
      { style: styles.notice },
      '每个 DSH 工作区（一个文件夹）单独配置同步。在会话右上角的「同步」按钮里配置当前会话所属的工作区。',
    ),
    React.createElement(CardControls, {
      value,
      disabled: !writable,
      onWrite: (field, next) => { void write(field, next) },
    }),

    React.createElement('div', { style: styles.sectionTitle }, '共享会话仓库'),
    React.createElement(DraftInput, {
      value: value.sessionsRemote ?? '',
      label: '共享会话仓库',
      placeholder: 'https://github.com/<you>/dsh-sessions.git',
      mono: true,
      disabled: !writable,
      onCommit: (next) => { void write('sessionsRemote', next.trim()) },
    }),
    React.createElement(
      'p',
      { style: styles.notice },
      '已有自己 git 仓库的工作区，对话会集中镜像到这个仓库，插件不会动项目仓库。',
    ),

    React.createElement('div', { style: styles.sectionTitle }, `已配置工作区（${workspaces.length}）`),
    workspaces.length === 0
      ? React.createElement(
        'p',
        { style: styles.notice },
        '还没有配置任何工作区。打开一个会话，用右上角的「同步」按钮配置它所属的工作区。',
      )
      : null,
    ...workspaces.map((workspace, index) => React.createElement(WorkspaceRow, {
      key: typeof workspace.path === 'string' && workspace.path !== '' ? workspace.path : `w${String(index)}`,
      workspace,
      status: joinStatus(observed, probes, workspace),
      disabled: !writable,
      onSync: (path) => {
        void write('request', {
          token: nextToken(value.request),
          path,
          kind: 'sync',
          at: Date.now(),
        })
      },
      onRemove: removeWorkspace,
    })),

    React.createElement(
      'div',
      { style: styles.sectionTitle },
      rows === undefined ? 'DSH 工作区总览' : `DSH 工作区总览（${rows.length}）`,
    ),
    rows === undefined || rows.length === 0
      ? React.createElement('p', { style: styles.notice }, '当前连接没有提供工作区列表。')
      : React.createElement(
        'div',
        { style: styles.rows },
        ...rows.map((view, index) => React.createElement(WorkspaceOverviewRow, {
          key: typeof view.workspaceId === 'string' && view.workspaceId !== '' ? view.workspaceId : `v${String(index)}`,
          view,
          configured: workspaces.some(candidate => samePath(candidate.path, view.path)),
        })),
      ),

    error !== '' ? React.createElement('p', { style: styles.error }, error) : null,
    writable ? null : React.createElement('p', { style: styles.notice }, '当前连接不接受设置写入，配置为只读。'),

    React.createElement('div', { style: styles.sectionTitle }, '同步状态'),
    React.createElement(
      'div',
      { style: styles.status },
      status.status === 'ready'
        ? `${statusValue.running === true ? '同步进行中' : '空闲'} · 更新于 ${timeText(Number(statusValue.updatedAt) || 0)}`
        : status.status === 'loading' ? '读取状态中…' : `状态命名空间不可用（${String(status.status)}）`,
    ),
    React.createElement(HistoryList, { history }),
  )
}

// ---------------------------------------------------------------------------
// The anchored workspace panel
// ---------------------------------------------------------------------------

/**
 * The panel's read-only folder-status block, rendered from one probe record.
 * Pure; the probe request itself rides on the trigger.
 */
function FolderStatus(props) {
  const probe = props.probe
  if (probe === undefined || probe === null) {
    return React.createElement('p', { style: styles.notice }, '正在检查这个文件夹…')
  }
  const kind = typeof probe.kind === 'string' ? probe.kind : 'unknown'
  if (kind === 'unknown') {
    return React.createElement('p', { style: styles.notice }, '正在检查这个文件夹…')
  }
  if (kind === 'none') {
    return React.createElement(
      'div',
      null,
      React.createElement('div', { style: styles.panelStatus }, React.createElement(StatusDot, { status: 'idle' }), '这个文件夹还不是 git 仓库。'),
      React.createElement('p', { style: styles.panelHint }, NOT_A_REPO_HINT),
    )
  }
  if (kind === 'repo') {
    const remote = typeof probe.remote === 'string' && probe.remote !== '' ? probe.remote : ''
    const branch = typeof probe.branch === 'string' && probe.branch !== '' ? probe.branch : '—'
    return React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
      React.createElement('div', { style: styles.panelStatus }, React.createElement(StatusDot, { status: 'ok' }), '已是一个 git 仓库'),
      React.createElement(
        'div',
        { style: { ...styles.mono, ...styles.dim } },
        `远端：${remote === '' ? '未配置远端' : remote}`,
      ),
      React.createElement(
        'div',
        { style: { ...styles.mono, ...styles.dim } },
        `分支：${branch} · 未提交文件：${Number(probe.dirty) || 0}`,
      ),
      React.createElement('p', { style: styles.emphasis }, NEVER_TOUCHES_REPO),
    )
  }
  if (kind === 'nested') {
    const root = typeof probe.root === 'string' && probe.root !== '' ? probe.root : '未知'
    return React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
      React.createElement(
        'div',
        { style: styles.panelStatus },
        React.createElement(StatusDot, { status: 'warning' }),
        `这个文件夹在另一个 git 仓库内部（仓库根：${root}）`,
      ),
      React.createElement('p', { style: styles.panelHint }, '插件不会在这里建独立仓库，只会同步对话记录。'),
      React.createElement('p', { style: styles.emphasis }, NEVER_TOUCHES_REPO),
    )
  }
  return React.createElement(
    'p',
    { style: styles.error },
    `探针失败：${typeof probe.error === 'string' && probe.error !== '' ? probe.error : kind}`,
  )
}

/** The claim banner for a folder another machine already synced. */
function ClaimPrompt(props) {
  return React.createElement(
    'div',
    { style: styles.claim },
    React.createElement(
      'span',
      null,
      `这个文件夹已由另一台机器同步过（远端 ${props.remote}）。`,
    ),
    React.createElement('button', {
      type: 'button',
      style: styles.link,
      onClick: () => { props.onClaim(props.remote) },
    }, '[ 启用 ]'),
  )
}

/** The collapsed `▸ 高级` block: mode, branch, direction, credential, scope. */
function AdvancedSection(props) {
  const workspace = props.workspace ?? {}
  const isRepo = props.kind === 'repo' || props.kind === 'nested'
  const mode = typeof workspace.mode === 'string' && workspace.mode !== '' ? workspace.mode : 'auto'
  const commitScope = typeof workspace.commitScope === 'string' && workspace.commitScope !== ''
    ? workspace.commitScope
    : 'archive'
  const risky = isRepo && (mode === 'folder' || commitScope === 'all')
  return React.createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    React.createElement(
      'div',
      { style: styles.grid },
      React.createElement('span', { style: styles.fieldLabel }, '模式'),
      React.createElement(SelectField, {
        label: '模式',
        value: mode,
        options: [
          { value: 'auto', label: '自动（推荐）' },
          { value: 'folder', label: '整个文件夹' },
          { value: 'sessions', label: '只同步对话' },
        ],
        onChange: (next) => { props.onAdvanced({ mode: next }) },
      }),
      React.createElement('span', { style: styles.fieldLabel }, '分支'),
      React.createElement(DraftInput, {
        value: workspace.branch ?? 'main',
        label: '分支',
        placeholder: 'main',
        mono: true,
        onCommit: (next) => { props.onAdvanced({ branch: next.trim() === '' ? 'main' : next.trim() }) },
      }),
      React.createElement('span', { style: styles.fieldLabel }, '方向'),
      React.createElement(SelectField, {
        label: '方向',
        value: typeof workspace.direction === 'string' && workspace.direction !== '' ? workspace.direction : 'both',
        options: [
          { value: 'both', label: '双向（先 pull 再 push）' },
          { value: 'push', label: '仅 push' },
          { value: 'pull', label: '仅 pull' },
        ],
        onChange: (next) => { props.onAdvanced({ direction: next }) },
      }),
      React.createElement('span', { style: styles.fieldLabel }, '凭据引用'),
      React.createElement(DraftInput, {
        value: workspace.credentialRef ?? '',
        label: '凭据引用',
        placeholder: 'DSH_SYNC_GIT_TOKEN（留空则用系统 git 凭据）',
        mono: true,
        onCommit: (next) => { props.onAdvanced({ credentialRef: next.trim() }) },
      }),
      React.createElement('span', { style: styles.fieldLabel }, '提交范围'),
      React.createElement(SelectField, {
        label: '提交范围',
        value: commitScope,
        options: [
          { value: 'all', label: '整个文件夹' },
          { value: 'archive', label: '只提交 .dsh-sessions' },
        ],
        onChange: (next) => { props.onAdvanced({ commitScope: next }) },
      }),
    ),
    risky ? React.createElement('p', { style: styles.warn }, SHARED_REPO_WARNING) : null,
  )
}

/**
 * The anchored panel: everything about one workspace folder's sync.
 *
 * Pure by construction — no hooks, no refs, no effects. The trigger owns all
 * of those and passes plain values and callbacks down, so a test can render
 * this subtree directly with nothing but props.
 *
 * Information structure, in fixed order:
 *   1. workspace name + copyable full path (+ close)
 *   2. claim banner, when another machine already synced this folder
 *   3. folder status from the probe
 *   4. remote input (folder mode) or session-repository input (repository mode)
 *   5. primary action: save and sync
 *   6. secondary actions: sync now / stop syncing
 *   7. last result line
 *   8. collapsed advanced block
 *
 * @param props - the resolved target, the probe, the copy state, and callbacks.
 * @returns the panel element.
 */
function SyncPanel(props) {
  const workspace = props.workspace ?? {}
  const status = props.status
  const state = status === undefined || status === null || typeof status.status !== 'string' ? 'idle' : status.status
  const path = typeof props.path === 'string' ? props.path : ''
  const title = typeof props.title === 'string' && props.title !== '' ? props.title : baseName(path)
  const probe = props.probe
  const kind = probe === undefined || probe === null
    ? 'unknown'
    : (typeof probe.kind === 'string' ? probe.kind : 'unknown')
  const isRepo = kind === 'repo' || kind === 'nested'
  const configured = props.configured === true
  const label = isRepo ? '会话仓库' : '远程仓库'
  const sharedRemote = typeof props.sessionsRemote === 'string' ? props.sessionsRemote : ''

  return React.createElement(
    'div',
    {
      ref: props.panelRef,
      style: props.position === null || props.position === undefined
        ? { ...styles.panel, visibility: 'hidden', left: 0, top: 0 }
        : { ...styles.panel, ...props.position },
      role: 'dialog',
      'aria-label': `同步设置：${title}`,
      'data-sync-panel': path,
    },
    React.createElement(
      'div',
      { style: styles.panelHead },
      React.createElement(
        'div',
        { style: styles.panelHeadText },
        React.createElement('span', { style: styles.panelTitle, title }, title),
        React.createElement(
          'button',
          {
            type: 'button',
            style: styles.panelPath,
            title: `复制路径：${path}`,
            'aria-label': `复制路径 ${path}`,
            onClick: () => { props.onCopy(path) },
          },
          props.copied === true ? '已复制' : path,
        ),
      ),
      React.createElement('button', {
        type: 'button',
        style: styles.panelClose,
        title: '关闭',
        'aria-label': '关闭',
        onClick: () => { props.onClose() },
      }, '×'),
    ),

    props.claimRemote !== undefined && props.claimRemote !== '' && !configured
      ? React.createElement(ClaimPrompt, { remote: props.claimRemote, onClaim: props.onClaim })
      : null,

    React.createElement(FolderStatus, { probe }),

    React.createElement('div', { style: styles.panelSection }, label),
    React.createElement(DraftInput, {
      key: `${path}:${label}`,
      value: props.remoteValue ?? '',
      label,
      placeholder: REMOTE_PLACEHOLDER,
      mono: true,
      disabled: props.disabled === true,
      onCommit: (next) => { props.onRemote(next.trim()) },
    }),
    isRepo && sharedRemote !== ''
      ? React.createElement('p', { style: styles.panelHint }, `留空则用共享会话仓库：${sharedRemote}`)
      : null,

    React.createElement(
      'div',
      { style: styles.buttons },
      React.createElement(primitives.Button, {
        variant: 'primary',
        disabled: props.disabled === true,
        onClick: () => { props.onSave() },
      }, '保存并同步'),
      configured
        ? React.createElement(primitives.Button, {
          size: 'sm',
          disabled: props.disabled === true,
          onClick: () => { props.onSync() },
        }, '立即同步')
        : null,
      configured
        ? React.createElement(primitives.Button, {
          size: 'sm',
          disabled: props.disabled === true,
          onClick: () => { props.onForget() },
        }, '取消同步')
        : null,
    ),

    React.createElement(
      'div',
      { style: styles.panelStatus },
      React.createElement(StatusDot, { status: state }),
      status === undefined || status === null
        ? '尚未同步'
        : `${STATUS_LABEL[state] ?? state} · ${relativeText(Number(status.at) || 0, props.now)} · HEAD ${shortSha(status.head)} · ↑${Number(status.ahead) || 0} ↓${Number(status.behind) || 0}`,
    ),
    status !== undefined && status !== null && typeof status.detail === 'string' && status.detail !== ''
      ? React.createElement('p', { style: styles.panelHint }, status.detail)
      : null,

    React.createElement(
      'div',
      { style: styles.panelAdvanced },
      React.createElement(
        'button',
        {
          type: 'button',
          style: styles.disclosureButton,
          'aria-expanded': props.advancedOpen === true ? 'true' : 'false',
          onClick: () => { props.onToggleAdvanced() },
        },
        `${props.advancedOpen === true ? '▾' : '▸'} 高级`,
      ),
      props.advancedOpen === true
        ? React.createElement(AdvancedSection, {
          workspace,
          kind,
          onAdvanced: (patch) => { props.onAdvanced(patch) },
        })
        : null,
    ),
  )
}

/**
 * The header control: one compact trigger plus the portaled panel.
 *
 * This is the only component in the plugin's browser half that owns refs and
 * layout effects, and its hook order is fixed: two scopes, the two optional
 * standard hooks, the open/copy/advanced/now state, the three refs, the
 * anchored position, the outside-pointer dismissal, then the timers. The
 * early `return null` sits after every hook for exactly that reason.
 *
 * @param props - the injected scopes plus the framework's standard session props.
 * @returns the trigger and, while open, the panel.
 */
function WorkspaceSyncButton(props) {
  const config = useScope(props.configScope)
  const status = useScope(props.statusScope)
  const target = resolveTarget(props.useWorkspaces, props.useSessions, props.sessionId)
  // `blank` is the one session field this control needs: a blank session has no
  // workspace yet, and the header is hidden there anyway.
  const blank = typeof props.useSession === 'function' ? props.useSession(state => state.blank) : false
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  // What the user has typed into the remote input since opening the panel. It
  // lives here, not in the panel, because this component owns every hook.
  const [remoteDraft, setRemoteDraft] = React.useState('')
  const [now, setNow] = React.useState(() => Date.now())
  const rootRef = React.useRef(null)
  const triggerRef = React.useRef(null)
  const panelRef = React.useRef(null)
  // Paths this control has already asked the Host to probe, so reopening the
  // panel — or a settings write re-rendering it — does not spam the command
  // channel while the first answer is still in flight.
  const probedRef = React.useRef([])
  const position = primitives.useAnchoredPosition({
    open,
    anchorRef: triggerRef,
    panelRef,
    side: 'bottom',
    gap: 6,
    margin: 12,
  })
  primitives.useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  const value = config.value ?? {}
  const statusValue = status.value ?? {}
  const workspace = Array.isArray(value.workspaces)
    ? value.workspaces.find(candidate => samePath(candidate.path, target.path))
    : undefined
  const probe = Array.isArray(statusValue.probes)
    ? statusValue.probes.find(candidate => samePath(candidate.path, target.path))
    : undefined
  const observed = Array.isArray(statusValue.workspaces)
    ? statusValue.workspaces.find(candidate => samePath(candidate.path, target.path))
    : undefined
  const writable = config.writable === true && config.mode === 'host'
  // A blank session has no workspace, and the header hides itself anyway; the
  // card is the surface for that case.
  const visible = target.path !== '' && blank !== true

  React.useEffect(() => {
    if (!open) return undefined
    setNow(Date.now())
    return undefined
  }, [open])

  React.useEffect(() => {
    const key = normalizePath(target.path)
    if (!open || probe !== undefined || key === '') return
    if (Array.isArray(probedRef.current) && probedRef.current.includes(key)) return
    if (Array.isArray(probedRef.current)) probedRef.current.push(key)
    void writeConfig(props.configScope, 'request', {
      token: nextToken(value.request),
      path: target.path,
      kind: 'probe',
      at: Date.now(),
    })
  }, [open, target.path, probe, value.request, props.configScope])

  if (!visible) return null

  const isRepo = isRepositoryProbe(probe)
  const remoteValue = resolveRemote(workspace, probe, value.sessionsRemote, remoteDraft, isRepo)
  const state = observed === undefined || observed === null || typeof observed.status !== 'string'
    ? 'idle'
    : observed.status
  const stateLabel = STATUS_LABEL[state] ?? state
  const title = `${TRIGGER_LABEL}：${target.title} · ${stateLabel}（${target.path}）`
  const claimRemote = probe !== undefined && probe !== null && typeof probe.manifestRemote === 'string'
    ? probe.manifestRemote
    : ''

  /** Patch this workspace's entry, creating it when it does not exist yet. */
  const patch = (fields) => {
    const workspaces = Array.isArray(value.workspaces) ? value.workspaces : []
    const existing = workspaces.find(candidate => samePath(candidate.path, target.path))
    const entry = {
      ...WORKSPACE_ENTRY_DEFAULTS,
      ...existing,
      ...fields,
      path: target.path,
      title: (existing !== undefined && typeof existing.title === 'string' && existing.title !== '')
        ? existing.title
        : target.title,
    }
    const next = existing === undefined
      ? [...workspaces, entry]
      : workspaces.map(candidate => (samePath(candidate.path, target.path) ? entry : candidate))
    // `areas` is the retired field: the Host's migration folds a surviving entry
    // back into `workspaces`, so every workspace write clears it in the same
    // commit.
    return Promise.all([
      writeConfig(props.configScope, 'workspaces', next),
      writeConfig(props.configScope, 'areas', []),
    ])
  }

  /** Ask the Host to run one pass over this workspace. */
  const requestSync = (kind) => writeConfig(props.configScope, 'request', {
    token: nextToken(value.request),
    path: target.path,
    kind,
    at: Date.now(),
  })

  /** Drop this workspace's entry entirely. */
  const forget = () => {
    const workspaces = Array.isArray(value.workspaces) ? value.workspaces : []
    return Promise.all([
      writeConfig(props.configScope, 'workspaces', workspaces.filter(candidate => !samePath(candidate.path, target.path))),
      writeConfig(props.configScope, 'areas', []),
    ])
  }

  /** Save the remote, then ask for a pass so the click has a visible effect. */
  const saveAndSync = async () => {
    // An existing repository mirrors its conversations: `sessions` mode keeps
    // the plugin's promise never to touch the project's own files, branch, and
    // commits. A plain folder becomes the sync target itself, but still commits
    // only `.dsh-sessions` unless the user opts into the whole folder.
    const fields = isRepo
      ? { mode: 'sessions', remote: remoteValue }
      : { mode: 'folder', remote: remoteValue, commitScope: 'archive' }
    await patch(fields)
    await requestSync('sync')
  }

  /** Adopt the remote another machine recorded in this folder's manifest. */
  const claim = async (remote) => {
    setRemoteDraft(remote)
    await patch(isRepo ? { mode: 'sessions', remote } : { mode: 'folder', remote, commitScope: 'archive' })
    await requestSync('sync')
  }

  return React.createElement(
    'div',
    {
      ref: rootRef,
      style: styles.root,
      onKeyDown: (event) => {
        if (event.key !== 'Escape' || !open) return
        event.preventDefault()
        setOpen(false)
        // Escape hands focus back to the control that opened the panel.
        const trigger = triggerRef.current
        if (trigger !== null && trigger !== undefined && typeof trigger.focus === 'function') trigger.focus()
      },
    },
    React.createElement(primitives.Tooltip, { label: title, side: 'bottom' },
      React.createElement(
        'button',
        {
          ref: triggerRef,
          type: 'button',
          style: styles.trigger,
          title,
          'aria-label': title,
          'aria-haspopup': 'dialog',
          'aria-expanded': open === true ? 'true' : 'false',
          'data-sync-status': state,
          onClick: () => { setOpen(!open) },
        },
        icon('IconBranchOutline16', 14),
        React.createElement(primitives.StateDot, { state: STATUS_DOT_STATE[state] ?? 'idle', size: 8 }),
        React.createElement('span', { style: styles.triggerLabel }, stateLabel),
      )),
    open
      ? portal(React.createElement(SyncPanel, {
        panelRef,
        position,
        path: target.path,
        title: target.title,
        workspace: workspace ?? {},
        status: observed,
        probe,
        sessionsRemote: value.sessionsRemote ?? '',
        remoteValue,
        claimRemote,
        configured: workspace !== undefined,
        disabled: !writable,
        copied,
        advancedOpen,
        now,
        onCopy: (text) => {
          setCopied(false)
          void primitives.writeClipboard(text).then((ok) => {
            if (ok === false) return
            setCopied(true)
            setTimeout(() => { setCopied(false) }, COPIED_MS)
          })
        },
        onClose: () => { setOpen(false) },
        onToggleAdvanced: () => { setAdvancedOpen(!advancedOpen) },
        onRemote: (next) => { setRemoteDraft(next) },
        onAdvanced: (fields) => { void patch(fields) },
        onSave: () => { void saveAndSync() },
        onSync: () => { void requestSync('sync') },
        onForget: () => { void forget() },
        onClaim: (remote) => { void claim(remote) },
      }))
      : null,
  )
}

// ---------------------------------------------------------------------------
// Shared helpers for the two contributions
// ---------------------------------------------------------------------------

/** True when a probe says the folder already sits inside a repository. */
function isRepositoryProbe(probe) {
  return probe !== undefined && probe !== null && (probe.kind === 'repo' || probe.kind === 'nested')
}

/**
 * Join one configured workspace onto the status document's rows.
 *
 * Both join keys are the path, compared loosely by {@link samePath}; the
 * Host's exact key is not reproducible in the browser, which does not know the
 * Host's platform.
 *
 * @param observed - `StatusConfig.workspaces`.
 * @param probes - `StatusConfig.probes`.
 * @param workspace - the configured entry.
 * @returns the matching status row, or undefined.
 */
function joinStatus(observed, probes, workspace) {
  const path = workspace !== null && typeof workspace === 'object' ? workspace.path : ''
  const found = observed.find(row => samePath(row.path, path))
  if (found !== undefined) return found
  // A folder the Host has only probed has no observed row yet; keep the probe's
  // timestamp out of the status line but let the row render its identity.
  const probe = probes.find(row => samePath(row.path, path))
  return probe === undefined ? undefined : { status: 'idle', at: probe.at, head: '', ahead: 0, behind: 0, detail: '' }
}

/**
 * Every DSH workspace view the current composition exposes.
 *
 * The card is a `settings.plugin.item` registration and is not guaranteed to
 * receive the Workspace UI's standard hook, so the overview degrades to
 * "not available" instead of failing. The hook is always invoked when present,
 * before any branch, so its own hook order is stable.
 *
 * @param useWorkspaces - the optional standard selector hook.
 * @returns the view array, or undefined when the hook is missing.
 */
function allWorkspaceViews(useWorkspaces) {
  if (typeof useWorkspaces !== 'function') return undefined
  const items = useWorkspaces(state => (state === undefined || state === null ? undefined : state.items))
  return Array.isArray(items) ? items : []
}

/** The next request token: monotonic, whatever the stored document held. */
function nextToken(request) {
  const token = request !== null && typeof request === 'object' && Number.isFinite(request.token)
    ? Number(request.token)
    : 0
  return token + 1
}

/** Write one settings field, reporting the failure instead of swallowing it. */
async function writeConfig(scope, field, value) {
  try {
    await scope.set(field, value)
    return true
  } catch (cause) {
    // The card surfaces write failures next to its controls; the header panel
    // has no error banner of its own, so the failure stays in the console.
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(`dsh-sync-tool: 写入设置失败（${field}）`, cause)
    }
    return false
  }
}

/**
 * Register the card into the Plugins settings tab, keyed by the namespace the
 * Host half serves, and the workspace control into the conversation header's
 * right-aligned utilities seat.
 * @param ctx - client cordis context.
 */
exports.apply = function apply(ctx) {
  const configScope = ctx.settingsScope.bind({ namespace: SYNC_NAMESPACE })
  const statusScope = ctx.settingsScope.bind({ namespace: STATUS_NAMESPACE })

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: SYNC_NAMESPACE,
    inject: () => ({ configScope, statusScope }),
  }, SyncCard))

  // The primary entry point: one control in the header's right-aligned
  // utilities. `conversation.session.header.utilities` is declared by
  // @deepseek-ai/dsh-client-ui-conversation as { kind: 'list', scope: 'session' }
  // and documented as "Right-aligned Session utilities in ascending order", so
  // order 200 places this control at the right edge. A list slot takes
  // `id` + `order`, not `key`.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'sync-tool-workspace',
    order: 200,
    inject: () => ({ configScope, statusScope }),
  }, WorkspaceSyncButton))
}
