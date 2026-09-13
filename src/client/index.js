/**
 * dsh-sync-tool — browser half.
 *
 * This file runs INSIDE the client module table's closure factory, so
 * `require`, `module`, and `exports` are supplied by the wrapper emitted in
 * `scripts/build.mjs`; it is not a standalone ES module. Cross-plugin
 * collaboration goes through Cordis services only, because the client bundle
 * purity gate forbids value imports between plugin packages — the card owns
 * its own chrome, controls, and copy.
 *
 * The card edits the `sync-tool` settings namespace and reads the
 * Host-published `sync-tool-status` namespace. Folder selection goes through
 * the already-mounted `directoryPicker` Remote; when that backend cannot serve
 * the native chooser the card falls back to a validated manual path.
 */
const React = require('react')

/** User-configuration namespace; must match the Host half. */
const SYNC_NAMESPACE = 'sync-tool'

/** Host-published status namespace; must match the Host half. */
const STATUS_NAMESPACE = 'sync-tool-status'

/** Cordis client plugin name. */
exports.name = 'sync-tool-client'

/** Slot registry, the settings transport, and the namespace scope binder. */
exports.inject = ['slots', 'remote', 'settingsScope']

const STATUS_LABEL = {
  idle: '待同步',
  validating: '校验中',
  syncing: '同步中',
  ok: '已同步',
  conflict: '冲突待处理',
  error: '错误',
}

const STATUS_COLOR = {
  idle: 'var(--dsw-alias-label-secondary, #888)',
  validating: 'var(--dsw-alias-label-secondary, #888)',
  syncing: 'var(--dsw-alias-brand-primary, #3b82f6)',
  ok: 'var(--dsw-alias-state-success-primary, #16a34a)',
  conflict: 'var(--dsw-alias-state-warn-primary, #d97706)',
  error: 'var(--dsw-alias-state-error-primary, #dc2626)',
}

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
  label: { display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer' },
  area: {
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))',
    borderRadius: '8px',
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '7px',
  },
  areaHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  areaPath: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '12px',
    wordBreak: 'break-all',
    flex: 1,
    minWidth: '160px',
  },
  grid: { display: 'grid', gridTemplateColumns: '76px 1fr', gap: '6px 10px', alignItems: 'center', fontSize: '12px' },
  fieldLabel: { opacity: 0.65 },
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
}

/** Subscribe to one bound settings scope. */
function useScope(scope) {
  const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot())
  React.useEffect(() => {
    setSnapshot(scope.getSnapshot())
    return scope.subscribe(() => { setSnapshot(scope.getSnapshot()) })
  }, [scope])
  return snapshot
}

/** A locally unique id for a new work area. */
function newId() {
  const random = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return random
}

/** Display name for a folder path. */
function baseName(path) {
  const parts = String(path).split(/[\\/]+/).filter(part => part !== '')
  return parts.length === 0 ? String(path) : parts[parts.length - 1]
}

/** Shorten a commit-ish for display. */
function shortSha(value) {
  return typeof value === 'string' && value.length > 10 ? value.slice(0, 10) : (value || '—')
}

/** Text input that commits on blur or Enter instead of on every keystroke. */
function TextField(props) {
  const [draft, setDraft] = React.useState(props.value ?? '')
  React.useEffect(() => { setDraft(props.value ?? '') }, [props.value])
  return React.createElement('input', {
    style: props.mono === true ? { ...styles.input, ...styles.inputMono } : styles.input,
    value: draft,
    placeholder: props.placeholder ?? '',
    spellCheck: false,
    onChange: (event) => { setDraft(event.target.value) },
    onBlur: () => { if ((props.value ?? '') !== draft) props.onCommit(draft) },
    onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
  })
}

/** Checkbox bound to one boolean field. */
function Checkbox(props) {
  return React.createElement(
    'label',
    { style: styles.label, title: props.title ?? undefined },
    React.createElement('input', {
      type: 'checkbox',
      checked: props.checked === true,
      disabled: props.disabled === true,
      onChange: (event) => { props.onChange(event.target.checked) },
    }),
    props.label,
  )
}

