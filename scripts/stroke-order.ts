/**
 * 筆順パラメータ場の前計算。
 *
 * `assets/svg/<字>_path.svg` は字形の塗りではなく**筆の運び**（中心線）で、
 * サブパスの並びがそのまま画の順になっている。これを 1 枚のスカラー場へ焼いておくと、
 * 実行時は塗りのグリフを 1 テクセル引くだけで「その画素が何番目に書かれるか」が分かり、
 * 筆順どおりに墨を置いていける（→ skill: ink-visuals）。
 *
 * 格納するのは **0〜1 の運びのパラメータ**。0 = 最初の画の起筆、1 = 最後の画の終筆で、
 * 各画素には最寄りの中心線上の点のパラメータが入る。画と画の間には筆を上げる間（`LIFT_RATIO`）を
 * 挟んであり、そこに落ちるパラメータはどの画素も取らない。画ごとの区間（`spans`）も一緒に返すので、
 * 実行時はその隙間で進行を止めれば、間の長さを尺（ミリ秒）で決められる（→ Splash.tsx）。
 *
 * SDF（scripts/sdf.ts）と同じセル配置・同じ覆う範囲（`ORDER_EXTENT` = `SDF_EXTENT`）にしてあり、
 * 塗りのメッシュからも滲み用の板からも同じ uv で引ける。
 */

import { SDF_EXTENT } from './sdf.ts'
import type { Vec2 } from './svg-path.ts'

/** 1 字あたりのテクセル数（一辺）。運びの前後関係は輪郭より細かい判別が要るので SDF より高い */
export const ORDER_RES = 192
/** セルが覆う字面座標の半径。SDF と揃える（滲みの板と同じ uv で引くため） */
export const ORDER_EXTENT = SDF_EXTENT
/** 画と画の間（筆を上げている間）。1 画の平均の長さに対する比 */
const LIFT_RATIO = 0.14

interface Segment {
  ax: number
  ay: number
  /** 終点への差分 */
  dx: number
  dy: number
  /** 差分の長さの二乗。0 除算を避けるため下限で丸めてある */
  lengthSq: number
  /** 起点・終点のパラメータ（0〜1） */
  t0: number
  t1: number
}

function polylineLength(points: Vec2[]): number {
  let length = 0
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y)
  }
  return length
}

export interface StrokeOrder {
  /** 筆順パラメータ場（`ORDER_RES * ORDER_RES` の 8bit、行は下から上） */
  field: Uint8Array
  /** 画ごとの運びの区間 `[起筆, 終筆]`（0〜1）。区間と区間の隙間が筆を上げている間 */
  spans: [number, number][]
}

/**
 * 画（折れ線）の列を線分の列へ均し、通し番号のパラメータを振る。
 * `strokes` は字面座標（[-0.5, 0.5]^2、Y 上向き）で、並びが筆順。
 */
function toSegments(strokes: Vec2[][]): { segments: Segment[]; spans: [number, number][] } {
  const lengths = strokes.map(polylineLength)
  const drawn = lengths.reduce((a, b) => a + b, 0)
  if (drawn <= 0) throw new Error('筆順のパスに長さが無い')

  const lift = (drawn / strokes.length) * LIFT_RATIO
  const total = drawn + lift * (strokes.length - 1)

  const segments: Segment[] = []
  const spans: [number, number][] = []
  let cursor = 0
  strokes.forEach((points, s) => {
    spans.push([cursor / total, (cursor + lengths[s]!) / total])
    let walked = 0
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!
      const b = points[i]!
      const dx = b.x - a.x
      const dy = b.y - a.y
      const length = Math.hypot(dx, dy)
      if (length === 0) continue
      segments.push({
        ax: a.x,
        ay: a.y,
        dx,
        dy,
        lengthSq: Math.max(dx * dx + dy * dy, 1e-12),
        t0: (cursor + walked) / total,
        t1: (cursor + walked + length) / total,
      })
      walked += length
    }
    cursor += lengths[s]! + lift
  })

  if (segments.length === 0) throw new Error('筆順のパスから線分が取れない')
  return { segments, spans }
}

/** テクセル中心 → 字面座標 */
function toGlyph(i: number): number {
  return ((i + 0.5) / ORDER_RES) * (2 * ORDER_EXTENT) - ORDER_EXTENT
}

/**
 * 1 字ぶんの筆順パラメータ場（`ORDER_RES * ORDER_RES` の 8bit）。
 * 行は下から上（three のテクスチャ座標に合わせる）。
 *
 * 各画素は「最寄りの中心線上の点」のパラメータを取る。画が交わるところでは
 * 近い側の画に属することになり、後から書いた画が前の画を跨ぐ形も素直に出る。
 */
export function buildStrokeOrder(strokes: Vec2[][]): StrokeOrder {
  const { segments, spans } = toSegments(strokes)
  const out = new Uint8Array(ORDER_RES * ORDER_RES)

  for (let y = 0; y < ORDER_RES; y++) {
    const py = toGlyph(y)
    for (let x = 0; x < ORDER_RES; x++) {
      const px = toGlyph(x)
      let best = Infinity
      let bestT = 0
      for (const s of segments) {
        const wx = px - s.ax
        const wy = py - s.ay
        // 線分上へ射影する。両端の外はそれぞれ端点への距離になる
        const u = Math.max(0, Math.min(1, (wx * s.dx + wy * s.dy) / s.lengthSq))
        const ex = wx - u * s.dx
        const ey = wy - u * s.dy
        const distance = ex * ex + ey * ey
        if (distance < best) {
          best = distance
          bestT = s.t0 + (s.t1 - s.t0) * u
        }
      }
      out[y * ORDER_RES + x] = Math.round(Math.max(0, Math.min(1, bestT)) * 255)
    }
  }

  return { field: out, spans }
}
