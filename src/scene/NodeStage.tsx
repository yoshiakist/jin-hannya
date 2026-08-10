/**
 * L1 以降 — 大書と、子ノードの関係図。
 *
 * 配置文法は 3 種類（README「レイアウト文法は 3 種類ある」）。
 *   none   … 図を持たない。大書のみ
 *   circle … 円相の内側に子を円周配置
 *   column … 角丸矩形を縦に連結
 *
 * 画面右端が現在ノードの大書、中央が子の図。情報は右から左へ流れる。
 * 位置と大きさは `world/node-layout.ts` が持つ（遷移と DOM オーバーレイが同じ値を引くため）。
 * ここは描き方だけを持つ。
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
  nodeOpacityValue,
  approach,
} from './materials.ts'
import { carriedNodeId } from './carry.ts'
import { isGestureClick } from '../world/pan.ts'
import { advancePulse, pulseAt, restartPulse } from './pulse.ts'
import { swayAt, swayPhase } from './sway.ts'
import {
  CIRCLE_DIAMETER,
  connectorDotRadius,
  connectorPath,
  diagramCenterX,
  columnMetrics,
  childCharOffset,
  diagramItems,
  frameSize,
  headlineLayout,
  type DiagramItem,
} from '../world/node-layout.ts'
import { navAtom, currentNodeAtom, childNodesAtom, acceptsInputAtom } from '../nav/atoms.ts'
import { headlineChildOwners } from '../content/loader.ts'
import { labelText, type GraphNode } from '../content/schema.ts'

/** 滲みの最大の濃さ。広がりは距離場が決めるので、ここで持つのは強さだけ */
const GLOW_OPACITY = 0.5

/** 引き出し線の濃さ。円相（0.55）よりわずかに落とし、地の装置として控えさせる */
const CONNECTOR_OPACITY = 0.45
/** 付け根の点の濃さ。線より濃く、字よりは控えめに */
const CONNECTOR_DOT_OPACITY = 0.7

export function NodeStage() {
  const node = useAtomValue(currentNodeAtom)
  const children = useAtomValue(childNodesAtom)

  // 入口の呼び水はノードごとに数え直す。時計を進めるのはここ 1 箇所で、
  // 字は `pulseAt` を読むだけにする（親の useFrame が子より先に回る）
  useEffect(() => restartPulse(), [node.id])
  useFrame(({ clock }) => advancePulse(clock.elapsedTime))

  return (
    <group>
      <Headline node={node} />
      {node.layout === 'circle' && <Connector node={node} />}
      {node.layout === 'circle' && <CircleLayout node={node} items={diagramItems(node, children)} />}
      {node.layout === 'column' && <ColumnLayout node={node} items={diagramItems(node, children)} />}
    </group>
  )
}

/**
 * 現在ノードの大書。縦組みで、長い句は左へ折り返す。
 *
 * 図を持たないノードでは、**大書そのものが子への入口**になる（`headlineChildOwners`）。
 * 子の `range` にあたる字だけが hover で琥珀に光り、クリックで一段潜る。
 * L0 の紙面で句の範囲だけが光るのと同じ表現を、そのまま大書へ持ち込んだもの。
 */
