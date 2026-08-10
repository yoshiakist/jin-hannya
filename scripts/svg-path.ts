/**
 * SVG パスの最小パーサ / フラット化。
 *
 * assets/svg/*.svg（Figma 由来）と assets/pattern/circle.svg（potrace 由来）を読むためだけの実装。
 * 依存を増やさず、かつ扱う SVG の形式が README「アセット在庫」で固定されているので自前で持つ。
 * 対応コマンド: M m L l H h V v C c S s Q q T t Z z（円弧 A は上記 2 系統の出力に現れないため未対応）
 */

export interface Vec2 {
  x: number
  y: number
}

/** 3 次ベジエ 1 本あたりの分割数。字形の輪郭は小さいのでこの程度で十分滑らか */
const CURVE_SEGMENTS = 12

const NUMBER_RE = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g

function parseCommands(d: string): { code: string; args: number[] }[] {
  const out: { code: string; args: number[] }[] = []
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? []
  let i = 0
  let code = ''
  while (i < tokens.length) {
    const token = tokens[i]!
    if (/[A-Za-z]/.test(token)) {
      code = token
      i++
    } else if (!code) {
      throw new Error(`パスが数値で始まっている: ${d.slice(0, 40)}`)
    }
    const arity = ARITY[code.toUpperCase()]
    if (arity === undefined) throw new Error(`未対応のパスコマンド: ${code}`)
    const args: number[] = []
    for (let k = 0; k < arity; k++) {
      const value = tokens[i + k]
      if (value === undefined || /[A-Za-z]/.test(value)) {
        throw new Error(`${code} の引数が足りない`)
      }
      args.push(Number(value))
    }
    i += arity
    out.push({ code, args })
    // 連続する数値の並びは同じコマンドの繰り返し（M の繰り返しは L 扱いが SVG の規定）
    if (code === 'M') code = 'L'
    else if (code === 'm') code = 'l'
  }
  return out
}

const ARITY: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 4,
  Z: 0,
}
// T は本来 2 引数。上表では扱わず、下の switch で個別に処理する
ARITY.T = 2

function cubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const e = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + e * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + e * p3.y,
  }
}

/**
 * `d` 属性を閉じた輪郭（点列）の配列へ変換する。
 * 塗り図形しか扱わないため、開いたサブパスも終点と始点を結んで閉じる。
 */
export function flattenPath(d: string): Vec2[][] {
  return flatten(d, 3)
}

/**
 * `d` 属性を**開いたまま**の折れ線の配列へ変換する。
 * `*_path.svg`（筆順の中心線）は塗りではなく運びなので、閉じずに 1 本 2 点から拾う。
 * サブパスの並びがそのまま画の順になる。
 */
export function flattenPolylines(d: string): Vec2[][] {
  return flatten(d, 2)
}

