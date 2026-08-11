/**
 * L0 — 写経の紙面。
 *
 * 全文を均質な格子として描く。列の切れ目は `content/sutra.txt` の改行位置に従い、
 * 意味による分節はしない（改行はあくまで底本の版面であって、句の区切りではない）。
 * 触れたときだけ、句の範囲にあたる文字が光る（README「意味の区切りは L1 から」）。
 */

import { useEffect, useMemo, useRef } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { useAtomValue, useSetAtom } from 'jotai'
import { InstancedBufferAttribute, InstancedMesh, Object3D, PlaneGeometry, type Color } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { attribute, mix, uniform, vec3 } from 'three/tsl'
import { SUTRA_CHARS, COLS_PER_LINE, GRID_COLUMNS, indexAt } from '../content/sutra.ts'
import { glyphGeometry, sdfCellOf } from './glyphs.ts'
import {
  INK,
  INK_RESTING,
  FOCUS,
  VISITED,
  VISITED_RESTING,
  VISITED_GLOW,
  GLOW_PLANE,
  createGlowMaterial,
  inkDensity,
  inkShade,
  inkAlpha,
  approach,
  paperOpacity,
  transitionAlpha,
  revealTime,
  revealMask,
  revealProgress,
  REVEAL_DURATION,
  REVEAL_SPREAD,
  REVEAL_TOTAL,
} from './materials.ts'
import { CELL_X, CELL_Y, GLYPH_SIZE, gridPosition } from '../world/paper.ts'
import { isGestureClick } from '../world/pan.ts'
import { navAtom, acceptsInputAtom, audioConsentAtom, splashAtom, visitedIndicesAtom } from '../nav/atoms.ts'
import { SUTRA_INDEX_TO_NODE, SUTRA_INDEX_TO_PAGE } from '../content/loader.ts'
import { carriedNodeId } from './carry.ts'
import { swayAt, swayPhase } from './sway.ts'

/** 滲みの最大の濃さ */
const GLOW_STRENGTH = 0.5

/**
 * 読破の青白の濃さ。触れている字の琥珀（`GLOW_STRENGTH`）よりはっきり弱くする。
 * ここを上げると紙面がイルミネーションになり、いま触れている字が読み取れなくなる。
 */
const VISITED_GLOW_STRENGTH = 0.38

interface CharGroup {
  char: string
  /** この字が現れる全文インデックス */
  indices: number[]
}

/**
 * hover 中に、フォーカス外の字をどこまで沈めるか（0 = 沈めない）。
 * どの字も同じだけ沈むので紙面で 1 本。進めるのは `Paper` 本体
 * （字ごとに進めると 1 フレームで 90 回寄ってしまう）。
 */
const dim = uniform(0)

/**
 * 字ごとの出はじめ（秒）。頭の字が 0、末尾の字が `REVEAL_SPREAD`。
 * 全文インデックスから引くので、格子の並びではなく**読む順**に滲み出す。
 */
function revealDelayOf(index: number): number {
  const last = SUTRA_CHARS.length - 1
  return last <= 0 ? 0 : (index / last) * REVEAL_SPREAD
}

/**
 * その字がもう現れ切ったか。滲み出しの最中は墨がまだ薄く、
 * 見えていない字を押せてしまうと、押した覚えのない語へ潜ることになる。
 * 時計（`revealTime`）はロゴを書いているあいだ止まっているので、
 * ロゴが引くまで紙面ぜんたいが触れないことにもなる。
 */
function isRevealed(index: number): boolean {
  return (revealTime.value as number) >= revealDelayOf(index) + REVEAL_DURATION
}

/** 初出の滲み出しを済ませたか。紙面は畳まないので、モジュールに 1 つ置けば足りる */
let introPlayed = false

/**
 * 紙面ぜんぶで共有する墨のマテリアル。
 *
 * 字ごとに持つと、L0 へ戻るたびに 90 本ぶんのノードマテリアルを組み直すことになり、
 * 面が差し替わった瞬間に固まる（シェーダの組み立ては 1 本でも安くない）。
 * ムラの種・フォーカス量・持ち越しはすべてインスタンス属性で持たせてあるので、
 * シェーダそのものは字によらず同じ。ここで 1 度だけ作って以後ずっと使い回す。
 */
