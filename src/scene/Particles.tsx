/**
 * 遷移演出の粒子。
 *
 * 潜るときと戻るときで**非対称**にする（README「遷移演出」）。
 *   散開 … 文字の形が解けて外へ流れて消える
 *   凝集 … 画面全体からの薄い流入が、文字の形へ収束してくる
 * 逆再生ではないので、出発分布を別に持つのがこの実装の要点。
 *
 * 位置の補間は TSL の頂点側で行う。Tier 1（WebGPU）と Tier 2（WebGL2 バックエンド）で
 * 同じノードグラフが走り、粒子数だけが変わる。
 */

import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useAtomValue } from 'jotai'
import { BufferAttribute, BufferGeometry, Points } from 'three'
import { PointsNodeMaterial } from 'three/webgpu'
import { attribute, uniform, mix, float, vec3, smoothstep } from 'three/tsl'
import { glyphParticles } from './glyphs.ts'
import { FOCUS_GLOW, INK } from './materials.ts'
import { tierAtom, particleScaleAtom } from '../nav/atoms.ts'
import { PARTICLE_BUDGET } from './tier.ts'

export type ParticleMode = 'disperse' | 'converge'

/** 同時に生かす粒子の総数の上限。ティアごとに 1 桁ずつ落とす（README「性能ティアごとの落とし所」） */
const TOTAL_PARTICLE_CAP: Record<1 | 2 | 3, number> = {
  1: 300_000,
  2: 60_000,
  3: 0,
}

export interface ParticleSource {
  char: string
  /** ワールド座標での字の中心 */
  position: [number, number]
  /** 字面の一辺（ワールド単位） */
  size: number
}

/** 決定的な擬似乱数。同じ字が同じ散り方をするよう seed を位置から作る */
function random(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let z = state
    z = Math.imul(z ^ (z >>> 15), z | 1)
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * `progress` が 0 → 1 へ進むあいだ、粒子が home と away のあいだを移動する。
 * `mode` によって「どちらが出発点か」と away の分布が入れ替わる。
 */
export function TransitionParticles({
  sources,
  mode,
  progress,
}: {
  sources: ParticleSource[]
  mode: ParticleMode
  progress: () => number
}) {
  const tier = useAtomValue(tierAtom)
  const scale = useAtomValue(particleScaleAtom)
  const pointsRef = useRef<Points>(null)

  // 紙面全体が散るときは字数が 3 桁になる。総数で頭を押さえてから 1 字あたりへ割り戻す
  const perGlyph = Math.max(
    0,
    Math.min(
      Math.floor(PARTICLE_BUDGET[tier] * scale),
      Math.floor(TOTAL_PARTICLE_CAP[tier] / Math.max(sources.length, 1)),
    ),
  )

  const built = useMemo(() => {
    if (perGlyph <= 0 || sources.length === 0) return null

    const home: number[] = []
    const away: number[] = []

    sources.forEach((source, s) => {
      const samples = glyphParticles(source.char, perGlyph)
      if (!samples) return
      const rng = random(s + 1)
      const count = samples.length / 2

      for (let i = 0; i < count; i++) {
        const hx = source.position[0] + samples[i * 2]! * source.size
        const hy = source.position[1] + samples[i * 2 + 1]! * source.size
        home.push(hx, hy, 0)

        if (mode === 'disperse') {
          // 字の中心から外向きへ。もとの形を保ったまま解けて飛ぶ
          const dx = hx - source.position[0]
          const dy = hy - source.position[1]
          const len = Math.hypot(dx, dy) || 1e-6
          const push = source.size * (2.5 + rng() * 5)
          away.push(hx + (dx / len) * push, hy + (dy / len) * push, 0)
        } else {
          // 画面全体からの薄い流入。散開の逆再生にしないため分布を変える
          const angle = rng() * Math.PI * 2
          const radius = source.size * (6 + rng() * 14)
          away.push(source.position[0] + Math.cos(angle) * radius, source.position[1] + Math.sin(angle) * radius, 0)
        }
      }
    })

    if (home.length === 0) return null

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(home), 3))
    geometry.setAttribute('away', new BufferAttribute(new Float32Array(away), 3))
    geometry.computeBoundingSphere()
    return geometry
  }, [sources, mode, perGlyph])

  const { material, progressUniform } = useMemo(() => {
    const progressUniform = uniform(0)
    // sizeAttenuation を切って画面ピクセル基準にする。ワールド基準だと拡大率で見え方が壊れる
    const material = new PointsNodeMaterial({
      transparent: true,
      depthWrite: false,
      size: 3,
      sizeAttenuation: false,
    })

    // 明示的な型引数が要る。渡した文字列からは 'vec3' に絞り込まれない
    const home = attribute<'vec3'>('position', 'vec3')
    const away = attribute<'vec3'>('away', 'vec3')
    // disperse は home → away、converge は away → home
    const t = mode === 'disperse' ? progressUniform : float(1).sub(progressUniform)
    material.positionNode = mix(home, away, smoothstep(0, 1, t))

    // 散り際・現れ際に消える。芯の色は琥珀寄り、落ち着いた側は墨の白
    const fade = float(1).sub(smoothstep(0.55, 1, t))
    material.opacityNode = fade.mul(0.85)
    material.colorNode = mix(
      vec3(FOCUS_GLOW.r, FOCUS_GLOW.g, FOCUS_GLOW.b),
      vec3(INK.r, INK.g, INK.b),
      smoothstep(0, 0.6, t),
    )

    return { material, progressUniform }
  }, [mode])

  useFrame(() => {
    progressUniform.value = progress()
  })

  if (!built) return null

  return <points ref={pointsRef} geometry={built} material={material} frustumCulled={false} />
}
