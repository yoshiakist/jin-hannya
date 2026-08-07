/**
 * グリフの符号付き距離場（SDF）の前計算。
 *
 * 発光の滲みを「1 点から放射する円」ではなく「字形の輪郭から等距離に広がる帯」にするために要る。
 * ランタイムで輪郭を触らない方針（README「グリフの扱い」）なので、距離場もここで焼いておき、
 * 実行時は 1 テクセル引くだけで字の形に沿った減衰が出せるようにする。
 *
 * 手順は素朴に 2 段。
 *   1. 三角形分割済みのメッシュを高解像度の内外マスクへラスタライズする
 *   2. 8SSEDT（8 点走査のユークリッド距離変換）で内外それぞれの距離を出し、差を取って符号付きにする
 * 輪郭線への厳密な距離ではなくラスタ格子での近似だが、滲みは元より柔らかいので差は見えない。
 */

/** 1 字あたりのテクセル数（一辺）。バイリニア補間前提なので粗くてよい */
export const SDF_RES = 64
/** セルが覆う字面座標の半径。字面は [-0.5, 0.5] なので、差の 0.4 が字の外側の余白になる */
export const SDF_EXTENT = 0.9
/** 距離を格納する範囲（字面座標）。これを超える距離は 0 / 1 に飽和する */
export const SDF_SPREAD = 0.4
/** ラスタライズ時の倍率。距離を出したあと平均して落とす */
const SUPERSAMPLE = 2

/** 字面座標 → 高解像度ラスタの画素座標（画素中心が整数） */
function toPixel(v: number, res: number): number {
  return ((v + SDF_EXTENT) / (2 * SDF_EXTENT)) * res - 0.5
}

/** 三角形の内外マスク。1 = 墨がのっている画素 */
function rasterize(positions: Float32Array, indices: Uint32Array, res: number): Uint8Array {
  const mask = new Uint8Array(res * res)

  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]! * 2
    const ib = indices[t + 1]! * 2
    const ic = indices[t + 2]! * 2

    const ax = toPixel(positions[ia]!, res)
    const ay = toPixel(positions[ia + 1]!, res)
    const bx = toPixel(positions[ib]!, res)
    const by = toPixel(positions[ib + 1]!, res)
    const cx = toPixel(positions[ic]!, res)
    const cy = toPixel(positions[ic + 1]!, res)

    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (area === 0) continue
    // 巻き方向に依らず同じ判定にするため、符号を掛けて正で揃える
    const s = area > 0 ? 1 : -1

    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx)))
    const x1 = Math.min(res - 1, Math.floor(Math.max(ax, bx, cx)))
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy)))
    const y1 = Math.min(res - 1, Math.floor(Math.max(ay, by, cy)))

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const e0 = s * ((bx - ax) * (y - ay) - (by - ay) * (x - ax))
        const e1 = s * ((cx - bx) * (y - by) - (cy - by) * (x - bx))
        const e2 = s * ((ax - cx) * (y - cy) - (ay - cy) * (x - cx))
        if (e0 >= 0 && e1 >= 0 && e2 >= 0) mask[y * res + x] = 1
      }
    }
  }

  return mask
}

const FAR = 1e9

/**
 * `mask` が `target` の画素までの距離（画素単位）を全画素について出す。
 * 各画素に「最寄りの target 画素への相対ベクトル」を持たせ、8 近傍の 2 走査で伝播させる。
 */
function distanceTo(mask: Uint8Array, res: number, target: number): Float64Array {
  const dx = new Float64Array(res * res)
  const dy = new Float64Array(res * res)
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === target) continue
    dx[i] = FAR
    dy[i] = FAR
  }

  const compare = (x: number, y: number, ox: number, oy: number): void => {
    const nx = x + ox
    const ny = y + oy
    if (nx < 0 || ny < 0 || nx >= res || ny >= res) return
    const here = y * res + x
    const there = ny * res + nx
    // 隣の画素が指す先へ、こちらから隣への差分を足したものが候補になる
    const cx = dx[there]! + ox
    const cy = dy[there]! + oy
    if (cx * cx + cy * cy < dx[here]! * dx[here]! + dy[here]! * dy[here]!) {
      dx[here] = cx
      dy[here] = cy
    }
  }

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      compare(x, y, -1, 0)
      compare(x, y, 0, -1)
      compare(x, y, -1, -1)
      compare(x, y, 1, -1)
    }
    for (let x = res - 1; x >= 0; x--) compare(x, y, 1, 0)
  }
  for (let y = res - 1; y >= 0; y--) {
    for (let x = res - 1; x >= 0; x--) {
      compare(x, y, 1, 0)
      compare(x, y, 0, 1)
      compare(x, y, 1, 1)
      compare(x, y, -1, 1)
    }
    for (let x = 0; x < res; x++) compare(x, y, -1, 0)
  }

  const out = new Float64Array(res * res)
  for (let i = 0; i < out.length; i++) out[i] = Math.hypot(dx[i]!, dy[i]!)
  return out
}

/**
 * 1 字ぶんの距離場。`SDF_RES * SDF_RES` の 8bit で、
 * 0.5 = 輪郭上、1 に近いほど内側、0 に近いほど外側（`SDF_SPREAD` で飽和）。
 * 行は下から上（three のテクスチャ座標に合わせる）。
 */
export function buildSdf(positions: Float32Array, indices: Uint32Array): Uint8Array {
  const hi = SDF_RES * SUPERSAMPLE
  const mask = rasterize(positions, indices, hi)
  const outer = distanceTo(mask, hi, 1)
  const inner = distanceTo(mask, hi, 0)

  /** 画素 → 字面座標。この倍率で距離を実寸へ戻す */
  const unit = (2 * SDF_EXTENT) / hi

  const out = new Uint8Array(SDF_RES * SDF_RES)
  for (let y = 0; y < SDF_RES; y++) {
    for (let x = 0; x < SDF_RES; x++) {
      // 距離は滑らかなので、超解像から平均で落として構わない
      let sum = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const i = (y * SUPERSAMPLE + sy) * hi + (x * SUPERSAMPLE + sx)
          sum += (outer[i]! - inner[i]!) * unit
        }
      }
      const signed = sum / (SUPERSAMPLE * SUPERSAMPLE)
      const encoded = 0.5 - signed / (2 * SDF_SPREAD)
      out[y * SDF_RES + x] = Math.round(Math.max(0, Math.min(1, encoded)) * 255)
    }
  }
  return out
}
