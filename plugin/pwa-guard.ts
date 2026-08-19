/**
 * pwa-guard：config.yml 写文件无人硬门禁（兜底硬规则，无需人工参与）。
 *
 * 机制：ctx.tools.guard 注册单调 deny 守卫——write/edit 直接写 config.yml、
 * bash 对 config.yml 的显式写（重定向/tee/sed -i）一律拒绝，理由指向
 * auto_pwa_edit_config。guard 只能 deny 不能放行，模型无法绕过；
 * 合法路径（auto_pwa_edit_config 内部用 node fs 原子写）不受影响。
 */
import { Context } from '@deepseek-ai/cordis'
import { configWriteGuard } from './pwa-utils.js'

export const name = 'pwa-guard'
export const inject = ['tools']

export function apply(ctx: Context): void {
  ctx.tools.guard?.(configWriteGuard)
}
