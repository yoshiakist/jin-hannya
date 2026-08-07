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
 *
 * 描画は `Points` ではなく **`Sprite` のインスタンシング**。`PointsNodeMaterial` の `sizeNode` は
 * `Points` に対しては読まれない（WebGPU の点は 1px 固定、WebGL2 経路も material.size を見る）ので、
 * 粒ごとの大きさが要るならこちらの経路しかない。1 粒 = 1 インスタンスの板。
 */

import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { useAtomValue } from 'jotai'
import { InstancedBufferAttribute } from 'three'
import { PointsNodeMaterial, type Node } from 'three/webgpu'
import { bufferAttribute, uniform, mix, float, vec3, smoothstep, sin, cos, uv, length, clamp } from 'three/tsl'
import { glyphParticles } from './glyphs.ts'
import { FOCUS_GLOW, INK } from './materials.ts'
import { tierAtom, particleScaleAtom } from '../nav/atoms.ts'
import { PARTICLE_BUDGET } from './tier.ts'
import { VIEW_HEIGHT } from '../world/paper.ts'

export type ParticleMode = 'disperse' | 'converge'

/** 実際に出す粒子の割合。密度を落として 1 粒 1 粒を見せる */
const PARTICLE_DENSITY = 0.3

/** 点の基準サイズ（画面ピクセル）。粒子ごとに 1〜2 倍のばらつきを持たせる */
const POINT_SIZE = 1.8

/**
 * 上向きへの偏り。飛距離に `1 + UP_BIAS * 上向き成分` を掛けるので、
 * 真上（1 + 1/3）は真下（1 − 1/3）のちょうど 2 倍飛ぶ。煙が立ちのぼる向き。
 */
const UP_BIAS = 1 / 3

/**
 * 散開の加速度（すべて字面の一辺を単位に、進行度 τ=0→1 での**変位**で書く）。
 *   RISE … 上向きの等加速度。τ² で効くので序盤は効かず、終わりぎわに浮き上がる
 *   SWAY … 横方向の正弦加速度の強さ。初速 0 から漂いはじめる
 *   SWAY_OMEGA … その角周波数の範囲［rad / 全尺］。1 周に満たない揺れが個々にずれる
 * 振幅・周期・初期位相は粒子ごとに乱数で振る（下の built を参照）
 */
const RISE = 1.2
const SWAY = 0.1
const SWAY_OMEGA: [number, number] = [2, 7]

/**
 * 濃さの立ち上がり／落ちの尺（進行度 τ に対する比）。
 *
 * **字（Transition.tsx の `glyphFade`）とは別の尺**である。字は素早く消え、粒子はそのあとも
 * 残って上へ流れていく。字が消えたあとの画面に居るのは粒子だけ、という状態を作るのが狙いなので、
 * ここを字と揃えてはいけない。
 *   DISPERSE_HOLD … 散開で不透明のまま持ちこたえる冒頭。ここを過ぎると 2 乗で落ちる
 *   DISPERSE_GONE … 散開が消えきる時点。尺いっぱいまで使って、ふわりと薄れて残る
 *   CONVERGE_FADE_IN … 凝集で 2 乗で立ち上がりきるまで。以降は形に収まるまで不透明
 */
