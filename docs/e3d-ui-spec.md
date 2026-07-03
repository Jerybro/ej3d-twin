# EJ3D 編輯器對標 AVEVA E3D Design 實作規格

適用檔案：
- `C:\Users\Admin\ej3d-twin-pid\static\editor.html`（版面殼、CSS）
- `C:\Users\Admin\ej3d-twin-pid\static\js\editor.js`（全部互動邏輯）
- `C:\Users\Admin\ej3d-twin-pid\static\js\plant-builders.js`（`ASSET_CATEGORIES` L818-861，27 種設備 7 分類）

## 0. 現況盤點（先確認基線，避免重工）

現有程式碼**已經不是**「左側素材面板」時代——editor.html 已是 ribbon（首頁/設備/管線/檢視 4 tabs）＋左樹＋右屬性＋狀態列的四區 grid。因此本規格是「補到 E3D 對標」的**差異規格**：

| E3D 對標項 | 現況 | 缺口 |
|---|---|---|
| Ribbon tab/group | 4 tabs、rgroup/rbtn 結構已在 | tab 命名與 group 拆法不符 E3D；無 QAT、無 Discipline 下拉 |
| Model Explorer | 平面樹（unit→設備）＋搜尋＋右鍵 | 無 WORL→SITE→ZONE 階層語意、無 CE 麵包屑、右鍵項太少 |
| Properties | pg-section 分節格已在 | 分節名/座標語意不是 E3D 式（E/N/U）、無 Owner 連動 |
| 3D 導航 | OrbitControls 預設（左鍵轉、右鍵平移） | 不符 MB2 慣例、無游標點 pivot pin、無 PowerCompass（只有 triad） |
| 底部 | 狀態列已在 | 無視圖分頁列、無 Prompt Area 語意 |
| 量測/剖切/節點編輯 | 兩點量距、單一水平剖切、節點拖曳/插入/刪除已在 | 無角度量測、無 Clip Box/六平面、無 Quick Routing 箭頭 |

---

## P0 — 核心觀感（一眼像 E3D）

### P0-1 Ribbon 重構：QAT ＋ E3D tab/group 結構

**UI 佈局**
- `--ribbon-h: 92px → 120px`（editor.html L21）。Ribbon 內部改三列：
  1. **QAT 列**（高 26px，背景 `var(--panel3)`）：左起 `儲存(Ctrl+S)`、`另存`、`復原`、`還原` 四個 20px 圖示鈕 ＋ **Discipline 下拉**（`<select id="qat-discipline">`，選項：`通用`/`設備 EQUIPMENT`/`管線 PIPING`，寬 128px，樣式沿用 `.rsel`）＋ 右端 `#scene-name`。
  2. **Tab 列**（沿用現有 `#ribbon-tabs`，高 30px）。
  3. **Body 列**（沿用 `#ribbon-body`，高 64px）。
- Tab 清單改為（固定＋情境兩段，中間以 12px 空隙分隔）：

| Tab | data-tab | Groups（group-label → 按鈕） |
|---|---|---|
| 專案 PROJECT | project | 場景：儲存/另存/開啟/新增（搬現有 `btn-save/saveas/open/new`）｜交付：孿生檢視 |
| 首頁 HOME | home | 共用 Common：屬性(聚焦右面板)/重新命名｜巡覽 Navigate：縮放至選取(F)/縮放全場(Home)｜量測 Measure：距離/角度｜視窗 Windows：模型樹開關/屬性開關｜刪除 Delete：刪除 |
| 檢視 VIEW | view | 內容 Content：底圖/網格/標籤（搬現有）｜視向 Control：北/南/東/西/俯視/等角（LOOK 語意）｜操縱 Manipulate：儲存視角/還原視角（P2 先放 disabled 鈕佔位）｜剖切 Clip and Cap：剖切盒/六平面/清除 |
| 設備 EQUIPMENT（情境） | equip | 建立 Create：現有 27 素材 gallery（`#equip-ribbon` 動態生成不動）｜修改 Modify：移動W/旋轉E/縮放R（搬現有 xf-btn） |
| 管線 PIPING（情境） | pipe | 建立 Create：繪製管線＋管徑欄（現有）｜修改 Modify：節點編輯（現有）｜路由 Route：快速路由（P1 佔位） |

