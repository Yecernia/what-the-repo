// Run from web: node scripts/generate-thinking-preview.mjs
// Generates a portable review artifact from the same labels and SVGs as the app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const bundle = await build({ stdin: {
  contents: `export * from './src/activity-presentation'; export * from './src/analysis-stage-catalog'; export * from './src/ActivityIcon'; export * from './src/ui-language'; export { Plus, X } from './src/HandIcons';`,
  resolveDir: root, loader: 'tsx',
}, bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react-dom/server'] });
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports);
const p = mod.exports;
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const svg = (name, size = 22) => renderToStaticMarkup(React.createElement(p.ActivityIcon, { name, size }));
const makeEvent = changes => ({ stage: 'run_started', label: '', status: 'running', elapsed_ms: 0, ...changes });
const bilingual = fn => ['zh-CN', 'en'].map(language => { p.setUiLanguage(language); return fn(); });
const text = pair => `<span data-zh="${esc(pair[0])}" data-en="${esc(pair[1])}">${esc(pair[0])}</span>`;
const label = (message, ...args) => bilingual(() => p.t(message, ...args));
const cards = [];
const add = (id, group, title, icon, rows, note = '') => cards.push({ id, group, title, icon, rows, note });
const row = (state, icon, pair, tone = '') => ({ state, icon, pair, tone });

const analysisTitles = {
  checking_existing: '检查已有结果', confirming_upstream: '检查仓库版本', reusing_snapshot: '复用已有分析',
  fetching_source: '获取仓库源码', comparing_versions: '比较版本差异', full_analysis: '扫描全部源码',
  incremental_analysis: '扫描变更源码', scanning: '扫描仓库结构', interpreting: '生成架构图',
  completed: '保存与完成分析', failed: '分析没有完成',
};
Object.keys(analysisTitles).forEach((kind, index) => {
  const e = makeEvent({ stage: `analysis:${kind}:1`, event_type: 'analysis_progress' });
  const icon = p.activityIconName(e, true);
  const rows = kind === 'failed'
    ? [row('未完成', icon, bilingual(() => p.analysisEventLabel({ ...e, status: 'failed' })), 'error')]
    : ['running', 'completed'].map(status => row(status === 'running' ? '进行中' : '完成后', icon, bilingual(() => p.analysisEventLabel({ ...e, status }))));
  add(`A${String(index + 1).padStart(2, '0')}`, 'analysis', analysisTitles[kind], icon, rows);
});

const legacyStages = { idle: '准备分析', fetching: '源码与已有结果', scanning: '仓库结构', extracting: '代码关系', clustering: '识别组件', interpreting: '生成架构图', done: '架构图已就绪', failed: '分析未完成' };
Object.entries(legacyStages).forEach(([stage, title], index) => {
  const e = makeEvent({ stage: `analysis:${stage}:running` });
  const icon = p.activityIconName(e, true);
  const statuses = stage === 'done' ? ['completed'] : stage === 'failed' ? ['failed'] : ['running','completed'];
  add(`B${String(index + 1).padStart(2, '0')}`, 'analysis', title, icon,
    statuses.map(status => row(status === 'failed' ? '未完成' : status === 'running' ? '进行中' : '完成后', icon, bilingual(() => p.analysisEventLabel({ ...e, status })), status === 'failed' ? 'error' : '')),
    '基础进度：分析只返回概括阶段时，会显示这一组。');
});
add('B09', 'analysis', '等待分析开始', 'wait', [row('排队中', 'wait', bilingual(() => p.analysisActivityLabel('idle', 'queued'))), row('已开始', 'wait', bilingual(() => p.analysisActivityLabel('idle', 'queued', true)))]);
add('B10', 'analysis', '其他分析步骤', 'inspect', [row('进行中', 'inspect', bilingual(() => p.analysisActivityLabel('unknown', null))), row('完成后', 'inspect', bilingual(() => p.analysisActivityLabel('unknown', null, true)))], '尚未对应到具体阶段时使用的兜底文案。');