let sharedInk: MeshBasicNodeMaterial | null = null

function paperInk(): MeshBasicNodeMaterial {
  if (sharedInk) return sharedInk
  const material = new MeshBasicNodeMaterial({ transparent: true, toneMapped: false })
  const focused = attribute<'float'>('aFocus', 'float')
  // 1 = 読破した語に属する字。hover と同じ経路で色を差し替えるので、シェーダは 1 本のまま
  const explored = attribute<'float'>('aVisited', 'float')
  const resting = mix(vec3(INK.r, INK.g, INK.b), vec3(INK_RESTING.r, INK_RESTING.g, INK_RESTING.b), dim)
  const restingVisited = mix(
    vec3(VISITED.r, VISITED.g, VISITED.b),
    vec3(VISITED_RESTING.r, VISITED_RESTING.g, VISITED_RESTING.b),
    dim,
  )
  // 触れているあいだは琥珀が勝つ。読破の青白は痕跡なので、いまの操作の色に譲る
  const base = mix(mix(resting, restingVisited, explored), vec3(FOCUS.r, FOCUS.g, FOCUS.b), focused)
  // 墨のムラ。光っている字ではムラを浅くして、発光の芯が抜けないようにする
  const density = mix(inkDensity(attribute<'float'>('aSeed', 'float')), 1, focused.mul(0.7))
  material.colorNode = base.mul(inkShade(density))
  // 光る字だけ不透明度も上げ、グローの芯にする
  // 遷移中は紙面ぜんたいがこの係数で薄れる（潜る＝散開に合わせて消え、戻ると凝集に合わせて現れる）。
  // ただし選んだ句の字だけは持ち越し側を読むので、薄れずにそのまま次の見出しへ渡る
  material.opacityNode = mix(mix(0.94, 0.55, dim), 1, focused)
    .mul(inkAlpha(density))
    .mul(transitionAlpha(attribute<'float'>('aPersist', 'float'), paperOpacity))
    // 初出だけ、字の中を左上から右下へ墨が回る。2 度目以降は 1 のまま素通りする
    .mul(revealMask(attribute<'float'>('aDelay', 'float')))
  sharedInk = material
  return material
}

/**
 * L0 の紙面。
 *
 * **`live` が false でも畳まない**（Stage.tsx）。組み直すと 90 字ぶんのマテリアルと
 * 描画オブジェクトを 1 フレームで用意することになり、そこで固まる。
 * 潜っているあいだは描かず、フレームの計算もせず、当たり判定にも出ないだけにして、
 * GPU 側の用意はそのまま温めておく。
 */
