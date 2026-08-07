/**
 * 深度をまたぐ演出の指揮。
 *
 * 潜る … 選んだ句／子の字はメッシュのまま次の見出しの位置へ動く。それ以外は粒子となって散開する
 * 戻る … 現在の大書はメッシュのまま図の中の位置へ戻る。周囲の字は粒子が凝集して形作る
 *
 * どちらも「**選んだノードの字**（＝持ち越される字）」と「それ以外」を分けるのが要点。
 * 持ち越される字は薄れも現れもせず、ここが出発点から行き先へ動かしながら描く。
 * 紙面・大書の側はその字を伏せる（`carry.ts` の id と `materials.ts` の `carryOpacity`）。
 * 粒子の運動そのものは Particles.tsx。
 */

import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useAtomValue, useSetAtom } from 'jotai'
import { Mesh } from 'three'
import { TransitionParticles, type ParticleSource } from './Particles.tsx'
import { INK, carryOpacity, createInkMaterial, stageOpacity } from './materials.ts'
import { setCarriedNodeId } from './carry.ts'
import { glyphGeometry } from './glyphs.ts'
import {
  headlineLayout,
  diagramItems,
  childCharOffset,
  DIAGRAM_X,
} from '../world/node-layout.ts'
import { navAtom, tierAtom } from '../nav/atoms.ts'
import { nodeById, root, childrenOf, SUTRA_INDEX_TO_NODE } from '../content/loader.ts'
import { SUTRA_CHARS } from '../content/sutra.ts'
import { gridPosition, GLYPH_SIZE } from '../world/paper.ts'
import { swayAt, swayPhase } from './sway.ts'
import { labelText, type GraphNode } from '../content/schema.ts'

/** 遷移演出の尺（ミリ秒）。ふんわりと滑らかに接続する */
export const TRANSITION_MS = 1700

/**
 * 演出が終わってから、字とオーバーレイが現れ始めるまでの間（ミリ秒）。
 * 着地を見せきってから次の面を出す。DOM 側（`Overlay.tsx`）も同じ値から遅延を引く。
 */
export const APPEAR_DELAY_MS = 500

/** 画面上の字 1 つ。粒子の出所にも、持ち越しの出発点・行き先にもなる */
interface StageGlyph extends ParticleSource {
  /** この字が属するノード id。紙面の句の範囲外は null */
  owner: string | null
  /**
   * ゆらぎの位相（`sway.ts`）。紙面は全文インデックス、大書と図は字から引く。
   * 描画側とまったく同じ種を使うことで、持ち越しの字が出発点でも行き先でも揺れの位置ごと繋がる
   */
  phase: number
}

/**
 * あるノードを表示しているとき、画面上に存在する字とその位置。
 * 根なら紙面の格子、それ以外なら大書 + 子の図。
 *
 * 位置と大きさは **描画側（Paper / NodeStage）と同じ関数**から引く。
 * 持ち越される字はここで出した出発点と行き先のあいだを動き、演出の終わりでそのまま
 * 描画側の字に入れ替わるので、両者がずれていると継ぎ目で跳ねる。
 */
function visibleGlyphs(node: GraphNode): StageGlyph[] {
  if (node.kind === 'sutra') {
    return SUTRA_CHARS.map((char, index) => {
      const [x, y] = gridPosition(index)
      return {
        char,
        position: [x, y] as [number, number],
        size: GLYPH_SIZE,
        owner: SUTRA_INDEX_TO_NODE[index] ?? null,
        phase: swayPhase(index),
      }
    })
  }

  const { chars, positions, size } = headlineLayout(node.label)
  const headline: StageGlyph[] = chars.map((char, i) => {
    const [x, y] = positions[i]!
    return {
      char,
      position: [x, y] as [number, number],
      size,
      owner: node.id,
      phase: swayPhase(char.codePointAt(0) ?? 0),
    }
  })

  const kids = diagramItems(node, childrenOf(node)).flatMap((item) => {
    const label = Array.from(labelText(item.node.label))
    return label.map((char, k) => {
      const [dx, dy] = childCharOffset(k, label.length, item.size, item.frame)
      return {
        char,
        position: [DIAGRAM_X + item.position[0] + dx, item.position[1] + dy] as [number, number],
        size: item.size,
        owner: item.node.id,
        phase: swayPhase(char.codePointAt(0) ?? 0),
      }
    })
  })

  return [...headline, ...kids]
}

/** 出発点と行き先を結んだ、持ち越される字 1 つ */
interface CarryPair {
  char: string
  from: StageGlyph
  to: StageGlyph
}

