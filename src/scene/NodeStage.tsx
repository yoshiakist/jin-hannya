/**
 * L1 以降 — 大書と、子ノードの関係図。
 *
 * 配置文法は 3 種類（README「レイアウト文法は 3 種類ある」）。
 *   none   … 図を持たない。大書のみ
 *   circle … 円相の内側に子を円周配置
 *   column … 角丸矩形を縦に連結
 *
 * 画面右端が現在ノードの大書、中央が子の図。情報は右から左へ流れる。
 */

import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useAtomValue, useSetAtom } from 'jotai'
import { BufferGeometry, Color, Group, Line, LineBasicMaterial, MeshBasicMaterial, Vector3 } from 'three'
import { glyphGeometry, glyphParticles, CIRCLE_KEY } from './glyphs.ts'
import { INK, FOCUS, STROKE, createInkMaterial, approach } from './materials.ts'
import { VIEW_HEIGHT } from '../world/paper.ts'
import { navAtom, currentNodeAtom, childNodesAtom, acceptsInputAtom } from '../nav/atoms.ts'
import type { GraphNode } from '../content/schema.ts'

/** 大書の 1 文字あたりの高さ。画面高の 60〜85% を大書が占める（モック分析より） */
const HEADLINE_SIZE = VIEW_HEIGHT * 0.30
/** 大書が 1 列で収まる上限。これを超えたら 2 列に折り返す（img_01 の 2 列組みに相当） */
const HEADLINE_SINGLE_COLUMN_MAX = 7

/** 画面右端の大書の中心 x。ワールド単位 */
const HEADLINE_X = VIEW_HEIGHT * 0.60

/**
 * 大書の組み方。句のように長い label でも必ず画面高に収まるよう、
 * 列数と 1 字の大きさを字数から決める。Transition もこの結果を使って粒子の出所を決めるので、
 * 配置の計算はここ 1 箇所に集約する。
 */
export function headlineLayout(label: string): { chars: string[]; perColumn: number; size: number } {
  const chars = Array.from(label)
  const perColumn =
    chars.length <= HEADLINE_SINGLE_COLUMN_MAX ? chars.length : Math.ceil(chars.length / 2)
  return { chars, perColumn, size: Math.min(HEADLINE_SIZE, (VIEW_HEIGHT * 0.80) / perColumn) }
}

/** 大書 1 字のワールド座標 */
export function headlinePosition(index: number, perColumn: number, total: number, size: number): [number, number, number] {
  const column = Math.floor(index / perColumn)
  const row = index % perColumn
  const rows = Math.min(perColumn, total - column * perColumn)
  return [HEADLINE_X - column * size * 1.15, ((rows - 1) / 2 - row) * size, 0]
}
/** 子の図の中心 x。左の解説と右の大書に挟まれた帯の中央に置く */
const DIAGRAM_X = 0

/** 発光の滲みが字面からはみ出す比率。広げるほど字の輪郭が溶けて読めなくなる */
const GLOW_SCALE = 1.03
/** 滲みの最大の濃さ */
const GLOW_OPACITY = 0.28

export function NodeStage() {
  const node = useAtomValue(currentNodeAtom)
  const children = useAtomValue(childNodesAtom)

  return (
    <group>
      <Headline node={node} />
      {node.layout === 'circle' && <CircleLayout nodes={children} />}
      {node.layout === 'column' && <ColumnLayout nodes={children} />}
    </group>
  )
}

/** 現在ノードの大書。縦組みで、長い句は左へ折り返す */
function Headline({ node }: { node: GraphNode }) {
  const { chars, perColumn, size } = useMemo(() => headlineLayout(node.label), [node.label])

  return (
    <group>
      {chars.map((char, i) => (
        <Glyph
          key={`${char}-${i}`}
          char={char}
          position={headlinePosition(i, perColumn, chars.length, size)}
          size={size}
          color={INK}
        />
      ))}
    </group>
  )
}

/**
 * 円相レイアウト。
 * 外周は assets/pattern/circle.svg（手続き的生成はしない）。子は円周上へ均等配置し、中心は空ける。
 */
