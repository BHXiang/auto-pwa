/**
 * auto_pwa_report: render iteration records into human-readable HTML.
 *
 * The model writes STRUCTURED records (IterationRecord, one per iteration);
 * this module renders them into self-contained HTML pages (index + per-iter)
 * so the user can read the iteration diary in a browser. No model-written
 * HTML ever enters the output: every field is escaped, and notes use a small
 * markdown subset (headings/lists/bold/code) rendered deterministically.
 *
 * Pure functions; no I/O.
 */

export interface IterationRecord {
  /** Iteration number, e.g. 1. */
  iter: number
  /** ISO timestamp of the decision. */
  timestamp?: string
  /** Human-readable summary line, e.g. "添加 rho(1450) 到 R_KK [1-]". */
  title: string
  /** Decision category: added / removed / float / converged / other. */
  kind: 'added' | 'removed' | 'float' | 'converged' | 'other'
  /** The config.yml used for this iteration (path or relative name). */
  configPath?: string
  /** Best NLL of the fit. */
  nll?: number
  /** NLL change vs the previous iteration (positive = worse). */
  deltaNll?: number
  /** Fit directory (iterations/iter-N). */
  iterDir?: string
  /** Structured change list (from auto_pwa_edit_config.changed). */
  changes?: string[]
  /** Validation warnings seen before applying. */
  warnings?: string[]
  /** Free/float decision made this round. */
  floatDecision?: string
  /** Free-form notes (small markdown subset). */
  notes?: string[]
  /** Whether the Hessian of the best run was positive definite. */
  hessianPositive?: boolean
  /**
   * The model's conclusion of THIS round: quality judgement and what to try
   * next. Written by auto_pwa_note, read by auto_pwa_history — this is the channel
   * that carries the fit conclusion into the next iteration.
   */
  conclusion?: string
  /** Next-iteration plan (e.g. "加 f2(2300) 到 R_KK [2+] 并 float 质量"). */
  nextPlan?: string
  /** Evidence references, e.g. evaluate.json path. */
  evidence?: string
  /** Token usage of this round (token-meter delta since the previous note). */
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  /** Hypothesis of THIS round (what the change should achieve, in physics
   * terms). Written by auto_pwa_note / auto_pwa_loop_decide. */
  hypothesis?: string
  /** Structured, checkable prediction of the hypothesis (verified by the
   * loop after the next fit completes). */
  prediction?: {
    metric: 'maxPull' | 'deltaNll' | 'regionPull'
    region?: [number, number]
    threshold: number
    direction: 'below' | 'above'
  }
  /** Verification result of the PREVIOUS round's prediction (filled by
   * auto_pwa_loop_next when the new fit is evaluated). */
  verification?: {
    passed: boolean
    actual: number | null
    note: string
  }
}

// ---------------------------------------------------------------------------
// markdown subset rendering
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Render one note line: minimal md — bold, inline code, links are plain text. */
function renderNoteLine(line: string): string {
  let out = escapeHtml(line)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  return out
}

