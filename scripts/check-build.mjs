#!/usr/bin/env node
/**
 * 构建新鲜度守门：`lib/` 是否比源码旧？
 *
 * 为什么需要：profile 是通过符号链接加载本仓库的，但 harness 实际 import 的是
 * **编译产物** `lib/`。实测踩过一次——`npm install`（链接）之后没重新编译，
 * 于是"装好了"却仍在跑旧代码（新特性全部不可见，查了才知道 lib 落后一小时）。
 *
 * 用法：`npm run check:build`（退出码 1 = 过期，需要 `npm run build`）
 */
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      walk(p, out)
    } else out.push(p)
  }
  return out
}

const sources = [...walk(join(root, 'src')), ...walk(join(root, 'plugin'))].filter((f) => f.endsWith('.ts'))
const libFiles = walk(join(root, 'lib')).filter((f) => f.endsWith('.js'))

if (sources.length === 0) {
  console.error('check-build: 找不到源码（src/ plugin/）')
  process.exit(2)
}
if (libFiles.length === 0) {
  console.error('check-build: ❌ lib/ 不存在或为空 → 先跑 `npm run build`')
  process.exit(1)
}

// 逐文件比对：src/x.ts ↔ lib/src/x.js、plugin/y.ts ↔ lib/plugin/y.js
const stale = []
for (const s of sources) {
  const rel = relative(root, s).replace(/\.ts$/, '.js')
  const target = join(root, 'lib', rel) // 产物在 lib/ 下，与 src|plugin 相对布局一致
  if (!existsSync(target)) {
    stale.push(`${rel}（产物缺失）`)
    continue
  }
  if (statSync(s).mtimeMs > statSync(target).mtimeMs + 1000) {
    stale.push(`${rel}（源 ${new Date(statSync(s).mtimeMs).toISOString()} > 产物 ${new Date(statSync(target).mtimeMs).toISOString()}）`)
  }
}

if (stale.length > 0) {
  console.error(`check-build: ❌ lib/ 比源码旧（${stale.length} 处）→ 必须跑 \`npm run build\` 再重启 harness：`)
  for (const x of stale.slice(0, 10)) console.error(`  - ${x}`)
  process.exit(1)
}
console.log(`check-build: ✅ lib/ 是最新的（${sources.length} 个源文件全部有更新的产物）`)
