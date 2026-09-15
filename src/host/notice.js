/**
 * dsh-sync-tool — Device-switch notice.
 *
 * A session that was synchronised from another machine is resumed here with a
 * history that happened somewhere else: its absolute paths, its tool output and
 * its working directory all describe a different computer. The model should
 * know that before it acts on any of it, and the person should not have to say
 * so in every conversation.
 *
 * Where the notice goes is a deliberate choice. The harness offers exactly one
 * channel that is both model-visible and cache-safe:
 *
 *  - `systemPrompt.section()` would change the system prompt, which lives at
 *    surface node 0. On the first step of a resumed session the loop treats a
 *    changed prompt as a new request series and *replaces* node 0, which
 *    invalidates the provider's prefix cache from the very first token — the
 *    exact cost this feature exists to avoid.
 *  - A durable message injected at `agent/session-start` would land after the
 *    cached history, but DSH renders it as its own context row.
 *  - `systemPrompt.context()` feeds the *dynamic runtime-context snapshot*,
 *    which the loop already materialises as a durable user-role message
 *    appended after the history. The notice therefore rides inside the
 *    "Current runtime context" entry that every session already has, preserves
 *    the cached prefix byte for byte, and adds no new transcript element.
 *
 * The contribution is conditional: `AssembleContext.agent` identifies the
 * session being assembled, so a session that started on this machine renders to
 * an empty string and the snapshot drops it entirely — zero effect on the
 * prompt, the log, and other users of this deployment.
 */

/** Stable registration name for the notice contribution. */
export const NOTICE_NAME = 'sync-tool:device-switch'

/**
 * Snapshot position. The harness allocates 110/115/120 to sandbox policy,
 * approval policy and subagent delegation; the notice follows them, before the
 * user's own turn context.
 */
export const NOTICE_ORDER = 130

/** One-line date, stable for a day, so the snapshot does not churn per turn. */
function dayOf(at) {
  const value = Number.isFinite(at) ? new Date(at) : new Date()
  return value.toISOString().slice(0, 10)
}

/**
 * Render the notice for one imported session.
 *
 * The text is deliberately stable for a given import: the runtime-context
 * snapshot is only re-materialised when its text changes, so a volatile notice
 * would append a message on every step.
 *
 * @param record - the import record stored beside the archive.
 * @param options - `{ archiveDir }` names where the session can also be read.
 * @returns the notice paragraph.
 */
export function noticeText(record, options = {}) {
  const lines = [
    `Device notice (dsh-sync-tool): this session's history was synchronised from another computer`
    + ` (${record.host ?? 'unknown-host'}, ${dayOf(record.at)}). Everything above this point was`
    + ' produced there, not on this machine.',
  ]
  if (typeof record.originalCwd === 'string' && record.originalCwd !== '') {
    lines.push(`- The working directory recorded in that history is ${record.originalCwd}.`)
  }
  if (record.rewritten === true && typeof record.cwd === 'string' && record.cwd !== '') {
    lines.push(`- On this machine the same work area is ${record.cwd}; paths from the earlier turns may not exist here.`)
  }
  if (typeof options.archiveDir === 'string' && options.archiveDir !== '') {
    lines.push(`- The synchronised copy of this session lives in ${options.archiveDir}.`)
  }
  lines.push('Treat earlier absolute paths and tool output as historical context: confirm a path exists before'
    + ' reading or writing it, and prefer this machine\'s own locations.')
  return lines.join('\n')
}

/**
 * Register the conditional device-switch notice.
 *
 * @param ctx - host cordis context.
 * @param options - `{ imports, enabled, archiveDir, log }`; `imports()` returns
 *   the import records keyed by session id and `archiveDir(record)` names the
 *   folder holding this session's synchronised copy.
 * @returns nothing; the registration is owned by the caller's fiber.
 */
export function installDeviceNotice(ctx, options = {}) {
  const imports = typeof options.imports === 'function' ? options.imports : () => ({})
  const enabled = typeof options.enabled === 'function' ? options.enabled : () => true
  const archiveDir = typeof options.archiveDir === 'function' ? options.archiveDir : () => ''
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => promptCtx.systemPrompt.context({
      name: NOTICE_NAME,
      order: NOTICE_ORDER,
      text: (assembly) => {
        if (enabled() !== true) return ''
        const id = assembly?.agent?.session?.header?.id
        if (typeof id !== 'string' || id === '') return ''
        const record = imports()[id]
        if (record === null || typeof record !== 'object') return ''
        return noticeText(record, { archiveDir: archiveDir(record) })
      },
    }), 'sync-tool: device notice')
  })
}
