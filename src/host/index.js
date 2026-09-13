/**
 * dsh-sync-tool — Host half.
 *
 * Owns the `sync-tool` settings namespace, which is the join key between this
 * half and the browser card: the Host serves the namespace and the card claims
 * it, so the Plugins settings tab pairs the two without either side knowing
 * the other exists.
 *
 * Later stages add the work-area registry and the git engine driven by
 * `turn/end`; see PLAN.md.
 */
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name (the loader row's `name` is the module specifier). */
export const name = 'sync-tool'

/** The settings namespace joining this Host half to its browser card. */
export const SYNC_NAMESPACE = 'sync-tool'

/**
 * Resolved configuration, layered as schema defaults, then the composition
 * row's `config`, then the user document section.
 */
export const Config = z.object({
  /** Master switch for every automatic sync. */
  enabled: z.boolean().default(true),
  /** Sync the work areas a finished turn touched. */
  syncOnTurnEnd: z.boolean().default(true),
  /** Coalescing window for bursty turn boundaries, in milliseconds. */
  debounceMs: z.natural().default(5000),
})

/**
 * Mount the Host half.
 * @param ctx - host cordis context.
 * @param config - schema-resolved configuration for this row.
 */
export function apply(ctx, config) {
  // The authoritative configuration thunk: the resolved settings scope while a
  // provider is attached, the composition entry otherwise.
  let resolveConfig = () => config

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, SYNC_NAMESPACE, Config, config, {
      setSource: (current) => { resolveConfig = current },
      onChange: () => { void resolveConfig },
    })
  })

  console.log(`[sync-tool] host half loaded (namespace "${SYNC_NAMESPACE}")`)
}