**互動流**
- `#qat-discipline` change → 情境 tabs 顯示/隱藏（`display:none` on `.rtab[data-tab=equip/pipe]`），並自動 click 對應第一個情境 tab。選「設備」帶出 EQUIPMENT；選「管線」同時帶出 EQUIPMENT＋PIPING（對標 E3D「選 PIPING 連帶 EQUIPMENT」行為）。
- **重要：不要**做「點選物件自動換 tab」（研究 C6 判定：E3D 是手動下拉切換）。但保留現有 `enterNodeMode()`（editor.js L799）裡的 `document.querySelector('.rtab[data-tab="pipe"]').click()`——這是功能觸發連動，合理。

**程式落點**
- editor.html L188-288 `#ribbon` 整段重排；xf-btn/btn-save 等 **id 全部不變**，editor.js 事件綁定（L1069-1077、L1126-1131）零改動。
- editor.js L563-570 rtab 切換邏輯不動；L573-592 設備 gallery 生成不動（目標容器仍是 `#equip-ribbon`）。
- 新增約 20 行：QAT discipline change handler，放在 L570 rtab 區塊後。

### P0-2 Model Explorer 階層化 ＋ CE 麵包屑

**UI 佈局**
- 樹改三層渲染（不改存檔 schema，純顯示映射）：
  ```
  WORL *                       ← 根，永遠展開
  └─ SITE {plant.id}           ← sceneData.plant
     └─ ZONE {unit.id} {unit.name}
        ├─ EQUI R-101 攪拌反應器   ← 現有 .mt-eq 列
        └─ …
     └─ ZONE PIPES 管線
        └─ PIPE #1（n 節點）
  ```
  型別字（WORL/SITE/ZONE/EQUI/PIPE）用 `<span class="mt-dbtype">`：10px、`color:var(--dim)`、等寬字。這是 E3D 味的關鍵（研究判定：PDMS 縮寫要照抄）。
- **麵包屑列**：`#viewport` 頂部加絕對定位條（`top:0; left:0; right:0; height:24px;` 背景 `rgba(19,27,36,.92)`、border-bottom `var(--bdr)`），id `#ce-breadcrumb`，內容如 `WORL * › SITE NEW › ZONE U-100 › EQUI R-101`，每段可點擊（點 ZONE → 樹捲動至該節點）。

**互動流**
- **CE 單一狀態**：現有 `selected` 變數即 CE。`selectEquipment()`（editor.js L322）末尾加：(1) 樹自動展開祖先 `<details>`（`det.open=true`）；(2) `row.scrollIntoView({block:'nearest'})`；(3) 更新麵包屑。`selectPipe()`（L336）同理。
- 樹右鍵選單擴充 `eqCtxItems()`（L541）為：`縮放至此(F)`／`顯示｜隱藏`／`重新命名`（inline：把 `.mt-tag` 換成 input，Enter 提交走現有 tag 改名邏輯 L393-402）／`屬性`（展開右面板並 focus 第一個 input）／sep／`刪除`。
- ZONE 列（summary）也給右鍵：`全部顯示`/`全部隱藏`（迴圈 `toggleHidden`）。

**程式落點**
- `rebuildTree()`（L452-504）重寫外層迴圈：多包一層 WORL/SITE `<details>`；`.mt-eq` 列生成邏輯與事件綁定原封不動。
- 新函式 `updateBreadcrumb()` 約 15 行，在 `selectEquipment/selectPipe/selectNone` 各呼叫一次。
- CSS 新增 `.mt-dbtype`、`#ce-breadcrumb` 約 12 行。

### P0-3 Properties grid E3D 分節

**UI 佈局**（沿用現有 `.pg-section/.pg-grid`，只改內容結構）
- `renderPropPanel()`（L358）分節改為：
  1. **General**：Name(=tag)、Description(=name)、Type、**Owner**（唯讀 `ZONE U-100`，點擊 → 樹捲動至該 ZONE）
  2. **Positional**：`東 E`（=pos[0]）、`北 N`（=pos[2]）、`上 U`（=0，唯讀灰字）、`旋轉 深度角度`、`WRT`（唯讀 `/WORL`）——座標一律用 E/N/U 字樣，這是 E3D 語感的最便宜投資
  3. **Design Parameters**：現有 dims 列不動
  4. **Information**：現有 pid_ref/尺寸來源/儀錶不動
