import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { apply } from '../plugin/auto-pwa.js'

/**
 * 工具表面守门测试（工具规范化）。
 *
 * 这些不是实现细节测试，而是"表面契约"：数量、句式、长度、弃用状态、
 * 路由提示与参数命名约定。任何工具增删或描述改动都必须走这里，避免
 * 表面悄悄膨胀、出现职责重叠或新的"该用哪个"歧义。
 */

/** defineTool 的参数规范是扁平 map（不是 JSON-schema 的 properties 嵌套）。 */
interface ParamSpec {
  description?: string
  required?: boolean
}
interface Def {
  name: string
  description?: string
  parameters?: Record<string, ParamSpec>
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

/** 规范里冻结的工具清单（25 个）。增删工具必须同时更新此表与文档。 */
const EXPECTED_TOOLS = [
  'auto_pwa_lookup',
  'auto_pwa_decay_check',
  'auto_pwa_jpc_check',
  'auto_pwa_init_config',
  'auto_pwa_config_view',
  'auto_pwa_validate_config',
  'auto_pwa_suggest',
  'auto_pwa_validate_add',
  'auto_pwa_trans_suggest',
  'auto_pwa_edit_config',
  'auto_pwa_remove_resonance',
  'auto_pwa_iter_start',
  'auto_pwa_note',
  'auto_pwa_git_log',
  'auto_pwa_history',
  'auto_pwa_evaluate',
  'auto_pwa_diagnose',
  'auto_pwa_root_view',
  'auto_pwa_wave_view',
  'auto_pwa_run_fit',
  'auto_pwa_fit_status',
  'auto_pwa_try_candidates',
  'auto_pwa_compare',
  'auto_pwa_loop_next',
  'auto_pwa_loop_decide',
]

/** 已弃用工具：描述必须以 [已弃用 开头并给出替代者。 */
const DEPRECATED: string[] = []

/** 描述长度上限（规范值）。 */
const MAX_DESC = 200
/** 瘦身后：工具描述只写"做什么"，路由指导（用/不要用）统一放 skill 路由表。 */
const MAX_DESC_SLIM = 90
/** 参数描述长度上限。 */
const MAX_PARAM_DESC = 200

/** 必须互相点名的易混对（至少一个方向提到对方的裸名）。 */
const ROUTING_PAIRS: [string, string][] = [
  ['auto_pwa_run_fit', 'fit_status'],
  ['auto_pwa_run_fit', 'try_candidates'],
  ['auto_pwa_try_candidates', 'compare'],
  ['auto_pwa_validate_add', 'validate_config'],
  ['auto_pwa_edit_config', 'remove_resonance'],
  ['auto_pwa_edit_config', 'init_config'],
  ['auto_pwa_evaluate', 'diagnose'],
  ['auto_pwa_root_view', 'wave_view'],
  ['auto_pwa_git_log', 'history'],
  ['auto_pwa_diagnose', 'evaluate'],
]

/**
 * 允许"全部参数可选"的工具：语义是"至少给一个"（参数规范是精简 schema，
 * 表达不了 or）。新增全可选工具必须显式登记在这里。
 */
const ALL_OPTIONAL_OK = new Set(['auto_pwa_lookup', 'auto_pwa_validate_config', 'auto_pwa_loop_next'])

/** 全库唯一允许的弃用别名（规范名 -> 别名）。 */
const ALIASES: { tool: string; canonical: string; alias: string }[] = [
  { tool: 'auto_pwa_run_fit', canonical: 'configPath', alias: 'config' },
  { tool: 'auto_pwa_run_fit', canonical: 'timeoutMin', alias: 'timeoutMs' },
  { tool: 'auto_pwa_git_log', canonical: 'anyPath', alias: 'path' },
]

const bare = (name: string): string => name.replace(/^auto_pwa_/, '')

describe('工具表面契约（规范化守门）', () => {
  const defs = collect()
  const map = new Map(defs.map((d) => [d.name, d]))

  it('工具清单与冻结表一致（增删必须显式改这里 + 文档）', () => {
    expect(defs.map((d) => d.name).sort()).toEqual([...EXPECTED_TOOLS].sort())
    expect(defs).toHaveLength(EXPECTED_TOOLS.length)
  })

  it('每个工具都有描述且不超过长度上限', () => {
    for (const d of defs) {
      expect(d.description, d.name).toBeTruthy()
      expect(d.description!.length, `${d.name} 描述 ${d.description!.length} 字符`).toBeLessThanOrEqual(MAX_DESC)
    }
  })

  it('描述保持精简：路由指导（用/不要用）归 skill 路由表，不在描述里重复', () => {
    for (const d of defs) {
      if (DEPRECATED.includes(d.name)) continue
      expect(d.description, d.name).not.toContain('用：')
      expect(d.description, d.name).not.toContain('不要用')
      expect(d.description!.length, `${d.name} 描述 ${d.description!.length} 字符（上限 ${MAX_DESC_SLIM}）`).toBeLessThanOrEqual(MAX_DESC_SLIM)
    }
  })

  it('弃用工具以 [已弃用 开头并指向替代者；其它工具不得自称弃用', () => {
    for (const name of DEPRECATED) {
      const d = map.get(name)!
      expect(d, name).toBeTruthy()
      expect(d.description!.startsWith('[已弃用'), name).toBe(true)
      expect(['iterate', 'loop_decide'].some((alt) => d.description!.includes(alt)), `${name} 必须点名替代者`).toBe(true)
    }
    for (const d of defs) {
      if (!DEPRECATED.includes(d.name)) expect(d.description!.startsWith('[已弃用'), d.name).toBe(false)
    }
  })

  it('易混对在 skill 路由表里被区分（避免"该用哪个"歧义）', () => {
    // 路由指导从工具描述搬到了 skill（progressive disclosure）：这里守住"没丢"。
    const skill = readFileSync(new URL('../skills/auto-pwa-analysis/SKILL.md', import.meta.url), 'utf8')
    for (const [a, b] of ROUTING_PAIRS) {
      expect(skill.includes(bare(a)) || skill.includes(bare(b)), `${a} 与 ${b} 至少一方要出现在路由表`).toBe(true)
    }
  })

  it('全部非弃用工具出现在 skill 的工具索引里（描述瘦身不丢入口）', () => {
    const skill = readFileSync(new URL('../skills/auto-pwa-analysis/SKILL.md', import.meta.url), 'utf8')
    for (const d of defs) {
      if (DEPRECATED.includes(d.name)) continue
      expect(skill.includes(d.name), `${d.name} 未出现在 skill 工具索引`).toBe(true)
    }
  })

  it('描述里用裸名（不加 auto_pwa_ 前缀），保持路由提示短而一致', () => {
    for (const d of defs) expect(d.description!.includes('auto_pwa_'), d.name).toBe(false)
  })

  it('参数：camelCase、必有描述、长度受限', () => {
    for (const d of defs) {
      const params = Object.entries(d.parameters ?? {})
      expect(params.length, `${d.name} 没有参数`).toBeGreaterThan(0)
      for (const [p, spec] of params) {
        expect(p, d.name).toMatch(/^[a-z][A-Za-z0-9]*$/)
        expect(spec.description, `${d.name}.${p} 缺描述`).toBeTruthy()
        expect(spec.description!.length, `${d.name}.${p} 描述过长`).toBeLessThanOrEqual(MAX_PARAM_DESC)
      }
    }
  })

  it('全可选参数的工具必须显式登记（其语义是"至少给一个"）', () => {
    for (const d of defs) {
      const hasRequired = Object.values(d.parameters ?? {}).some((v) => v.required === true)
      if (!hasRequired) expect(ALL_OPTIONAL_OK.has(d.name), `${d.name} 无必填参数且未登记`).toBe(true)
    }
  })

  it('参数命名：路径类规范名 + 显式弃用别名，别名不得扩散', () => {
    for (const { tool, canonical, alias } of ALIASES) {
      const params = map.get(tool)!.parameters!
      expect(Object.keys(params), `${tool} 缺规范名 ${canonical}`).toContain(canonical)
      expect(Object.keys(params), `${tool} 缺别名 ${alias}`).toContain(alias)
      expect(params[alias]!.description, `${tool}.${alias} 必须标注已弃用`).toContain('[已弃用别名')
    }
    for (const d of defs) {
      if (ALIASES.some((a) => a.tool === d.name)) continue
      const keys = Object.keys(d.parameters ?? {})
      expect(keys, d.name).not.toContain('config')
      expect(keys, d.name).not.toContain('path')
    }
  })
})
