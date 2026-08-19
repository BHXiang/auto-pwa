/**
 * Vendored minimal type surface + runtime stub for `@deepseek-ai/cordis`.
 * See dsh-tools.ts for the rationale. Covers what the plugin files consume:
 * `apply(ctx)` with `ctx.tools.register`/`ctx.tools.guard`, the `Service`
 * base class (service definitions extend it), the `Context` interface that
 * plugin-side `declare module` augmentations merge into (mirroring how the
 * real cordis Context is augmented by dsh-jobs / dsh-spill / dsh-commands /
 * our own pwa-fit), plus optional spillStore/commands/on surfaces.
 */
import type { ToolDefinition, ToolGuard } from './dsh-tools.js'

/** Spill-save input shape (mirrors @deepseek-ai/dsh-spill SaveTextSpill). */
export interface SpillSaveInput {
  owner: { sessionId: string }
  source: { toolName: string; callId: string; label: string }
  suggestedName: string
  content: string
}

/** Spill-save result shape (mirrors @deepseek-ai/dsh-spill SpillRef). */
export interface SpillRefLike {
  locator: string
  bytes: number
  retrievalHint: string
}

/** Slash-command registration input (mirrors @deepseek-ai/dsh-commands). */
export interface CommandDefinitionLike {
  name: string
  description: string
  input?: { hint: string }
  handler: (invocation: { agent: { sessionId?: string; id?: string }; rawInput: string; signal: AbortSignal }) =>
    { kind: 'success'; text?: string } | { kind: 'error'; text: string } | Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
}

/** Cordis plugin context — the subset our plugin consumes. */
export interface PluginContext {
  tools: {
    register(def: ToolDefinition): void
    guard?(guard: ToolGuard): () => void
  }
  get<T>(name: string): T | undefined
  effect?: (fn: () => void | (() => void)) => void
  /**
   * Optional DSH surfaces present in real deployments; the plugin code uses
   * optional chaining so tests without them still pass. `on` is cordis's
   * event subscription (e.g. 'session/event' for token-usage accounting).
   */
  on?(event: string, handler: (...args: unknown[]) => void): void
  spillStore?: { saveText(input: SpillSaveInput): Promise<SpillRefLike> }
  commands?: { register(def: CommandDefinitionLike): () => void }
}

/**
 * Context type mirroring cordis's `Context` export name. Declared as an
 * INTERFACE so plugin-side `declare module '@deepseek-ai/cordis'` augmentations
 * (pwaFit, jobs) merge into it exactly like they merge into the real cordis
 * Context.
 */
export interface Context extends PluginContext {}

/** Base class kept for API-shape compatibility; plugins may ignore it. */
export abstract class Service {
  /** The registering context (real cordis stores it the same way). */
  protected ctx: PluginContext

  constructor(ctx: PluginContext, name: string) {
    this.ctx = ctx
    void name
  }
}
