// 頁內導覽（spotlight）：聚光燈框住目標元素＋說明卡，首次進入自動播放一次，
// localStorage 記住看過；Tour.replay(key, steps) 可重看。無相依、各頁共用。
// steps: [{el:'.css-selector', title:'標題', text:'說明'}]（找不到或不可見的步驟自動略過）
window.Tour = (function () {
  let steps = [], idx = 0, key = '', ring = null, tip = null;

  function visible(sel) {
    const e = document.querySelector(sel);
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  }
  function mk(css) { const d = document.createElement('div'); d.style.cssText = css; return d; }

  function start(k, s) {
    key = 'tour:' + k;
    steps = (s || []).filter((x) => visible(x.el));
    idx = 0;
    if (!steps.length) return;
    ring = mk('position:fixed;z-index:9998;border:2px solid #046AFB;border-radius:10px;' +
      'box-shadow:0 0 0 9999px rgba(6,16,39,.55);pointer-events:none;transition:all .25s ease;');
    tip = mk('position:fixed;z-index:9999;width:300px;background:#fff;border:1px solid #DBDDE0;' +
      'border-radius:10px;padding:13px 15px;font-family:Inter,"Noto Sans TC","Microsoft JhengHei",sans-serif;' +
      'font-size:13px;color:#061027;box-shadow:0 10px 34px rgba(6,16,39,.25);');
    document.body.appendChild(ring); document.body.appendChild(tip);
    addEventListener('resize', place);
    show();
  }
  function auto(k, s) { if (!localStorage.getItem('tour:' + k)) start(k, s); }
  function replay(k, s) { localStorage.removeItem('tour:' + k); start(k, s); }

  function show() {
    const s = steps[idx];
    const t = document.querySelector(s.el);
    if (!t) { next(); return; }
    t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    tip.innerHTML = `<div style="font-weight:700;margin-bottom:4px">${s.title}</div>
      <div style="color:#555;line-height:1.7">${s.text}</div>
      <div style="display:flex;align-items:center;margin-top:10px">
        <span style="font-size:11px;color:#999">${idx + 1} / ${steps.length}</span>
        <button id="tour-skip" style="margin-left:auto;border:none;background:none;color:#999;font-size:12px;cursor:pointer;font-family:inherit">略過</button>
        <button id="tour-next" style="margin-left:8px;border:none;border-radius:7px;background:#046AFB;color:#fff;font-size:12.5px;padding:6px 14px;cursor:pointer;font-family:inherit">${idx === steps.length - 1 ? '完成' : '下一步'}</button>
      </div>`;
    tip.querySelector('#tour-next').onclick = next;
    tip.querySelector('#tour-skip').onclick = end;
    setTimeout(place, 280); // 等 scrollIntoView 滾完再定位
  }
  function place() {
    const s = steps[idx]; if (!s) return;
    const t = document.querySelector(s.el); if (!t) return;
    const r = t.getBoundingClientRect();
    ring.style.left = (r.left - 6) + 'px';
    ring.style.top = (r.top - 6) + 'px';
    ring.style.width = (r.width + 12) + 'px';
    ring.style.height = (r.height + 12) + 'px';
    const tw = 300, th = tip.offsetHeight || 130;
    let tx = Math.min(Math.max(r.left, 10), innerWidth - tw - 20);
    let ty = r.bottom + 14;
    if (ty + th > innerHeight - 10) ty = r.top - th - 14;
    if (ty < 10) ty = 10;
    tip.style.left = tx + 'px';
    tip.style.top = ty + 'px';
  }
  function next() { idx++; if (idx >= steps.length) { end(); return; } show(); }
  function end() {
    localStorage.setItem(key, '1');
    ring.remove(); tip.remove();
    removeEventListener('resize', place);
  }
  return { start, auto, replay };
})();
