/**
 * SVG → メッシュ + 粒子サンプルの前計算。
 *
 * README「グリフの扱い（演出の核）」より。
 * ランタイムで SVG をサンプリングしないのがスマホ性能上の要点なので、
 * 三角形分割も粒子サンプリングもここで済ませ、バイナリで同梱する。
 *
 * 出力
 *   public/glyphs/mesh.<hash>.bin      … 頂点座標(f32 xy) + インデックス(u32) を全字ぶん連結
 *   public/glyphs/particles.<hash>.bin … 粒子ホームポジション(f32 xy) を全字ぶん連結
 *   public/glyphs/sdf.<hash>.bin       … 符号付き距離場(u8) を 1 枚のアトラスに敷き詰めたもの
 *   public/glyphs/order.<hash>.bin     … 筆順パラメータ場(u8)。`<字>_path.svg` がある字だけ
 *   src/generated/glyphs.json          … 上記へのオフセット表（`files` に実ファイル名と寸法）
 *
 * **bin の名前には中身のハッシュを入れる。** オフセット表はハッシュ付きの JS へ焼かれるので、
 * bin が固定名だと「新しいオフセット表 × キャッシュに残った古い bin」の組が成立してしまい、
 * 字を 1 つ足して出し直した先で再訪問者だけが範囲外アクセスで落ちる。
 *
 * 座標系は three に合わせて **Y 上向き**、字面が `[-0.5, 0.5]^2` に収まるよう正規化する。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { ShapeUtils, Vector2 } from 'three'
import { flattenPath, flattenPolylines, toRegions, parseTransform, signedArea, type Vec2 } from './svg-path.ts'
import { buildSdf, SDF_RES, SDF_EXTENT, SDF_SPREAD } from './sdf.ts'
import { buildStrokeOrder, ORDER_RES, ORDER_EXTENT, type StrokeOrder } from './stroke-order.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SVG_DIR = join(ROOT, 'assets/svg')
const PATTERN_DIR = join(ROOT, 'assets/pattern')
const OUT_BIN = join(ROOT, 'public/glyphs')
const OUT_TS = join(ROOT, 'src/generated')

/**
 * bin を `<名前>.<中身のハッシュ>.bin` で書き出し、索引に載せる分（名前と長さ）を返す。
 * 長さも持たせるのは、取ってきた bin が索引と組で正しいかをランタイムが確かめられるようにするため。
 */
function emit(name: string, data: Buffer): { name: string; bytes: number } {
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 8)
  const file = `${name}.${hash}.bin`
  writeFileSync(join(OUT_BIN, file), data)
  return { name: file, bytes: data.byteLength }
}

/** 1 文字あたりの粒子数。README の見積り（111 字 × 4,000 点 ≒ 45 万点）に合わせる */
const PARTICLES_PER_GLYPH = 4000
/** 円相は面積が大きいので多めに配る */
const PARTICLES_FOR_CIRCLE = 20000

/** SDF アトラスの列数。行数は字数から決まる */
const SDF_COLUMNS = 16
/** 筆順アトラスの列数。載るのは `<字>_path.svg` を用意した数字だけなので細く取る */
const ORDER_COLUMNS = 4

/** 筆順の中心線を持つ SVG の接尾辞。塗りのグリフとしては読まない */
const PATH_SUFFIX = '_path'

interface Built {
  key: string
  positions: Float32Array
  indices: Uint32Array
  particles: Float32Array
  /** 符号付き距離場 1 字ぶん（SDF_RES × SDF_RES の u8、下から上） */
  sdf: Uint8Array
  /** 筆順パラメータ場 1 字ぶん + 画ごとの区間（`<字>_path.svg` があるときだけ） */
  order: StrokeOrder | null
}

function readSvg(path: string): { viewBox: [number, number, number, number]; paths: string[]; transform: string | null } {
  const source = readFileSync(path, 'utf8')

  const viewBoxAttr = /viewBox="([^"]+)"/.exec(source)?.[1]
  if (!viewBoxAttr) throw new Error(`${path}: viewBox が無い`)
  const vb = viewBoxAttr.trim().split(/[\s,]+/).map(Number)
  if (vb.length !== 4 || vb.some(Number.isNaN)) throw new Error(`${path}: viewBox が読めない`)

  // <clipPath> 内の <rect> は形状ではないので拾わない。<path d="..."> のみを対象にする
  const paths = [...source.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((m) => m[1]!)
  if (paths.length === 0) throw new Error(`${path}: <path d> が無い`)

  const transform = /<g\b[^>]*\btransform="([^"]+)"/.exec(source)?.[1] ?? null

  return { viewBox: vb as [number, number, number, number], paths, transform }
}