export function Paper({ live = true }: { live?: boolean }) {
  const hoveredId = useAtomValue(navAtom).hoveredId
  /** 読破した語に属する字（0/1）。中身が変わるのは L1 以降から戻ってきたときだけ */
  const visitedTargets = useAtomValue(visitedIndicesAtom)
  /** ロゴを書いている・音の断りを待っているあいだは、経文の時計を止めておく（→ src/scene/Splash.tsx） */
  const splash = useAtomValue(splashAtom)
  /** 経文が滲み出すのは音の断りに答えが出てから（→ src/overlay/AudioConsent.tsx） */
  const consent = useAtomValue(audioConsentAtom)

  // 初出の滲み出しは起動して紙面が出るときの 1 度きり。
  // 時計は 0（＝透明）から始まっているので、ここですることは「2 度目なら出し終わりへ飛ばす」だけ。
  // 紙面は畳まないので普段ここは通らないが、組み直したときに書き直しから始めないための備え
  useEffect(() => {
    if (introPlayed) revealTime.value = REVEAL_TOTAL
    introPlayed = true
  }, [])

  /**
   * ロゴを書いているあいだ、紙面は**描いたまま濃さだけ 0 にして**伏せる。
   * 描画から外す（`visible = false`）と、90 字ぶんのプログラムとバッファの用意が
   * ロゴの明け際に一度に来て、いちばん見せたい入れ替わりで固まる。
   * 経文の墨は初出の時計（`revealTime` = 0）でどのみち透明だが、読破の青白は
   * 触れずとも点いてしまうので、深度ぜんたいの濃さで止める。
   *
   * 戻すのは**自分が伏せたときだけ**、'writing' を抜けた 1 回。相を決め打ちで見ると、
   * 1 フレームが長引いて 'fading' を飛び越したときに伏せたままになる。
   * 伏せていないときに書かないのは、薄れているあいだに潜られたとき
   * （`.stage` は 'fading' で操作を受け付ける）に `StageFade` と取り合わないため。
   */
  const hidden = useRef(false)
  useEffect(() => {
    if (splash === 'writing' || splash === 'asking') {
      paperOpacity.value = 0
      hidden.current = true
    } else if (hidden.current) {
      paperOpacity.value = 1
      hidden.current = false
    }
  }, [splash])

  // 沈み込みは紙面で 1 つ。hover の変化そのものは行き先だけを書き、寄せるのはここ
  useFrame((_, delta) => {
    // 初出の時計だけは伏せていても進める（潜ったまま止めると、戻ったとき途中から書き始める）。
    // ただし音の断りに答えが出るまでは止める。ここで進めると、ロゴが薄れたときには
    // 経文が刷り上がっていて、紙面が自分で書かれていくところを見せられない
    if (consent !== null && (revealTime.value as number) < REVEAL_TOTAL) {
      revealTime.value = Math.min(REVEAL_TOTAL, (revealTime.value as number) + delta)
    }
    if (!live) return
    dim.value = approach(dim.value, hoveredId ? 1 : 0, delta)
  })

  // 文字インデックス → 潜り先の句 id。hover 判定と持ち越し判定が同じ表を引く
  const indexToNode = SUTRA_INDEX_TO_NODE

  const groups = useMemo<CharGroup[]>(() => {
    const byChar = new Map<string, number[]>()
    SUTRA_CHARS.forEach((char, index) => {
      const list = byChar.get(char)
      if (list) list.push(index)
      else byChar.set(char, [index])
    })
    return [...byChar.entries()].map(([char, indices]) => ({ char, indices }))
  }, [])

  return (
    <group>
      <HoverPlane indexToNode={indexToNode} live={live} />
      <FocusGlow indexToNode={indexToNode} live={live} />
      <VisitedGlow targets={visitedTargets} live={live} />
      {groups.map((group) => (
        <CharInstances
          key={group.char}
          group={group}
          indexToNode={indexToNode}
          visitedTargets={visitedTargets}
          live={live}
        />
      ))}
    </group>
  )
}

/**
 * ゆらぎ込みの字の位置と傾き。位相は全文インデックスから引く
 * （同じ字が紙面に何度出ても別々に揺れ、格子が波打たない）。
 */
function paperSway(index: number, t: number): { x: number; y: number; rotation: number } {
  const [x, y] = gridPosition(index)
  const sway = swayAt(swayPhase(index), GLYPH_SIZE, t)
  return { x: x + sway.x, y: y + sway.y, rotation: sway.rotation }
}

/**
 * フォーカスされた字の裏に焚く滲み。行き先は hover から引く。
 */
function FocusGlow({ indexToNode, live }: { indexToNode: readonly (string | null)[]; live: boolean }) {
  const hoveredId = useAtomValue(navAtom).hoveredId
  const targets = useMemo(() => {
    const array = new Float32Array(SUTRA_CHARS.length)
    if (hoveredId !== null) {
      for (let i = 0; i < array.length; i++) array[i] = indexToNode[i] === hoveredId ? 1 : 0
    }
    return array
  }, [hoveredId, indexToNode])

  return <SdfGlow targets={targets} strength={GLOW_STRENGTH} live={live} />
}

/**
 * 読破した語の字に灯りっぱなしの滲み。hover の琥珀と同じ仕掛けで、色と強さだけが違う。
 * 明滅させず、触っていなくても点いたままにする（狙いは「もう見た」の痕跡であって、誘目ではない）。
 */
function VisitedGlow({ targets, live }: { targets: Float32Array; live: boolean }) {
  return <SdfGlow targets={targets} color={VISITED_GLOW} strength={VISITED_GLOW_STRENGTH} live={live} />
}