const DISPERSE_HOLD = 0.3
const DISPERSE_GONE = 1
const CONVERGE_FADE_IN = 0.55

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

  // 紙面全体が散るときは字数が 3 桁になる。総数で頭を押さえてから 1 字あたりへ割り戻す
  const perGlyph = Math.max(
    0,
    Math.floor(
      Math.min(
        PARTICLE_BUDGET[tier] * scale,
        TOTAL_PARTICLE_CAP[tier] / Math.max(sources.length, 1),
      ) * PARTICLE_DENSITY,
    ),
  )

  const built = useMemo(() => {
    if (perGlyph <= 0 || sources.length === 0) return null

    const home: number[] = []
    const sizes: number[] = []
    // 凝集でだけ使う流入元。散開は初速と加速度で動かすので away を持たない
    const away: number[] = []
    // 散開でだけ使う。vel = 初速、rise = 上昇量、sway = (振幅, 角周波数, 初期位相)
    const vel: number[] = []
    const rise: number[] = []
    const sway: number[] = []

    sources.forEach((source, s) => {
      const samples = glyphParticles(source.char, perGlyph)
      if (!samples) return
      const rng = random(s + 1)
      const count = samples.length / 2

      for (let i = 0; i < count; i++) {
        const hx = source.position[0] + samples[i * 2]! * source.size
        const hy = source.position[1] + samples[i * 2 + 1]! * source.size
        home.push(hx, hy, 0)
        sizes.push(POINT_SIZE * (1 + rng()))

        if (mode === 'disperse') {
          // 字の中心から外向きへ。もとの形を保ったまま解けて飛ぶ
          const dx = hx - source.position[0]
          const dy = hy - source.position[1]
          const len = Math.hypot(dx, dy) || 1e-6
          const speed = source.size * (0.625 + rng() * 1.25) * (1 + UP_BIAS * (dy / len))
          vel.push((dx / len) * speed, (dy / len) * speed, 0)
          rise.push(source.size * RISE * (0.7 + rng() * 0.6))
          sway.push(
            source.size * SWAY * (0.4 + rng() * 1.2),
            SWAY_OMEGA[0] + rng() * (SWAY_OMEGA[1] - SWAY_OMEGA[0]),
            rng() * Math.PI * 2,
          )
        } else {
          // 画面全体からの薄い流入。散開の逆再生にしないため分布を変える
          const angle = rng() * Math.PI * 2
          const radius = source.size * (6 + rng() * 14)
          away.push(source.position[0] + Math.cos(angle) * radius, source.position[1] + Math.sin(angle) * radius, 0)
        }
      }
    })

    if (home.length === 0) return null

    // インスタンス属性としてノードへ直に渡す。ジオメトリは Sprite 内蔵の板を使うので、
    // ここで作る BufferAttribute は geometry には載せない
    const instanced = (values: number[], itemSize: number) =>
      new InstancedBufferAttribute(new Float32Array(values), itemSize)

    const progressUniform = uniform(0)
    // 等倍での画面ピクセル数を基準に、拡大率だけを自前で掛ける。
    // sizeAttenuation は正射影では効かない（three が透視投影でのみ適用する）
    const zoomUniform = uniform(1)
    const material = new PointsNodeMaterial({ transparent: true, depthWrite: false })

    // 粒の大小は属性で持つ。1 回の描画で粗密を出す
    material.sizeNode = bufferAttribute<'float'>(instanced(sizes, 1), 'float').mul(zoomUniform)
    const homeNode = bufferAttribute<'vec3'>(instanced(home, 3), 'vec3')
    // disperse は home から飛ぶ、converge は away → home
    const t = mode === 'disperse' ? progressUniform : float(1).sub(progressUniform)

    if (mode === 'disperse') {
      // 初速 + 上向きの等加速度 + 横方向の正弦加速度を、τ で解析的に積分した位置。
      // 横は a=A·sin(φ+ωτ) を 2 回積分した形（振幅 s は変位の尺度として持つ）で、
      // τ=0 で変位も横速度も 0 から始まる。sin φ の項が消えないのはそのため。
      const velNode = bufferAttribute<'vec3'>(instanced(vel, 3), 'vec3')
      const swayNode = bufferAttribute<'vec3'>(instanced(sway, 3), 'vec3')
      const riseNode = bufferAttribute<'float'>(instanced(rise, 1), 'float')
      const phase = swayNode.z
      const wt = swayNode.y.mul(t)
      const lateral = swayNode.x.mul(sin(phase).add(wt.mul(cos(phase))).sub(sin(phase.add(wt))))
      material.positionNode = homeNode.add(velNode.mul(t)).add(vec3(lateral, riseNode.mul(t).mul(t), 0))
    } else {
      const awayNode = bufferAttribute<'vec3'>(instanced(away, 3), 'vec3')
      material.positionNode = mix(homeNode, awayNode, smoothstep(0, 1, t))
    }

    // 1 粒 = 板なので、そのままだと正方形に出る。板の uv で中心からの距離を測って円に抜く。
    // 数 px の粒なので縁は硬く切らず、外側 2 割ほどを滑らかに落としてジャギを消す
    const disc = smoothstep(0.5, 0.32, length(uv().sub(0.5)))

    // 散り際・現れ際の濃さ。ここも潜る／戻るで非対称にする（README「遷移演出」）。
    //   散開 … `DISPERSE_HOLD` まで濃さを保ち、そこから 2 乗のカーブでふわりと薄れて消える
    //   凝集 … 無から 2 乗のカーブで立ち上がり、形に収まるころには出そろっている
    // どちらも t（= home からの隔たり）で書くので、下の 2 本は同じ向きの式にならない
    const ramp = (x: Node<'float'>): Node<'float'> => {
      const k = clamp(x, 0, 1)
      return k.mul(k)
    }
    const fade =
      mode === 'disperse'
        ? ramp(float(DISPERSE_GONE).sub(t).div(DISPERSE_GONE - DISPERSE_HOLD))
        : ramp(float(1).sub(t).div(CONVERGE_FADE_IN))
    material.opacityNode = fade.mul(disc).mul(0.85)
    material.colorNode = mix(
      vec3(FOCUS_GLOW.r, FOCUS_GLOW.g, FOCUS_GLOW.b),
      vec3(INK.r, INK.g, INK.b),
      smoothstep(0, 0.6, t),
    )

    return { material, count: home.length / 3, progressUniform, zoomUniform }
  }, [sources, mode, perGlyph])

  // 遷移ごとに作り直すので、前のぶんを捨てる
  useEffect(() => () => built?.material.dispose(), [built])

  useFrame((state) => {
    if (!built) return
    built.progressUniform.value = progress()
    // camera.zoom には「視野高を画面高に合わせる係数」も乗っているので、等倍ぶんを割って戻す。
    // 潜るときのズームアウトにも追従させたいので atom ではなくカメラの実値を読む
    const base = state.size.height / VIEW_HEIGHT
    built.zoomUniform.value = base > 0 ? state.camera.zoom / base : 1
  })

  if (!built) return null

  // count でインスタンス数が決まる。位置は positionNode が持つので matrix は原点のまま
  return <sprite count={built.count} material={built.material} frustumCulled={false} />
}
