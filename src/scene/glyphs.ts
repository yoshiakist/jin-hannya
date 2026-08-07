/**
 * 前計算済みグリフ（メッシュ + 粒子サンプル）の読み込み。
 *
 * 実体は scripts/build-glyphs.ts が吐いた public/glyphs/*.bin。
 * ランタイムでは SVG を一切触らない（README「グリフの扱い」）。
 */

import { BufferGeometry, BufferAttribute } from 'three'
import glyphIndex from '../generated/glyphs.json'

interface GlyphEntry {
  positionOffset: number
  vertexCount: number
  indexOffset: number
  indexCount: number
  particleOffset: number
  particleCount: number
}

const entries = glyphIndex.glyphs as Record<string, GlyphEntry>

/** 円相（assets/pattern/circle.svg）はグリフと同じ経路で載せる。字ではないので別キー */
export const CIRCLE_KEY = '@circle'

let meshBuffer: ArrayBuffer | null = null
let particleBuffer: ArrayBuffer | null = null
let loading: Promise<void> | null = null

export function loadGlyphs(): Promise<void> {
  if (!loading) {
    loading = Promise.all([
      fetch(`${import.meta.env.BASE_URL}glyphs/mesh.bin`).then((r) => r.arrayBuffer()),
      fetch(`${import.meta.env.BASE_URL}glyphs/particles.bin`).then((r) => r.arrayBuffer()),
    ]).then(([mesh, particles]) => {
      meshBuffer = mesh
      particleBuffer = particles
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
