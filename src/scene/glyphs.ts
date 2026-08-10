/**
 * 前計算済みグリフ（メッシュ + 粒子サンプル）の読み込み。
 *
 * 実体は scripts/build-glyphs.ts が吐いた public/glyphs/*.bin。
 * ランタイムでは SVG を一切触らない（README「グリフの扱い」）。
 */

import {
  BufferGeometry,
  BufferAttribute,
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RedFormat,
  UnsignedByteType,
} from 'three'
import glyphIndex from '../generated/glyphs.json'

interface GlyphEntry {
  positionOffset: number
  vertexCount: number
  indexOffset: number
  indexCount: number
  particleOffset: number
  particleCount: number
  /** Tier 2 用に間引いたぶんの位置と数（`particles-lo` の中でのバイト位置） */
  particleLowOffset: number
  particleLowCount: number
  /** SDF アトラス上のセル番号 */
  sdfCell: number
  /** 筆順アトラス上のセル番号。中心線（`<字>_path.svg`）を持たない字は -1 */
  orderCell: number
  /** 画ごとの [起筆, 終筆]（0〜1）を平らに並べたもの。中心線を持たない字は空 */
  strokeSpans: number[]
}

const entries = glyphIndex.glyphs as Record<string, GlyphEntry>

/**
 * SDF アトラスの寸法。`scripts/sdf.ts` の定数がそのまま焼かれている。
 * `extent` はセルが覆う字面座標の半径（字面は 0.5）、`spread` は距離が飽和するまでの幅。
 */
export const SDF = glyphIndex.sdf as {
  res: number
  columns: number
  rows: number
  extent: number
  spread: number
}

/**
 * 筆順アトラスの寸法（`scripts/stroke-order.ts` の定数の写し）。
 * `count` が 0 なら中心線を用意した字が 1 つも無い＝アトラスが空。
 */
export const ORDER = glyphIndex.order as {
  res: number
  columns: number
  rows: number
  extent: number
  count: number
}

/**
 * bin の実ファイル名と長さ。名前には中身のハッシュが入っている（→ scripts/build-glyphs.ts）。
 * この索引はハッシュ付きの JS に焼かれるので、bin 側も名前が変われば古い版と混ざりようがない。
 */
const FILES = glyphIndex.files as Record<
  'mesh' | 'particlesLow' | 'particlesHigh' | 'sdf' | 'order',
  { name: string; bytes: number }
>

/** 円相（assets/pattern/circle.svg）はグリフと同じ経路で載せる。字ではないので別キー */
export const CIRCLE_KEY = '@circle'

let meshBuffer: ArrayBuffer | null = null
let particleBuffer: ArrayBuffer | null = null
/** 取った粒子がどちらのファイルか。字ごとのオフセットが別なので取り違えられない */
let particleQuality: 'low' | 'high' | null = null
let sdfBuffer: ArrayBuffer | null = null
let orderBuffer: ArrayBuffer | null = null
let loading: Promise<void> | null = null
let loadingParticles: Promise<void> | null = null

/**
 * bin を 1 本取る。取れなかった場合・索引と長さが食い違う場合は投げる。
 * 長さの照合は、キャッシュや配信の都合で索引と違う版の bin が返ってきた場合の歯止め
 * （そのまま使うと、字ごとのオフセットが実体の外を指して `RangeError` で画面ごと落ちる）。
 */
async function fetchBin(file: { name: string; bytes: number }): Promise<ArrayBuffer> {
  const response = await fetch(`/glyphs/${file.name}`)
  if (!response.ok) throw new Error(`[glyphs] ${file.name} が取れない (HTTP ${response.status})`)
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength !== file.bytes) {
    throw new Error(`[glyphs] ${file.name} の長さが索引と違う (${buffer.byteLength} ≠ ${file.bytes})`)
  }
  return buffer
}