- 管線版 `renderPipeProps()`（L421）同樣加 General（Name=`PIPE #n`、Owner=ZONE PIPES）與 Specification 節（管徑欄搬進去）。

**程式落點**：純 L358-441 兩函式的模板字串改寫，input 的 `data-k` 寫回機制（L386-416）完全不動。約 40 行 diff。

### P0-4 3D 導航：MB2 慣例 ＋ pivot pin ＋ PowerCompass

**互動流（E3D 滑鼠模型）**
- OrbitControls 重新映射（editor.js L30-32 之後加）：
  ```js
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
  controls.zoomToCursor = true;
  ```
  左鍵純選取（現有 pointerup 選取邏輯 L676 不變且不再與旋轉衝突）、中鍵按住＝旋轉、右鍵拖＝平移（現有 contextmenu 的 5px 位移判斷 L734 已相容）、滾輪＝縮放。
- **游標點 pivot（粉紅 pin）**：`pointerdown` 且 `e.button===1` 時 raycast（沿用 `pickObject()` L648，miss 則 `groundPoint()`），把命中點設為 `controls.target`（保持相機位置不動：設 target 前後不動 camera.position 即可），同時在該點放一個粉紅 sprite（`0xff69b4`、半徑 0.12 球＋十字線），`pointerup` 移除。約 25 行，掛在 L675 附近。
- **MB2 單擊置中**：中鍵 down/up 位移 <5px → 該點 `controls.target` 平滑插值置中（沿用 downXY 模式）。
- 模式鍵：`F2`=Zoom（中鍵改 DOLLY）、`F3`=Pan、`F5`=Rotate（預設），在 keydown（L1024）加三個 case，並在狀態列顯示目前導航模式。

**PowerCompass（取代 ViewCube 的關鍵識別物）**
- 位置：viewport 左下角（`left:12px; bottom:36px`），直徑 96px，DOM/SVG 實作（不用 WebGL）：外圈圓環＋N/S/E/W 四個字母熱區＋中央 U/D 兩鈕；整體 `cursor:grab` 可拖曳移位（純 CSS translate，記在 localStorage）。
- 點擊：N→`setViewPreset` 看向北（新增 VIEW_DIRS：`n:(0,.12,-1) s:(0,.12,1) e:(-1,.12,0) w:(1,.12,0) u:top d:(0.001,-1,0.001)`，L980 擴充）。
- 現有 axis triad（L1160-1183）**保留**移到右下不動——triad 顯示方位、PowerCompass 負責點擊切視向，兩者並存不衝突。
- 羅盤字母隨相機 yaw 旋轉：animate()（L1199）內每幀 `compassEl.style.transform = rotate(-yaw)`。

**程式落點**：editor.js 新區塊「PowerCompass」約 60 行＋CSS 25 行；OrbitControls 重映射 3 行；pivot pin 25 行。

### P0-5 底部視圖分頁列 ＋ Prompt Area

**UI 佈局**
- `#workspace` grid-template-rows 改四列：`var(--ribbon-h) 1fr 24px var(--status-h)`，新列 `grid-area: vtabs` 橫跨三欄。
- 內容：左側一個 active 分頁 `3D View (1)`（樣式同 `.rtab` 但上下顛倒：`border-radius: 0 0 6px 6px`）＋灰色 `+` 鈕（P0 disabled，title「多視圖規劃中」）。
- **Prompt Area**：現有 `#mode-hint`（居中膠囊）改為**左下貼齊**的 prompt 列（`left:12px; bottom:12px; transform:none; text-align:left;`，寬上限 46%）——E3D 的提示在固定 prompt 區而非浮動居中；`setHint()`（L289）不用改。

**程式落點**：editor.html grid L28-36＋新 div 約 10 行；CSS 15 行；editor.js 零改動。

---

## P1 — 操作深度

### P1-1 管線 Quick Routing Handles（正交延伸＋自動彎頭）

