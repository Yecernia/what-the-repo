// Generate a portable visual review without starting a conversation or mocking an API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { Script } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const bundle = await build({ stdin: {
  contents: `export * from './src/ConversationFeedback'; export * from './src/ActivityIcon'; export * from './src/activity-presentation'; export * from './src/ui-language'; export { conversationErrorMessage } from './src/api'; export { X, ChevronRight } from './src/HandIcons';`,
  resolveDir: root, loader: 'tsx',
}, bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
external: ['react', 'react-dom/server'], define: { 'import.meta.env.VITE_API_BASE_URL': '""' } });
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports);
const p = mod.exports;
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const render = (component, props = {}) => renderToStaticMarkup(React.createElement(component, props));
const icon = (name, size = 22) => render(p.ActivityIcon, { name, size, className: size === 22 ? 'activity-step-icon' : '' });
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
const text = (zh, en) => p.getUiLanguage() === 'en' ? en : zh;
const bi = fn => ['zh-CN', 'en'].map(locale => { p.setUiLanguage(locale); return `<div data-language="${locale}">${fn()}</div>`; }).join('');
const noop = () => {};
const cards = [];
function card(id, title, note, body, wide = false) {
  cards.push(`<article class="sample${wide ? ' wide' : ''}" id="${id}"><header><span class="card-id">${id}</span><h2>${esc(title)}</h2></header><p class="review-note">${esc(note)}</p>${bi(body)}<label class="feedback-label">这项的意见<textarea class="feedback" data-note="${id}" rows="2" placeholder="例如：图标太复杂 / 文案拥挤 / 保持现在这样"></textarea></label></article>`);
}
function summary(name, label, { status = 'running', detail, open = false } = {}) {
  const contents = `${render(p.ChevronRight, { size: 13, 'aria-hidden': true })}${icon(name)}<span>${esc(label)}</span>`;
  return `<div class="conversation-activity" data-status="${status}">${detail ? `<details${open ? ' open' : ''}><summary class="activity-toggle">${contents}</summary><div class="activity-history"><div class="activity-step ${status}">${icon(status === 'failed' ? 'warning' : name)}<div class="activity-step-body"><div class="activity-step-heading"><span>${esc(detail)}</span></div></div></div></details>` : `<div class="activity-summary"><div class="activity-toggle activity-toggle-static">${icon(name)}<span>${esc(label)}</span></div></div>`}</div>`;
}
const error = code => render(p.ConversationErrorNotice, { text: p.conversationErrorMessage(code) });
const partial = () => `<p class="answer-example">${text('这里已经输出的回答会保留下来。你仍然可以阅读这一段，再决定是否重新发送。', 'The answer received so far stays here. You can read it before deciding whether to resend.')}</p>`;
const actions = () => render(p.LastMessageActions, { onEdit: noop, onResend: noop });
const question = () => text('请讲一下这个文件的主要职责。', 'Explain the main responsibility of this file.');

card('I01', '新增图标 · 放大与实际尺寸', '五张新图；最后是已有的取消图标，供你比较是否协调。', () => `<div class="icon-grid">${[
  ['reconnect','接回聊天流','Reconnect'], ['retry','分析重试','Retry analysis'], ['failure','回答失败','Answer failed'],
  ['revise','编辑原问题','Edit question'], ['resend','原文重发','Resend'], ['stop','已取消','Cancelled'],
].map(([name,zh,en]) => `<div class="icon-tile"><div class="large-icon${name === 'failure' ? ' danger' : ''}">${icon(name,64)}</div><div class="actual-icon">${icon(name,20)}<span>${esc(text(zh,en))}</span></div></div>`).join('')}</div>`, true);