/**
 * 字の裏に焚く滲み 1 層。
 *
 * 字ごとに持たせると描画呼び出しが倍になるので、紙面ぜんぶで 1 つのメッシュにまとめる。
 * 板は矩形だが、光の形は字ごとの符号付き距離場（`createGlowMaterial`）が決めるので、
 * どの字も同じ丸い光にはならず、滲みの縁が字形をなぞる。
 *
 * `targets` は字ごとの行き先（0〜1）。値は書き換えず、フレーム側で寄せる。
 */
function SdfGlow({
  targets,
  color,
  strength,
  live,
}: {
  targets: Float32Array
  color?: Color
  strength: number
  live: boolean
}) {
  const meshRef = useRef<InstancedMesh>(null)
  const dummy = useMemo(() => new Object3D(), [])
  const count = SUTRA_CHARS.length

  const focus = useMemo(() => new InstancedBufferAttribute(new Float32Array(count), 1), [count])

  /** 字ごとの距離場アトラスのセル番号。グリフが無い字は -1（マテリアル側で消える） */
  const cell = useMemo(() => {
    const array = new Float32Array(count)
    SUTRA_CHARS.forEach((char, i) => {
      array[i] = sdfCellOf(char) ?? -1
    })
    return new InstancedBufferAttribute(array, 1)
  }, [count])

  /** 初出の出はじめ（秒）。滲みは字より遅れずに点くよう、墨と同じ遅れを読む */
  const delay = useMemo(() => {
    const array = new Float32Array(count)
    for (let i = 0; i < count; i++) array[i] = revealDelayOf(i)
    return new InstancedBufferAttribute(array, 1)
  }, [count])

  const geometry = useMemo(() => {
    const plane = new PlaneGeometry(1, 1)
    plane.setAttribute('aFocus', focus)
    plane.setAttribute('aCell', cell)
    plane.setAttribute('aDelay', delay)
    return plane
  }, [focus, cell, delay])
  useEffect(() => () => geometry.dispose(), [geometry])

  const material = useMemo(
    () =>
      createGlowMaterial(
        attribute<'float'>('aCell', 'float'),
        attribute<'float'>('aFocus', 'float')
          .mul(strength)
          // まだ書かれていない字は光らない（読破の青白が墨より先に点くのを防ぐ）。
          // 滲みは板いっぱいに出るので、字の中を回る拭き方（revealMask）ではなく進み具合だけを掛ける
          .mul(revealProgress(attribute<'float'>('aDelay', 'float'))),
        { color, layer: paperOpacity },
      ),
    [color, strength],
  )
  useEffect(() => () => material.dispose(), [material])

  useFrame(({ clock }, delta) => {
    const mesh = meshRef.current
    if (!mesh || !live) return
    const t = clock.elapsedTime

    const array = focus.array as Float32Array
    let moved = false
    for (let i = 0; i < count; i++) {
      const next = approach(array[i]!, targets[i] ?? 0, delta)
      if (next !== array[i]) {
        array[i] = next
        moved = true
      }
    }
    if (moved) focus.needsUpdate = true

    for (let i = 0; i < count; i++) {
      const { x, y } = paperSway(i, t)
      // 滲みは字の裏。加算合成なので墨そのものを白く飛ばさない
      dummy.position.set(x, y, -0.05)
      dummy.scale.setScalar(GLOW_PLANE)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  })

  return <instancedMesh ref={meshRef} args={[geometry, material, count]} visible={live} frustumCulled={false} />
}

/**
 * 紙面全体を覆う透明な板。
 * ポインタ位置をワールド座標から格子インデックスへ落とすことで hover 判定にする。
 * 276 個の当たり判定を持たせるより安く、範囲が列をまたいでも破綻しない。
 */
function HoverPlane({ indexToNode, live }: { indexToNode: readonly (string | null)[]; live: boolean }) {
  const dispatch = useSetAtom(navAtom)
  const accepts = useAtomValue(acceptsInputAtom)

  const columns = GRID_COLUMNS
  const width = columns * CELL_X
  const height = COLS_PER_LINE * CELL_Y

  /** ワールド座標 → 格子 → 字。行末より下の空き升は `null` になる */
  const indexUnder = (x: number, y: number): number | null =>
    indexAt(Math.round(-x / CELL_X), Math.round((COLS_PER_LINE - 1) / 2 - y / CELL_Y))

  /** まだ現れていない字は、升が空いているのと同じ扱いにする */
  const nodeUnder = (event: ThreeEvent<PointerEvent | MouseEvent>): string | null => {
    const index = indexUnder(event.point.x, event.point.y)
    if (index === null || !isRevealed(index)) return null
    return indexToNode[index] ?? null
  }

  const onPointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!accepts) return
    dispatch({ type: 'hover', id: nodeUnder(event) })
  }

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    if (!accepts || isGestureClick()) return
    const id = nodeUnder(event)
    if (id) dispatch({ type: 'enter', id })
  }

  // 潜っているあいだは板ごと外す。`visible={false}` では**レイキャストから外れない**ので
  // （three の Raycaster は visible を見ない）、L1 以降の黒い余白のクリックが
  // 裏に残った L0 の升を叩き、無関係なノードへ飛ぶ。
  // 板は planeGeometry + meshBasicMaterial の 1 枚きりで、TSL のマテリアルを持つ
  // 字や滲みとは違い、組み直しの代償が無い（→ CLAUDE.md「面の用意をやり直さない」）。
  if (!live) return null

  return (
    <mesh
      // 紙面はワールド固定。パンはカメラ側で行うのでここは動かさない
      position={[-((columns - 1) * CELL_X) / 2, 0, -0.5]}
      onPointerMove={onPointerMove}
      onPointerOut={() => dispatch({ type: 'hover', id: null })}
      onClick={onClick}
    >
      <planeGeometry args={[width, height]} />
      {/* 見せずに当てるので、消すのではなく透明で置く */}
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  )
}

