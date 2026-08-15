# 判讀表：把可疑清單變成「人一條一條打勾」的離線頁面
#
# 為什麼要這個：三張圖的清單估計 100～150 條，純 JSON 判不動——判讀成本
# 才是這一輪的真正瓶頸（腳本跑完只要幾分鐘）。這頁只做一件事：讓人看到
# 「圖上這個位置、這條線／這對文字」然後按真錯或誤報，結果匯出成 JSON
# 回頭複算。它是評測工具，不進工作台。
from __future__ import annotations

import json
from pathlib import Path

_CSS = """
*{box-sizing:border-box;margin:0;padding:0}
body{font:13px/1.6 Inter,"Noto Sans TC","Microsoft JhengHei",sans-serif;
 background:#F6F7FA;color:#061027;display:flex;height:100vh;overflow:hidden}
#stage{flex:1;overflow:auto;background:#E9EDF2;position:relative}
#wrap{position:relative;display:inline-block}
#wrap img{display:block}
.mk{position:absolute;border:2px solid #D93F3F;border-radius:2px;pointer-events:none;
 min-width:10px;min-height:10px}
.mk.on{border-color:#046AFB;box-shadow:0 0 0 3px rgba(4,106,251,.25);
 animation:p 1.1s ease-in-out infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:.45}}
aside{width:360px;flex-shrink:0;background:#fff;border-left:1px solid #DBDDE0;
 display:flex;flex-direction:column}
header{padding:12px 14px;border-bottom:1px solid #DBDDE0}
h1{font-size:14px;font-weight:700}
.sub{color:#5C6773;font-size:11.5px;margin-top:3px}
#list{flex:1;overflow-y:auto;padding:8px}
.it{border:1px solid #DBDDE0;border-radius:8px;padding:9px 10px;margin-bottom:6px;
 cursor:pointer;background:#fff}
.it:hover{border-color:#046AFB}
.it.cur{border-color:#046AFB;background:#F2F7FF}
.it.y{border-left:4px solid #12A150}.it.n{border-left:4px solid #9AA3AE}
.t{font-weight:600;font-size:12.5px}
.d{color:#5C6773;font-size:11.5px;margin-top:2px}
footer{padding:10px 14px;border-top:1px solid #DBDDE0;display:flex;gap:6px;
 align-items:center;flex-wrap:wrap}
button{font:inherit;padding:6px 11px;border-radius:6px;border:1px solid #DBDDE0;
 background:#F1F3F6;cursor:pointer}
button.p{background:#046AFB;border-color:#046AFB;color:#fff;font-weight:600}
#stat{font-size:11.5px;color:#5C6773;width:100%}
"""

_JS = """
const D=DATA, S={}; let cur=0;
const $=s=>document.querySelector(s);
// 標記一律用百分比定位：座標本來就是正規化的，換算成像素只會多一個
// 對「圖載入了沒」的依賴——圖沒載到就全部歸零，而且看起來像沒有標記。
// 百分比在圖片還沒載入、被縮放、或頁面被當快照渲染時都成立。
function draw(){
 const w=$('#wrap'); w.querySelectorAll('.mk').forEach(e=>e.remove());
 const pc=v=>(v*100).toFixed(4)+'%';
 D.forEach((d,i)=>{const b=d.box,e=document.createElement('div');
  e.className='mk'+(i===cur?' on':'');
  e.style.left=pc(b[0]); e.style.top=pc(b[1]);
  e.style.width=pc(Math.max(b[2]-b[0],0.001));
  e.style.height=pc(Math.max(b[3]-b[1],0.001));
  e.dataset.i=i; w.appendChild(e);});
}
function list(){
 $('#list').innerHTML=D.map((d,i)=>`<div class="it ${i===cur?'cur':''} ${S[i]||''}"
  data-i="${i}"><div class="t">${i+1}. ${d.title}</div>
  <div class="d">${d.detail}</div></div>`).join('');
 $('#list').querySelectorAll('.it').forEach(e=>e.onclick=()=>sel(+e.dataset.i));
 const y=Object.values(S).filter(v=>v==='y').length,
       n=Object.values(S).filter(v=>v==='n').length;
 $('#stat').textContent=`已判 ${y+n}/${D.length}　真錯 ${y}　誤報 ${n}`
  +(y+n?`　命中率 ${(y/(y+n)*100).toFixed(1)}%`:'');
}
function sel(i){cur=i;draw();list();
 const m=$(`.mk[data-i="${i}"]`); if(m)m.scrollIntoView({block:'center',inline:'center'});
 const e=$(`.it[data-i="${i}"]`); if(e)e.scrollIntoView({block:'nearest'});}
function mark(v){S[cur]=v; if(cur<D.length-1)sel(cur+1); else list();}
document.addEventListener('keydown',e=>{
 if(e.key==='1')mark('y'); else if(e.key==='2')mark('n');
 else if(e.key==='ArrowDown')sel(Math.min(cur+1,D.length-1));
 else if(e.key==='ArrowUp')sel(Math.max(cur-1,0));});
function dump(){
 const out=D.map((d,i)=>({...d,verdict:S[i]||null}));
 const b=new Blob([JSON.stringify(out,null,1)],{type:'application/json'});
 const a=document.createElement('a'); a.href=URL.createObjectURL(b);
 a.download=FILE; a.click();}
// 立刻畫（不等圖）：百分比定位不需要圖片尺寸，圖載不到也還能判讀清單
draw();list();sel(0);
$('#im').addEventListener('error',()=>{
 document.getElementById('warn').textContent='底圖載入失敗，標記位置仍正確（相對比例）';});
"""


def build_html(out_path: Path, title: str, img_rel: str, items: list,
               subtitle: str = "") -> Path:
    """items: [{box:[x0,y0,x1,y1] 正規化, title, detail, ...}]"""
    html = f"""<!doctype html><meta charset="utf-8"><title>{title}</title>
<style>{_CSS}</style>
<div id="stage"><div id="wrap"><img id="im" src="{img_rel}"></div></div>
<aside>
 <header><h1>{title}</h1><div class="sub">{subtitle}</div>
  <div class="sub" id="warn" style="color:#D93F3F"></div></header>
 <div id="list"></div>
 <footer>
  <button class="p" onclick="mark('y')">真錯 (1)</button>
  <button onclick="mark('n')">誤報 (2)</button>
  <button onclick="dump()">匯出判讀 JSON</button>
  <div id="stat"></div>
 </footer>
</aside>
<script>
const DATA={json.dumps(items, ensure_ascii=False)};
const FILE={json.dumps(out_path.stem + '.verdict.json')};
{_JS}
</script>"""
    out_path.write_text(html, encoding="utf-8")
    return out_path