function Headline({ node }: { node: GraphNode }) {
  const { chars, positions, size } = useMemo(() => headlineLayout(node), [node])
  const owners = useMemo(() => headlineChildOwners(node), [node])
  const hoveredId = useAtomValue(navAtom).hoveredId

  /** 入口ごとに、その子が占める字の位置。列をまたいでも 1 つの入口として扱える */
  const gates = useMemo(() => {
    const byChild = new Map<string, [number, number, number][]>()
    owners.forEach((id, i) => {
      if (!id) return
      const cells = byChild.get(id)
      if (cells) cells.push(positions[i]!)
      else byChild.set(id, [positions[i]!])
    })
    return [...byChild.entries()]
  }, [owners, positions])

  /** 入口の並び順（＝呼び水の灯る順）。大書は読み順そのまま、上の字から灯る */
  const order = useMemo(() => new Map(gates.map(([id], i) => [id, i])), [gates])

  return (
    <group>
      {chars.map((char, i) => (
        <Glyph
          key={`${char}-${i}`}
          char={char}
          position={positions[i]!}
          size={size}
          color={INK}
          focused={owners[i] !== null && owners[i] === hoveredId}
          // 図を持たないノードでは、この字が入口。周期的に琥珀へ灯して押せると知らせる
          pulseOrder={owners[i] === null ? undefined : order.get(owners[i]!)}
          // 潜って来た／これから戻る字。遷移では薄れず、図の位置とのあいだを動く
          owner={node.id}
          // 一段深くへ潜るときは、この字がそのまま次の大書へ渡る
          enters={owners[i] ?? undefined}
        />
      ))}
      {gates.map(([id, cells]) => (
        <HeadlineGate key={`gate-${id}`} id={id} cells={cells} size={size} />
      ))}
    </group>
  )
}

/**
 * 大書の中の入口 1 つぶんの当たり判定。
 * 字の上へ透明な板を置くだけで、光らせるのは `Headline` 側の `focused`。
 * 見せずに当てたいので、`visible={false}` で消すのではなく透明マテリアルで置く。
 */