/**
 * **起動を止めるのは最初の一画面に要るものだけ**にする。ここが解決するまで Canvas ごと
 * マウントされないので、待たせたぶんそのまま黒い画面になる（いちばん見せたいロゴの手前で）。
 * 粒子は最初の遷移まで要らないので `loadParticles` へ回す。
 *
 * 失敗したら reject する。呼び手（Stage）はそれを拾って DOM の紙面へ落とすこと
 * （拾わないと ready が立たないまま真っ黒になる）。
 */
export function loadGlyphs(): Promise<void> {
  if (!loading) {
    loading = Promise.all([
      fetchBin(FILES.mesh),
      fetchBin(FILES.sdf),
      // 筆順は数字ぶんしか無い（空のこともある）。他と同じく起動時に 1 度だけ取る
      ORDER.count > 0 ? fetchBin(FILES.order) : Promise.resolve(null),
    ])
      .then(([mesh, sdf, order]) => {
        meshBuffer = mesh
        sdfBuffer = sdf
        orderBuffer = order
      })
      .catch((error) => {
        // 次のマウントで取り直せるよう、失敗した約束は握らない
        loading = null
        throw error
      })
  }
  return loading
}

/**
 * 遷移の粒子を**あとから**取る。ティアが決まってから呼ぶこと（Tier 2 は 1 字 400 点しか使わず、
 * 全量を渡しても捨てるだけなので、間引いた側だけ取る）。
 *
 * 着く前に遷移が起きても演出は崩れない（`glyphParticles` が null を返し、その回だけ粒子が出ない）。
 * 起動を止めてまで待つ価値は無いので、失敗しても紙面は落とさず黙って粒子無しで進む。
 */
export function loadParticles(tier: 1 | 2 | 3): Promise<void> {
  if (tier === 3) return Promise.resolve()
  if (!loadingParticles) {
    const quality = tier === 1 ? 'high' : 'low'
    loadingParticles = fetchBin(quality === 'high' ? FILES.particlesHigh : FILES.particlesLow)
      .then((buffer) => {
        particleBuffer = buffer
        particleQuality = quality
      })
      .catch((error: unknown) => {
        loadingParticles = null
        throw error
      })
  }
  return loadingParticles
}

export function hasGlyph(char: string): boolean {
  return char in entries
}

const warned = new Set<string>()

function entryOf(char: string): GlyphEntry | null {
  const entry = entries[char]
  if (!entry) {
    if (!warned.has(char)) {
      warned.add(char)
      console.warn(`[glyphs] "${char}" のグリフが無い。assets/svg/${char}.svg を追加して content:build を回すこと`)
    }
    return null
  }
  return entry
}

const geometryCache = new Map<string, BufferGeometry>()

/**
 * 字面が `[-0.5, 0.5]^2` に収まる平面ジオメトリ。
 * 同じ字は 1 つのジオメトリを共有し、格子上の 276 字ぶんはインスタンス側で位置を持つ。
 */
