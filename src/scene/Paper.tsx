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
import { AdditiveBlending, InstancedBufferAttribute, InstancedMesh, Object3D, PlaneGeometry } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { attribute, mix, positionGeometry, smoothstep, uniform, vec3 } from 'three/tsl'
import { SUTRA_CHARS, COLS_PER_LINE, GRID_COLUMNS, indexAt } from '../content/sutra.ts'
import { glyphGeometry } from './glyphs.ts'
import {
  INK,
  INK_RESTING,
  FOCUS,
  FOCUS_GLOW,
  inkDensity,
  inkShade,
  inkAlpha,
  approach,
} from './materials.ts'
import { CELL_X, CELL_Y, gridPosition } from '../world/paper.ts'
import { navAtom, acceptsInputAtom } from '../nav/atoms.ts'
import { root, childrenOf } from '../content/loader.ts'

/** 各文字が基準位置から微小にゆらぐ幅（ワールド単位） */
const SWAY = 0.035

/**
 * 発光の滲みの一辺（1 = 字面の一辺）。字より少しはみ出すだけに留める。
 * 大きくすると隣の升まで滲み、どの字が光っているのか読み取れなくなる。
 */
const GLOW_SIZE = 1.3
/** 滲みの最大の濃さ */
const GLOW_STRENGTH = 0.5

/**
 * 文字インデックス → 潜り先ノード id。
 * L0 で触れられるのは根の子（句）だけなので、その range を展開して引ける表にしておく。
 */
function buildIndexToNode(): (string | null)[] {
  const table: (string | null)[] = new Array(SUTRA_CHARS.length).fill(null)
  for (const child of childrenOf(root)) {
    if (!child.range) continue
    const [start, end] = child.range
    for (let i = start; i < end && i < table.length; i++) table[i] = child.id
  }
  return table
}

interface CharGroup {
  char: string
  /** この字が現れる全文インデックス */
  indices: number[]
}

export function Paper() {
  const indexToNode = useMemo(buildIndexToNode, [])

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
      <HoverPlane indexToNode={indexToNode} />
      <FocusGlow indexToNode={indexToNode} />
      {groups.map((group) => (
        <CharInstances key={group.char} group={group} indexToNode={indexToNode} />
      ))}
    </group>
  )
}

/**
 * ゆらぎの位相。字ごとにずらす（同じ周期で揃うと格子が波打って見える）。
 * 墨と発光の滲みが別のメッシュに分かれても同じ場所に居るよう、位相は index から引き直す。
 */
function swayPhase(index: number): number {
  return (Math.sin(index * 12.9898) * 43758.5453) % (Math.PI * 2)
}

/** ゆらぎ込みの字の位置と傾き */
function swayAt(index: number, t: number): { x: number; y: number; rotation: number } {
  const [x, y] = gridPosition(index)
  const phase = swayPhase(index)
  return {
    x: x + Math.sin(t * 0.55 + phase) * SWAY,
    y: y + Math.cos(t * 0.41 + phase * 1.7) * SWAY,
    rotation: Math.sin(t * 0.3 + phase) * 0.012,
  }
}

/**
 * フォーカスされた字の裏に焚く滲み。
 *
 * 字ごとに持たせると描画呼び出しが倍になるので、紙面ぜんぶで 1 つのメッシュにまとめる。
 * 板は字と同じジオメトリではなく矩形で、中心から縁へ落ちる減衰だけで滲みを作る。
 */
function FocusGlow({ indexToNode }: { indexToNode: (string | null)[] }) {
  const meshRef = useRef<InstancedMesh>(null)
  const dummy = useMemo(() => new Object3D(), [])
  const nav = useAtomValue(navAtom)
  const count = SUTRA_CHARS.length

  const focus = useMemo(() => new InstancedBufferAttribute(new Float32Array(count), 1), [count])
  const focusTarget = useMemo(() => new Float32Array(count), [count])

  const geometry = useMemo(() => {
    const plane = new PlaneGeometry(1, 1)
    plane.setAttribute('aFocus', focus)
    return plane
  }, [focus])
  useEffect(() => () => geometry.dispose(), [geometry])

  const material = useMemo(() => {
    const nodeMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      blending: AdditiveBlending,
    })
    const focused = attribute<'float'>('aFocus', 'float')
    // 板の中心から縁へ向かって落とす。矩形の角を残さないよう半径 0.5 で切る。
    // smoothstep の端は昇順で渡す（降順は環境によって未定義）ので、立ち上がりを作って反転させる
    const falloff = smoothstep(0, 0.5, positionGeometry.xy.length()).oneMinus()
    nodeMaterial.colorNode = vec3(FOCUS_GLOW.r, FOCUS_GLOW.g, FOCUS_GLOW.b)
    // 二乗して芯を締める。線形だと縁まで一様に明るく、滲みの範囲だけが広く見える
    nodeMaterial.opacityNode = falloff.mul(falloff).mul(focused).mul(GLOW_STRENGTH)
    return nodeMaterial
  }, [])
  useEffect(() => () => material.dispose(), [material])

  // hover の変化は行き先を書くだけ。実際の濃さはフレーム側で寄せる
  useEffect(() => {
    for (let i = 0; i < count; i++) {
      focusTarget[i] = nav.hoveredId !== null && indexToNode[i] === nav.hoveredId ? 1 : 0
    }
  }, [nav.hoveredId, indexToNode, focusTarget, count])

  useFrame(({ clock }, delta) => {
    const mesh = meshRef.current
    if (!mesh) return
    const t = clock.elapsedTime

    const array = focus.array as Float32Array
    let moved = false
    for (let i = 0; i < count; i++) {
      const next = approach(array[i]!, focusTarget[i]!, delta)
      if (next !== array[i]) {
        array[i] = next
        moved = true
      }
    }
    if (moved) focus.needsUpdate = true

    for (let i = 0; i < count; i++) {
      const { x, y } = swayAt(i, t)
      // 滲みは字の裏。加算合成なので墨そのものを白く飛ばさない
      dummy.position.set(x, y, -0.05)
      dummy.scale.setScalar(GLOW_SIZE)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  })

  return <instancedMesh ref={meshRef} args={[geometry, material, count]} frustumCulled={false} />
}