function HeadlineGate({
  id,
  cells,
  size,
}: {
  id: string
  cells: [number, number, number][]
  size: number
}) {
  const dispatch = useSetAtom(navAtom)
  const accepts = useAtomValue(acceptsInputAtom)

  return (
    <group
      onPointerOver={(event) => {
        event.stopPropagation()
        if (accepts) dispatch({ type: 'hover', id })
      }}
      onPointerOut={() => accepts && dispatch({ type: 'hover', id: null })}
      onClick={(event) => {
        event.stopPropagation()
        if (accepts && !isGestureClick()) dispatch({ type: 'enter', id })
      }}
    >
      {cells.map(([x, y], i) => (
        <mesh key={i} position={[x, y, 0.1]}>
          {/* 升は字面ぴったり。縦は隙間なく繋がり、横は列のあいだで切れる */}
          <planeGeometry args={[size, size]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
    </group>
  )
}

/**
 * 大書から図への引き出し線。大書の左端から水平に出て、段差を降り、円相の右端へ入る（img_03）。
 * 親子関係を目で辿らせる装置なので、線そのものは揺らさない（図と大書のあいだに固定して掛ける）。
 *
 * 枠線と同じく `THREE.Line` を自前で組む（`<line>` は JSX の SVG と衝突し、
 * WebGPURenderer はノードマテリアルなしの線を素直に描くため）。
 */
function Connector({ node }: { node: GraphNode }) {
  const path = useMemo(() => connectorPath(node), [node])

  const line = useMemo(() => {
    if (!path) return null
    const points = path.map(([x, y]) => new Vector3(x, y, -0.3))
    return new Line(
      new BufferGeometry().setFromPoints(points),
      new LineBasicMaterial({ transparent: true, opacity: CONNECTOR_OPACITY, toneMapped: false, color: STROKE }),
    )
  }, [path])

  // 付け根の点。線より濃く打って、大書から線が出ているのだと分かるようにする。
  // こちらはメッシュなのでノードマテリアルが持てる（濃さは nodeOpacity 任せ）
  const dot = useMemo(() => createStrokeMaterial(CONNECTOR_DOT_OPACITY), [])
  useEffect(() => () => dot.dispose(), [dot])

  useEffect(
    () => () => {
      line?.geometry.dispose()
      ;(line?.material as LineBasicMaterial | undefined)?.dispose()
    },
    [line],
  )

  // 線は Line なのでノードマテリアルを持てない。遷移の濃さを CPU 側から掛ける（枠線と同じ）
  useFrame(() => {
    if (!line) return
    ;(line.material as LineBasicMaterial).opacity = CONNECTOR_OPACITY * nodeOpacityValue()
  })

  if (!line || !path) return null
  const [startX, startY] = path[0]!
  return (
    <group>
      <primitive object={line} />
      <mesh position={[startX, startY, -0.3]} material={dot}>
        <circleGeometry args={[connectorDotRadius(), 16]} />
      </mesh>
    </group>
  )
}

/**
 * 円相レイアウト。
 * 外周は assets/pattern/circle.svg（手続き的生成はしない）。子は円周上へ均等配置し、中心は空ける。
 */
function CircleLayout({ node, items }: { node: GraphNode; items: DiagramItem[] }) {
  const diameter = CIRCLE_DIAMETER

  return (
    <group position={[diagramCenterX(node), 0, 0]}>
      <Glyph
        char={CIRCLE_KEY}
        position={[0, 0, -0.2]}
        size={diameter}
        color={STROKE}
        opacity={0.55}
        // 円相は図の地。振れ幅は中の字に合わせ、輪だけが大きく泳がないようにする
        swaySize={diameter * 0.17}
      />
      {items.map((item, i) => (
        <ChildNode key={item.node.id} item={item} order={i} />
      ))}
    </group>
  )
}

/**
 * 縦連結レイアウト。
 * 角丸矩形を縦に等間隔で並べ、中央を通る 1 本の細い縦線で連結する。
 * hover では文字と枠の両方が琥珀に光る（img_03 の文字のみの発光との違い）。
 */
function ColumnLayout({ node, items }: { node: GraphNode; items: DiagramItem[] }) {
  // 連結線も字と同じ濃さで出入りさせる（nodeOpacity を通すためノードマテリアルで持つ）
  const link = useMemo(() => createStrokeMaterial(0.55), [])
  useEffect(() => () => link.dispose(), [link])
  const { pitch, size } = columnMetrics(items.length)
  // 箱の高さぶんを除いた「あいだ」だけに線を引く。箱を貫かせない
  const gap = Math.max(0, pitch - size * 1.9)

  return (
      <group position={[diagramCenterX(node), 0, 0]}>
        {items.slice(0, -1).map((item) => (
          <mesh
            key={`link-${item.node.id}`}
            position={[0, item.position[1] - pitch / 2, -0.3]}
            material={link}
          >
            <planeGeometry args={[0.02, gap]} />
          </mesh>
        ))}
        {items.map((item, i) => (
          <ChildNode key={item.node.id} item={item} order={i} />
        ))}
      </group>
    )
}

/**
 * 図中の子ノード 1 つ。hover で琥珀に発光し、クリックで一段潜る。
 * `order` は図の中での並び順で、入口の呼び水が灯る順になる（→ `pulse.ts`）。
 */
function ChildNode({ item, order }: { item: DiagramItem; order: number }) {
  const { node, size, frame } = item
  const position: [number, number, number] = [item.position[0], item.position[1], 0]
  const dispatch = useSetAtom(navAtom)
  const accepts = useAtomValue(acceptsInputAtom)
  const hoveredId = useAtomValue(navAtom).hoveredId
  const hovered = hoveredId === node.id
  const chars = useMemo(() => Array.from(labelText(node.label)), [node.label])

  const { width, height } = frameSize(chars.length, size)
  const along = size * chars.length * 1.3
  const across = size * 1.6
  const hitSize: [number, number] = frame
    ? [Math.max(width, along), Math.max(height, across)]
    : [Math.max(width, across), Math.max(height, along)]

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
        if (accepts && !isGestureClick()) dispatch({ type: 'enter', id: node.id })
      }}
    >
      {frame && <RoundedFrame width={width} height={height} focused={hovered} pulseOrder={order} />}
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
            // 図の中の字も入口。周期的に灯して、押せるものだと知らせる
            pulseOrder={order}
            // この子へ潜る／この子から戻るときは、ここの字がそのまま大書へ渡る
            owner={node.id}
          />
        )
      })}
      {/* 当たり判定。字の隙間で hover が切れないように矩形で覆う。
          見せずに当てるので、消すのではなく透明で置く。
          字数が効くのは**字の並ぶ軸だけ**（枠の中は横組み・図の中は縦組み）。
          両軸に効かせると縦連結で上下の隣まで覆い、手前の枠が hover を奪う */}
      <mesh position={[0, 0, 0.1]}>
        <planeGeometry args={hitSize} />
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
function RoundedFrame({
  width,
  height,
  focused,
  pulseOrder,
}: {
  width: number
  height: number
  focused: boolean
  /** 入口の呼び水の順番。枠を持つ図では、字と一緒に枠も灯る（hover と同じ扱い） */
  pulseOrder?: number
}) {
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
    // 触れているあいだは呼び水より必ず明るい（灯りは山でも 1 に届かない）
    const lit = Math.max(amount.current, pulseOrder === undefined ? 0 : pulseAt(pulseOrder))
    const material = line.material as LineBasicMaterial
    material.color.copy(STROKE).lerp(FOCUS, lit)
    // 枠は Line なのでノードマテリアルを持てない。同じ値を CPU 側から掛ける
    material.opacity = 0.75 * nodeOpacityValue()
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
  pulseOrder,
  owner,
  enters,
  swaySize = size,
}: {
  char: string
  position: [number, number, number]
  size: number
  color: Color
  opacity?: number
  /**
   * ゆらぎの振れ幅を決める大きさ。既定は字面そのもの。
   * 円相のように字ではないものだけ、周りの字と同じ幅で漂うよう小さく渡す
   */
  swaySize?: number
  /** 琥珀への発色と滲み。切り替えは瞬時ではなく FOCUS_FADE 秒かけて渡る */
  focused?: boolean
  /**
   * 子への入口である字だけが持つ、呼び水の順番（→ `pulse.ts`）。
   * 触られていなくても周期的に琥珀へ灯り、押せる字だと知らせる。
   */
  pulseOrder?: number
  /** この字が属するノード id。遷移で持ち越される側かどうかの判定に使う */
  owner?: string
  /**
   * この字から潜れる子のノード id（大書の中の入口）。
   * 持ち越しは深い側のノードで決まるので、潜るときは `owner` ではなくこちらが一致する。
   */
  enters?: string
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

  // 大書も図の中の字もゆらぐ。紙面とまったく同じ運動則（`sway.ts`）に乗せることで、
  // 潜っても同じ場に浮かんでいると分かる。位相は字から引き、遷移の持ち越しと揃える
  const phase = useMemo(() => swayPhase(char.codePointAt(0) ?? 0), [char])
  useFrame(({ clock }, delta) => {
    // 持ち越される字は遷移中こちらでは描かない（Transition が動かしながら描く）。
    // 相ではなく id の一致で決まるので、React の再レンダーを待たずフレームごとに引く。
    // 浅い側へ戻るなら自分の owner が、深い側へ潜るなら大書の中の入口（enters）が一致する
    const carried = carriedNodeId()
    ink.persist.value = carried !== null && (owner === carried || enters === carried) ? 1 : 0
    focusAmount.current = approach(focusAmount.current, focused ? 1 : 0, delta)
    // hover と呼び水は同じ琥珀。濃いほうを採り、触れているあいだは必ず hover が勝つ
    const lit = Math.max(focusAmount.current, pulseOrder === undefined ? 0 : pulseAt(pulseOrder))
    // 墨から琥珀へじわりと寄せ、同じ量で滲みを焚く
    ink.color.value.copy(color).lerp(FOCUS, lit)
    glow.amount.value = lit * GLOW_OPACITY

    const group = groupRef.current
    if (!group) return
    const sway = swayAt(phase, swaySize, clock.elapsedTime)
    group.position.set(position[0] + sway.x, position[1] + sway.y, position[2])
    group.rotation.z = sway.rotation
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