card('S01', '浏览器重连', '接回同一次回答，不重新请求模型。次数来自事件；这里并列展示1/5至5/5，仅作排版样例。', () => [1,2,3,4,5].map(attempt => {
  const event = {stage:'reconnecting',status:'running',label:p.t('正在重新连接（{0}/{1}）',attempt,5)};
  return summary(p.activityIconName(event), p.activityStatusLabel(event));
}).join(''));
card('S02', '分析自动恢复', '首次尝试之外最多再试2次。与聊天的5次重连分开；没有新增自动重试策略。', () => [1,2].map(attempt => {
  const event = {stage:'provider_retry',status:'running',label:`${p.t('上游连接中断')}，${p.t('正在重试（{0}/{1}）',attempt,2)}`};
  return summary(p.activityIconName(event,true), p.activityStatusLabel(event));
}).join(''));
card('S03', '本次回答失败 · 已有部分正文', '点击“回答失败”可收起/展开原因。底部淡色提示是本次临时状态。', () => summary('failure',p.t('回答失败'),{status:'failed',detail:p.conversationErrorMessage('provider_connection_failed'),open:true}) + partial() + error('provider_connection_failed'));
card('S04', '刷新后 · 失败记录', '失败摘要和已有正文仍在；底部临时错误条不会重现。', () => summary('failure',p.t('回答失败'),{status:'failed',detail:p.conversationErrorMessage('provider_connection_failed')}) + partial());
card('S05', '主动取消', '保留正文，摘要可以展开；不出现红色失败条。', () => summary('stop',p.t('已取消'),{status:'cancelled',detail:p.t('本轮回答已取消。'),open:true}) + partial());
card('S06', '尚未输出正文就失败', '没有空白气泡或伪造回答，只显示失败摘要和本次错误提示。', () => summary('failure',p.t('回答失败'),{status:'failed',detail:p.conversationErrorMessage('provider_timeout')}) + error('provider_timeout'));
card('S07', '分析最终失败', '继续展示后端安全分类原因；这里是终态，不显示重试计数或完成图标。', () => summary('warning',p.conversationErrorMessage('provider_connection_failed'),{status:'failed'}));
card('S08', '重连恢复成功', '重连恢复且完成回答后才显示完成。', () => summary('done',p.t('回答完成'),{status:'completed'}));

card('A01', '最后一条消息 · 编辑 / 原文重发', '按钮常驻，支持键盘。这里点编辑可试取消；重新发送只展示效果，不发出请求。', () => `<div class="edit-demo"><div class="user-example">${esc(question())}</div>${actions()}<div class="editor-example" hidden>${render(p.MessageEditNotice,{onCancel:noop})}<textarea class="demo-input" aria-label="${esc(text('编辑消息预览','Edit message preview'))}">${esc(question())}</textarea><button class="preview-button apply-edit">${esc(text('发送修改（仅预览）','Send edit (preview only)'))}</button></div><p class="demo-result" aria-live="polite"></p></div>`,true);
card('A02', '编辑模式 · 输入框上方', '继续使用原输入框；铅笔与文字标明状态，取消编辑不带纸片边框，悬停/聚焦变红。', () => `<div class="edit-demo">${render(p.MessageEditNotice,{onCancel:noop})}<textarea class="demo-input" aria-label="${esc(text('编辑内容示例','Example edited message'))}">${esc(question())}</textarea><p class="demo-result" aria-live="polite"></p></div>`,true);
card('A03', '生成中与较早消息', '较早消息不显示编辑/重发；生成中先取消，再编辑。这里是只读状态样例。', () => `<div class="user-example">${esc(question())}</div>${summary('speak',p.t('正在回答'))}<div class="preview-generating"><button class="message-action preview-cancel">${render(p.X,{size:20,'aria-hidden':true})}<span>${esc(p.t('取消本轮回答'))}</span></button><span class="demo-result" aria-live="polite"></span></div>`);