const chat = {
  understanding: ['理解你的问题','run_started','understanding','正在理解问题'],
  context: ['回顾前面的对话','model_started','context','正在整理较早对话'],
  repository: ['翻阅仓库文件','tool_call_requested','tool','正在读取仓库文件'],
  evidence: ['寻找代码证据','tool_call_requested','tool','正在检索代码证据'],
  architecture: ['梳理代码关系','tool_call_requested','tool','正在查询组件关系'],
  planning: ['整理思路与回答','thinking_started','reasoning','正在整理思路'],
  answer: ['把结果讲给你','answer_started','answer','正在生成回答'],
  state: ['记录学习进度','tool_call_requested','tool','正在更新学习状态'],
  waiting: ['准备与连接','connected','waiting','正在等待'],
  analysis: ['其他代码检查','runtime','runtime','正在处理'],
};
Object.entries(chat).forEach(([phase, [title, stage, display_stage, raw]], index) => {
  const e = makeEvent({ stage, display_stage, label: raw });
  const icon = p.activityIconName(e);
  if (p.activityPhaseKey(e) !== phase) throw new Error(`Preview phase mismatch: ${phase}`);
  add(`C${String(index + 1).padStart(2, '0')}`, 'chat', title, icon,
    ['running','completed'].map(status => row(status === 'running' ? '进行中' : '完成后', icon, bilingual(() => p.activityPhaseLabel(phase, status)))),
    phase === 'planning' ? '组织回答、思路开始/结束、步骤完成和中间说明，当前归为同一条摘要。' : phase === 'evidence' ? '检索证据、一般项目查询和没有专门分类的工具调用会合并到这里。' : '');
});

const states = [
  ['请求取消', makeEvent({ stage: 'run_cancelling' }), '请求已发出，仍在等待本轮停止。'],
  ['已经取消', makeEvent({ stage: 'run_cancelled', status: 'cancelled' }), ''],
  ['查询未完成', makeEvent({ stage: 'tool_result_received', status: 'failed', kind: 'tool', tool_error: true }), '工具失败不会显示成“已找到相关代码”。'],
  ['回答未完成', makeEvent({ stage: 'run_failed', status: 'failed' }), ''],
  ['上一轮还在处理', makeEvent({ stage: 'run_failed', status: 'failed', label: '上一轮仍在处理' }), ''],
];
states.forEach(([title,e,note], index) => add(`D${String(index + 1).padStart(2, '0')}`, 'status', title, p.activityIconName(e),
  [row(e.status === 'failed' ? '未完成' : '状态', p.activityIconName(e), bilingual(() => p.activityStatusLabel(e)), e.status === 'failed' ? 'error' : '')], note));

const completion = [
  ['参考过文件','回答完成 · 参考 {0} 个文件',3], ['找到过关系','回答完成 · 找到 {0} 条关系',5],
  ['有代码查询','回答完成'], ['没有额外查询','已完成'],
];
const appSource = fs.readFileSync(path.join(root, 'src/App.tsx'),'utf8');
completion.forEach(([title,message,count], index) => {
  if (!appSource.includes(message)) throw new Error(`Completion copy changed: ${message}`);
  add(`E${String(index + 1).padStart(2,'0')}`, 'status', title, 'done', [row('收起后','done',label(message, count))], count ? '数字只作排版示例，实际按本轮引用统计。' : '最终回答下方的简短记录；完成后不展开过程。');
});
add('E05','chat','文件数量补充','search',[row('补充信息','search',label('已找到 {0} 个相关文件',3))], '数字只作排版示例；出现在查阅文件或查找代码的摘要旁。');
add('E06','chat','调用关系数量补充','relations',[row('补充信息','relations',label('已整理 {0} 条调用关系',5))], '数字只作排版示例；出现在整理关系的摘要旁。');