/**
 * 紙面全体を覆う透明な板。
 * ポインタ位置をワールド座標から格子インデックスへ落とすことで hover 判定にする。
 * 276 個の当たり判定を持たせるより安く、範囲が列をまたいでも破綻しない。
 */
function HoverPlane({ indexToNode }: { indexToNode: (string | null)[] }) {
  const dispatch = useSetAtom(navAtom)
  const accepts = useAtomValue(acceptsInputAtom)

  const columns = GRID_COLUMNS
  const width = columns * CELL_X
  const height = COLS_PER_LINE * CELL_Y

  /** ワールド座標 → 格子 → 字。行末より下の空き升は `null` になる */
  const indexUnder = (x: number, y: number): number | null =>
    indexAt(Math.round(-x / CELL_X), Math.round((COLS_PER_LINE - 1) / 2 - y / CELL_Y))

  const onPointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (!accepts) return
    const index = indexUnder(event.point.x, event.point.y)
    dispatch({ type: 'hover', id: index === null ? null : (indexToNode[index] ?? null) })
  }

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    if (!accepts) return
    const index = indexUnder(event.point.x, event.point.y)
    const id = index === null ? null : indexToNode[index]
    if (id) dispatch({ type: 'enter', id })
  }

  return (
    <mesh
      // 紙面はワールド固定。パンはカメラ側で行うのでここは動かさない
      position={[-((columns - 1) * CELL_X) / 2, 0, -0.5]}
      onPointerMove={onPointerMove}
      onPointerOut={() => dispatch({ type: 'hover', id: null })}
      onClick={onClick}
    >
      <planeGeometry args={[width, height]} />
      {/* visible={false} にするとレイキャストの対象から外れるので、透明にして残す */}
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
function CharInstances({ group, indexToNode }: { group: CharGroup; indexToNode: (string | null)[] }) {
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

  /** 墨のムラの種。同じ字が紙面に何度出ても違うムラになるよう、全文インデックスから引く */
  const seed = useMemo(() => {
    const array = new Float32Array(group.indices.length)
    group.indices.forEach((index, i) => {
      const r = Math.sin(index * 78.233) * 43758.5453
      array[i] = (r - Math.floor(r)) * 8
    })
    return new InstancedBufferAttribute(array, 1)
  }, [group.indices])

  const geometry = useMemo(() => {
    const base = glyphGeometry(group.char)
    if (!base) return null
    // glyphGeometry は字ごとに 1 つを返し、CharInstances も字ごとに 1 つ。属性を足して衝突しない
    base.setAttribute('aFocus', focus)
    base.setAttribute('aSeed', seed)
    return base
  }, [group.char, focus, seed])

  /** hover 中に、フォーカス外の字をどこまで沈めるか（0 = 沈めない） */
  const dim = useMemo(() => uniform(0), [])
  const dimTarget = useRef(0)

  const material = useMemo(() => {
    const nodeMaterial = new MeshBasicNodeMaterial({ transparent: true, toneMapped: false })
    const focused = attribute<'float'>('aFocus', 'float')
    const resting = mix(vec3(INK.r, INK.g, INK.b), vec3(INK_RESTING.r, INK_RESTING.g, INK_RESTING.b), dim)
    const base = mix(resting, vec3(FOCUS.r, FOCUS.g, FOCUS.b), focused)
    // 墨のムラ。光っている字ではムラを浅くして、発光の芯が抜けないようにする
    const density = mix(inkDensity(attribute<'float'>('aSeed', 'float')), 1, focused.mul(0.7))
    nodeMaterial.colorNode = base.mul(inkShade(density))
    // 光る字だけ不透明度も上げ、グローの芯にする
    nodeMaterial.opacityNode = mix(mix(0.94, 0.55, dim), 1, focused).mul(inkAlpha(density))
    return nodeMaterial
  }, [dim])

  // hover の変化そのものは変わったときに 1 度だけ拾い、補間はフレーム側に任せる
  useEffect(() => {
    group.indices.forEach((index, i) => {
      focusTarget[i] = nav.hoveredId !== null && indexToNode[index] === nav.hoveredId ? 1 : 0
    })
    dimTarget.current = nav.hoveredId ? 1 : 0
  }, [nav.hoveredId, group.indices, indexToNode, focusTarget])

  useFrame(({ clock }, delta) => {
    const mesh = meshRef.current
    if (!mesh) return
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
    dim.value = approach(dim.value, dimTarget.current, delta)

    group.indices.forEach((index, i) => {
      const { x, y, rotation } = swayAt(index, t)
      dummy.position.set(x, y, 0)
      dummy.rotation.z = rotation
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    })

    mesh.instanceMatrix.needsUpdate = true
  })

  if (!geometry) return null

  return <instancedMesh ref={meshRef} args={[geometry, material, group.indices.length]} frustumCulled={false} />
}
