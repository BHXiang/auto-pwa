/**
 * Vendored minimal type surface + runtime stub for `@deepseek-ai/cordis`.
 * See dsh-tools.ts for the rationale. Covers only what plugin/pwa-tools.ts
 * and the tests use: `apply(ctx)` with `ctx.tools.register`.
 */
import type { ToolDefinition } from './dsh-tools.js'

/** Cordis plugin context — the subset our plugin consumes. */
export interface PluginContext {
  tools: {
    register(def: ToolDefinition): void
  }
  get<T>(name: string): T | undefined
  effect?: (fn: () => void | (() => void)) => void
}

/** Base class kept for API-shape compatibility; plugins may ignore it. */
export abstract class Service {
  constructor(ctx: PluginContext, name: string) {
    void ctx
    void name
  }
}

/** Context type alias mirroring cordis's `Context` export name. */
export type Context = PluginContext