function CircleLayout({ nodes }: { nodes: GraphNode[] }) {
  const diameter = VIEW_HEIGHT * 0.58
  const radius = diameter * 0.34

  return (
    <group position={[DIAGRAM_X, 0, 0]}>
      <Glyph char={CIRCLE_KEY} position={[0, 0, -0.2]} size={diameter} color={STROKE} opacity={0.55} />
      {nodes.map((child, i) => {
        // 頂点付近から時計回りに 1 つずつ
        const angle = Math.PI / 2 - (i / nodes.length) * Math.PI * 2
        return (
          <ChildNode
            key={child.id}
            node={child}
            position={[Math.cos(angle) * radius, Math.sin(angle) * radius, 0]}
            size={diameter * 0.17}
            frame={false}
          />
        )
      })}
    </group>
  )
}

/**
 * 縦連結レイアウト。
 * 角丸矩形を縦に等間隔で並べ、中央を通る 1 本の細い縦線で連結する。
 * hover では文字と枠の両方が琥珀に光る（img_03 の文字のみの発光との違い）。
 */
function ColumnLayout({ nodes }: { nodes: GraphNode[] }) {
  const pitch = (VIEW_HEIGHT * 0.78) / Math.max(nodes.length, 1)
  const size = Math.min(pitch * 0.42, VIEW_HEIGHT * 0.075)
  const top = ((nodes.length - 1) / 2) * pitch
  // 箱の高さぶんを除いた「あいだ」だけに線を引く。箱を貫かせない
  const gap = Math.max(0, pitch - size * 1.9)

  return (
      <group position={[DIAGRAM_X, 0, 0]}>
        {nodes.slice(0, -1).map((child, i) => (
          <mesh key={`link-${child.id}`} position={[0, top - i * pitch - pitch / 2, -0.3]}>
            <planeGeometry args={[0.02, gap]} />
            <meshBasicMaterial color={STROKE} transparent opacity={0.55} toneMapped={false} />
          </mesh>
        ))}
        {nodes.map((child, i) => (
          <ChildNode key={child.id} node={child} position={[0, top - i * pitch, 0]} size={size} frame />
        ))}
      </group>
    )
}