function flatten(d: string, minPoints: number): Vec2[][] {
  const contours: Vec2[][] = []
  let current: Vec2[] = []
  let cursor: Vec2 = { x: 0, y: 0 }
  let start: Vec2 = { x: 0, y: 0 }
  let lastControl: Vec2 | null = null

  const push = (p: Vec2) => {
    const prev = current[current.length - 1]
    if (prev && Math.abs(prev.x - p.x) < 1e-9 && Math.abs(prev.y - p.y) < 1e-9) return
    current.push(p)
  }
  const finish = () => {
    if (current.length >= minPoints) contours.push(current)
    current = []
  }

  for (const { code, args } of parseCommands(d)) {
    const rel = code === code.toLowerCase()
    const ox = rel ? cursor.x : 0
    const oy = rel ? cursor.y : 0

    switch (code.toUpperCase()) {
      case 'M': {
        finish()
        cursor = { x: args[0]! + ox, y: args[1]! + oy }
        start = cursor
        push(cursor)
        lastControl = null
        break
      }
      case 'L': {
        cursor = { x: args[0]! + ox, y: args[1]! + oy }
        push(cursor)
        lastControl = null
        break
      }
      case 'H': {
        cursor = { x: args[0]! + ox, y: cursor.y }
        push(cursor)
        lastControl = null
        break
      }
      case 'V': {
        cursor = { x: cursor.x, y: args[0]! + oy }
        push(cursor)
        lastControl = null
        break
      }
      case 'C':
      case 'S': {
        let c1: Vec2
        let c2: Vec2
        let end: Vec2
        if (code.toUpperCase() === 'C') {
          c1 = { x: args[0]! + ox, y: args[1]! + oy }
          c2 = { x: args[2]! + ox, y: args[3]! + oy }
          end = { x: args[4]! + ox, y: args[5]! + oy }
        } else {
          // S は直前の制御点を現在点で反射したものを第 1 制御点にする
          c1 = lastControl
            ? { x: 2 * cursor.x - lastControl.x, y: 2 * cursor.y - lastControl.y }
            : cursor
          c2 = { x: args[0]! + ox, y: args[1]! + oy }
          end = { x: args[2]! + ox, y: args[3]! + oy }
        }
        for (let s = 1; s <= CURVE_SEGMENTS; s++) {
          push(cubic(cursor, c1, c2, end, s / CURVE_SEGMENTS))
        }
        lastControl = c2
        cursor = end
        break
      }
      case 'Q':
      case 'T': {
        let q: Vec2
        let end: Vec2
        if (code.toUpperCase() === 'Q') {
          q = { x: args[0]! + ox, y: args[1]! + oy }
          end = { x: args[2]! + ox, y: args[3]! + oy }
        } else {
          q = lastControl
            ? { x: 2 * cursor.x - lastControl.x, y: 2 * cursor.y - lastControl.y }
            : cursor
          end = { x: args[0]! + ox, y: args[1]! + oy }
        }
        // 2 次を 3 次へ昇格させて共通経路に流す
        const c1 = { x: cursor.x + (2 / 3) * (q.x - cursor.x), y: cursor.y + (2 / 3) * (q.y - cursor.y) }
        const c2 = { x: end.x + (2 / 3) * (q.x - end.x), y: end.y + (2 / 3) * (q.y - end.y) }
        for (let s = 1; s <= CURVE_SEGMENTS; s++) {
          push(cubic(cursor, c1, c2, end, s / CURVE_SEGMENTS))
        }
        lastControl = q
        cursor = end
        break
      }
      case 'Z': {
        finish()
        cursor = start
        lastControl = null
        break
      }
    }
  }
  finish()
  return contours
}

/** 符号付き面積。正なら反時計回り（SVG の Y 下向き座標系では時計回りに見える） */
export function signedArea(points: Vec2[]): number {
  let sum = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += (points[j]!.x - points[i]!.x) * (points[j]!.y + points[i]!.y)
  }
  return sum / 2
}

export function pointInContour(p: Vec2, contour: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
    const a = contour[i]!
    const b = contour[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

export interface Region {
  contour: Vec2[]
  holes: Vec2[][]
}

/**
 * 輪郭群を「外側 + 穴」の組へ分類する。
 * 偶奇則: 他の輪郭に含まれる回数が偶数なら外側、奇数なら穴。
 * 対象の SVG は入れ子の深さが 2 を超えないため、これで十分。
 */
export function toRegions(contours: Vec2[][]): Region[] {
  const depth = contours.map((c) => {
    const probe = c[0]!
    let count = 0
    for (const other of contours) {
      if (other === c) continue
      if (pointInContour(probe, other)) count++
    }
    return count
  })

  const regions: Region[] = contours
    .map((contour): Region => ({ contour, holes: [] }))
    .filter((_, i) => depth[i]! % 2 === 0)

  for (let i = 0; i < contours.length; i++) {
    if (depth[i]! % 2 === 0) continue
    const hole = contours[i]!
    // 最も小さい外側領域に属させる
    let best: Region | null = null
    let bestArea = Infinity
    for (const region of regions) {
      if (!pointInContour(hole[0]!, region.contour)) continue
      const area = Math.abs(signedArea(region.contour))
      if (area < bestArea) {
        bestArea = area
        best = region
      }
    }
    if (best) best.holes.push(hole)
  }
  return regions
}

/** `transform="translate(a,b) scale(c,d)"` を読む。circle.svg の Y 反転に必要 */
export function parseTransform(transform: string | null | undefined): {
  tx: number
  ty: number
  sx: number
  sy: number
} {
  const result = { tx: 0, ty: 0, sx: 1, sy: 1 }
  if (!transform) return result
  const translate = /translate\(([^)]*)\)/.exec(transform)
  if (translate) {
    const [a, b] = (translate[1]!.match(NUMBER_RE) ?? []).map(Number)
    result.tx = a ?? 0
    result.ty = b ?? 0
  }
  const scale = /scale\(([^)]*)\)/.exec(transform)
  if (scale) {
    const [a, b] = (scale[1]!.match(NUMBER_RE) ?? []).map(Number)
    result.sx = a ?? 1
    result.sy = b ?? result.sx ?? 1
  }
  return result
}