for (const stage of p.detailedAnalysisStages) {
  const event = makeEvent({ stage: `analysis:${stage.id}:1`, event_type: 'analysis_progress' });
  add(stage.reviewId, 'pipeline', stage.title, p.activityIconName(event, true),
    ['running','completed'].map(status => row(status === 'running' ? '进行中' : '完成后', stage.icon,
      bilingual(() => p.analysisEventLabel({ ...event, status })))), stage.description);
}
// Keep previous A–E identifiers unchanged so saved user comments remain attached.
cards.sort((a,b) => Number(b.group === 'pipeline') - Number(a.group === 'pipeline'));
const drawingCount = new Set(cards.map(card => card.icon)).size;

// Current fixed application copy must be available in both languages.
for (const card of cards) for (const r of card.rows) {
  if (/[\u3400-\u9fff]/u.test(r.pair[1])) throw new Error(`Missing English label in ${card.id}: ${r.pair[1]}`);
}

const cardHTML = c => `<article class="sample" data-group="${c.group}" data-search="${esc(c.id+' '+c.title+' '+c.rows.map(r=>r.pair.join(' ')).join(' '))}">
  <header><span class="number">${c.id}</span><h3>${esc(c.title)}</h3></header>${c.group === 'pipeline' ? '<span class="pending">描述与图标已备好 · 待后端传事件</span>' : ''}
  <div class="drawing">${svg(c.icon,72)}</div>
  <div class="actual">${c.rows.map(r=>`<div class="sample-row ${r.tone}"><small>${r.state}</small><div>${svg(r.icon)}${text(r.pair)}</div></div>`).join('')}</div>
  ${c.note ? `<p class="note">${esc(c.note)}</p>` : ''}
  <details class="feedback"><summary>记一句修改意见</summary><textarea aria-label="${c.id} 修改意见" placeholder="例如：图标太细 / 这句有点生硬" data-note="${c.id}"></textarea></details>
</article>`;
const plus = renderToStaticMarkup(React.createElement(p.Plus,{size:20}));
const close = renderToStaticMarkup(React.createElement(p.X,{size:20}));
const favicon = '<img width="16" height="16" alt="" src="data:image/svg+xml;base64,' + fs.readFileSync(path.join(root,'public/favicon-ink.svg')).toString('base64') + '" />';
const font = fs.readFileSync(path.join(root,'public/fonts/JasonHandwriting9p.ttf')).toString('base64');
const license = fs.readFileSync(path.join(root,'public/fonts/OFL-JasonHandwriting.txt'),'utf8');
const previewRows = (ids) => ids.map(id => { const c=cards.find(c=>c.id===id); const r=c.rows[0]; return `<div class="live-row">${svg(r.icon)}${text(r.pair)}</div>`; }).join('');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>思考摘要图鉴 · what-the-repo</title>
<style>
@font-face{font-family:'Jason Handwriting 9p';src:url(data:font/ttf;base64,${font}) format('truetype');font-weight:400;font-style:normal;font-display:swap}
:root{--bg:#f2ecdf;--paper:#faf6ea;--ink:#30332b;--muted:#686353;--green:#427952;--line:#b5ac97;--red:#ae4937;color-scheme:light}
:root.dark{--bg:#25271f;--paper:#303329;--ink:#eee8d5;--muted:#c0bba7;--green:#a5c69c;--line:#696e5b;--red:#efa78c;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 'Jason Handwriting 9p','Segoe UI','Microsoft YaHei',sans-serif;font-synthesis:none}button,input,textarea{font:inherit;color:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--green);outline-offset:4px}svg{flex:none;vertical-align:middle}main{max-width:1220px;margin:auto;padding:48px 30px 80px}.eyebrow{color:var(--green);letter-spacing:.07em}h1{font-size:42px;line-height:1.3;font-weight:400;margin:16px 0}h2{font-size:25px;font-weight:400;margin:0 0 20px}h3{font-size:18px;font-weight:400;margin:0}p{margin:10px 0}.intro{max-width:780px;color:var(--muted);font:14px/1.9 'Segoe UI','Microsoft YaHei',sans-serif}.toolbar{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:30px -10px;padding:14px 10px;background:var(--bg);border-bottom:1px solid var(--line)}button{padding:7px 14px;border:1px solid var(--line);border-radius:7px 5px 8px 4px;background:transparent;min-height:40px}button:hover,button[aria-pressed=true]{color:var(--green);border-color:var(--green)}.toolbar input{width:190px;margin-left:auto;padding:8px 12px;background:var(--paper);border:1px solid var(--line);border-radius:6px}.utility{display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin-bottom:25px}.tab-swatch{color-scheme:light;display:inline-flex;align-items:center;gap:8px;padding:9px 15px;border-radius:9px 9px 3px 3px;font:13px 'Segoe UI',sans-serif;color:#141611;background:#d8d8d8}.tab-swatch.blue{background:#3478ca}.tab-swatch.night{color-scheme:dark;background:#20252d;color:#eee}.symbol{position:relative;width:40px;height:40px;padding:0;border:0;display:inline-grid;place-items:center}.symbol::before{content:'';position:absolute;inset:0;background:currentColor;opacity:.65;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 40' preserveAspectRatio='none'%3E%3Cpath d='M4 3 Q24 1 50 2 T96 3 Q99 18 97 36 Q75 39 50 37 T3 37 Q1 20 4 3Z' fill='none' stroke='white' stroke-width='1.25' vector-effect='non-scaling-stroke'/%3E%3C/svg%3E") center/100% 100% no-repeat}.symbol.close:hover,.symbol.close:focus-visible{color:var(--red)}.examples{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:22px 0 36px}.live{padding:20px 24px;background:var(--paper);border:1px solid var(--line);border-radius:8px 13px 6px 10px}.live details>summary{cursor:pointer}.live-row{display:flex;gap:8px;align-items:center;font-size:14px;color:var(--green);margin:10px 0}.live small{display:block;color:var(--muted);font:12px/1.7 'Segoe UI','Microsoft YaHei',sans-serif}.live details .live-row{margin-left:18px}.catalog{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}.sample{position:relative;padding:20px 20px 16px;background:var(--paper);border:1px solid var(--line);border-radius:7px 11px 6px 9px;box-shadow:2px 3px 0 color-mix(in srgb,var(--line) 20%,transparent);min-width:0}.sample header{display:flex;gap:12px;align-items:baseline}.number{font:12px/1.3 'Segoe UI',sans-serif;color:var(--muted);letter-spacing:.06em}.drawing{height:113px;display:grid;place-items:center;color:var(--green)}.actual{border-top:1px dashed var(--line);padding-top:9px}.sample-row{margin:7px 0}.sample-row small{display:block;color:var(--muted);font:10px/1.6 'Segoe UI','Microsoft YaHei',sans-serif;margin-bottom:3px}.sample-row>div{display:flex;gap:8px;align-items:center;font-size:14px;line-height:1.65}.sample-row svg{color:var(--green)}.sample-row.error svg{color:var(--red)}.note{font:11px/1.75 'Segoe UI','Microsoft YaHei',sans-serif;color:var(--muted);margin:14px 0 8px}.feedback{margin-top:16px;padding-top:10px;border-top:1px solid color-mix(in srgb,var(--line) 40%,transparent);color:var(--muted);font:11px/1.6 'Segoe UI','Microsoft YaHei',sans-serif}.feedback summary{cursor:pointer}.feedback textarea{width:100%;min-height:75px;padding:8px;margin-top:8px;background:var(--bg);border:1px solid var(--line);border-radius:5px;font:13px/1.6 'Segoe UI','Microsoft YaHei',sans-serif}.export{margin:30px 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap}.export textarea{width:100%;min-height:100px;background:var(--paper);border:1px solid var(--line);padding:12px;font:13px/1.7 'Segoe UI','Microsoft YaHei',sans-serif}footer{margin-top:40px;color:var(--muted);font:12px/1.8 'Segoe UI','Microsoft YaHei',sans-serif}[hidden]{display:none!important}@media(max-width:950px){.catalog{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:620px){main{padding:25px 18px 50px}h1{font-size:32px}.catalog,.examples{grid-template-columns:1fr}.toolbar{gap:6px}.toolbar button{padding:5px 9px}.toolbar input{width:100%;margin-left:0}.sample{padding:20px}.utility{gap:8px}.tab-swatch{padding:8px 10px}}
.pending{display:inline-block;font:10px/1.7 'Segoe UI','Microsoft YaHei',sans-serif;color:var(--muted);margin-top:9px;border-bottom:1px dotted var(--line)}.pipeline-overview{margin:25px 0;padding:22px 24px;background:var(--paper);border:1px solid var(--line);border-radius:10px 6px 12px 7px}.pipeline-overview h2{margin-bottom:12px}.flow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding:0;list-style:none}.flow>li{padding:14px 12px;border:1px dashed var(--line);border-radius:6px}.flow small,.parallel-note{font:12px/1.8 'Segoe UI','Microsoft YaHei',sans-serif;color:var(--muted)}.flow small{display:block;margin-top:6px}.flow .branches{color:var(--green)}.review-changes{font:12px/1.8 'Segoe UI','Microsoft YaHei',sans-serif;color:var(--muted)}@media(max-width:760px){.flow{grid-template-columns:1fr 1fr}}@media(max-width:480px){.flow{grid-template-columns:1fr}}
</style>
<main><div class="eyebrow">what-the-repo · 图文校样 01</div><h1>思考摘要，一起过一遍。</h1>
<p class="intro">${cards.length} 种情况，${drawingCount} 张原创小画。上方看放大图，下方看页面里的 22px 小图与真实文案。中英文、进行中、完成和异常提示都在这里。可以直接告诉我编号，也可以先在卡片下面记意见，再汇总复制。</p>
<div class="toolbar"><button data-filter="all" aria-pressed="true">全部</button><button data-filter="pipeline" aria-pressed="false">完整流程 · 待接入</button><button data-filter="analysis" aria-pressed="false">现有分析进度</button><button data-filter="chat" aria-pressed="false">对话讲解</button><button data-filter="status" aria-pressed="false">结束与异常</button><button id="language" aria-pressed="false">English</button><button id="theme" aria-pressed="false">深色预览</button><input id="search" type="search" aria-label="搜索编号或文案" placeholder="搜编号、文案…"></div>
<section class="pipeline-overview"><h2>补齐后的完整分析流程</h2><p class="intro">核对了当前后端代码。F01–F18 是真实工作步骤的展示草案，前端已准备好对应文字和图标，后端目前尚未逐项发送。现有 A / B 进度继续保留；不会用计时器猜测正在执行哪一步。</p><ol class="flow"><li>① 静态读码<small>取源码与版本比较之后<br>F02 语法解析 → F03 调用识别 → F04 基础图谱</small></li><li>② 组件讲解<small>F05 模型分析各组件<br>必要时 F06 补全讲解</small></li><li>③ 两路并行<small class="branches">F07 架构归纳 → F09 架构组装<br>同时进行 F08 价值点挖掘</small></li><li>④ 汇合与保存<small>F10 整合结果 → F12 校验证据 → F13 保存就绪</small></li></ol><p class="parallel-note">F01 项目资料查询可以提前开始，和源码获取、静态分析重叠。F11 源码阅读材料在静态分析后准备，与模型分析并行，整合前等待完成。没有新版本时可直接复用已有结果。</p><p class="parallel-note">补充显示语言是另一条按需分支：F14 组件讲解 → F15 架构层 → F16 关系说明 → F17 价值点 → F18 保存语言版本。首次分析不生成完整学习路线；学习路线属于后续对话。</p><p class="review-changes">已按你的意见修改：A07 减号用红色；B01 完成后显示“准备分析”。原有编号和已填写的意见保留。</p></section><section aria-label="页签和设置图标"><h2>先看两个小改动</h2><div class="utility"><span class="tab-swatch">${favicon}what-the-repo</span><span class="tab-swatch blue">${favicon}what-the-repo</span><span class="tab-swatch night">${favicon}what-the-repo</span><button class="symbol" aria-label="添加 API 配置示意" title="加号悬停或键盘聚焦变绿">${plus}</button><button class="symbol close" aria-label="关闭设置示意" title="叉号悬停或键盘聚焦变红">${close}</button></div><p class="intro">页签保持透明底，跟随浏览器浅／深色主题自动使用黑／白线条，略微加粗。自定义页签底色不一定跟随主题。设置的两个符号加了细笔框；这里可以悬停或用 Tab 查看变色。</p></section>
<div class="examples"><section class="live"><small>实际组合 · 分析进行中（可展开）</small><details open><summary>${text(label('正在扫描变更源码'))}</summary>${previewRows(['A01','A02','A07'])}</details></section><section class="live"><small>实际组合 · 对话进行中（可展开）</small><details open><summary>${text(label('正在查找相关代码'))}</summary>${previewRows(['C01','C02','C04'])}</details></section></div>
<p class="intro" id="count">显示 ${cards.length} 项</p><div class="catalog">${cards.map(cardHTML).join('')}</div>
<div class="export"><button id="collect">汇总修改意见</button><span class="intro">填写的意见保存在这个浏览器本地。</span><textarea id="collected" aria-label="汇总后的修改意见" hidden readonly></textarea></div>
<footer>图标和阶段文案直接取自当前产品代码。F：核实后的完整流程，待后端接入；A：现有详细分析；B：基础分析进度；C：聊天阶段；D：中断与异常；E：最终统计与数量补充。<br>同类工具调用会合并成阶段摘要；答案正文、用量更新和内部连接标记不会另列为思考条目。暂停或失败的提示可能在本轮结束后由单独的对话提示接替。示例中的数字与组合用于排版，不代表发起了真实分析。<details><summary>字体许可：JasonHandwriting9p · SIL OFL</summary><pre style="white-space:pre-wrap">${esc(license)}</pre></details></footer></main>
<script>
let filter='all',english=false;const cards=[...document.querySelectorAll('.sample')];const storageKey='what-the-repo-thinking-review-01';
function update(){const query=document.querySelector('#search').value.toLowerCase();let count=0;cards.forEach(card=>{card.hidden=!(filter==='all'||card.dataset.group===filter)||!card.dataset.search.toLowerCase().includes(query);if(!card.hidden)count++});document.querySelector('#count').textContent='显示 '+count+' 项'}
document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));update()});
document.querySelector('#search').oninput=update;
document.querySelector('#language').onclick=function(){english=!english;this.setAttribute('aria-pressed',String(english));this.textContent=english?'中文':'English';document.querySelectorAll('[data-zh]').forEach(el=>el.textContent=el.dataset[english?'en':'zh'])};
document.querySelector('#theme').onclick=function(){const dark=document.documentElement.classList.toggle('dark');this.setAttribute('aria-pressed',String(dark));this.textContent=dark?'浅色预览':'深色预览'};
let notes={};try{notes=JSON.parse(localStorage.getItem(storageKey)||'{}')}catch{}document.querySelectorAll('[data-note]').forEach(input=>{input.value=notes[input.dataset.note]||'';input.oninput=()=>{notes[input.dataset.note]=input.value;try{localStorage.setItem(storageKey,JSON.stringify(notes))}catch{}}});
document.querySelector('#collect').onclick=()=>{const output=document.querySelector('#collected');output.value=Object.entries(notes).filter(([,value])=>value.trim()).map(([id,value])=>id+'：'+value.trim()).join(String.fromCharCode(10))||'还没有填写意见。';output.hidden=false;output.focus();output.select()};
</script></html>`;
const out = path.join(root,'.local/thinking-summaries.html');
fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,html);
console.log(`${cards.length} cases; ${drawingCount} drawings; bilingual labels verified.\n${out}`);
