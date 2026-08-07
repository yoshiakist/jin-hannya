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
import { InstancedBufferAttribute, InstancedMesh, Object3D } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { attribute, mix, uniform, vec3 } from 'three/tsl'
import { SUTRA_CHARS, COLS_PER_LINE, GRID_COLUMNS, indexAt } from '../content/sutra.ts'
import { glyphGeometry } from './glyphs.ts'
import { INK, INK_RESTING, FOCUS } from './materials.ts'
import { CELL_X, CELL_Y, gridPosition } from '../world/paper.ts'
import { navAtom, acceptsInputAtom } from '../nav/atoms.ts'
import { root, childrenOf } from '../content/loader.ts'

/** 各文字が基準位置から微小にゆらぐ幅（ワールド単位） */
const SWAY = 0.035

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
      {groups.map((group) => (
        <CharInstances key={group.char} group={group} indexToNode={indexToNode} />
      ))}
    </group>
  )
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

  /** 0 = 通常、1 = フォーカス。hover が変わったときだけ書き換える */
  const focus = useMemo(
    () => new InstancedBufferAttribute(new Float32Array(group.indices.length), 1),
    [group.indices.length],
  )

  const geometry = useMemo(() => {
    const base = glyphGeometry(group.char)
    if (!base) return null
    // glyphGeometry は字ごとに 1 つを返し、CharInstances も字ごとに 1 つ。属性を足して衝突しない
    base.setAttribute('aFocus', focus)
    return base
  }, [group.char, focus])

  /** hover 中に、フォーカス外の字をどこまで沈めるか（0 = 沈めない） */
  const dim = useMemo(() => uniform(0), [])

  const material = useMemo(() => {
    const nodeMaterial = new MeshBasicNodeMaterial({ transparent: true, toneMapped: false })
    const focused = attribute<'float'>('aFocus', 'float')
    const resting = mix(vec3(INK.r, INK.g, INK.b), vec3(INK_RESTING.r, INK_RESTING.g, INK_RESTING.b), dim)
    nodeMaterial.colorNode = mix(resting, vec3(FOCUS.r, FOCUS.g, FOCUS.b), focused)
    // 光る字だけ不透明度も上げ、グローの芯にする
    nodeMaterial.opacityNode = mix(mix(0.94, 0.55, dim), 1, focused)
    return nodeMaterial
  }, [dim])

  /** ゆらぎの位相を字ごとにずらす。同じ周期で揃うと格子が波打って見えてしまう */
  const phases = useMemo(
    () => group.indices.map((index) => (Math.sin(index * 12.9898) * 43758.5453) % (Math.PI * 2)),
    [group.indices],
  )

  // hover の変化はフレームごとではなく、変わったときに 1 度だけ反映する
  useEffect(() => {
    const array = focus.array as Float32Array
    group.indices.forEach((index, i) => {
      array[i] = nav.hoveredId !== null && indexToNode[index] === nav.hoveredId ? 1 : 0
    })
    focus.needsUpdate = true
    dim.value = nav.hoveredId ? 1 : 0
  }, [nav.hoveredId, group.indices, indexToNode, focus, dim])

  useFrame(({ clock }) => {
    const mesh = meshRef.current
    if (!mesh) return
    const t = clock.elapsedTime

    group.indices.forEach((index, i) => {
      const [x, y] = gridPosition(index)
      const phase = phases[i]!
      dummy.position.set(
        x + Math.sin(t * 0.55 + phase) * SWAY,
        y + Math.cos(t * 0.41 + phase * 1.7) * SWAY,
        0,
      )
      dummy.rotation.z = Math.sin(t * 0.3 + phase) * 0.012
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    })

    mesh.instanceMatrix.needsUpdate = true
  })

  if (!geometry) return null

  return <instancedMesh ref={meshRef} args={[geometry, material, group.indices.length]} frustumCulled={false} />
}
