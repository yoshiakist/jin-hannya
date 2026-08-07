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
import { BufferGeometry, Color, Group, Line, LineBasicMaterial, PlaneGeometry, Vector3 } from 'three'
import { uniform } from 'three/tsl'
import { glyphGeometry, glyphParticles, sdfCellOf, CIRCLE_KEY } from './glyphs.ts'
import {
  INK,
  FOCUS,
  STROKE,
  GLOW_PLANE,
  createGlowMaterial,
  createInkMaterial,
  createStrokeMaterial,
  stageOpacityValue,
  approach,
} from './materials.ts'
import { carriedNodeId } from './carry.ts'
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
export const DIAGRAM_X = 0

/** 図の中の子ノード 1 つぶんの配置。位置は図の原点（`DIAGRAM_X`）からの相対 */
export interface DiagramItem {
  node: GraphNode
  position: [number, number]
  /** 字面の一辺 */
  size: number
  /** 角丸枠を持つか。枠の中は横組み、無いものは縦組みになる */
  frame: boolean
}

/**
 * 子の図の配置。
 *
 * 遷移で「子の字がそのまま次の見出しへ移る」ためには、Transition が描画とまったく同じ
 * 位置・大きさを引けなければならない。配置の数値はここ 1 箇所だけが持つ。
 */
export function diagramItems(node: GraphNode, children: GraphNode[]): DiagramItem[] {
  if (node.layout === 'circle') {
    const diameter = VIEW_HEIGHT * 0.58
    const radius = diameter * 0.34
    return children.map((child, i) => {
      // 頂点付近から時計回りに 1 つずつ
      const angle = Math.PI / 2 - (i / children.length) * Math.PI * 2
      return {
        node: child,
        position: [Math.cos(angle) * radius, Math.sin(angle) * radius] as [number, number],
        size: diameter * 0.17,
        frame: false,
      }
    })
  }

  if (node.layout === 'column') {
    const { pitch, size, top } = columnMetrics(children.length)
    return children.map((child, i) => ({
      node: child,
      position: [0, top - i * pitch] as [number, number],
      size,
      frame: true,
    }))
  }

  return []
}

/** 縦連結レイアウトの寸法。図の描画と連結線が同じ値を読む */
function columnMetrics(count: number): { pitch: number; size: number; top: number } {
  const pitch = (VIEW_HEIGHT * 0.78) / Math.max(count, 1)
  return {
    pitch,
    size: Math.min(pitch * 0.42, VIEW_HEIGHT * 0.075),
    top: ((count - 1) / 2) * pitch,
  }
}

/** 子ノードの `index` 番目の字の、その子の中心からの相対位置 */
export function childCharOffset(index: number, count: number, size: number, frame: boolean): [number, number] {
  return frame
    ? // 枠の中は横組み。左から右へ読む
      [(index - (count - 1) / 2) * size * 1.08, 0]
    : // 図の中の縦組み。上から下へ読む
      [0, ((count - 1) / 2 - index) * size * 1.08]
}

/** 滲みの最大の濃さ。広がりは距離場が決めるので、ここで持つのは強さだけ */
const GLOW_OPACITY = 0.5

export function NodeStage() {
  const node = useAtomValue(currentNodeAtom)
  const children = useAtomValue(childNodesAtom)

  return (
    <group>
      <Headline node={node} />
      {node.layout === 'circle' && <CircleLayout items={diagramItems(node, children)} />}
      {node.layout === 'column' && <ColumnLayout items={diagramItems(node, children)} />}
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
          // 潜って来た／これから戻る字。遷移では薄れず、図の位置とのあいだを動く
          owner={node.id}
        />
      ))}
    </group>
  )
}

/**
 * 円相レイアウト。
 * 外周は assets/pattern/circle.svg（手続き的生成はしない）。子は円周上へ均等配置し、中心は空ける。
 */
function CircleLayout({ items }: { items: DiagramItem[] }) {
  const diameter = VIEW_HEIGHT * 0.58

  return (
    <group position={[DIAGRAM_X, 0, 0]}>
      <Glyph char={CIRCLE_KEY} position={[0, 0, -0.2]} size={diameter} color={STROKE} opacity={0.55} />
      {items.map((item) => (
        <ChildNode key={item.node.id} item={item} />
      ))}
    </group>
  )
}

/**
 * 縦連結レイアウト。
 * 角丸矩形を縦に等間隔で並べ、中央を通る 1 本の細い縦線で連結する。
 * hover では文字と枠の両方が琥珀に光る（img_03 の文字のみの発光との違い）。
 */
