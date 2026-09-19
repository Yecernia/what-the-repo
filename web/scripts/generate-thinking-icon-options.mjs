// Generate an isolated review sheet; no production icon is replaced.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Script } from 'node:vm';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const bundle=await build({entryPoints:[path.join(root,'src/pen-path.ts')],bundle:true,write:false,format:'esm',platform:'node'});
const {penPath}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const stroke=(p,closed=false,w=1.7)=>({p,closed,w});
const items=[
 ['T01','茶芽','一个念头，慢慢长出来。',[
 stroke([[16,28,.9],[16,20,1],[18,14,.95],[24,8,.9]]),
 stroke([[17,19,.95],[17,10,1],[23,5,.95],[29,4,.9],[27,13,1],[22,18,.95],[17,19,.9]],true),
 stroke([[15,22,.9],[9,21,1],[5,15,.9],[11,15,1],[15,19,.95]])]],
 ['T02','微光','留一个小小的灵感符号。',[
 stroke([[16,4,.95],[19,12,1],[27,16,.95],[19,20,1],[16,28,.95],[12,20,1],[4,16,.95],[12,12,1]],true),
 stroke([[26,3,.9],[26,8,1]]),stroke([[23,5,.9],[29,5.5,1]])]],
 ['T03','叠页','两张略错开的纸，像不同的思路。',[
 stroke([[8,22,.9],[5,21,1],[4,6,.95],[20,4,1],[22,8,.9]]),
 stroke([[10,10,.95],[26,9,1],[27,26,.95],[10,28,1]],true),
 stroke([[14,16,.9],[22,15.7,1]])]],
 ['T04','翻开','用一本展开的小册子表示理解。',[
 stroke([[16,9,.95],[11,6,1],[4,6,.95],[4,24,1],[10,24,.95],[16,27,1],[23,24,.95],[28,24,1],[28,6,.95],[21,6,1],[16,9,.95]]),
 stroke([[16,10,.9],[16.3,26,1]])]],
 ['T05','灯盏','安静的小灯，不加放射线。',[
 stroke([[11,22,.95],[10,18,1],[7,14,.95],[8,8,1],[13,5,.95],[20,5,1],[25,10,.95],[24,16,1],[21,19,.95],[20,22,1]],false),
 stroke([[11,23,.9],[20,23.3,1]]),stroke([[13,27,.9],[18,27.3,1]])]],
 ['T06','一点','一个圆弧，一点念头，尽量留白。',[
 stroke([[8,25,.95],[4,18,1],[5,10,.95],[11,5,1],[20,5,.95],[27,12,1],[26,21,.95],[21,26,1],[13,27,.9]]),
 stroke([[14,14,1],[17,12,1],[20,15,1],[17,18,1],[14,16,1]],true,1.5)]],
 ['T07','一杯茶','适合轻松、慢慢想的气质。',[
 stroke([[5,13,.95],[6,23,1],[10,27,.95],[19,26,1],[22,22,.95],[22,13,1],[5,13,.95]]),
 stroke([[22,14,.9],[27,14,1],[29,18,.95],[26,22,1],[22,21,.9]]),
 stroke([[13,3,.9],[11,6,1],[14,9,.9]])]],
 ['T08','小帆','沿一个方向，继续探索。',[
 stroke([[15,5,.95],[6,20,1],[16,19,.95],[15,5,.95]]),
 stroke([[19,7,.95],[26,20,1],[19,19,.9]]),
 stroke([[4,24,.9],[11,27,1],[23,26,.95],[28,23,.9]])]],
 ['T09','连起来','两个端点，一条清楚的思路。',[
 stroke([[6,5,1],[10,5,1],[12,8,1],[10,11,1],[6,11,1],[4,8,1]],true),
 stroke([[22,21,1],[26,21,1],[28,24,1],[26,27,1],[22,27,1],[20,24,1]],true),
 stroke([[11,8,.95],[22,10,1],[22,15,.95],[10,17,1],[10,22,.95],[20,24,.9]])]],
 ['T10','小窗','一扇窗和一个亮点，简洁而中性。',[
 stroke([[5,7,.95],[10,5,1],[26,6,.95],[27,25,1],[23,27,.95],[5,26,1]],true),
 stroke([[18,11,.95],[18,18,1]]),stroke([[14,14,.95],[22,14.5,1]])]],
];
const svg=(item,size=24)=>`<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">${item[3].map(s=>`<path d="${penPath(s.p,s.w,s.closed)}" fill-rule="evenodd"/>`).join('')}</svg>`;
const shield='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 Q16 6 20 6 L19 14 Q18 19 12 22 Q5 19 4 14 L4 6 Q8 6 12 3Z M8 12 L11 15 L16 10"/></svg>';
const cards=items.map(item=>`<article data-id="${item[0]}"><div class="caption"><span class="number">${item[0]}</span><h2>${item[1]}</h2><button class="pick" aria-label="挑选 ${item[0]} ${item[1]}" aria-pressed="false">挑选</button></div><div class="drawing">${svg(item,78)}</div><p>${item[2]}</p><div class="sizes"><span>${svg(item,20)}<small>20 px</small></span><span>${svg(item,24)}<small>24 px</small></span><span class="green">${svg(item,24)}<small>选中</small></span></div><div class="composer"><span class="placeholder">尽情提问</span><div class="controls"><button class="try" aria-label="体验 ${item[0]} 选中效果" aria-pressed="false">${svg(item)}</button><span>中</span><span class="check">${shield}核对代码</span><svg class="send" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10 L21 3 L15 22 L11 14 Z M11 14 L21 3"/></svg></div></div></article>`).join('');
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>思考图标 · what-the-repo</title><style>
@font-face{font-family:hand;src:url('/fonts/JasonHandwriting9p.ttf') format('truetype')}*{box-sizing:border-box}body{margin:0;background:#f5efe3;color:#30332b;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;--paper:#fffaf0;--line:#c9c1b0;--ink:#30332b;--green:#39815a;--sub:#727365}body.dark{background:#232720;color:#ecebdf;--paper:#2e332b;--line:#59604f;--ink:#ecebdf;--green:#9dcba6;--sub:#b6b9a9}header,main{max-width:1130px;margin:auto;padding:30px 22px}header{padding-bottom:12px}.eyebrow{font-size:12px;letter-spacing:.1em;color:var(--green)}h1{font:38px/1.35 hand,cursive;margin:10px 0}header p{color:var(--sub);margin:5px 0}.top{display:flex;justify-content:space-between;align-items:center;gap:20px}button{font:inherit;color:inherit;cursor:pointer;background:none;border:1px solid var(--line);border-radius:8px 11px 8px 10px;padding:7px 13px;min-height:42px}button:hover{color:var(--green);border-color:var(--green)}button:focus-visible{outline:2px solid var(--green);outline-offset:3px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px;padding-bottom:110px}article{background:var(--paper);border:1px solid var(--line);border-radius:15px 11px 18px 12px;padding:18px;box-shadow:3px 4px 0 rgb(80 72 50 / 5%)}article.chosen{border-color:var(--green)}.caption{display:flex;align-items:center;gap:12px}.number{font-size:12px;color:var(--sub)}h2{font:23px hand,cursive;margin:0;flex:1}.pick{font-size:13px;padding:4px 11px}.pick[aria-pressed=true]{color:var(--green);border-color:var(--green)}.drawing{height:125px;display:grid;place-items:center;color:var(--ink)}article p{font-size:13px;color:var(--sub);margin:0;text-align:center;min-height:42px}.sizes{display:flex;align-items:center;justify-content:center;gap:30px;margin:14px 0 21px}.sizes>span{display:flex;align-items:center;gap:6px}.sizes small{font-size:10px;color:var(--sub)}.green{color:var(--green)}.composer{border:1.4px solid var(--line);border-radius:12px 16px 11px 15px;padding:10px 12px;font-family:hand,cursive}.placeholder{color:var(--sub);font-size:17px}.controls{display:flex;align-items:center;gap:13px;margin-top:14px;white-space:nowrap}.try{border:0;padding:0;width:32px;display:grid;place-items:center}.try[aria-pressed=true]{color:var(--green)}.check{display:flex;align-items:center;gap:5px;font-size:14px}.send{margin-left:auto;color:var(--green);flex-shrink:0}.tray{position:fixed;bottom:0;left:0;right:0;border-top:1px solid var(--line);background:var(--paper);padding:14px 22px;text-align:center;font-size:14px}.tray strong{color:var(--green)}@media(max-width:950px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:580px){.grid{grid-template-columns:1fr}h1{font-size:30px}.top{gap:8px}header,main{padding:20px 16px}.grid{padding-bottom:115px}}
</style><header><div class="eyebrow">what-the-repo / DRAWING STUDIES</div><div class="top"><h1>留一点空白，想一点事情。</h1><button id="theme" aria-pressed="false">切换深色</button></div><p>10 个思考入口图标候选。大图看线条，小图和聊天框看实际感觉。</p><p>点击「挑选」可以保留多个编号；点击聊天框里的图标可以试试绿色效果。这里只预览，不改变产品。</p></header><main class="grid">${cards}</main><footer class="tray" aria-live="polite">尚未挑选 · 可以比较后告诉我编号</footer><script>
const selected=new Set();document.querySelectorAll('.pick').forEach(button=>button.addEventListener('click',()=>{const card=button.closest('article');const id=card.dataset.id;if(selected.has(id))selected.delete(id);else selected.add(id);button.setAttribute('aria-pressed',String(selected.has(id)));button.textContent=selected.has(id)?'已挑选':'挑选';card.classList.toggle('chosen',selected.has(id));document.querySelector('.tray').textContent=selected.size?'已挑选：'+[...selected].sort().join('、')+' · 告诉我编号，也可以只选喜欢的局部。':'尚未挑选 · 可以比较后告诉我编号';}));document.querySelectorAll('.try').forEach(button=>button.addEventListener('click',()=>button.setAttribute('aria-pressed',String(button.getAttribute('aria-pressed')!=='true'))));document.querySelector('#theme').addEventListener('click',event=>{const dark=document.body.classList.toggle('dark');event.currentTarget.textContent=dark?'切换浅色':'切换深色';event.currentTarget.setAttribute('aria-pressed',String(dark));});
</script></html>`;
new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const output=path.join(root,'.local/thinking-icon-options.html');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,html);console.log(output);