/** One work area's editor row. */
function AreaRow(props) {
  const { area, status, onPatch, onRemove } = props
  const state = status ?? { status: 'idle', detail: '', at: 0, head: '', ahead: 0, behind: 0 }
  return React.createElement(
    'div',
    { style: styles.area },
    React.createElement(
      'div',
      { style: styles.areaHead },
      React.createElement('input', {
        type: 'checkbox',
        checked: area.enabled !== false,
        title: '启用该工作区域',
        onChange: (event) => { onPatch(area.id, { enabled: event.target.checked }) },
      }),
      React.createElement('span', { style: styles.areaPath, title: area.path }, area.path),
      React.createElement(
        'span',
        { style: { ...styles.status, color: STATUS_COLOR[state.status] ?? 'inherit' } },
        STATUS_LABEL[state.status] ?? state.status,
      ),
      React.createElement('button', {
        style: styles.buttonDanger,
        onClick: () => { onRemove(area.id) },
      }, '移除'),
    ),
    React.createElement(
      'div',
      { style: styles.grid },
      React.createElement('span', { style: styles.fieldLabel }, '名称'),
      React.createElement(TextField, {
        value: area.name ?? '',
        placeholder: baseName(area.path),
        onCommit: (value) => { onPatch(area.id, { name: value }) },
      }),
      React.createElement('span', { style: styles.fieldLabel }, '远端'),
      React.createElement(TextField, {
        value: area.remote ?? '',
        placeholder: 'https://github.com/you/dsh-sync.git',
        mono: true,
        onCommit: (value) => { onPatch(area.id, { remote: value }) },
      }),
      React.createElement('span', { style: styles.fieldLabel }, '分支'),
      React.createElement(TextField, {
        value: area.branch ?? 'main',
        placeholder: 'main',
        mono: true,
        onCommit: (value) => { onPatch(area.id, { branch: value.trim() === '' ? 'main' : value.trim() }) },
      }),
      React.createElement('span', { style: styles.fieldLabel }, '凭据'),
      React.createElement(TextField, {
        value: area.credentialRef ?? '',
        placeholder: 'DSH_SYNC_GIT_TOKEN（留空则用系统 git 凭据）',
        mono: true,
        onCommit: (value) => { onPatch(area.id, { credentialRef: value.trim() }) },
      }),
      React.createElement('span', { style: styles.fieldLabel }, '方向'),
      React.createElement(
        'select',
        {
          style: styles.input,
          value: area.direction ?? 'both',
          onChange: (event) => { onPatch(area.id, { direction: event.target.value }) },
        },
        React.createElement('option', { value: 'both' }, '双向（先 pull 再 push）'),
        React.createElement('option', { value: 'push' }, '仅 push'),
        React.createElement('option', { value: 'pull' }, '仅 pull'),
      ),
      React.createElement('span', { style: styles.fieldLabel }, '选项'),
      React.createElement(
        'div',
        { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } },
        Checkbox({
          label: '自动提交',
          checked: area.autoCommit !== false,
          onChange: (next) => { onPatch(area.id, { autoCommit: next }) },
        }),
        Checkbox({
          label: '敏感文件保护',
          title: '暂存区出现 .credentials.yaml、.env、私钥等文件时拒绝自动提交',
          checked: area.guardSensitive !== false,
          onChange: (next) => { onPatch(area.id, { guardSensitive: next }) },
        }),
        Checkbox({
          label: '父仓库内建库',
          title: '该目录位于另一个 git 仓库内部时（例如家目录本身是仓库），在它内部初始化独立仓库；关闭则拒绝操作',
          checked: (area.nestedRepos ?? 'init') === 'init',
          onChange: (next) => { onPatch(area.id, { nestedRepos: next ? 'init' : 'refuse' }) },
        }),
      ),
    ),
    state.detail !== ''
      ? React.createElement('div', { style: { ...styles.status, color: STATUS_COLOR[state.status] ?? 'inherit' } }, state.detail)
      : null,
    state.at > 0
      ? React.createElement(
        'div',
        { style: { ...styles.status, opacity: 0.6 } },
        `最近：${new Date(state.at).toLocaleString()} · HEAD ${shortSha(state.head)} · ↑${state.ahead ?? 0} ↓${state.behind ?? 0}`,
      )
      : null,
  )
}

/**
 * The plugin card.
 * @param props - injected scopes and the host folder picker.
 * @returns the card element.
 */