/**
 * ほぼ重なった点を落とす。
 * potrace 出力（circle.svg）は近接点が非常に多く、そのまま earcut に渡すと
 * 穴の橋渡しが破綻して巨大な偽の三角形が出る。正規化後の座標で判定する。
 */
const MERGE_EPS = 2e-4

function simplify(points: Vec2[]): Vec2[] {
  const merged: Vec2[] = []
  for (const p of points) {
    const last = merged[merged.length - 1]
    if (last && Math.abs(last.x - p.x) < MERGE_EPS && Math.abs(last.y - p.y) < MERGE_EPS) continue
    merged.push(p)
  }
  // 先頭と末尾も重なっていれば閉じているとみなして片方を落とす
  while (merged.length > 1) {
    const first = merged[0]!
    const last = merged[merged.length - 1]!
    if (Math.abs(first.x - last.x) < MERGE_EPS && Math.abs(first.y - last.y) < MERGE_EPS) merged.pop()
    else break
  }

  return merged
}

/** 三角形の面積で重み付けして内部に一様分布する点を取る */
function sampleTriangles(positions: Float32Array, indices: Uint32Array, count: number, seed: number): Float32Array {
  const triangleCount = indices.length / 3
  const cumulative = new Float64Array(triangleCount)
  let total = 0
  for (let t = 0; t < triangleCount; t++) {
    const ia = indices[t * 3]! * 2
    const ib = indices[t * 3 + 1]! * 2
    const ic = indices[t * 3 + 2]! * 2
    const area = Math.abs(
      (positions[ib]! - positions[ia]!) * (positions[ic + 1]! - positions[ia + 1]!) -
        (positions[ic]! - positions[ia]!) * (positions[ib + 1]! - positions[ia + 1]!),
    ) / 2
    total += area
    cumulative[t] = total
  }

  // 決定的な擬似乱数（mulberry32）。ビルドの再現性を保つため Math.random は使わない
  let state = seed >>> 0
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let z = state
    z = Math.imul(z ^ (z >>> 15), z | 1)
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296
  }

  const out = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    // 二分探索で面積比に応じた三角形を選ぶ
    const target = random() * total
    let lo = 0
    let hi = triangleCount - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cumulative[mid]! < target) lo = mid + 1
      else hi = mid
    }
    const ia = indices[lo * 3]! * 2
    const ib = indices[lo * 3 + 1]! * 2
    const ic = indices[lo * 3 + 2]! * 2

    let u = random()
    let v = random()
    if (u + v > 1) {
      u = 1 - u
      v = 1 - v
    }
    const w = 1 - u - v
    out[i * 2] = w * positions[ia]! + u * positions[ib]! + v * positions[ic]!
    out[i * 2 + 1] = w * positions[ia + 1]! + u * positions[ib + 1]! + v * positions[ic + 1]!
  }
  return out
}

/**
 * SVG のユーザ座標 → 字面ローカル座標（[-0.5, 0.5]^2、Y 上向き）への写像。
 * 塗りのグリフと筆順の中心線は同じ viewBox なので、同じ写像を通せば重なる。
 */
function localizer(viewBox: [number, number, number, number], transform: string | null) {
  const { tx, ty, sx, sy } = parseTransform(transform)
  const [vx, vy, vw, vh] = viewBox
  // 長辺を 1 に揃えてアスペクトを保つ。circle.svg は正確な正方形ではない
  const scale = 1 / Math.max(vw, vh)

  return (p: Vec2): Vec2 => {
    const x = p.x * sx + tx
    const y = p.y * sy + ty
    return {
      // 中心原点へ寄せ、Y は SVG（下向き）から three（上向き）へ反転
      x: (x - vx - vw / 2) * scale,
      y: -(y - vy - vh / 2) * scale,
    }
  }
}

/** `<字>_path.svg` を読み、筆順どおりに並んだ画（字面ローカルの折れ線）を返す */
function readStrokes(file: string): Vec2[][] {
  const { viewBox, paths, transform } = readSvg(file)
  const toLocal = localizer(viewBox, transform)
  const strokes = paths.flatMap((d) => flattenPolylines(d)).map((points) => points.map(toLocal))
  if (strokes.length === 0) throw new Error(`${file}: 画が 1 本も取れない`)
  return strokes
}

