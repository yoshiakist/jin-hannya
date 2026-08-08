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

import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { useAtomValue, useSetAtom } from 'jotai'
import { Mesh } from 'three'
import { TransitionParticles, type ParticleMode, type ParticleSource } from './Particles.tsx'
import { INK, carryOpacity, createInkMaterial, nodeOpacity, paperOpacity } from './materials.ts'
import { setCarriedNodeId } from './carry.ts'
import { glyphGeometry } from './glyphs.ts'
import {
  headlineLayout,
  diagramItems,
  childCharOffset,
  diagramCenterX,
} from '../world/node-layout.ts'
import { navAtom, tierAtom } from '../nav/atoms.ts'
import { nodeById, root, childrenOf, headlineChildOwners, SUTRA_INDEX_TO_NODE } from '../content/loader.ts'
import { SUTRA_CHARS } from '../content/sutra.ts'
import { gridPosition, GLYPH_SIZE } from '../world/paper.ts'
import { swayAt, swayPhase } from './sway.ts'
import { ease } from '../world/ease.ts'
import { labelText, type GraphNode } from '../content/schema.ts'

/** 遷移演出の尺（ミリ秒）。ふんわりと滑らかに接続する */
export const TRANSITION_MS = 1700

/**
 * 演出が終わってから、字とオーバーレイが現れ始めるまでの間（ミリ秒）。
 * 着地を見せきってから次の面を出す。DOM 側（`Overlay.tsx`）も同じ値から遅延を引く。
 * **潜るとき（と L1 以降どうしの戻り）だけ**の間合い。L0 へ戻るときは、紙面が演出の
 * あいだに現れきっているのでこの遅延を挟まない。
 */
export const APPEAR_DELAY_MS = 500

/**
 * 戻るときに、字とオーバーレイが現れ始めるまでの間（ミリ秒）。
 * 戻りは「光が凝集する → 字が現れる → 残った光が引く」の順。凝集は演出の終わり（τ=1）で
 * 形に収まりきっているので、待たずにそのまま字へ渡す。ここに間を空けると、
 * 光が消えきってから字が出てくる（＝一度なにも無い画面を挟む）ことになる。
 */
export const RETURN_APPEAR_DELAY_MS = 0

