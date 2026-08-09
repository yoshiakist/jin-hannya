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
  /** SDF アトラス上のセル番号 */
  sdfCell: number
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

/** 円相（assets/pattern/circle.svg）はグリフと同じ経路で載せる。字ではないので別キー */
export const CIRCLE_KEY = '@circle'

let meshBuffer: ArrayBuffer | null = null
let particleBuffer: ArrayBuffer | null = null
let sdfBuffer: ArrayBuffer | null = null
let loading: Promise<void> | null = null

export function loadGlyphs(): Promise<void> {
  if (!loading) {
    loading = Promise.all([
      fetch('/glyphs/mesh.bin').then((r) => r.arrayBuffer()),
      fetch('/glyphs/particles.bin').then((r) => r.arrayBuffer()),
      fetch('/glyphs/sdf.bin').then((r) => r.arrayBuffer()),
    ]).then(([mesh, particles, sdf]) => {
      meshBuffer = mesh
      particleBuffer = particles
      sdfBuffer = sdf
    })
  }
  return loading
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
  geometry.setIndex(new BufferAttribute(new Uint32Array(meshBuffer, entry.indexOffset, entry.indexCount), 1))
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

/**
 * 粒子のホームポジション。`count` を指定すると先頭から間引いて返す。
 * サンプルは面積重みで一様に取られているので、先頭から切っても分布は保たれる。
 */
export function glyphParticles(char: string, count?: number): Float32Array | null {
  const entry = entryOf(char)
  if (!entry || !particleBuffer) return null
  const available = entry.particleCount
  const wanted = count === undefined ? available : Math.max(1, Math.min(available, count))
  return new Float32Array(particleBuffer, entry.particleOffset, wanted * 2)
}