function build(key: string, file: string, particleCount: number, seed: number, orderFile?: string): Built {
  const { viewBox, paths, transform } = readSvg(file)
  const toLocal = localizer(viewBox, transform)

  const contours = paths
    .flatMap((d) => flattenPath(d))
    .map((c) => simplify(c.map(toLocal)))
    .filter((c) => c.length >= 3)
  const regions = toRegions(contours)

  const positions: number[] = []
  const indices: number[] = []
  for (const region of regions) {
    // triangulateShape は輪郭が反時計回り・穴が時計回りであることを前提にする
    const contour = signedArea(region.contour) < 0 ? [...region.contour].reverse() : region.contour
    const holes = region.holes.map((h) => (signedArea(h) > 0 ? [...h].reverse() : h))

    const base = positions.length / 2
    const flat = [contour, ...holes].flat()
    for (const p of flat) positions.push(p.x, p.y)

    // triangulateShape は Vector2 のメソッド（equals）を使うため、素の {x,y} では渡せない
    const toVec2 = (points: Vec2[]) => points.map((p) => new Vector2(p.x, p.y))
    for (const tri of ShapeUtils.triangulateShape(toVec2(contour), holes.map(toVec2))) {
      indices.push(base + tri[0]!, base + tri[1]!, base + tri[2]!)
    }
  }

  if (indices.length === 0) throw new Error(`${file}: 三角形が 1 つも生成されなかった`)

  const positionArray = new Float32Array(positions)
  const indexArray = new Uint32Array(indices)
  return {
    key,
    positions: positionArray,
    indices: indexArray,
    particles: sampleTriangles(positionArray, indexArray, particleCount, seed),
    sdf: buildSdf(positionArray, indexArray),
    order: orderFile ? buildStrokeOrder(readStrokes(orderFile)) : null,
  }
}