function ColumnLayout({ items }: { items: DiagramItem[] }) {
  // 連結線も字と同じ濃さで出入りさせる（stageOpacity を通すためノードマテリアルで持つ）
  const link = useMemo(() => createStrokeMaterial(0.55), [])
  useEffect(() => () => link.dispose(), [link])
  const { pitch, size } = columnMetrics(items.length)
  // 箱の高さぶんを除いた「あいだ」だけに線を引く。箱を貫かせない
  const gap = Math.max(0, pitch - size * 1.9)

  return (
      <group position={[DIAGRAM_X, 0, 0]}>
        {items.slice(0, -1).map((item) => (
          <mesh
            key={`link-${item.node.id}`}
            position={[0, item.position[1] - pitch / 2, -0.3]}
            material={link}
          >
            <planeGeometry args={[0.02, gap]} />
          </mesh>
        ))}
        {items.map((item) => (
          <ChildNode key={item.node.id} item={item} />
        ))}
      </group>
    )
}

/** 図中の子ノード 1 つ。hover で琥珀に発光し、クリックで一段潜る */
function ChildNode({ item }: { item: DiagramItem }) {
  const { node, size, frame } = item
  const position: [number, number, number] = [item.position[0], item.position[1], 0]
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
      {chars.map((char, i) => {
        const [dx, dy] = childCharOffset(i, chars.length, size, frame)
        return (
          <Glyph
            key={`${char}-${i}`}
            char={char}
            position={[dx, dy, 0]}
            size={size}
            color={INK}
            focused={hovered}
            // この子へ潜る／この子から戻るときは、ここの字がそのまま大書へ渡る
            owner={node.id}
          />
        )
      })}
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
    const material = line.material as LineBasicMaterial
    material.color.copy(STROKE).lerp(FOCUS, amount.current)
    // 枠は Line なのでノードマテリアルを持てない。同じ値を CPU 側から掛ける
    material.opacity = 0.75 * stageOpacityValue()
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
  owner,
}: {
  char: string
  position: [number, number, number]
  size: number
  color: Color
  opacity?: number
  /** 琥珀への発色と滲み。切り替えは瞬時ではなく FOCUS_FADE 秒かけて渡る */
  focused?: boolean
  /** この字が属するノード id。遷移で持ち越される側かどうかの判定に使う */
  owner?: string
}) {
  const geometry = useMemo(() => glyphGeometry(char), [char])
  const groupRef = useRef<Group>(null)

  // 墨のムラ。色と不透明度はユニフォーム越しに毎レンダー流し込む（hover でシェーダを作り直さない）
  const ink = useMemo(() => createInkMaterial(), [])
  useEffect(() => () => ink.material.dispose(), [ink])
  ink.color.value.copy(color)
  ink.opacity.value = opacity

  /**
   * 発光の滲み。hover していない間も置いたままにし、濃さだけで出し入れする。
   * 光の形は字の符号付き距離場から引くので、字を拡大コピーした板より輪郭が字に忠実になる。
   */
  const glow = useMemo(() => {
    const amount = uniform(0)
    const cell = uniform(sdfCellOf(char) ?? -1)
    return { material: createGlowMaterial(cell, amount), amount }
  }, [char])
  useEffect(() => () => glow.material.dispose(), [glow])
  const glowGeometry = useMemo(() => new PlaneGeometry(1, 1), [])
  useEffect(() => () => glowGeometry.dispose(), [glowGeometry])
  const focusAmount = useRef(0)
  ink.scale.value = size
  // 種は字ごとに固定。同じ字は常に同じムラになるので、遷移で拡大しても模様が飛ばない
  ink.seed.value = ((char.codePointAt(0) ?? 0) % 251) / 251 * 8

  // 大書もわずかにゆらぐ。紙面と同じ運動則にすることで、潜っても同じ場だと分かる
  const phase = useMemo(() => (char.charCodeAt(0) % 97) / 97 * Math.PI * 2, [char])
  useFrame(({ clock }, delta) => {
    // 持ち越される字は遷移中こちらでは描かない（Transition が動かしながら描く）。
    // 相ではなく id の一致で決まるので、React の再レンダーを待たずフレームごとに引く
    ink.persist.value = owner !== undefined && owner === carriedNodeId() ? 1 : 0
    focusAmount.current = approach(focusAmount.current, focused ? 1 : 0, delta)
    // 墨から琥珀へじわりと寄せ、同じ量で滲みを焚く
    ink.color.value.copy(color).lerp(FOCUS, focusAmount.current)
    glow.amount.value = focusAmount.current * GLOW_OPACITY

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
      {/* 滲みは字の裏。板は字面より一回り大きく、光の届く範囲は距離場が切る */}
      <mesh geometry={glowGeometry} material={glow.material} scale={size * GLOW_PLANE} position={[0, 0, -0.01]} />
    </group>
  )
}

/** 粒子のホームポジションを引く薄いラッパ。散開・凝集演出の入口 */
export function particlesFor(char: string, count: number): Float32Array | null {
  return glyphParticles(char, count)
}