/**
 * 持ち越される字の対応づけ。
 *
 * `pivot` は深い側のノード（潜るなら行き先、戻るなら出発点）。その字が、
 * 浅い側では図の中の子として、深い側では大書として、同じ順に並んでいる。
 * 数が合わないときは対応が取れないので持ち越しを諦める（全部が粒子になる）。
 */
function carryPairs(before: StageGlyph[], after: StageGlyph[], pivot: string | null): CarryPair[] {
  if (!pivot) return []
  const from = before.filter((glyph) => glyph.owner === pivot)
  const to = after.filter((glyph) => glyph.owner === pivot)
  if (from.length === 0 || from.length !== to.length) return []
  return from.map((glyph, i) => ({ char: glyph.char, from: glyph, to: to[i]! }))
}

/**
 * 行きも戻りも滑らかに出入りする補間。等速だと機械が動いて見える。
 * カメラ（`Stage.tsx` の `CameraRig`）も遷移のあいだはこれを使う。持ち越しの字と同じ尺・
 * 同じカーブで動かさないと、ワールド座標では滑らかでも画面上では字が寄り道して見える。
 */
export function ease(t: number): number {
  // 5 次（smootherstep）。3 次と違って両端で加速度も 0 になるので、動き出しに角が立たず、
  // 終わりはぐっと減速しながら行き先へ着地する
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/**
 * 字が現れきるまでの尺（ミリ秒）。
 * 中身の差し替えは演出が終わってから起きるので、この分だけ遷移より後ろに伸びる。
 * 凝集しきった粒子を受け取るため、散り際より短くして間を空けない。
 */
const APPEAR_MS = 420

/**
 * 字が消える尺（進行度 τ に対する比）。冒頭 `GLYPH_HOLD` だけ持ちこたえ、
 * `GLYPH_GONE` で消えきる。**粒子の尺とは別に持つ**：
 * 字はさっと引き、そのあとに残った粒子だけがふわりと上へ流れていく、という順序を作る。
 */
const GLYPH_HOLD = 0.04
const GLYPH_GONE = 0.3

/** τ → 字の濃さ。2 乗のカーブで急激に落ちる */
function glyphFade(t: number): number {
  const k = Math.min(1, Math.max(0, (GLYPH_GONE - t) / (GLYPH_GONE - GLYPH_HOLD)))
  return k * k
}

/**
 * 字のメッシュの出入り。
 *
 * 紙面・大書は `Stage.tsx` が `nav.nodeId` で丸ごと差し替えるので、放っておくと
 * 演出の終わりで瞬間的に入れ替わる。ここが `stageOpacity`（materials.ts）を毎フレーム進め、
 * 墨・滲み・枠線のシェーダにまとめて効かせる。粒子と同じく**潜ると戻るで非対称**：
 *   消える … 2 乗のカーブ（`glyphFade`）で素早く引く。あとに残るのは粒子だけになる
 *   現れる … `APPEAR_DELAY_MS` だけ待ってから、立ち上がりの速い 2 乗のカーブで出す。
 *            持ち越しの字が着地したのを見せきってから、周りが追って現れる
 *
 * 持ち越される字だけはこの出入りに乗らない（`carryOpacity`）。遷移のあいだは Transition が
 * 動かしながら描くので伏せ、差し替わった瞬間に不透明のまま引き継ぐ。
 */
export function StageFade() {
  const nav = useAtomValue(navAtom)
  const step = useRef<{ kind: 'out' | 'in'; at: number } | null>(null)

  useEffect(() => {
    if (nav.phase === 'zooming-in' || nav.phase === 'zooming-out') {
      // 持ち越されるのは深い側のノードの字。潜るなら行き先、戻るなら出発点
      setCarriedNodeId(nav.phase === 'zooming-in' ? nav.pendingId : nav.nodeId)
      step.current = { kind: 'out', at: performance.now() }
    } else if (step.current?.kind === 'out') {
      // 相が抜けた時点で中身は差し替わっている。ここから現れる側へ
      step.current = { kind: 'in', at: performance.now() }
    }
  }, [nav.phase, nav.nodeId, nav.pendingId])

  useFrame(() => {
    const current = step.current
    if (!current) {
      stageOpacity.value = 1
      return
    }
    const elapsed = performance.now() - current.at
    if (current.kind === 'out') {
      stageOpacity.value = glyphFade(Math.min(1, elapsed / TRANSITION_MS))
      // 持ち越しの字は Transition が描いているので、こちら側では伏せる
      carryOpacity.value = 0
    } else {
      // 行き先の位置にもう置き換わっている。改めて現れさせず、そのまま引き継ぐ。
      // 待っているあいだ画面に残るのはこの字だけになる
      carryOpacity.value = 1
      const u = Math.min(1, Math.max(0, elapsed - APPEAR_DELAY_MS) / APPEAR_MS)
      stageOpacity.value = 1 - (1 - u) * (1 - u)
      if (u >= 1) {
        step.current = null
        setCarriedNodeId(null)
      }
    }
  })

  return null
}

export function Transition() {
  const nav = useAtomValue(navAtom)
  const tier = useAtomValue(tierAtom)
  const dispatch = useSetAtom(navAtom)
  const startedAt = useRef(0)

  const active = nav.phase === 'zooming-in' || nav.phase === 'zooming-out'
  const mode = nav.phase === 'zooming-in' ? 'disperse' : 'converge'

  const { particles, carried } = useMemo<{ particles: ParticleSource[]; carried: CarryPair[] }>(() => {
    if (!active || !nav.pendingId) return { particles: [], carried: [] }
    const from = nodeById(nav.nodeId) ?? root
    const to = nodeById(nav.pendingId) ?? root
    const before = visibleGlyphs(from)
    const after = visibleGlyphs(to)
    // 深い側のノードの字だけが持ち越される
    const pivot = mode === 'disperse' ? to.id : from.id
    const pairs = carryPairs(before, after, pivot)
    // 持ち越されない字が粒子になる。潜るときは今ある字が散り、戻るときは現れる字が凝集する
    const stage = mode === 'disperse' ? before : after
    const survives = pairs.length > 0 ? pivot : null
    return { particles: stage.filter((glyph) => glyph.owner !== survives), carried: pairs }
  }, [active, mode, nav.nodeId, nav.pendingId])

  // 演出の終了で FSM を次の相へ進める。Tier 3 は粒子を出さないが尺は揃える
  useEffect(() => {
    if (!active) return
    startedAt.current = performance.now()
    const timer = setTimeout(() => dispatch({ type: 'settled' }), TRANSITION_MS)
    return () => clearTimeout(timer)
  }, [active, nav.pendingId, dispatch])

  const progress = () => Math.min(1, (performance.now() - startedAt.current) / TRANSITION_MS)

  if (!active) return null

  return (
    <>
      {carried.map((pair, i) => (
        <CarryGlyph key={`${pair.char}-${i}`} pair={pair} progress={progress} />
      ))}
      {tier !== 3 && particles.length > 0 && (
        <TransitionParticles sources={particles} mode={mode} progress={progress} />
      )}
    </>
  )
}

/**
 * 持ち越される字 1 つ。出発点から行き先へ、位置も大きさも連続して動く。
 *
 * 濃さは遷移の出入りに乗らない（`createInkMaterial(false)`）。散る字が薄れても、
 * この字だけは不透明のまま動きつづけ、演出の終わりで描画側の字とすり替わる。
 */
function CarryGlyph({ pair, progress }: { pair: CarryPair; progress: () => number }) {
  const meshRef = useRef<Mesh>(null)
  const geometry = useMemo(() => glyphGeometry(pair.char), [pair.char])
  const ink = useMemo(() => createInkMaterial(false), [])
  useEffect(() => () => ink.material.dispose(), [ink])

  ink.color.value.copy(INK)
  // 種は字ごとに固定。紙面・大書と同じ規則にして、すり替わりでムラが飛ばないようにする
  ink.seed.value = (((pair.char.codePointAt(0) ?? 0) % 251) / 251) * 8

  useFrame(({ clock }) => {
    const mesh = meshRef.current
    if (!mesh) return
    const t = ease(progress())
    const size = pair.from.size + (pair.to.size - pair.from.size) * t
    // ゆらぎも出発点のものから行き先のものへ渡す。演出のあいだ揺れが止まらず、
    // 両端では紙面・大書が出す値とぴたり一致するので、すり替わりで字が跳ねない
    const before = swayAt(pair.from.phase, pair.from.size, clock.elapsedTime)
    const after = swayAt(pair.to.phase, pair.to.size, clock.elapsedTime)
    mesh.position.set(
      pair.from.position[0] + (pair.to.position[0] - pair.from.position[0]) * t + before.x + (after.x - before.x) * t,
      pair.from.position[1] + (pair.to.position[1] - pair.from.position[1]) * t + before.y + (after.y - before.y) * t,
      0,
    )
    mesh.rotation.z = before.rotation + (after.rotation - before.rotation) * t
    mesh.scale.setScalar(size)
    // 墨のムラはワールド単位で一定。大きさが変わるあいだも同じ細かさに保つ
    ink.scale.value = size
  })

  if (!geometry) return null

  return <mesh ref={meshRef} geometry={geometry} material={ink.material} />
}
