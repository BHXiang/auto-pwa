/**
 * pwa-guard：init_config.yml 写文件无人硬门禁（兜底硬规则，无需人工参与）。
 *
 * 机制：ctx.tools.guard 注册单调 deny 守卫——write/edit 直接写 init_config.yml、
 * bash 对它的显式写（重定向/tee/sed -i）一律拒绝，理由指向
 * auto_pwa_init_config。guard 只能 deny 不能放行，模型无法绕过；
 * 合法路径（auto_pwa_init_config 内部用 node fs 原子写）不受影响。
 *
 * config.yml 不在守卫范围内：写时拦证明是错的关卡（盖不住变体 yml / 外部
 * Resonances include，还把系统检验堵死）。改由"跑前门禁 + provenance 记录"
 * 保证 —— 见 src/config-gate.ts、src/provenance.ts 与 auto_pwa_validate_config。
 */
import { Context } from '@deepseek-ai/cordis'
import { configWriteGuard } from './pwa-utils.js'

export const name = 'pwa-guard'
export const inject = ['tools']

export function apply(ctx: Context): void {
  ctx.tools.guard?.(configWriteGuard)
}
