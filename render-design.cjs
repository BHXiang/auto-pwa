const fs = require('fs');
const path = require('path');
const MarkdownIt = require(path.join(__dirname, 'node_modules', 'markdown-it'));

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

const src = fs.readFileSync(path.join(__dirname, 'DESIGN.md'), 'utf8');
const body = md.render(src);

const css = `
:root { --fg:#1a1a2e; --muted:#5a5a72; --accent:#2563eb; --bg:#f7f7fb; --card:#ffffff; --line:#e3e3ee; --code-bg:#0f172a; --code-fg:#e2e8f0; }
* { box-sizing: border-box; }
body { margin:0; font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--fg); line-height:1.7; }
.wrap { max-width: 900px; margin: 0 auto; padding: 32px 24px 80px; }
header.doc-head { border-bottom: 2px solid var(--accent); padding-bottom: 12px; margin-bottom: 24px; }
header.doc-head .meta { color: var(--muted); font-size: 14px; }
h1 { font-size: 28px; margin: 0 0 6px; color: var(--fg); }
h2 { font-size: 22px; margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--accent); }
h3 { font-size: 17px; margin-top: 28px; color: var(--fg); }
h4 { font-size: 15px; margin-top: 20px; }
p, li { font-size: 15px; }
a { color: var(--accent); }
blockquote { margin: 16px 0; padding: 10px 16px; border-left: 4px solid var(--accent); background: #eef2ff; border-radius: 0 6px 6px 0; color:#334155; }
blockquote p { margin: 4px 0; }
code { background:#eef1f6; padding: 2px 6px; border-radius: 4px; font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 13px; }
pre { background: var(--code-bg); color: var(--code-fg); padding: 16px 20px; border-radius: 8px; overflow-x: auto; line-height: 1.55; }
pre code { background: transparent; padding: 0; color: inherit; font-size: 13px; }
table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; background: var(--card); box-shadow: 0 1px 3px rgba(0,0,0,.06); border-radius: 8px; overflow: hidden; }
th { background: #eef2ff; text-align: left; }
th, td { padding: 9px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: none; }
hr { border: none; border-top: 1px solid var(--line); margin: 28px 0; }
strong { color: var(--fg); }
ul, ol { padding-left: 24px; }
li { margin: 4px 0; }
@media print { body { background:#fff; } .wrap { max-width:none; } }
`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>auto-pwa 优化架构设计</title>
<style>${css}</style>
</head>
<body>
<div class="wrap">
<div class="doc-head">
<div class="meta">Design Doc v0.1 · 由 DESIGN.md 生成 · 生成时间 ${new Date().toLocaleString('zh-CN')}</div>
</div>
${body}
</div>
</body>
</html>`;

fs.writeFileSync(path.join(__dirname, 'DESIGN.html'), html);
console.log('written DESIGN.html, bytes:', Buffer.byteLength(html));
