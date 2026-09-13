/**
 * dsh-sync-tool — browser half.
 *
 * This file runs INSIDE the client module table's closure factory, so
 * `require`, `module`, and `exports` are supplied by the wrapper emitted in
 * `scripts/build.mjs`; it is not a standalone ES module. Cross-plugin
 * collaboration goes through Cordis services only, because the client bundle
 * purity gate forbids value imports between plugin packages — the card owns
 * its own chrome, controls, and copy.
 */
const React = require('react')

/** The settings namespace this card claims; it must match the Host half. */
const SYNC_NAMESPACE = 'sync-tool'

/** Cordis client plugin name. */
exports.name = 'sync-tool-client'

/** Slot registry, the settings transport, and the namespace scope binder. */
exports.inject = ['slots', 'remote', 'settingsScope']

const styles = {
  card: {
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28))',
    borderRadius: '10px',
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
  },
  titleRow: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
  title: { margin: 0, fontSize: '14px', fontWeight: 600 },
  subtitle: { fontSize: '12px', opacity: 0.6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  grid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: '12px' },
  label: { opacity: 0.65 },
  value: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  note: { fontSize: '12px', opacity: 0.7, lineHeight: 1.5, margin: 0 },
}

/** Human-readable status for one scope snapshot. */
function statusText(snapshot) {
  if (snapshot.status === 'ready') return '已连接 Host 设置 / connected'
  if (snapshot.status === 'loading') return '读取中… / loading'
  return '不可用 / unavailable'
}

/** One `label: value` row. */
function Row(label, value) {
  return [
    React.createElement('div', { key: `${label}-l`, style: styles.label }, label),
    React.createElement('div', { key: `${label}-v`, style: styles.value }, value),
  ]
}

/**
 * The plugin card: current resolved configuration, read-only in this stage.
 * @param props - injected `scope`, the bound `sync-tool` settings namespace.
 * @returns the card element.
 */
function SyncCard(props) {
  const scope = props.scope
  const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot())

  React.useEffect(() => {
    setSnapshot(scope.getSnapshot())
    return scope.subscribe(() => { setSnapshot(scope.getSnapshot()) })
  }, [scope])

  const value = snapshot.value ?? {}
  const rows = [
    ...Row('配置状态 / status', statusText(snapshot)),
    ...Row('启用 / enabled', String(value.enabled ?? '—')),
    ...Row('每轮同步 / on turn end', String(value.syncOnTurnEnd ?? '—')),
    ...Row('防抖 / debounce', `${value.debounceMs ?? '—'} ms`),
    ...Row('命名空间 / namespace', SYNC_NAMESPACE),
  ]

  return React.createElement(
    'section',
    { style: styles.card },
    React.createElement(
      'div',
      { style: styles.titleRow },
      React.createElement('h3', { style: styles.title }, '工作区域 Git 同步'),
      React.createElement('span', { style: styles.subtitle }, 'dsh-sync-tool'),
    ),
    React.createElement('div', { style: styles.grid }, rows),
    React.createElement(
      'p',
      { style: styles.note },
      '骨架阶段：Host 命名空间已注册、卡片已配对。工作区域的添加、远端配置与同步历史将在下一阶段接入。',
    ),
  )
}

/**
 * Register the card into the Plugins settings tab, keyed by the namespace the
 * Host half serves.
 * @param ctx - client cordis context.
 */
exports.apply = function apply(ctx) {
  const scope = ctx.settingsScope.bind({ namespace: SYNC_NAMESPACE })
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: SYNC_NAMESPACE,
    inject: () => ({ scope }),
  }, SyncCard))
}