/**
 * 同じ字はジオメトリを共有し、位置とフォーカス状態だけをインスタンスで持つ。
 *
 * 発光は `setColorAt`（instanceColor）ではなく、インスタンス属性 + TSL で行う。
 * WebGPURenderer のノードマテリアル経路では instanceColor が期待どおりに効かないためで、
 * 属性を自前で持てば Tier 1 / Tier 2 のどちらでも同じ結果になる。
 */
function CharInstances({
  group,
  indexToNode,
  visitedTargets,
  live,
}: {
  group: CharGroup
  indexToNode: readonly (string | null)[]
  /** 全文インデックス基準の 0/1。読破した語に属する字が 1 */
  visitedTargets: Float32Array
  live: boolean
}) {
  const meshRef = useRef<InstancedMesh>(null)
  const dummy = useMemo(() => new Object3D(), [])
  const nav = useAtomValue(navAtom)

  /**
   * 0 = 通常、1 = フォーカス。hover では行き先だけを書き、実際の値は
   * `FOCUS_FADE` 秒かけてフレームごとに寄せる。
   */
  const focus = useMemo(
    () => new InstancedBufferAttribute(new Float32Array(group.indices.length), 1),
    [group.indices.length],
  )
  const focusTarget = useMemo(() => new Float32Array(group.indices.length), [group.indices.length])

  /**
   * 1 = 次の見出しへ持ち越される字。
   * 同じ字が紙面に何度現れても、選んだ句の位置にある字だけが立つ（char ではなく index で判定する）。
   */
  const persist = useMemo(
    () => new InstancedBufferAttribute(new Float32Array(group.indices.length), 1),
    [group.indices.length],
  )

  /**
   * 1 = 読破した語に属する字。フォーカスと同じく行き先を書いてフレーム側で寄せるので、
   * 戻ってきた紙面では青白がじわりと点く（切り替わりが瞬時だと紙面が点滅して見える）。
   */
  const visited = useMemo(
    () => new InstancedBufferAttribute(new Float32Array(group.indices.length), 1),
    [group.indices.length],
  )
  const visitedTarget = useMemo(() => new Float32Array(group.indices.length), [group.indices.length])

  /** 墨のムラの種。同じ字が紙面に何度出ても違うムラになるよう、全文インデックスから引く */
  const seed = useMemo(() => {
    const array = new Float32Array(group.indices.length)
    group.indices.forEach((index, i) => {
      const r = Math.sin(index * 78.233) * 43758.5453
      array[i] = (r - Math.floor(r)) * 8
    })
    return new InstancedBufferAttribute(array, 1)
  }, [group.indices])

  /** 初出の出はじめ（秒）。同じ字が何度出てもそれぞれの位置の順に滲む */
  const delay = useMemo(() => {
    const array = new Float32Array(group.indices.length)
    group.indices.forEach((index, i) => {
      array[i] = revealDelayOf(index)
    })
    return new InstancedBufferAttribute(array, 1)
  }, [group.indices])

  const geometry = useMemo(() => {
    const base = glyphGeometry(group.char)
    if (!base) return null
    // glyphGeometry は字ごとに 1 つを返し、CharInstances も字ごとに 1 つ。属性を足して衝突しない
    base.setAttribute('aFocus', focus)
    base.setAttribute('aSeed', seed)
    base.setAttribute('aPersist', persist)
    base.setAttribute('aVisited', visited)
    base.setAttribute('aDelay', delay)
    return base
  }, [group.char, focus, seed, persist, visited, delay])

  // シェーダは紙面で 1 本を共有する（字ごとに組み直さない）
  const material = paperInk()

  // hover の変化そのものは変わったときに 1 度だけ拾い、補間はフレーム側に任せる
  useEffect(() => {
    group.indices.forEach((index, i) => {
      focusTarget[i] = nav.hoveredId !== null && indexToNode[index] === nav.hoveredId ? 1 : 0
    })
  }, [nav.hoveredId, group.indices, indexToNode, focusTarget])

  // 読破は L1 以降で増えるので、戻ってきたときに 1 度だけ拾えばよい
  useEffect(() => {
    group.indices.forEach((index, i) => {
      visitedTarget[i] = visitedTargets[index] ?? 0
    })
  }, [visitedTargets, group.indices, visitedTarget])

  useFrame(({ clock }, delta) => {
    const mesh = meshRef.current
    if (!mesh || !live) return
    const t = clock.elapsedTime

    // フォーカス量を行き先へ寄せる。全インスタンスが行き先に着いていれば転送を省く
    const array = focus.array as Float32Array
    let moved = false
    for (let i = 0; i < array.length; i++) {
      const next = approach(array[i]!, focusTarget[i]!, delta)
      if (next !== array[i]) {
        array[i] = next
        moved = true
      }
    }
    if (moved) focus.needsUpdate = true

    // 読破の青白も同じ速さで寄せる。増えるのは戻ってきた瞬間だけなので、たいていは空振りで抜ける
    const visitedArray = visited.array as Float32Array
    let lit = false
    for (let i = 0; i < visitedArray.length; i++) {
      const next = approach(visitedArray[i]!, visitedTarget[i]!, delta)
      if (next !== visitedArray[i]) {
        visitedArray[i] = next
        lit = true
      }
    }
    if (lit) visited.needsUpdate = true

    // 持ち越される字（＝選んだ句、あるいは経文の外の 1 枚が大書に借りている字）。
    // 相ではなく id の一致で決まるので毎フレーム引き直す。
    // 判定は Transition の `belongsTo` と同じ 2 つの表を見る —— 片方だけを見ると、
    // Transition が動かしている字を紙面も並べて描いてしまい、出だしで二重に見える
    const carried = carriedNodeId()
    const persistArray = persist.array as Float32Array
    let switched = false
    group.indices.forEach((index, i) => {
      const next =
        carried !== null && (indexToNode[index] === carried || SUTRA_INDEX_TO_PAGE[index] === carried)
          ? 1
          : 0
      if (persistArray[i] !== next) {
        persistArray[i] = next
        switched = true
      }
    })
    if (switched) persist.needsUpdate = true

    group.indices.forEach((index, i) => {
      const { x, y, rotation } = paperSway(index, t)
      dummy.position.set(x, y, 0)
      dummy.rotation.z = rotation
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    })

    mesh.instanceMatrix.needsUpdate = true
  })

  if (!geometry) return null

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, group.indices.length]}
      visible={live}
      frustumCulled={false}
    />
  )
}