**互動流**
1. `pipenode` 模式選中**端點**節點（index 0 或最後）時，除 TransformControls 外，在端點加 4 支水平正交箭頭＋1 支向上箭頭（`ConeGeometry`＋`CylinderGeometry`，長 1.2、`0x46c2e0`，`userData.routeDir`）。
2. 拖曳某支箭頭：沿該軸 raycast 平面投影，即時虛線預覽（沿用 `updatePipePreview()` L756 的 LineDashed 樣式）；放開 → `pushUndo()` → `pipe.pts` 在端點 push/unshift 新點（吸附 `snapVal`），`rebuildAllPipes()` 後重建 handles。轉向即自然形成 90 度折點——對標「每次轉向自動放 elbow」。
3. 微調：選中節點時 `+`/`-` 鍵沿上次拖曳軸步進 0.5m（snapOn 時）/0.1m；右鍵節點 → 選單加 `輸入數值…`（prompt 三欄 E/N/U，直接寫 `pipe.pts[i]`）。
4. 彎頭視覺：`buildPipe()`（L213）在相鄰兩段夾角 85-95 度時，把 joint 球換成 quarter-torus（`TorusGeometry(r*1.8, r, 8, 8, PI/2)` 對齊兩段平面），其餘角度維持球——一眼看出「elbow」。

**程式落點**：`buildNodeHandles()`（L808）加 `buildRoutingArrows(pipe, endIndex)`；`pointerup` 選取分支（L722）加 `routeDir` case；`buildPipe` L230-235 joint 改造。合計約 120 行。

### P1-2 量測強化：角度＋持久標註＋重複量測

- HOME > 量測 group 兩鈕：`距離`（現有 btn-measure 改綁）與 `角度`。
- **角度**：三點（第一點=頂點，prompt 提示「先點頂點」），完成後顯示 `∠ 87.3°`，畫兩條邊線＋圓弧（`EllipseCurve` 20 段）。
- 量測結果**不再單一 tip**：每次完成生成一個持久標註（CSS2DObject，樣式同 measure-tip），存入 `measureAnnotations[]`；Esc 或再按鈕清空全部。空白鍵＝以上一次模式立即開始下一段（對標 3.1.7）。
- **落點**：`addMeasurePoint()`（L892）改多型（distance/angle 兩狀態機）；`measureTip` 定位邏輯（animate L1209-1214）改為 CSS2DObject 後可整段刪除。約 80 行。

### P1-3 剖切升級：Clip Box ＋ 六平面

- VIEW > Clip and Cap group：`剖切盒`／`從選取建盒`／`六平面`／`清除`。
- **Clip Box**：6 個 `THREE.Plane` ＋ `Box3Helper`（`0x46c2e0` 線框）；`從選取建盒`＝CE 的 Box3 各向 +1m（對標 from CE）。拖曳調整：六面中心各放一個 16px 方形 CSS2D 手柄，拖曳沿法向平移該平面。
- **六平面模式**：右屬性面板顯示 6 列 slider（±X/±Y/±Z，各自 checkbox 啟閉）——選中「剖切」狀態時 Properties 面板切換為剖切情境面板（對標 E3D 情境編輯面板停靠右側的行為）。
- 實作：`renderer.localClippingEnabled = true`；材質共用（`pipeMat`、builders 的 `std()`）所以**必須**逐 mesh clone 或全域 `renderer.clippingPlanes`——維持現有全域法（L938）最省事，直接把 `renderer.clippingPlanes` 換成 6 平面陣列。Capping 留 P2。
- **落點**：L921-939 整段換成 `clipbox` 模組（新增約 130 行）；`btn-clip`/`clip-slider` 移除。

### P1-4 對齊捕捉強化

- TransformControls 內建 snap（L51 建立處加 3 行）：
  ```js
  transform.setTranslationSnap(snapOn ? 0.5 : null);
  transform.setRotationSnap(THREE.MathUtils.degToRad(15));
  ```
  `st-snap` toggle（L1012）同步更新——現況是 mouseUp 後才吸附（L774），改為拖曳中即吸附，手感立刻接近 E3D increment。
- 右鍵設備選單加 `對齊到…`：進入拾取模式（hint「點選目標設備」），點另一設備 → 彈 3 選項（對齊 E／對齊 N／兩者），寫回 `def.pos` 後 `renderPropPanel`。落點：`eqCtxItems`（L541）＋新 mode `'alignpick'` 約 40 行。
- 管線繪製中按住 `Shift`＝正交鎖定（新點強制與上一點同 E 或同 N，取差值大者）——`pointermove` 的 pipe 分支（L667）加 6 行。

### P1-5 右鍵情境選單擴充