function SyncCard(props) {
  const config = useScope(props.configScope)
  const status = useScope(props.statusScope)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [manualPath, setManualPath] = React.useState('')

  const value = config.value ?? {}
  const areas = Array.isArray(value.areas) ? value.areas : []
  const statusValue = status.value ?? {}
  const statusById = new Map(
    (Array.isArray(statusValue.areas) ? statusValue.areas : []).map(entry => [entry.id, entry]),
  )
  const history = Array.isArray(statusValue.history) ? statusValue.history : []
  const writable = config.writable === true && config.mode === 'host'

  /** Write one config field, surfacing failures instead of swallowing them. */
  const write = async (field, next) => {
    setError('')
    try {
      await props.configScope.set(field, next)
    } catch (cause) {
      setError(`写入设置失败 / failed to write settings: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const patchArea = (id, patch) => {
    void write('areas', areas.map(area => (area.id === id ? { ...area, ...patch } : area)))
  }

  const addArea = async (path) => {
    const trimmed = String(path).trim()
    if (trimmed === '') return
    if (areas.some(area => area.path === trimmed)) {
      setError('该目录已在列表中 / that folder is already listed')
      return
    }
    await write('areas', [...areas, {
      id: newId(),
      name: baseName(trimmed),
      path: trimmed,
      remote: '',
      branch: 'main',
      credentialRef: '',
      direction: 'both',
      enabled: true,
      autoCommit: true,
      extraIgnores: [],
      guardSensitive: true,
    }])
  }

  const pickAndAdd = async () => {
    setError('')
    setBusy(true)
    try {
      const picked = await props.pickDirectory(new AbortController().signal)
      if (typeof picked === 'string' && picked !== '') await addArea(picked)
    } catch (cause) {
      setError(`原生目录选择器不可用 / native picker unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  const requestSync = (areaId) => {
    const request = value.request ?? {}
    void write('request', {
      token: (request.token ?? 0) + 1,
      areaId: areaId ?? '',
      kind: 'sync',
      at: Date.now(),
    })
  }

  /** Ask the Host for a shortcut path it can write to. */
  const quickAdds = [
    { label: '预设目录', path: props.presetsPath },
  ].filter(entry => typeof entry.path === 'string' && entry.path !== '')

  return React.createElement(
    'section',
    { style: styles.card },
    React.createElement(
      'div',
      { style: styles.titleRow },
      React.createElement('h3', { style: styles.title }, '工作区域 Git 同步'),
      React.createElement('span', { style: styles.subtitle }, 'dsh-sync-tool'),
    ),

    React.createElement(
      'div',
      { style: styles.toggles },
      Checkbox({
        label: '启用插件',
        checked: value.enabled !== false,
        disabled: !writable,
        onChange: (next) => { void write('enabled', next) },
      }),
      Checkbox({
        label: '每轮对话后同步',
        checked: value.syncOnTurnEnd !== false,
        disabled: !writable,
        onChange: (next) => { void write('syncOnTurnEnd', next) },
      }),
      Checkbox({
        label: '启动时同步',
        checked: value.syncOnStartup === true,
        disabled: !writable,
        onChange: (next) => { void write('syncOnStartup', next) },
      }),
      Checkbox({
        label: '每轮同步全部区域',
        title: '默认只同步「包含当前会话工作目录」的区域；勾选后每轮都同步全部启用的区域',
        checked: value.syncAllOnTurnEnd === true,
        disabled: !writable,
        onChange: (next) => { void write('syncAllOnTurnEnd', next) },
      }),
      React.createElement(
        'label',
        { style: styles.label },
        '防抖',
        React.createElement('input', {
          type: 'number',
          min: 0,
          step: 500,
          disabled: !writable,
          value: value.debounceMs ?? 5000,
          style: { ...styles.input, width: '84px' },
          onChange: (event) => { void write('debounceMs', Math.max(0, Number(event.target.value) || 0)) },
        }),
        'ms',
      ),
    ),

    React.createElement('div', { style: styles.sectionTitle }, `工作区域（${areas.length}）`),
    areas.length === 0
      ? React.createElement('p', { style: styles.notice }, '还没有工作区域。添加一个目录，插件会在每轮对话结束后把它同步到你的远程仓库。')
      : null,
    ...areas.map(area => React.createElement(AreaRow, {
      key: area.id,
      area,
      status: statusById.get(area.id),
      onPatch: patchArea,
      onRemove: (id) => { void write('areas', areas.filter(candidate => candidate.id !== id)) },
    })),

    React.createElement(
      'div',
      { style: styles.buttons },
      React.createElement('button', {
        style: styles.buttonPrimary,
        disabled: busy || !writable,
        onClick: () => { void pickAndAdd() },
      }, busy ? '选择中…' : '选择目录并添加'),
      ...quickAdds.map(entry => React.createElement('button', {
        key: entry.path,
        style: styles.button,
        disabled: !writable,
        title: entry.path,
        onClick: () => { void addArea(entry.path) },
      }, `+ ${entry.label}`)),
      React.createElement('button', {
        style: styles.button,
        disabled: !writable || areas.length === 0,
        onClick: () => { requestSync('') },
      }, '立即同步全部'),
    ),

    React.createElement(
      'div',
      { style: styles.buttons },
      React.createElement('input', {
        style: { ...styles.input, ...styles.inputMono, flex: 1, minWidth: '220px' },
        placeholder: '或手动输入绝对路径，例如 D:\\work\\my-plugins',
        value: manualPath,
        spellCheck: false,
        onChange: (event) => { setManualPath(event.target.value) },
        onKeyDown: (event) => {
          if (event.key !== 'Enter') return
          void addArea(manualPath).then(() => { setManualPath('') })
        },
      }),
      React.createElement('button', {
        style: styles.button,
        disabled: !writable || manualPath.trim() === '',
        onClick: () => { void addArea(manualPath).then(() => { setManualPath('') }) },
      }, '添加路径'),
    ),

    error !== '' ? React.createElement('p', { style: styles.error }, error) : null,
    writable ? null : React.createElement('p', { style: styles.notice }, '当前连接不接受设置写入，配置为只读。'),

    React.createElement('div', { style: styles.sectionTitle }, '同步状态'),
    React.createElement(
      'div',
      { style: styles.status },
      status.status === 'ready'
        ? `${statusValue.running === true ? '同步进行中' : '空闲'} · 更新于 ${statusValue.updatedAt ? new Date(statusValue.updatedAt).toLocaleString() : '—'}`
        : `状态命名空间：${status.status}`,
    ),
    history.length === 0
      ? React.createElement('p', { style: styles.notice }, '暂无同步历史。')
      : React.createElement(
        'ul',
        { style: styles.history },
        ...[...history].reverse().slice(0, 10).map((entry, index) => React.createElement(
          'li',
          { key: `${entry.at}-${index}`, style: { color: entry.ok ? 'inherit' : STATUS_COLOR.error } },
          `${entry.ok ? '✓' : '✗'} ${new Date(entry.at).toLocaleTimeString()} · ${entry.summary}`,
        )),
      ),

    React.createElement(
      'p',
      { style: styles.notice },
      '同步在每轮对话结束后由宿主自动执行。git 通过宿主子进程运行，凭据只在拼装命令的瞬间从 credentials 读取，不落盘。',
    ),
  )
}

/** Join a folder onto a host home path using the separator it already uses. */
function joinPath(base, child) {
  const separator = String(base).includes('\\') ? '\\' : '/'
  return `${String(base).replace(/[\\/]+$/, '')}${separator}${child}`
}

/**
 * Register the card into the Plugins settings tab, keyed by the namespace the
 * Host half serves, and bind the Host-published status namespace read-only.
 * @param ctx - client cordis context.
 */
exports.apply = function apply(ctx) {
  const configScope = ctx.settingsScope.bind({ namespace: SYNC_NAMESPACE })
  const statusScope = ctx.settingsScope.bind({ namespace: STATUS_NAMESPACE })

  // Folder selection reuses the composed directory-picker Remote rather than
  // declaring a private one; the card degrades to manual entry without it.
  const pickDirectory = async (signal) => {
    const picker = ctx.remote && ctx.remote.directoryPicker
    if (picker === undefined || typeof picker.pick !== 'function') {
      throw new Error('directoryPicker.pick is not available in this composition')
    }
    return await picker.pick(signal)
  }

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: SYNC_NAMESPACE,
    inject: () => {
      const home = ctx.remote && ctx.remote.$host ? ctx.remote.$host.home : undefined
      return {
        configScope,
        statusScope,
        pickDirectory,
        presetsPath: typeof home === 'string' && home !== '' ? joinPath(home, '.agent-presets') : undefined,
      }
    },
  }, SyncCard))
}