// Use actual app error mapping; do not maintain a second set of error sentences.
const apiSource = fs.readFileSync(path.join(root,'src/api.ts'),'utf8');
const errorMapping = apiSource.slice(apiSource.indexOf('export function conversationErrorMessage'),apiSource.indexOf('/** Convert unknown transport/API errors'));
const codes = [...errorMapping.matchAll(/^\s+([a-z_]+): '/gm)].map(match => match[1]).filter(code => !['internal_error','cancelled'].includes(code));
const errorTitles = {
  provider_balance_insufficient:'余额不足', provider_authentication_failed:'API Key 无效', provider_permission_denied:'调用权限不足',
  provider_rate_limited:'请求过多', provider_busy:'上游繁忙', provider_timeout:'上游超时', provider_connection_failed:'上游连接中断',
  provider_request_failed:'其他已知上游错误', provider_invalid_response:'上游返回空回答', provider_transient_error:'上游连接失败',
  provider_budget_exceeded:'本站用量上限', provider_unavailable:'免费配置 / 上游暂不可用', provider_key_required:'尚未添加 Key',
  server_error:'服务端错误', last_message_changed:'末条消息已变化', session_busy:'上一轮仍在处理', client_network_error:'浏览器网络错误',
};
codes.forEach((code,index) => card(`E${String(index+1).padStart(2,'0')}`, errorTitles[code] ?? code, '以下文案直接读取现有安全错误映射；图标与提示条复用产品组件。', () => error(code)));
card('E99','无法识别的错误 · 兜底','不显示原始上游响应、堆栈或内部信息。',()=>render(p.ConversationErrorNotice,{text:p.t('请求未能完成，请稍后重试。')}));

const css = fs.readFileSync(path.join(root,'src/index.css'),'utf8');
const themeCss = [...css.matchAll(/:root(?:\[data-theme="dark"\])?\s*\{[^}]*\}/g)].map(match=>match[0]).join('\n');
const activityCss = css.slice(css.indexOf('.conversation-activity {'),css.indexOf('.placeholder-notice {'));
const feedbackCss = css.slice(css.indexOf('.conversation-activity[data-status="failed"]'));
const font = fs.readFileSync(path.join(root,'public/fonts/JasonHandwriting9p.ttf')).toString('base64');
const license = fs.readFileSync(path.join(root,'public/fonts/OFL-JasonHandwriting.txt'),'utf8');
const html = `<!doctype html><html lang="zh-CN" data-locale="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>聊天反馈审图 · what-the-repo</title><style>
@font-face{font-family:'Jason Handwriting 9p';src:url(data:font/ttf;base64,${font}) format('truetype');font-weight:400;font-display:swap}
${themeCss}\n${activityCss}\n${feedbackCss}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 var(--font-reading)}main{max-width:1140px;margin:auto;padding:40px 24px 80px}h1{font:38px/1.4 var(--font-display);margin:8px 0 12px}h2{font:20px/1.4 var(--font-display);margin:0}.eyebrow{color:var(--accent);font:17px var(--font-display)}.intro{max-width:820px;color:var(--fg-muted)}.toolbar{position:sticky;top:0;z-index:2;padding:12px 0;display:flex;gap:10px;flex-wrap:wrap;background:var(--bg);border-bottom:1px solid var(--border);margin:24px 0}.preview-button{border:1px solid var(--border-strong);border-radius:8px;background:var(--panel);color:var(--fg);padding:8px 13px;font:14px var(--font-reading);cursor:pointer;min-height:44px}.preview-button:hover{color:var(--accent);border-color:var(--accent)}button:focus-visible,summary:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.catalog{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.sample{min-width:0;padding:22px;background:var(--panel);border:1px solid var(--border);border-radius:11px 15px 10px 13px}.sample.wide{grid-column:1/-1}.sample header{display:flex;align-items:baseline;gap:12px}.card-id{color:var(--accent);font:12px var(--font-reading)}.review-note{color:var(--fg-muted);font-size:12px;margin:12px 0 22px}.feedback-label{display:block;border-top:1px dashed var(--border);margin-top:22px;padding-top:12px;color:var(--fg-muted);font-size:12px}.feedback{display:block;width:100%;resize:vertical;margin-top:6px;border:1px solid var(--border);border-radius:6px;background:var(--control-bg);color:var(--fg);font:13px/1.6 var(--font-reading);padding:8px}.icon-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:18px}.large-icon{color:var(--accent);padding:18px;text-align:center}.large-icon.danger{color:var(--err)}.actual-icon{display:flex;justify-content:center;align-items:center;gap:7px;font:14px/1.5 var(--font-display)}.actual-icon svg{flex:none}.answer-example{font:15px/1.8 var(--font-reading);margin:18px 0}.user-example{max-width:90%;margin-left:auto;border-radius:12px 10px 7px 12px;background:var(--user-bubble);padding:12px 16px}.demo-input{display:block;width:100%;min-height:84px;padding:15px;background:var(--paper-base);border:1px solid var(--border-strong);border-radius:9px 14px 10px 12px;color:var(--fg);font:15px/1.7 var(--font-reading);resize:vertical}.demo-result{font-size:13px;color:var(--accent);min-height:1.7em}.preview-generating{display:flex;gap:12px;align-items:center}.conversation-activity{margin:12px 0}.activity-toggle{min-height:36px}.activity-toggle>span:last-child{white-space:normal;overflow-wrap:anywhere}.activity-toggle::-webkit-details-marker{display:none}summary{list-style:none}details[open]>summary>.hand-icon{transform:rotate(90deg)}.activity-step-icon{flex-shrink:0}[data-language]{display:none}[data-locale="zh-CN"] [data-language="zh-CN"],[data-locale="en"] [data-language="en"]{display:block}[hidden]{display:none!important}#notes-output{width:100%;min-height:150px;margin-top:12px;background:var(--panel);color:var(--fg);font:14px/1.7 var(--font-reading)}footer{margin-top:32px;color:var(--fg-muted);font-size:12px}@media(max-width:700px){main{padding:24px 14px}.catalog{grid-template-columns:1fr}.sample{padding:18px}.icon-grid{grid-template-columns:repeat(2,1fr)}}
</style></head><body><main><div class="eyebrow">what-the-repo / 新增反馈审图</div><h1>出错时，也能看得明白</h1><p class="intro">共${cards.length}项：图标、过程摘要、编辑入口与全部安全错误提示。图标及错误/编辑控件来自产品源码；情境、次数和正文为展示样例，不会调用API或模型。可以按编号留意见，底部汇总后直接复制给我。</p><div class="toolbar"><button class="preview-button" id="language">切换到 English</button><button class="preview-button" id="theme">切换深浅色</button><button class="preview-button" id="export">汇总我的意见</button></div><section class="catalog">${cards.join('')}</section><section id="notes-panel" hidden><h2>意见汇总</h2><textarea id="notes-output" readonly></textarea></section><footer>本页仅供视觉审阅。确认后再做最小功能测试。意见尝试保存在本浏览器；浏览器禁止本地存储时请使用“汇总我的意见”复制保存。<details><summary>字体许可 · OFL</summary><pre style="white-space:pre-wrap">${esc(license)}</pre></details></footer></main><script>
const root=document.documentElement,storageKey='wtr-conversation-feedback-review-v1';let notes={};try{notes=JSON.parse(localStorage.getItem(storageKey)||'{}')}catch{}
document.querySelectorAll('[data-note]').forEach(el=>{el.value=notes[el.dataset.note]||'';el.addEventListener('input',()=>{notes[el.dataset.note]=el.value;try{localStorage.setItem(storageKey,JSON.stringify(notes))}catch{}})});
document.getElementById('language').onclick=e=>{const en=root.dataset.locale!=='en';root.dataset.locale=en?'en':'zh-CN';root.lang=root.dataset.locale;e.target.textContent=en?'切换到简体中文':'切换到 English'};
document.getElementById('theme').onclick=()=>{root.dataset.theme=root.dataset.theme==='dark'?'light':'dark'};
document.getElementById('export').onclick=()=>{const out=document.getElementById('notes-output');out.value=Object.entries(notes).filter(([,v])=>v.trim()).map(([id,v])=>id+'：'+v).join('\\n\\n')||'尚未填写意见。';document.getElementById('notes-panel').hidden=false;out.focus();out.select();out.scrollIntoView({behavior:'smooth',block:'center'})};
document.querySelectorAll('.edit-demo').forEach(demo=>{const actions=demo.querySelector('.last-message-actions'),editor=demo.querySelector('.editor-example'),input=demo.querySelector('textarea'),result=demo.querySelector('.demo-result');const say=(zh,en)=>{result.textContent=root.dataset.locale==='en'?en:zh};if(actions){actions.children[0].onclick=()=>{editor.hidden=false;actions.hidden=true;input.focus()};actions.children[1].onclick=()=>say('原文重发预览：使用同一条消息位置。这里没有发送请求。','Resend preview: reuse this message position. No request was sent.')}demo.querySelector('.cancel-edit').onclick=()=>{if(editor){editor.hidden=true;actions.hidden=false;input.value=demo.querySelector('.user-example').textContent}say('已退出编辑预览。','Edit preview closed.')};const apply=demo.querySelector('.apply-edit');if(apply)apply.onclick=()=>{demo.querySelector('.user-example').textContent=input.value;editor.hidden=true;actions.hidden=false;say('已更新这一条示例问题，没有追加消息或请求模型。','This example question was replaced. No message was appended or model called.')}});
document.querySelectorAll('.preview-cancel').forEach(button=>button.onclick=()=>{button.nextElementSibling.textContent=root.dataset.locale==='en'?'Cancel preview only; no running request.':'这里只展示取消入口，没有正在运行的请求。'});
</script></body></html>`;
const output = path.join(root,'.local/conversation-feedback.html');
fs.mkdirSync(path.dirname(output),{recursive:true});
new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1], { filename: 'conversation-feedback-inline.js' });
fs.writeFileSync(output,html);
console.log(`${cards.length} review items written to ${output}`);