- **空白處**（L747-753）擴為：`縮放至全場(Home)`／`視向 ›`（子選單 北/南/東/西/俯視/等角——`openCtxMenu` 需支援 `children` 巢狀，hover 展開第二層）／`量測距離`／`從此點剖切`（以點擊點為中心建 4m clip box）。
- **設備**（L541）加：`輸入座標…`（聚焦 Properties 的 E 欄）／`對齊到…`（P1-4）／`複製`（clone def、tag 走 `nextTag`、pos 偏移 +2,+2）。
- `openCtxMenu()`（L518）加子選單支援約 25 行。加分（可延後）：把此選單改 pie 版面——8 個 60px tile 圓形排列，中央取消；同一 items 資料結構双渲染，`localStorage` 開關切換。

---

## P2 — 加分

### P2-1 視角書籤（Save & Restore Views）

- VIEW > Manipulate：`儲存視角` → prompt 名稱 → 存 `{ name, pos:[…], target:[…], hiddenTags:[…], thumb }`，thumb 用 `renderer.domElement.toDataURL('image/jpeg', .5)` 縮到 160×100（離屏 canvas）。
- 存入 `sceneData.views[]`（隨 `saveScene()` L1102 一起進 API，schema 向後相容——twin 檢視端讀不到就忽略）。
- `還原視角` → 右側 Properties 位置彈出清單面板（縮圖＋名稱＋刪除鈕），點擊 → 相機 lerp 0.4s 過去＋還原 hiddenTags（對標 E3D 存 drawlist＋視向＋快照）。約 90 行。

### P2-2 Walk 模式

- VIEW > Control 加 `漫遊` 鈕（或 F6）：切至 `PointerLockControls`，`camera.fov=90`＋`updateProjectionMatrix()`、相機高鎖 1.7m、WASD/方向鍵移動（速度 4 m/s，Shift 8 m/s）、Esc 退出還原 fov 55 與 OrbitControls。
- 落點：import PointerLockControls；`animate()`（L1199）加 walk 分支的位移積分；與 `controls.enabled` 互斥。約 70 行。

### P2-3 Clash 面板

- TOOLS tab（新固定 tab）> Clashes group：`檢查全部`。
- 演算法：設備 AABB（`Box3.setFromObject`）兩兩相交＝**Overlap**；間距 <0.1m＝**Touch**；管線每段以線段膨脹 `pipe.r` 對設備 AABB 距離測試（`Box3.distanceToPoint` 沿段取樣 10 點即可，量級 27 設備×百段可接受）。排除 `snapToEquipment` 產生的合法接管（管段端點落在設備 2m 接管圈內者跳過）。
- UI：底部 dock 面板（高 160px，插在視圖分頁列上方，可收合）grid 三欄：類型（Touch 黃/Overlap 紅 badge）、物件 A、物件 B。點列 → 兩物件紅色 emissive 高亮＋`frameBox` 聚焦＋自動建 4m clip box（P1-3 複用）。
- 落點：新檔 `static/js/clash.js` export `runClash(sceneData, eqObjects)`；editor.js import 並掛 `window.EJ3D_EDITOR.runClash` 供測試。約 150 行。

---

## 實作順序與相依

```
P0-1 Ribbon（半天）→ P0-3 Properties（2h）→ P0-2 樹＋麵包屑（半天）
→ P0-4 導航＋PowerCompass（1天）→ P0-5 分頁列（1h）
→ P1-4 snap（1h）→ P1-1 Quick Routing（1天）→ P1-3 Clip Box（1天）
→ P1-2 量測（半天）→ P1-5 右鍵（半天）
→ P2 依需求
```

相依關係：P1-3 的 clip box 被 P2-3 複用；P1-5 的子選單機制被 P1-1 的節點右鍵複用；P0-4 的 mouseButtons 重映射必須先做，否則 P1-1 箭頭拖曳會和左鍵旋轉打架（現在左鍵=ROTATE 是最大手感偏差）。

## 三條不可違反的對標紀律（來自研究驗證結論）

1. 情境 tab 由 **QAT Discipline 下拉手動切換**，不做「點選物件自動換 tab」（C6）。
2. 用 **PowerCompass（可拖球形羅盤）**，不做 Autodesk 式 ViewCube（C7）；tab 名用 **VIEW** 不用 3D VIEW（C1）。
3. 樹階層字樣照抄 PDMS 縮寫 **WORL/SITE/ZONE/EQUI/PIPE**——這不是過時命名，是 E3D 識別度的核心。
