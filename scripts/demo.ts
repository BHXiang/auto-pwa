/** Demo: what auto_pwa_decay_check answers for a real chain (run: npm run demo). */
import { decayCheck } from '../src/decay-check.js'
import { defaultDb } from '../src/db.js'

const jpsi = { j: 1, p: -1, mass: 3.0969 }
const kaon = { j: 0, p: -1, mass: 0.4937 }
const r = decayCheck(jpsi, kaon, defaultDb, { decayTo: ['K+', 'eta'] })

console.log('允许的中间态 J^P:', r.allowed.map((a) => `${a.jp.j}${a.jp.p > 0 ? '+' : '-'}`).join(', '))
const v1 = r.candidates.find((c) => c.jp.j === 1 && c.jp.p === -1)!
console.log('--- 1- 候选 (J/psi -> K + R, R -> K eta) ---')
for (const c of v1.resonances) {
  console.log(' ', c.entry.id.padEnd(14), '质量', c.entry.mass.toFixed(3), c.decaysTo ? '★ 列表含 K eta 衰变' : '')
}