function main(): void {
  const svgFiles = readdirSync(SVG_DIR)
    .filter((f) => f.endsWith('.svg'))
    .sort()
  // 筆順の中心線は塗りではないので、グリフとしては読まない
  const glyphFiles = svgFiles.filter((f) => !basename(f, '.svg').endsWith(PATH_SUFFIX))

  const built: Built[] = []
  const failures: string[] = []

  glyphFiles.forEach((file, i) => {
    const key = basename(file, '.svg')
    const orderFile = join(SVG_DIR, `${key}${PATH_SUFFIX}.svg`)
    try {
      built.push(
        build(key, join(SVG_DIR, file), PARTICLES_PER_GLYPH, i + 1, existsSync(orderFile) ? orderFile : undefined),
      )
    } catch (error) {
      failures.push(`${file}: ${(error as Error).message}`)
    }
  })

  // 塗りの無い筆順は引きようがない。取りこぼしに気づけるよう落とす
  for (const file of svgFiles) {
    const key = basename(file, '.svg')
    if (!key.endsWith(PATH_SUFFIX)) continue
    const base = key.slice(0, -PATH_SUFFIX.length)
    if (!glyphFiles.includes(`${base}.svg`)) failures.push(`${file}: 対になる ${base}.svg が無い`)
  }

  try {
    built.push(build('@circle', join(PATTERN_DIR, 'circle.svg'), PARTICLES_FOR_CIRCLE, 9001))
  } catch (error) {
    failures.push(`circle.svg: ${(error as Error).message}`)
  }

  if (failures.length > 0) {
    console.error('グリフのビルドに失敗:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }

  // --- バイナリへ連結 ---
  const meshBytes = built.reduce((n, g) => n + g.positions.byteLength + g.indices.byteLength, 0)
  const particleBytes = built.reduce((n, g) => n + g.particles.byteLength, 0)
  const mesh = Buffer.alloc(meshBytes)
  const particles = Buffer.alloc(particleBytes)

  // SDF は 1 枚のアトラスへ。字ごとにテクスチャを持つと描画呼び出しごとに束ね直すことになる
  const sdfRows = Math.ceil(built.length / SDF_COLUMNS)
  const sdfWidth = SDF_COLUMNS * SDF_RES
  const sdfHeight = sdfRows * SDF_RES
  const sdf = Buffer.alloc(sdfWidth * sdfHeight)

  let meshOffset = 0
  let particleOffset = 0
  const index: Record<string, unknown> = {}

  built.forEach((g, cell) => {
    const column = cell % SDF_COLUMNS
    const row = Math.floor(cell / SDF_COLUMNS)
    for (let y = 0; y < SDF_RES; y++) {
      const dest = (row * SDF_RES + y) * sdfWidth + column * SDF_RES
      sdf.set(g.sdf.subarray(y * SDF_RES, (y + 1) * SDF_RES), dest)
    }
  })

  // 筆順は用意した字だけの別アトラス。全字ぶん取ると使わない面が大半になる
  const ordered = built.filter((g) => g.order)
  const orderCells = new Map(ordered.map((g, cell) => [g.key, cell]))
  const orderRows = Math.ceil(ordered.length / ORDER_COLUMNS)
  const orderWidth = ORDER_COLUMNS * ORDER_RES
  const order = Buffer.alloc(orderWidth * orderRows * ORDER_RES)
  ordered.forEach((g, cell) => {
    const column = cell % ORDER_COLUMNS
    const row = Math.floor(cell / ORDER_COLUMNS)
    for (let y = 0; y < ORDER_RES; y++) {
      const dest = (row * ORDER_RES + y) * orderWidth + column * ORDER_RES
      order.set(g.order!.field.subarray(y * ORDER_RES, (y + 1) * ORDER_RES), dest)
    }
  })

  for (const [cell, g] of built.entries()) {
    const positionOffset = meshOffset
    Buffer.from(g.positions.buffer, g.positions.byteOffset, g.positions.byteLength).copy(mesh, meshOffset)
    meshOffset += g.positions.byteLength
    const indexOffset = meshOffset
    Buffer.from(g.indices.buffer, g.indices.byteOffset, g.indices.byteLength).copy(mesh, meshOffset)
    meshOffset += g.indices.byteLength

    Buffer.from(g.particles.buffer, g.particles.byteOffset, g.particles.byteLength).copy(particles, particleOffset)

    index[g.key] = {
      positionOffset,
      vertexCount: g.positions.length / 2,
      indexOffset,
      indexCount: g.indices.length,
      particleOffset,
      particleCount: g.particles.length / 2,
      sdfCell: cell,
      // 筆順を持たない字は -1。シェーダ側はこれを見て運びの判定を素通りさせる
      orderCell: orderCells.get(g.key) ?? -1,
      // 画ごとの [起筆, 終筆] を平らに並べたもの。持たない字は空
      strokeSpans: (g.order?.spans ?? []).flat().map((t) => Number(t.toFixed(5))),
    }
    particleOffset += g.particles.byteLength
  }

  mkdirSync(OUT_BIN, { recursive: true })
  mkdirSync(OUT_TS, { recursive: true })
  // 前回のハッシュ付き bin は残しておくと出力に溜まり続けるので毎回掃く
  for (const file of readdirSync(OUT_BIN)) {
    if (file.endsWith('.bin')) rmSync(join(OUT_BIN, file))
  }
  const files = {
    mesh: emit('mesh', mesh),
    particles: emit('particles', particles),
    sdf: emit('sdf', sdf),
    order: emit('order', order),
  }
  writeFileSync(
    join(OUT_TS, 'glyphs.json'),
    JSON.stringify(
      {
        particlesPerGlyph: PARTICLES_PER_GLYPH,
        // ランタイムはここに書かれた名前だけを取りに行く（固定名では引かない）
        files,
        sdf: {
          res: SDF_RES,
          columns: SDF_COLUMNS,
          rows: sdfRows,
          extent: SDF_EXTENT,
          spread: SDF_SPREAD,
        },
        order: {
          res: ORDER_RES,
          columns: ORDER_COLUMNS,
          rows: orderRows,
          extent: ORDER_EXTENT,
          count: ordered.length,
        },
        glyphs: index,
      },
      null,
      2,
    ) + '\n',
  )

  const totalParticles = built.reduce((n, g) => n + g.particles.length / 2, 0)
  console.log(
    `glyphs: ${built.length} 件 / mesh ${(meshBytes / 1e6).toFixed(2)}MB / ` +
      `particles ${(particleBytes / 1e6).toFixed(2)}MB (${totalParticles.toLocaleString()} 点) / ` +
      `sdf ${(sdf.byteLength / 1e6).toFixed(2)}MB (${sdfWidth}x${sdfHeight}) / ` +
      `order ${ordered.length} 字 (${ordered.map((g) => g.key).join('')})`,
  )
}

main()
