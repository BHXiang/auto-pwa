/**
 * Vendored minimal type surface + runtime stub for `@deepseek-ai/dsh-tools`.
 *
 * Why: the npm registry only carries an old rc (0.0.1-rc.1) whose API differs
 * from the DeepSeek Harness checkout (>= 0.1.0-rc.5). The real package is
 * provided by the DSH runtime at plugin load time (peer dependency). This
 * module lets contributors typecheck and unit-test the plugin WITHOUT a DSH
 * checkout: `defineTool` is an identity at runtime (the plugin test only
 * checks registration), and the types cover exactly the surface
 * plugin/pwa-tools.ts uses.
 *
 * When developing against a real checkout, prefer the real types:
 * `scripts/setup-dev.sh` links the checkout packages into node_modules, and
 * tsconfig paths below are shadowed by real resolution in that case.
 */
import type { PluginContext } from './cordis.js'

// ---------------------------------------------------------------------------
// schema DSL (subset)
// ---------------------------------------------------------------------------

export interface SchemaAnnotations {
  description?: string
  title?: string
}

export interface StringSchema extends SchemaAnnotations {
  type: 'string'
  enum?: readonly string[]
  const?: string
}

export interface NumberSchema extends SchemaAnnotations {
  type: 'number'
  enum?: readonly number[]
  const?: number
}

export interface IntegerSchema extends SchemaAnnotations {
  type: 'integer'
  enum?: readonly number[]
  const?: number
}

export interface BooleanSchema extends SchemaAnnotations {
  type: 'boolean'
}

export interface NullSchema extends SchemaAnnotations {
  type: 'null'
}

export interface ArraySchema extends SchemaAnnotations {
  type: 'array'
  items?: ValueSchema
}

export interface ObjectSchema extends SchemaAnnotations {
  type: 'object'
  properties?: ParameterSchemaSpec
  additionalProperties: boolean
}

export interface JsonSchema extends SchemaAnnotations {
  type: 'json'
}

export interface OneOfSchema extends SchemaAnnotations {
  oneOf: readonly [ValueSchema, ValueSchema, ...ValueSchema[]]
}

export type ValueSchema =
  | StringSchema
  | NumberSchema
  | IntegerSchema
  | BooleanSchema
  | NullSchema
  | ArraySchema
  | ObjectSchema
  | JsonSchema
  | OneOfSchema

export type ParameterPropertySpec = ValueSchema & { required?: true }

export type ParameterSchemaSpec = {
  [key: string]: ParameterPropertySpec
}

/** Loosely inferred argument type (exact inference is a nice-to-have). */
export type InferArgs<S extends ParameterSchemaSpec | undefined> = S extends ParameterSchemaSpec
  ? { [K in keyof S]: unknown }
  : Record<string, never>

/** A rendered model-visible content block. */
export type ContentBlock = { type: 'text'; text: string }

export interface DefineToolOptions<S extends ParameterSchemaSpec | undefined, Out> {
  name: string
  description: string
  parameters: S
  output: {
    schema: ValueSchema
    // value is `any` in the stub (the plugin declares its own render types;
    // the real dsh-tools checks them against the output schema).
    render: (args: InferArgs<S>, value: any) => ContentBlock[]
  }
  // args is `any` in the stub on purpose: the plugin declares explicit
  // parameter types, and the real dsh-tools infers them from the schema.
  execute(args: any, exec: { signal: AbortSignal; agent?: { id: string } }): Promise<Out>
  presentCall?: unknown
  presentResult?: unknown
}

export interface ToolDefinition {
  name: string
  description?: string
}

/**
 * Identity at runtime for standalone development/tests; the real
 * implementation (schema validation, execution pipeline) comes from the DSH
 * runtime, which resolves its own `@deepseek-ai/dsh-tools`.
 */
export function defineTool<S extends ParameterSchemaSpec | undefined, Out>(
  def: DefineToolOptions<S, Out>,
): DefineToolOptions<S, Out> & ToolDefinition {
  return def as DefineToolOptions<S, Out> & ToolDefinition
}

/** Plugin factory signature (name/inject/apply), used by the cordis loader. */
export type PluginModule = {
  name: string
  inject?: string[]
  apply: (ctx: PluginContext) => void
}
