// 點雲 as-built 載入（brownfield 業主孿生定位核心）
// 雷射掃描 .ply → THREE.Points，讓數位模型可疊合既有廠現況。
//
// 鐵律：座標即「公尺」canonical（假設掃描以公尺匯出；USD metersPerUnit=1）。
//   若掃描以其他單位匯出，用可選 scale 參數在載入邊界一次換算成公尺，
//   之後場景/量測/存檔一律讀公尺——mm 僅存在顯示/輸入邊界（不在此檔）。
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

// 載入單一 .ply 點雲。
//   url    : object URL 或路徑（本機檔用 URL.createObjectURL；不上傳）
//   THREE  : 由 editor.js 傳入的 three 命名空間（共用同一份，避免雙實例）
//   opts   : { scale=1（匯出單位→公尺）, size=0.015（點大小，公尺）, color=0x9aa7b4（無頂點色時的灰） }
// 回傳：{ points, dispose }
export async function loadPointCloud(url, THREE, opts = {}) {
  const { scale = 1, size = 0.015, color = 0x9aa7b4 } = opts;
  const loader = new PLYLoader();
  const geometry = await loader.loadAsync(url);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // 掃描單位換算（預設 1＝已是公尺）；只在此載入邊界做一次，寫回場景即公尺 canonical
  if (scale !== 1 && Number.isFinite(scale) && scale > 0) {
    geometry.scale(scale, scale, scale);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }

  const hasColor = !!geometry.getAttribute('color');
  const material = new THREE.PointsMaterial({
    size,
    sizeAttenuation: true,   // 透視衰減：近大遠小，符合真實掃描尺度感
    vertexColors: hasColor,  // 有頂點色就用掃描原色，否則灰色
    color: hasColor ? 0xffffff : color,
    transparent: true,
    opacity: 1,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'pointcloud';

  const dispose = () => {
    points.geometry?.dispose();
    if (points.material) {
      (Array.isArray(points.material) ? points.material : [points.material])
        .forEach((m) => m.dispose());
    }
  };

  return { points, dispose };
}