export function glyphGeometry(char: string): BufferGeometry | null {
  const cached = geometryCache.get(char)
  if (cached) return cached

  const entry = entryOf(char)
  if (!entry || !meshBuffer) return null

  const xy = new Float32Array(meshBuffer, entry.positionOffset, entry.vertexCount * 2)
  // three は 3 成分の position を要求するので z を足して詰め直す
  const positions = new Float32Array(entry.vertexCount * 3)
  for (let i = 0; i < entry.vertexCount; i++) {
    positions[i * 3] = xy[i * 2]!
    positions[i * 3 + 1] = xy[i * 2 + 1]!
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  // インデックスは字ごとに 0 から振り直してあるので u16 に収まる（ビルド時に確かめている）
  geometry.setIndex(new BufferAttribute(new Uint16Array(meshBuffer, entry.indexOffset, entry.indexCount), 1))
  geometry.computeBoundingSphere()

  geometryCache.set(char, geometry)
  return geometry
}

let sdfTexture: DataTexture | null = null

/**
 * 全字ぶんの符号付き距離場を敷き詰めた 1 枚のテクスチャ。
 *
 * 赤 1 成分・8bit。0.5 が輪郭、上が内側で下が外側（`SDF.spread` で飽和）。
 * ミップは持たない（距離場は縮小補間で意味が壊れる）が、セルの縁は必ず飽和値なので
 * バイリニアで隣のセルへ滲んでも見た目に出ない。
 */
export function glyphSdfTexture(): DataTexture | null {
  if (sdfTexture) return sdfTexture
  if (!sdfBuffer) return null

  sdfTexture = new DataTexture(
    new Uint8Array(sdfBuffer),
    SDF.columns * SDF.res,
    SDF.rows * SDF.res,
    RedFormat,
    UnsignedByteType,
  )
  sdfTexture.minFilter = LinearFilter
  sdfTexture.magFilter = LinearFilter
  sdfTexture.wrapS = ClampToEdgeWrapping
  sdfTexture.wrapT = ClampToEdgeWrapping
  sdfTexture.generateMipmaps = false
  sdfTexture.needsUpdate = true
  return sdfTexture
}

/** その字の SDF アトラス上のセル番号。グリフが無ければ `null` */
export function sdfCellOf(char: string): number | null {
  return entryOf(char)?.sdfCell ?? null
}

let orderTexture: DataTexture | null = null

/**
 * 筆順パラメータ場を敷き詰めた 1 枚のテクスチャ。
 * 赤 1 成分・8bit で、0 = 最初の画の起筆、1 = 最後の画の終筆（→ scripts/stroke-order.ts）。
 * 距離場と同じくミップは持たない（運びの前後関係が縮小補間で混ざる）。
 */
export function glyphOrderTexture(): DataTexture | null {
  if (orderTexture) return orderTexture
  if (!orderBuffer || ORDER.count === 0) return null

  orderTexture = new DataTexture(
    new Uint8Array(orderBuffer),
    ORDER.columns * ORDER.res,
    ORDER.rows * ORDER.res,
    RedFormat,
    UnsignedByteType,
  )
  orderTexture.minFilter = LinearFilter
  orderTexture.magFilter = LinearFilter
  orderTexture.wrapS = ClampToEdgeWrapping
  orderTexture.wrapT = ClampToEdgeWrapping
  orderTexture.generateMipmaps = false
  orderTexture.needsUpdate = true
  return orderTexture
}

/** その字の筆順アトラス上のセル番号。中心線を持たない字は `null` */
export function orderCellOf(char: string): number | null {
  const cell = entryOf(char)?.orderCell ?? -1
  return cell < 0 ? null : cell
}

/**
 * 画ごとの運びの区間 `[起筆, 終筆]`（0〜1）。中心線を持たない字は `null`。
 * 区間と区間の隙間には、どの画素のパラメータも落ちない（筆を上げている間）。
 */
export function strokeSpansOf(char: string): [number, number][] | null {
  const flat = entryOf(char)?.strokeSpans
  if (!flat || flat.length < 2) return null
  const spans: [number, number][] = []
  for (let i = 0; i + 1 < flat.length; i += 2) spans.push([flat[i]!, flat[i + 1]!])
  return spans
}

/**
 * 粒子のホームポジション。`count` を指定すると先頭から間引いて返す。
 * サンプルは面積重みで一様に取られているので、先頭から切っても分布は保たれる。
 *
 * bin が届く前は `null`。呼び手（`Particles.tsx`）はその字を飛ばすだけでよい。
 * 中身は u16 なので、ここで字面ローカル座標へ戻す。
 */
export function glyphParticles(char: string, count?: number): Float32Array | null {
  const entry = entryOf(char)
  if (!entry || !particleBuffer) return null
  const high = particleQuality === 'high'
  const available = high ? entry.particleCount : entry.particleLowCount
  const wanted = count === undefined ? available : Math.max(1, Math.min(available, count))
  const raw = new Uint16Array(particleBuffer, high ? entry.particleOffset : entry.particleLowOffset, wanted * 2)
  const out = new Float32Array(wanted * 2)
  for (let i = 0; i < out.length; i++) out[i] = raw[i]! / 65535 - 0.5
  return out
}
