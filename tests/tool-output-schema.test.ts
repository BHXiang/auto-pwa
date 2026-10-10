import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { apply } from '../plugin/auto-pwa.js'
import { spillOutputSchema } from '../plugin/pwa-utils.js'

/**
 * 工具 output schema 契约测试。
 *
 * harness 在注册时会用 valueSchemaSpecToJsonSchema 把插件的**表面 DSL**
 * （属性级 `required: true` 等）编译成真正的 JSON Schema，之后每次工具返回都用
 * 它校验值。两类事故都真实发生过：
 *   - DSL 用错关键字 → 注册即抛错（整个插件加载失败）；
 *   - schema 与脚本产出的形状不一致 → 每次调用都 "returned invalid output"
 *     （`moments` 声明了 `additionalProperties: false` 却没有 properties；
 *      spill 信封带了两个没声明的字段，wave_view 连 `spilled` 都没声明）。
 *
 * 注意：测试里 `defineTool` 被 vitest alias 换成 vendored stub（不做 DSL 编译），
 * 所以校验必须自己先编译一次；真校验器在 @deepseek-ai/dsh-tools 里，而它是
 * peerDependency、`npm ci` 不会装（不在 lockfile），故该组 skipIf 门控。
 * 结构声明那组在任何环境都跑 —— 正是它守住"某个工具忘了声明 spilled"。
 */

interface Def {
  name: string
  output?: { schema?: Record<string, unknown> }
}

/** 调用真实 apply() 收集工具定义（与运行时注册路径一致）。 */
function collect(): Def[] {
  const definitions: Def[] = []
  const ctx = {
    tools: { register: (def: Def) => definitions.push(def) },
    on: () => {},
    get: () => undefined,
  }
  apply(ctx as never)
  return definitions
}

/** 会 spread spill 信封的工具（与 maybeSpill 的 6 个调用点一一对应）。 */
const SPILLING_TOOLS = [
  'auto_pwa_jpc_check',
  'auto_pwa_init_config',
  'auto_pwa_config_view',
  'auto_pwa_evaluate',
  'auto_pwa_root_view',
  'auto_pwa_wave_view',
]

const TOOLS_LIB = fileURLToPath(
  new URL('../node_modules/@deepseek-ai/dsh-tools/lib/index.js', import.meta.url),
)
const HAS_VALIDATOR = existsSync(TOOLS_LIB)

/** 真 dsh-tools（DSL 编译器 + 子集断言 + 值校验），缺失时由 skipIf 挡掉。 */
async function dshTools(): Promise<{
  valueSchemaSpecToJsonSchema: (spec: unknown) => unknown
  assertSupportedJsonSchema: (schema: unknown) => void
  validateJsonSchemaValue: (schema: unknown, value: unknown) => unknown[]
}> {
  return (await import(TOOLS_LIB)) as never
}

describe('工具 output schema：结构声明（任何环境都跑）', () => {
  const defs = collect()

  it('每个工具都声明了 object 根 schema', () => {
    expect(defs.length).toBeGreaterThan(20)
    for (const def of defs) {
      const schema = def.output?.schema
      expect(schema, `${def.name} 缺 output.schema`).toBeDefined()
      expect(schema?.type, `${def.name} 的 schema.type 必须是 object`).toBe('object')
    }
  })

  it('会 spill 的工具都声明了 spilled 字段，且用共享常量', () => {
    const byName = new Map(defs.map((d) => [d.name, d]))
    for (const name of SPILLING_TOOLS) {
      const def = byName.get(name)
      expect(def, `${name} 不在工具表里`).toBeDefined()
      const props = (def!.output?.schema as { properties?: Record<string, unknown> }).properties ?? {}
      expect(props.spilled, `${name} 没声明 spilled（spill 一触发整份输出就非法）`).toBeDefined()
      expect(props.spilled, `${name} 的 spilled 漂移成了内联 schema`).toBe(spillOutputSchema)
    }
  })
})

describe.skipIf(!HAS_VALIDATOR)('工具 output schema：DSL 编译 + 值校验一致性', () => {
  it('全部工具的 schema 都能编译进 DSH 支持的子集（否则注册时就炸）', async () => {
    const { valueSchemaSpecToJsonSchema, assertSupportedJsonSchema } = await dshTools()
    for (const def of collect()) {
      let compiled: unknown
      expect(() => {
        compiled = valueSchemaSpecToJsonSchema(def.output?.schema)
      }, `${def.name} 的 output schema 编译失败`).not.toThrow()
      expect(() => assertSupportedJsonSchema(compiled), `${def.name} 编译后不在支持子集内`).not.toThrow()
    }
  })

  it('spill 信封能被共享 schema 接受（两种 summary 形态）', async () => {
    const { valueSchemaSpecToJsonSchema, validateJsonSchemaValue } = await dshTools()
    const schema = valueSchemaSpecToJsonSchema(spillOutputSchema)
    const envelope = { spilled: true, locator: '/spill/x.txt', bytes: 4096, retrievalHint: 'read it' }
    // 6 个调用点的 fallback 都是 null；对象形态留给将来传真摘要的调用方。
    expect(validateJsonSchemaValue(schema, { ...envelope, summary: null })).toEqual([])
    expect(validateJsonSchemaValue(schema, { ...envelope, summary: { ok: true } })).toEqual([])
  })

  it('evaluate：1D 标量矩与 2D 逐 bin 矩都合法，且形状不混用', async () => {
    const { valueSchemaSpecToJsonSchema, validateJsonSchemaValue } = await dshTools()
    const evaluate = collect().find((d) => d.name === 'auto_pwa_evaluate')!
    const schema = valueSchemaSpecToJsonSchema(evaluate.output!.schema) as {
      properties: { distributions: { items: unknown } }
    }
    const item = schema.properties.distributions.items
    // 1D：标量 data/fit/delta —— 这条曾经因为 moments 没有 properties 而全挂。
    expect(validateJsonSchemaValue(item, { name: 'cosbeta0', moments: { '2': { data: 1, fit: 2, delta: -1 } } })).toEqual([])
    // 2D：逐质量 bin 的数组（可空 bin），单独放在 moments2d，与 massBins 对齐。
    expect(
      validateJsonSchemaValue(item, {
        name: 'dalitz0',
        moments2d: { '2': { data: [1.2, null], fit: [1.1, 2.0] }, '4': { data: [3], fit: [3.5] } },
        massBins: [1.0, null],
      }),
    ).toEqual([])
    // 负向对照：数组形态塞进标量 moments 必须被拒（否则两种形状会再次混用）。
    expect(
      validateJsonSchemaValue(item, { name: 'x', moments: { '2': { data: [1, 2], fit: [1, 2] } } }).length,
    ).toBeGreaterThan(0)
  })
})