/** 図中の子ノード 1 つ。hover で琥珀に発光し、クリックで一段潜る */
function ChildNode({
  node,
  position,
  size,
  frame,
}: {
  node: GraphNode
  position: [number, number, number]
  size: number
  frame: boolean
}) {
  const dispatch = useSetAtom(navAtom)
  const accepts = useAtomValue(acceptsInputAtom)
  const hoveredId = useAtomValue(navAtom).hoveredId
  const hovered = hoveredId === node.id
  const chars = useMemo(() => Array.from(node.label), [node.label])

  const width = size * (chars.length * 1.05 + 1.6)
  const height = size * 1.9

  return (
    <group
      position={position}
      onPointerOver={(event) => {
        event.stopPropagation()
        if (accepts) dispatch({ type: 'hover', id: node.id })
      }}
      onPointerOut={() => accepts && dispatch({ type: 'hover', id: null })}
      onClick={(event) => {
        event.stopPropagation()
        if (accepts) dispatch({ type: 'enter', id: node.id })
      }}
    >
      {frame && <RoundedFrame width={width} height={height} focused={hovered} />}
      {/* 枠の中では字を横に並べる。縦組みの図では 1 字ずつ縦に積む */}
      {chars.map((char, i) => (
        <Glyph
          key={`${char}-${i}`}
          char={char}
          position={
            frame
              ? // 枠の中は横組み。左から右へ読む
                [(i - (chars.length - 1) / 2) * size * 1.08, 0, 0]
              : // 図の中の縦組み。上から下へ読む
                [0, ((chars.length - 1) / 2 - i) * size * 1.08, 0]
          }
          size={size}
          color={INK}
          focused={hovered}
        />
      ))}
      {/* 当たり判定。字の隙間で hover が切れないように矩形で覆う。
          visible={false} だとレイキャストされないため、透明にして残す */}
      <mesh position={[0, 0, 0.1]}>
        <planeGeometry args={[Math.max(width, size * 1.6), Math.max(height, size * chars.length * 1.3)]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  )
}

/**
 * 角丸矩形（スタジアム形に近い）の枠線。塗りは背景と同じ黒。
 * `<line>` は JSX 上で SVG の line と衝突し、WebGPURenderer は LineLoop を描かないため、
 * THREE.Line を自前で組んで primitive として差し込む。
 */
function RoundedFrame({ width, height, focused }: { width: number; height: number; focused: boolean }) {
  const line = useMemo(() => {
    // 角丸半径は高さの約 1/4（img_02 のプロポーション）
    const radius = height / 4
    const halfW = Math.max(0, width / 2 - radius)
    const halfH = Math.max(0, height / 2 - radius)
    const corners: [number, number, number][] = [
      [halfW, halfH, 0],
      [-halfW, halfH, Math.PI / 2],
      [-halfW, -halfH, Math.PI],
      [halfW, -halfH, -Math.PI / 2],
    ]
    const points: Vector3[] = []
    for (const [cx, cy, start] of corners) {
      for (let s = 0; s <= 8; s++) {
        const angle = start + (s / 8) * (Math.PI / 2)
        points.push(new Vector3(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 0))
      }
    }
    // 始点を末尾に足して閉じる
    points.push(points[0]!.clone())

    return new Line(
      new BufferGeometry().setFromPoints(points),
      new LineBasicMaterial({ transparent: true, opacity: 0.75, toneMapped: false }),
    )
  }, [width, height])

  // 色は hover でじわりと動く。React の再レンダーではなくフレームごとに寄せる
  const amount = useRef(0)
  useFrame((_, delta) => {
    amount.current = approach(amount.current, focused ? 1 : 0, delta)
    ;(line.material as LineBasicMaterial).color.copy(STROKE).lerp(FOCUS, amount.current)
  })

  return <primitive object={line} />
}

/** 前計算済みグリフ 1 文字。`size` は字面の一辺（ワールド単位） */
export function Glyph({
  char,
  position,
  size,
  color,
  opacity = 1,
  focused = false,
}: {
  char: string
  position: [number, number, number]
  size: number
  color: Color
  opacity?: number
  /** 琥珀への発色と滲み。切り替えは瞬時ではなく FOCUS_FADE 秒かけて渡る */
  focused?: boolean
}) {
  const geometry = useMemo(() => glyphGeometry(char), [char])
  const groupRef = useRef<Group>(null)

  // 墨のムラ。色と不透明度はユニフォーム越しに毎レンダー流し込む（hover でシェーダを作り直さない）
  const ink = useMemo(() => createInkMaterial(), [])
  useEffect(() => () => ink.material.dispose(), [ink])
  ink.color.value.copy(color)
  ink.opacity.value = opacity

  /** 発光の滲み。hover していない間も置いたままにし、不透明度だけで出し入れする */
  const glowMaterial = useMemo(
    () => new MeshBasicMaterial({ color: FOCUS, transparent: true, opacity: 0, toneMapped: false }),
    [],
  )
  useEffect(() => () => glowMaterial.dispose(), [glowMaterial])
  const focusAmount = useRef(0)
  ink.scale.value = size
  // 種は字ごとに固定。同じ字は常に同じムラになるので、遷移で拡大しても模様が飛ばない
  ink.seed.value = ((char.codePointAt(0) ?? 0) % 251) / 251 * 8

  // 大書もわずかにゆらぐ。紙面と同じ運動則にすることで、潜っても同じ場だと分かる
  const phase = useMemo(() => (char.charCodeAt(0) % 97) / 97 * Math.PI * 2, [char])
  useFrame(({ clock }, delta) => {
    focusAmount.current = approach(focusAmount.current, focused ? 1 : 0, delta)
    // 墨から琥珀へじわりと寄せ、同じ量で滲みを焚く
    ink.color.value.copy(color).lerp(FOCUS, focusAmount.current)
    glowMaterial.opacity = focusAmount.current * GLOW_OPACITY

    const group = groupRef.current
    if (!group) return
    const t = clock.elapsedTime
    group.position.set(
      position[0] + Math.sin(t * 0.42 + phase) * size * 0.012,
      position[1] + Math.cos(t * 0.31 + phase) * size * 0.012,
      position[2],
    )
  })

  if (!geometry) return null

  return (
    <group ref={groupRef} position={position}>
      <mesh geometry={geometry} material={ink.material} scale={size} />
      {/* グローの近距離側。遠距離側は DOM 側の bloom 相当で補う */}
      <mesh geometry={geometry} material={glowMaterial} scale={size * GLOW_SCALE} position={[0, 0, -0.01]} />
    </group>
  )
}

/** 粒子のホームポジションを引く薄いラッパ。散開・凝集演出の入口 */
export function particlesFor(char: string, count: number): Float32Array | null {
  return glyphParticles(char, count)
}