/** Render a note block (list of lines) with heading/list/code handling. */
export function renderNotes(notes: string[] | undefined): string {
  if (!notes || notes.length === 0) return '<p class="muted">（无）</p>'
  const parts: string[] = []
  let inCode = false
  let codeBuf: string[] = []
  for (const raw of notes) {
    if (raw.startsWith('```')) {
      if (inCode) {
        parts.push(`<pre>${escapeHtml(codeBuf.join('\n'))}</pre>`)
        codeBuf = []
        inCode = false
      } else {
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeBuf.push(raw)
      continue
    }
    if (raw.startsWith('## ')) parts.push(`<h3>${renderNoteLine(raw.slice(3))}</h3>`)
    else if (raw.startsWith('# ')) parts.push(`<h2>${renderNoteLine(raw.slice(2))}</h2>`)
    else if (raw.startsWith('- ')) parts.push(`<li>${renderNoteLine(raw.slice(2))}</li>`)
    else if (raw.trim() === '') parts.push('')
    else parts.push(`<p>${renderNoteLine(raw)}</p>`)
  }
  if (inCode) parts.push(`<pre>${escapeHtml(codeBuf.join('\n'))}</pre>`)
  // Wrap consecutive <li> into <ul>.
  const html = parts.join('\n')
  return html.replace(/(<li>[\s\S]*?<\/li>)(\s*(?=<li>)|$)/g, '<ul>$1</ul>')
}

// ---------------------------------------------------------------------------
// page chrome
// ---------------------------------------------------------------------------

const CSS = `
:root { --bg:#fafaf8; --fg:#1c1c1a; --muted:#6b6b64; --line:#e3e3dd; --accent:#1a6e5c;
        --accent-bg:#e9f4f0; --warn:#a05a12; --warn-bg:#fdf3e5; --bad:#a03028; --bad-bg:#fbeae8;
        --code-bg:#f1f1ec; }
* { box-sizing: border-box; }
body { background:var(--bg); color:var(--fg); font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
       line-height:1.7; margin:0; padding:0 0 80px; }
.wrap { max-width:920px; margin:0 auto; padding:0 24px; }
header { border-bottom:1px solid var(--line); padding:28px 0 16px; margin-bottom:20px; }
h1 { font-size:1.6em; margin:0 0 6px; } h2 { font-size:1.3em; margin:28px 0 10px; }
h3 { font-size:1.05em; margin:18px 0 6px; }
.sub { color:var(--muted); font-size:.95em; }
.badge { display:inline-block; background:var(--accent-bg); color:var(--accent); border-radius:4px;
         padding:1px 8px; font-size:.82em; margin-right:6px; }
.badge.warn { background:var(--warn-bg); color:var(--warn); }
.badge.bad { background:var(--bad-bg); color:var(--bad); }
table { border-collapse:collapse; width:100%; font-size:.9em; margin:12px 0; }
th,td { border:1px solid var(--line); padding:7px 10px; text-align:left; vertical-align:top; }
th { background:var(--code-bg); font-weight:600; white-space:nowrap; }
code { font-family:"JetBrains Mono","Consolas",monospace; font-size:.9em; background:var(--code-bg);
       padding:1px 5px; border-radius:3px; }
pre { background:var(--code-bg); border:1px solid var(--line); border-radius:6px; padding:10px 14px;
      overflow-x:auto; font-size:.85em; line-height:1.5; }
ul { padding-left:22px; } li { margin:3px 0; }
.nll { font-variant-numeric:tabular-nums; font-weight:600; }
.delta.good { color:var(--accent); } .delta.bad { color:var(--bad); }
.muted { color:var(--muted); }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
.kv { display:grid; grid-template-columns:160px 1fr; gap:4px 14px; margin:10px 0; font-size:.95em; }
.kv dt { color:var(--muted); } .kv dd { margin:0; }
.conclusion { background:var(--accent-bg); border-left:3px solid var(--accent); padding:8px 14px;
              border-radius:0 6px 6px 0; font-size:.95em; margin:8px 0; }
.nextplan { background:var(--warn-bg); border-left:3px solid var(--warn); padding:8px 14px;
            border-radius:0 6px 6px 0; font-size:.95em; margin:8px 0; }
`

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="sub">auto-pwa 迭代日记 · 程序生成，仅作阅读 · 数据源: iterations/SUMMARY.jsonl</div>
</header>
${body}
</div>
</body>
</html>`
}

const fmt = (n: number | undefined, digits = 2): string => (n === undefined ? '—' : n.toFixed(digits))

const KIND_LABEL: Record<IterationRecord['kind'], string> = {
  added: '加共振态',
  removed: '删共振态',
  float: '调参数',
  converged: '收敛',
  other: '其他',
}

// ---------------------------------------------------------------------------
// index page
// ---------------------------------------------------------------------------

/** Render iterations/index.html: one row per iteration, newest last. */
export function renderIndex(records: IterationRecord[]): string {
  const sorted = [...records].sort((a, b) => a.iter - b.iter)
  const rows = sorted
    .map((r) => {
      const delta =
        r.deltaNll === undefined
          ? '<span class="muted">—</span>'
          : `<span class="delta ${r.deltaNll <= 0 ? 'good' : 'bad'}">${r.deltaNll > 0 ? '+' : ''}${fmt(r.deltaNll)}</span>`
      const nll = r.nll === undefined ? '<span class="muted">—</span>' : `<span class="nll">${fmt(r.nll)}</span>`
      const hessian =
        r.hessianPositive === undefined
          ? '<span class="muted">—</span>'
          : r.hessianPositive
            ? '<span class="badge">正定</span>'
            : '<span class="badge bad">不正定</span>'
      const link = r.iterDir
        ? `<a href="iter-${String(r.iter).padStart(3, '0')}/report.html">${escapeHtml(r.title)}</a>`
        : escapeHtml(r.title)
      return `<tr><td>${r.iter}</td><td>${link}</td><td><span class="badge">${KIND_LABEL[r.kind]}</span></td><td>${nll}</td><td>${delta}</td><td>${hessian}</td></tr>`
    })
    .join('\n')
  const body = `
<h2>迭代总览</h2>
<table>
<tr><th>轮</th><th>决策</th><th>类型</th><th>最佳 NLL</th><th>ΔNLL</th><th>Hessian</th></tr>
${rows}
</table>
<p class="muted">共 ${sorted.length} 轮。ΔNLL &lt; 10 的新增共振态不显著（√(2ΔNLL) &lt; 4.5σ），应考虑移除或换方案。</p>`
  return page(`分波迭代日记 · 共 ${sorted.length} 轮`, body)
}

// ---------------------------------------------------------------------------
// per-iteration page
// ---------------------------------------------------------------------------

/** Render iterations/iter-N/report.html: one iteration in detail. */
export function renderReport(record: IterationRecord): string {
  const parts: string[] = []
  parts.push(`<h2>第 ${record.iter} 轮 · ${KIND_LABEL[record.kind]}</h2>`)
  parts.push(`<p>${escapeHtml(record.title)}</p>`)
  parts.push('<dl class="kv">')
  parts.push(`<dt>时间</dt><dd>${escapeHtml(record.timestamp ?? '—')}</dd>`)
  parts.push(`<dt>配置</dt><dd><code>${escapeHtml(record.configPath ?? '—')}</code></dd>`)
  if (record.iterDir) parts.push(`<dt>迭代目录</dt><dd><code>${escapeHtml(record.iterDir)}</code></dd>`)
  parts.push(`<dt>最佳 NLL</dt><dd><span class="nll">${fmt(record.nll)}</span></dd>`)
  parts.push(
    `<dt>ΔNLL</dt><dd>${record.deltaNll === undefined ? '<span class="muted">—</span>' : `<span class="delta ${record.deltaNll <= 0 ? 'good' : 'bad'}">${record.deltaNll > 0 ? '+' : ''}${fmt(record.deltaNll)}</span>`}</dd>`,
  )
  if (record.hessianPositive !== undefined) {
    parts.push(`<dt>Hessian</dt><dd>${record.hessianPositive ? '<span class="badge">正定</span> 参数误差可信' : '<span class="badge bad">不正定</span> 参数误差不可靠'}</dd>`)
  }
  if (record.tokens !== undefined) {
    const t = record.tokens
    const cached = (t.cacheRead ?? 0) + (t.cacheWrite ?? 0)
    parts.push(`<dt>本轮 token</dt><dd>输入 ${t.input} + 输出 ${t.output}${cached > 0 ? `（缓存 ${cached}）` : ''}</dd>`)
  }
  parts.push('</dl>')

  if (record.changes && record.changes.length > 0) {
    parts.push('<h3>变更</h3><ul>')
    parts.push(...record.changes.map((c) => `<li><code>${escapeHtml(c)}</code></li>`))
    parts.push('</ul>')
  }
  if (record.warnings && record.warnings.length > 0) {
    parts.push('<h3>验证警告</h3><ul>')
    parts.push(...record.warnings.map((w) => `<li class="muted">${renderNoteLine(w)}</li>`))
    parts.push('</ul>')
  }
  if (record.floatDecision) {
    parts.push(`<h3>参数 float 决策</h3><p>${renderNoteLine(record.floatDecision)}</p>`)
  }
  if (record.evidence) {
    parts.push(`<h3>证据</h3><p><code>${escapeHtml(record.evidence)}</code></p>`)
  }
  if (record.conclusion) {
    parts.push(`<h3>本轮结论</h3><div class="conclusion">${renderNotes(record.conclusion.split('\n'))}</div>`)
  }
  if (record.nextPlan) {
    parts.push(`<h3>下一步计划</h3><div class="nextplan">${renderNotes(record.nextPlan.split('\n'))}</div>`)
  }
  parts.push('<h3>笔记</h3>')
  parts.push(renderNotes(record.notes))
  parts.push('<p><a href="../index.html">← 返回总览</a></p>')
  return page(`第 ${record.iter} 轮 · ${record.title}`, parts.join('\n'))
}

/** Render both pages and return { indexHtml, reportHtml }. */
export function renderIterationDiary(records: IterationRecord[]): { indexHtml: string; reportHtml: Record<string, string> } {
  const indexHtml = renderIndex(records)
  const reportHtml: Record<string, string> = {}
  for (const r of records) reportHtml[String(r.iter)] = renderReport(r)
  return { indexHtml, reportHtml }
}
