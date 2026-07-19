// 術語註記（全站共用）：技術用語右上角小標記 ⓘ，滑鼠懸停顯示中文註解。
// 用法：<span class="tm" data-t="model_key">model_key</span>
//   - data-t 省略時直接拿元素文字當字典鍵。
//   - 字典集中管理，各頁不必重複寫解釋；描述句保持精簡英文術語即可。
window.Term = (function () {
  const G = {
    'model_key': '模型金鑰——模型發布後取得的固定識別碼。孿生區塊、API 呼叫都以它指名模型；與訓練資料脫鉤，原始資料刪除也不影響推論。',
    'block': '區塊——數據孿生流程中的一個單元，通常對應一台設備，各自綁定一個模型。',
    'predict': '推論——給一組輸入特徵值，模型計算並回傳輸出（品質模型回預測值、異常偵測回風險值與健康分數）。',
    'what-if': '假設試算——手動調整輸入值，立即觀察模型輸出如何變化；只影響畫面上的模擬，不影響實際製程。',
    'flowsheet': '流程方案——由多個區塊與「模型輸出連接」組成、可每拍求解的數據孿生；用設計器即可自組。',
    'dataset_id': '資料集編號——訓練階段的內部編號；發布後對外一律改用模型金鑰（model_key）。',
    'model_id': '模型編號——訓練階段的內部編號；發布後對外一律改用模型金鑰（model_key）。',
    'task': '任務類型——模型屬於品質預測（迴歸）、分類、異常偵測或時序預測；決定回傳欄位與可用端點。',
    'capability': '能力——此模型支援的端點集合（推論／評估／假設試算／最佳化…），依任務類型自動推導，不可手填。',
    'anomaly': '異常偵測——無監督健康監測：以健康運轉資料為基準，計算目前運轉點的偏離程度（風險值）與健康分數。',
    'occ': '異常偵測（單類別分類）——以健康運轉資料為基準的無監督健康監測，回傳風險值、健康分數與是否超標。',
    'inputs': '輸入值——模型需要的特徵數值；全部特徵都要有值，模型才能計算。',
    'guard': '守門員——檢查每個輸入是否落在該模型的訓練域內；超出即為外插，預測不可信，會以橘／紅警示。',
    'P1~P99': '訓練域——訓練資料的第 1 到第 99 百分位範圍；模型只在這個範圍內學過，超出即為外插。',
    'L1': '第一層・資料——資料集與欄位的統一存取層，模型輸入特徵的單一來源。',
    'L2': '第二層・模型服務——發布制模型註冊表：模型發布成穩定金鑰，統一推論與治理。',
    'L3': '第三層・孿生綁定——孿生流程的每個區塊以模型金鑰取用模型服務。',
    '相關 |r|': '相關強度——兩個欄位一起變動的程度：0＝無關、1＝完全同步。一個欄位被其他欄位「解釋」得越多，通常越容易被準確預測，也越適合當目標。',
  };

  const css = document.createElement('style');
  css.textContent = `
    .tm { border-bottom: 1px dotted rgba(4,106,251,.55); cursor: help; }
    .tm::after { content: 'ⓘ'; font-size: .58em; vertical-align: super;
      color: #046AFB; opacity: .8; margin-left: 1px; }
    #term-tip { position: fixed; z-index: 99999; max-width: 300px;
      background: #061027; color: #F2F5F9; font-size: 12px; line-height: 1.75;
      padding: 9px 12px; border-radius: 8px; pointer-events: none; display: none;
      box-shadow: 0 8px 24px rgba(6,16,39,.35);
      font-family: Inter, "Noto Sans TC", "Microsoft JhengHei", sans-serif; }
    #term-tip b { color: #7FB0FF; }`;
  document.head.appendChild(css);

  const tip = document.createElement('div');
  tip.id = 'term-tip';
  (document.body || document.documentElement).appendChild(tip);

  function place(e) {
    const r = tip.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY + 18;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 12;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 12;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest && e.target.closest('.tm');
    if (!t) return;
    const key = (t.dataset.t || t.textContent).trim();
    const txt = G[key] ?? G[key.toLowerCase()];
    if (!txt) return;
    tip.innerHTML = `<b>${key}</b>　${txt}`;
    tip.style.display = 'block';
    place(e);
  });
  document.addEventListener('mousemove', (e) => { if (tip.style.display === 'block') place(e); });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest && e.target.closest('.tm')) tip.style.display = 'none';
  });
  return { G };
})();