/** 画面上の字 1 つ。粒子の出所にも、持ち越しの出発点・行き先にもなる */
interface StageGlyph extends ParticleSource {
  /** この字が属するノード id。紙面の句の範囲外は null */
  owner: string | null
  /**
   * この字から潜れる子のノード id（大書の中の入口。`headlineChildOwners`）。
   * 図を持たないノードでは、大書の一部がそのまま次の大書へ渡るので、
   * 持ち越しの対応づけは `owner` だけでは取れない。
   */
  enters: string | null
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
        // 紙面では句そのものが入口。owner と同じなので改めて持たない
        enters: null,
        phase: swayPhase(index),
      }
    })
  }

  const { chars, positions, size } = headlineLayout(node)
  // 図を持たないノードでは、大書の中の子の範囲が入口になる（描画側と同じ表を引く）
  const owners = headlineChildOwners(node)
  const headline: StageGlyph[] = chars.map((char, i) => {
    const [x, y] = positions[i]!
    return {
      char,
      position: [x, y] as [number, number],
      size,
      owner: node.id,
      enters: owners[i] ?? null,
      phase: swayPhase(char.codePointAt(0) ?? 0),
    }
  })

  const kids = diagramItems(node, childrenOf(node)).flatMap((item) => {
    const label = Array.from(labelText(item.node.label))
    return label.map((char, k) => {
      const [dx, dy] = childCharOffset(k, label.length, item.size, item.frame)
      return {
        char,
        position: [diagramCenterX(node) + item.position[0] + dx, item.position[1] + dy] as [number, number],
        size: item.size,
        owner: item.node.id,
        enters: null,
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
 * その字が `pivot`（＝深い側のノード）のものか。
 *
 * 浅い側では、図の中の子（`owner`）か、図を持たないノードの大書の中の入口（`enters`）。
 * 深い側では、その大書そのもの（`owner`）。どちらの側から見ても同じ 1 つの判定で拾える。
 */
function belongsTo(glyph: StageGlyph, pivot: string): boolean {
  return glyph.owner === pivot || glyph.enters === pivot
}

/**
 * 持ち越される字の対応づけ。
 *
 * `pivot` は深い側のノード（潜るなら行き先、戻るなら出発点）。その字が、
 * 浅い側では図の中の子（あるいは大書の中の子の範囲）として、深い側では大書として、
 * 同じ順に並んでいる。
 * 数が合わないときは対応が取れないので持ち越しを諦める（全部が粒子になる）。
 */
function carryPairs(before: StageGlyph[], after: StageGlyph[], pivot: string | null): CarryPair[] {
  if (!pivot) return []
  const from = before.filter((glyph) => belongsTo(glyph, pivot))
  const to = after.filter((glyph) => belongsTo(glyph, pivot))
  if (from.length === 0 || from.length !== to.length) return []
  return from.map((glyph, i) => ({ char: glyph.char, from: glyph, to: to[i]! }))
}

/**
 * 行きも戻りも滑らかに出入りする補間。等速だと機械が動いて見える。
 * カメラ（`Stage.tsx` の `CameraRig`）も L1 以降のパンの戻し（`world/pan.ts`）も遷移のあいだは
 * これを使う。持ち越しの字と同じ尺・同じカーブで動かさないと、ワールド座標では滑らかでも
 * 画面上では字が寄り道して見える。定義は `world/ease.ts`（world/ から読めるように）。
 */
export { ease }

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
 * L0 へ戻るとき、紙面の字が現れはじめる進行度。
 * ここから τ=1（＝粒子が形に収まりきる時点）にかけて濃くなるので、
 * 光が凝集するのと同じ時間で字が立ち上がり、着地の瞬間には字が出そろっている。
 */
const ENTER_FROM = 0.5

/** τ → 戻り先の紙面の濃さ。2 乗のカーブで、終わりぎわに一気に濃くなる */
function enterFade(t: number): number {
  const k = Math.min(1, Math.max(0, (t - ENTER_FROM) / (1 - ENTER_FROM)))
  return k * k
}

/**
 * 字のメッシュの出入り。
 *
 * 紙面・大書は `Stage.tsx` が `nav.nodeId` で丸ごと差し替えるので、放っておくと
 * 演出の終わりで瞬間的に入れ替わる。ここが深度ごとの濃さ（materials.ts の
 * `paperOpacity` / `nodeOpacity`）を毎フレーム進め、墨・滲み・枠線のシェーダに
 * まとめて効かせる。粒子と同じく**潜ると戻るで非対称**：
 *   消える … 2 乗のカーブ（`glyphFade`）で素早く引く。あとに残るのは粒子だけになる
 *   現れる … 行き先が L0 なら、紙面は演出のあいだに `enterFade` で立ち上がる。
 *            粒子の凝集と同じ時間で濃くなるので、光が集まってそのまま字になる。
 *            行き先が L1 以降なら、面が差し替わってから出す。潜るときは `APPEAR_DELAY_MS`
 *            だけ待って（持ち越しの字が着地したのを見せきってから、周りが追って現れる）、
 *            戻るときは待たない（`RETURN_APPEAR_DELAY_MS`。凝集しきった光をそのまま字へ渡す）
 *
 * 持ち越される字だけはこの出入りに乗らない（`carryOpacity`）。遷移のあいだは Transition が
 * 動かしながら描くので伏せ、差し替わった瞬間に不透明のまま引き継ぐ。
 */
export function StageFade() {
  const nav = useAtomValue(navAtom)
  const step = useRef<{
    kind: 'out' | 'in'
    at: number
    fromRoot: boolean
    toRoot: boolean
    /** 戻り（zooming-out）か。現れ始めるまでの間合いが向きで変わる */
    returning: boolean
  } | null>(null)

  useEffect(() => {
    if (nav.phase === 'zooming-in' || nav.phase === 'zooming-out') {
      // 持ち越されるのは深い側のノードの字。潜るなら行き先、戻るなら出発点
      setCarriedNodeId(nav.phase === 'zooming-in' ? nav.pendingId : nav.nodeId)
      step.current = {
        kind: 'out',
        at: performance.now(),
        fromRoot: nav.nodeId === root.id,
        toRoot: nav.pendingId === root.id,
        returning: nav.phase === 'zooming-out',
      }
    } else if (step.current?.kind === 'out') {
      if (step.current.toRoot) {
        // 紙面は演出のあいだに現れきっている。改めて出さず、持ち越しの字だけ受け取る
        paperOpacity.value = 1
        carryOpacity.value = 1
        setCarriedNodeId(null)
        step.current = null
      } else {
        // 相が抜けた時点で中身は差し替わっている。ここから現れる側へ
        step.current = { ...step.current, kind: 'in', at: performance.now() }
      }
    }
  }, [nav.phase, nav.nodeId, nav.pendingId])

  useFrame(() => {
    const current = step.current
    if (!current) return
    const elapsed = performance.now() - current.at
    if (current.kind === 'out') {
      const t = Math.min(1, elapsed / TRANSITION_MS)
      // 出ていくのは出発点の側の深度。潜るなら紙面、戻るなら大書と図
      const leaving = current.fromRoot ? paperOpacity : nodeOpacity
      leaving.value = glyphFade(t)
      // 戻り先が L0 のときだけ、紙面がもう画面に居る。凝集に合わせて濃くしていく
      if (current.toRoot) paperOpacity.value = enterFade(t)
      // 持ち越しの字は Transition が描いているので、こちら側では伏せる
      carryOpacity.value = 0
    } else {
      // 行き先の位置にもう置き換わっている。改めて現れさせず、そのまま引き継ぐ。
      // 待っているあいだ画面に残るのはこの字だけになる
      carryOpacity.value = 1
      const delay = current.returning ? RETURN_APPEAR_DELAY_MS : APPEAR_DELAY_MS
      const u = Math.min(1, Math.max(0, elapsed - delay) / APPEAR_MS)
      nodeOpacity.value = 1 - (1 - u) * (1 - u)
      if (u >= 1) {
        step.current = null
        setCarriedNodeId(null)
      }
    }
  })

  return null
}

/**
 * 凝集しきった粒子が消えるまでの尺（ミリ秒）。
 * 演出の**終わったあと**に伸びる余韻で、字が出そろってから光だけが遅れて引く。
 * ここで粒子を捨てずに薄めるのは絵のためでもあり、面の差し替えと同じフレームで
 * マテリアルを捨てないためでもある。
 */
const PARTICLE_FADE_MS = 520

/**
 * 凝集しきった光が、引きはじめるまで留まる間（ミリ秒）。**戻り（凝集）だけ**に掛かる。
 * 戻りの順序は「光が凝集する → 字が現れる → 光が引く」。字の立ち上がり（`APPEAR_MS`）に
 * 頭を譲るぶんだけ光を残しておかないと、光が消えたあとに字が出る形に見えてしまう。
 * 散開は字が先に消えて光だけが残る形なので、こちらには掛けない。
 */
const PARTICLE_HOLD_MS = 100

/** いま描いている演出ひとつぶん。相が抜けたあとも、粒子が消えきるまで残る */
interface Run {
  mode: ParticleMode
  particles: ParticleSource[]
  carried: CarryPair[]
  /** 演出の開始時刻。進行度も余韻もここから数える */
  at: number
}

export function Transition() {
  const nav = useAtomValue(navAtom)
  const tier = useAtomValue(tierAtom)
  const dispatch = useSetAtom(navAtom)
  const [run, setRun] = useState<Run | null>(null)

  const active = nav.phase === 'zooming-in' || nav.phase === 'zooming-out'

  // 演出の組み立てと、終了の通知。相が抜けても run は畳まない（下の余韻で捨てる）
  useEffect(() => {
    if (!active || !nav.pendingId) return
    const mode: ParticleMode = nav.phase === 'zooming-in' ? 'disperse' : 'converge'
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
    setRun({
      mode,
      particles: stage.filter((glyph) => !survives || !belongsTo(glyph, survives)),
      carried: pairs,
      at: performance.now(),
    })
    // Tier 3 は粒子を出さないが尺は揃える
    const timer = setTimeout(() => dispatch({ type: 'settled' }), TRANSITION_MS)
    return () => clearTimeout(timer)
  }, [active, nav.phase, nav.nodeId, nav.pendingId, dispatch])

  // 余韻が切れたところで粒子を捨てる。次の遷移が始まれば run ごと差し替わる
  useEffect(() => {
    if (!run) return
    const hold = run.mode === 'converge' ? PARTICLE_HOLD_MS : 0
    const timer = setTimeout(() => setRun(null), TRANSITION_MS + hold + PARTICLE_FADE_MS)
    return () => clearTimeout(timer)
  }, [run])

  const elapsed = () => performance.now() - (run?.at ?? 0)
  const progress = () => Math.min(1, elapsed() / TRANSITION_MS)
  /**
   * 余韻の濃さ。演出のあいだは 1 のまま、終わってから 0 へ引く。
   * 凝集ではそのあと `PARTICLE_HOLD_MS` だけ留まり、字が現れはじめてから引く
   */
  const tail = () => {
    const hold = run?.mode === 'converge' ? PARTICLE_HOLD_MS : 0
    return 1 - Math.min(1, Math.max(0, elapsed() - TRANSITION_MS - hold) / PARTICLE_FADE_MS)
  }

  if (!run) return null

  return (
    <>
      {/* 持ち越しの字は演出のあいだだけ。相が抜けたら紙面・大書の側が同じ位置で引き継ぐ */}
      {active &&
        run.carried.map((pair, i) => (
          <CarryGlyph key={`${pair.char}-${i}`} pair={pair} progress={progress} />
        ))}
      {tier !== 3 && run.particles.length > 0 && (
        <TransitionParticles sources={run.particles} mode={run.mode} progress={progress} tail={tail} />
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
